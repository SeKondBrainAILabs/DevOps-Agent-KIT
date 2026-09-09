# EPIC: PR-Backed Review and a Single Merge Question

**Repo:** DevOps-Agent-KIT · **Branch:** development · **Ships as two slices**

> Revision 1 — every file:line below was verified against the code before writing. Claims the first draft got wrong are corrected inline, marked **CHECKER**.

---

## Context

KIT's merge gate already depends on a pull request. Nothing in KIT has ever created one.

`kit_merge` refuses a merge into a protected target unless CI is green, and it establishes that by running `gh pr checks <branch>` ([MergeService.ts:236](electron/services/MergeService.ts:236)). That command answers about a PR. When no PR exists it falls through to a branch-level `gh run list` ([:291](electron/services/MergeService.ts:291)), and if that yields nothing usable it fails closed with `CI_UNKNOWN` ([:329](electron/services/MergeService.ts:329)).

So the gate works, but it is weaker than it reads: a repo with no PR is gated on whatever workflows happened to run on the branch, and **nothing anywhere checks that a human approved the change**. It is a CI gate wearing the clothes of a review gate.

Meanwhile the tool that is supposed to hand work to a human does nothing. `kit_request_review` ([tools.ts:1233](electron/services/mcp/tools.ts:1233)) writes one activity row carrying `reviewRequested: true` and returns. **That flag is read nowhere in the codebase** — verified by grep across `renderer/` and `electron/`. Its own description claims it "emits event to KIT dashboard"; it does not. An agent finishing a task announces itself into a void.

**Outcome:** an agent calls `kit_request_review`; a pull request exists with a body describing what actually landed; the human sees one card with the PR, its CI state and what changed; they answer the merge question once; the merge proceeds through the gate that already exists.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Entry point | `kit_request_review` creates the PR. No new `kit_create_pr` tool |
| Idempotency | Create-or-update. Calling it five times yields one PR |
| Body source | `git log <base>..<head>` — **not** the `commits` table. See CHECKER below |
| Failure posture | Degrade, never block. No remote / no `gh` / not GitHub ⇒ review still recorded |
| Merge mechanism | Unchanged — local merge + push. `gh pr merge` deferred, see *Deferred* |
| Approval gate | Slice 2, behind a setting, default off |

**Why `kit_request_review` and not a new tool.** The call already exists, already means "a human should look at this", is already in the agent prompt, and is already in `MCP_OBSERVER_FORBIDDEN_TOOLS` ([mcp-types.ts:191](shared/mcp-types.ts:191)) so observers cannot fire it. Adding `kit_create_pr` alongside it would give agents two ways to say the same thing and one more step to forget. The streamlining is that there is no new step.

**Why not have `kit_merge` create the PR.** Merge is the destructive operation. Opening a PR as a side effect of "please merge" inverts the intent: the artefact a human was meant to review appears at the moment it is being merged. The gate should refuse and point at `kit_request_review`, not paper over the gap.

---

## CHECKER: the correction that changed the design

The first draft built the PR body from the `commits` table — KIT's own record, with `files_changed`, `additions`, `deletions` and `author` already populated ([DatabaseService.ts:136](electron/services/DatabaseService.ts:136)).

**That table is not a complete record of a branch.** Rows are written from exactly three places: `kit_commit` ([tools.ts:743](electron/services/mcp/tools.ts:743)), `kit_commit_all` ([:919](electron/services/mcp/tools.ts:919)), and the watcher's idle-end checkpoint ([WatcherService.ts:952](electron/services/WatcherService.ts:952)). An agent that runs `git commit` in bash — which the prompt discourages but does not prevent — produces no row at all.

A PR body built from it would silently omit commits, and would omit them *most* for the agents least likely to follow instructions. A reviewer would be reading an incomplete summary presented as complete.

**Corrected:** `git log <base>..<head>` is the source of truth for what the PR contains. The `commits` table is used only to *enrich* — session attribution, which commits KIT made versus the agent, activity context. Git decides what is in the PR; KIT decides what it knows about it.

---

## Slice 1 — A PR exists, and a human can see it

### P1 — `shared/github-cli.ts` (new)

`MergeService` inlines its own `runGh` helper ([:228](electron/services/MergeService.ts:228)) with a 30s timeout and `reject: false`. Slice 1 needs the same thing in two more places, so it is extracted once.

```ts
export interface GhResult { ok: boolean; stdout: string; stderr: string; code: number }
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

export function classifyGhFailure(r: GhResult): 'not_installed' | 'not_authenticated' | 'not_github' | 'other' | null;
```

`classifyGhFailure` is pure and is what every caller branches on, so the "gh is missing" and "this is not a GitHub remote" paths are decided in one tested place rather than by ad-hoc regex at each call site — which is what `MergeService.ts:238` does today (`/command not found|ENOENT/i`).

*AC:* table-driven over real `gh` stderr strings for each classification. Missing `gh` is never reported as "not a GitHub repo".
*Tests:* `GithubCli.test.ts`.

### P2 — `shared/pr-body.ts` (new, pure)

`buildPrTitle(input)` and `buildPrBody(input)` from: task description, branch, base, and the commit list read from git. Deliberately dependency-free so it is fully table-testable.

- Title: the session's task description, trimmed to 72 chars, falling back to the branch name.
- Body: what changed (commit subjects), files touched, the KIT session id, and a marker line.
- **A marker line is required** — `<!-- kit-session: <id> -->`. It is how P3 recognises a PR it owns on a later call, and how a human reading GitHub knows an agent opened it.
- Never includes diffs or file contents. A PR body is a public artefact in most repos; commit subjects are already public, file contents may not be.
- Truncates at a bounded length with `...and N more commits` — a 300-commit branch must not produce a 300-line body.

*AC:* a session with zero commits produces a body that says so rather than an empty section; a 500-commit branch produces a bounded body; the marker round-trips through `parseSessionMarker`.
*Tests:* `PrBody.test.ts`.

### P3 — `GitHubService.ensurePullRequest()` (new service)

The one operation, idempotent:

1. Resolve the remote. No `origin` ⇒ `{ status: 'no_remote' }`. Not a github.com remote ⇒ `{ status: 'not_github' }`.
2. `gh` missing or unauthenticated ⇒ `{ status: 'gh_unavailable', reason }`.
3. Push the branch. `GitService.push` already runs `push -u origin <branch>` ([GitService.ts:346](electron/services/GitService.ts:346)), so upstream is set and no new push path is needed.
4. `gh pr view <branch> --json number,url,state,isDraft` — if one exists and is open, **update** its body (`gh pr edit`) and return `{ status: 'updated' }`.
5. Otherwise `gh pr create --base <base> --head <branch> --title ... --body-file ...`, returning `{ status: 'created' }`.

**Body via `--body-file`, never `--body`.** A generated body contains newlines, backticks and quotes; passing it as an argument is a quoting bug waiting to happen and, with commit subjects in it, an argument-injection surface. Write to a temp file and delete it.

**A closed or merged PR is not reused.** `gh pr view` returns the most recent PR for a branch including merged ones; editing a merged PR would silently do nothing useful. Treat non-open as "create a new one".

*AC:* running it twice yields one PR and one `gh pr create`; a repo with no remote returns `no_remote` and does not throw; a merged PR on the same branch results in a new PR, not an edit.
*Tests:* `EnsurePullRequest.test.ts` with an injected `GhRunner` fake — no network.

### P4 — `kit_request_review` creates the PR

The tool keeps its signature and gains PR behaviour plus a real return value.

```
{ ok, review_logged, pr: { status, url, number } | null, ci: { state } | null, message }
```

**It must never fail because the PR could not be created.** The review signal is the primary effect and works offline; the PR is the enrichment. Every non-GitHub outcome returns `ok: true` with `pr.status` explaining why there is no link. An agent on a local-only repo must not see an error for doing the right thing.

Its description is corrected: it currently claims to emit a dashboard event and does not.

*AC:* on a repo with no remote the call still returns `ok: true` and still logs the review; the returned `pr.url` is the same on the second call; an observer session is still refused (unchanged — it is already in the forbidden set).

### P5 — Make `reviewRequested` real

`reviewRequested: true` is written into activity details and read by nothing. This story gives it a consumer: a review state on the session, an `INSTANCE_REVIEW_REQUESTED` event, and a card in the session view showing the summary, the PR link, and CI state.

**This is the story that makes the epic visible.** Without it P1–P4 create a PR that only an agent ever sees.

*AC:* calling `kit_request_review` surfaces the card without an app restart; the card survives a reload; a session with no PR shows the summary and says why there is no link.

### P6 — `kit_merge` refuses when a protected merge has no PR

New refusal, protected targets only:

```
PR_MISSING — "Refused merge into 'main': no open pull request for '<branch>'.
Call kit_request_review to open one so the change can be reviewed."
```

**Protected targets are `['main','master','production','release']`, exact match** ([MergeService.ts:864](electron/services/MergeService.ts:864)). `dev`, `develop` and `staging` are **not** protected — worth knowing before assuming this gate covers a team's real trunk. This story does not change that list; it is noted so nobody assumes wider coverage than exists.

The existing `force` override continues to bypass it, unchanged.

*AC:* merging into `development` is unaffected; merging into `main` with no PR is refused with `PR_MISSING` and a usable instruction; `force: true` still merges.

**Slice 1 order:** `P1 → P2 → P3 → P4 → P5 → P6`

---

## Slice 2 — One merge question

### P7 — The merge question, asked once

Today the human path is `MergeWorkflowModal` ([MergeWorkflowModal.tsx](renderer/components/features/MergeWorkflowModal.tsx), 1433 lines). It is the right place; it just has no idea a PR exists.

The review card gets **Merge** and **Not yet**. Merge opens the existing modal pre-filled with source, target and the PR's CI state already resolved, so the human answers once rather than re-deriving what the agent already established.

Explicitly *not* a second merge implementation. The modal stays the single merge path.

### P8 — Optional approval gate

Setting `merge.require_pr_approval`, **default false**. When on, a protected merge additionally requires `reviewDecision === 'APPROVED'` from `gh pr view`. Off by default because turning it on for an existing team mid-release would block every in-flight merge.

### P9 — CI status without polling

The review card needs CI state, and `gh pr checks` is a network call. Fetch on card open and on explicit refresh; never on a timer. Twenty agent sessions each polling `gh` is a rate-limit incident.

**Slice 2 order:** `P7 → P8 → P9`

---

## Failure modes

| Risk | Mitigation |
|---|---|
| **PR body omits commits made outside `kit_commit`.** The reason the design changed | Body built from `git log <base>..<head>`, never from the `commits` table |
| **`gh` absent, unauthenticated, or the remote is not GitHub.** Common on a fresh machine and on any GitLab repo | `classifyGhFailure` decides once; every path returns a status, never an exception. Review always logs |
| **Quoting and injection through the PR body.** Commit subjects are attacker-influenceable in a repo that takes contributions | `--body-file` only, never `--body`. No diffs or file contents in the body |
| **Duplicate PRs from repeated calls.** Agents retry | `gh pr view` first; open PR ⇒ edit. Merged or closed ⇒ new PR, deliberately |
| **A network call inside an MCP tool.** `gh pr create` can hang | 30s timeout, matching the existing `runGh`. Timeout returns a status, not a throw |
| **Multi-repo sessions.** A session can span repos; a PR belongs to one | Slice 1 opens a PR for the PRIMARY repo only and says so in the response. Secondary-repo PRs deferred |
| **Rate limits at fan-out.** 20 sessions requesting review | No polling anywhere; CI fetched on open and on demand |

---

## Verification

**Unit** (`jest.kanvas.config.cjs`): `GithubCli.test.ts`, `PrBody.test.ts`, `EnsurePullRequest.test.ts` — all with an injected `GhRunner`, no network.

**Real-git integration:** a temp repo with a real remote (a bare repo on disk) exercises push and branch state. `gh` itself is faked; the git half is real.

**Manual, against a real GitHub repo** — the half no test covers, and the half that found three bugs last time:
1. `kit_request_review` on a branch with no PR → PR appears, body lists the real commits.
2. Call it again → same PR, body updated, no duplicate.
3. `kit_merge` into `main` with the PR open and CI green → proceeds.
4. Delete the PR, retry the merge → `PR_MISSING`.
5. A repo with no remote → `ok: true`, review logged, `pr.status: 'no_remote'`.
6. `gh` logged out → `ok: true`, `pr.status: 'gh_unavailable'`, review still logged.

---

## Deferred

**`gh pr merge` as the merge mechanism.** KIT merges locally and pushes. Switching to `gh pr merge` would respect branch protection, required reviewers and merge queues — genuinely more correct for protected branches. It is deferred because it changes the merge mechanism for every existing user, interacts with the conflict-resolution path in `MergeService`, and would need its own rollback story. Revisit once PRs actually exist, which is what this epic delivers.

**Secondary-repo PRs for multi-repo sessions.** One PR per repo, coordinated. No demand demonstrated yet.

**Widening the protected-branch list.** `dev`/`develop`/`staging` being unprotected is arguably wrong, but changing it silently starts refusing merges people currently make. It belongs in its own change with its own release note.
