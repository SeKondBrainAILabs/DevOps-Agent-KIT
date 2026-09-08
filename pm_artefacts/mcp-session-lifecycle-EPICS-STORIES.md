# EPIC: Agent-Managed KIT Sessions over MCP

**Date:** 2026-08-29 · **Repo:** DevOps-Agent-KIT · **Branch:** development · **Ships as three slices**
**Status:** Spec approved, not started · **Notion mirror:** https://app.notion.com/p/3cb23d8c2375811c8339efc611b993d8

> Revision 2 — corrected after an adversarial checker pass. Every file:line below was re-verified against the code; claims the first draft got wrong are noted inline where the correction changes a design decision.

---

## Context

KIT sessions can only be created and destroyed by a human clicking through the desktop UI — every lifecycle operation runs through `ipcMain.handle` in [electron/ipc/index.ts](electron/ipc/index.ts). There is no programmatic entry point.

That blocks the workflow this repo exists to support. When an orchestrating agent fans out to many subagents, each needs its own isolated branch + worktree + auto-commit watcher + MCP binding. Today a human pre-creates every one by hand, guesses how many are needed, and cleans them up manually. At 8–20× the manual step is the bottleneck, and abandoned worktrees accumulate.

**Outcome:** an agent calls `kit_start_session` to spawn a working session, hands the returned `session_id` + `worktree_path` to a subagent, and later calls `kit_close_sessions(parent_session_id=<self>)` to tear down everything it created — safely, with the human still in control via caps, a kill switch, and (later) a reaper.

**Second, non-optional outcome:** the existing teardown path is leaky, and productising it over MCP multiplies those leaks by the fan-out factor. Four of the eight leaks found are load-bearing for the new close path and ship in Slice 1.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Tool scope | Full lifecycle + control — start, close, bulk close, list, status, restart, adopt, update |
| Close default | **SAFE.** Stop watcher, unbind MCP, mark `closed`, **keep** worktree + branch. Destructive actions need explicit flags and are refused on dirty/unpushed work unless forced |
| Lineage | `createdBy: 'ui' \| 'mcp' \| 'adopted'` + `parentSessionId`; bulk close by subtree |
| Isolation | `'worktree'` (default, made cheap via CoW `node_modules`) \| `'observer'` (no worktree, read-only) |
| Guardrails | Concurrency cap + single-session-mode respect + user kill switch + TTL/orphan reaper — all four |
| Pre-existing leaks | Folded in, split across slices by risk |

**Slicing (added in revision 2).** The original single-unit epic was ~3× too large to land safely: three new shared modules, a new orchestrator, eight tools, eight leak fixes, a reaper and three renderer surfaces — nearly all of them modifying `createInstance` or `deleteInstanceWithCleanup`, so the stories do not merge independently. Nothing is dropped; it ships in three releases.

- **Slice 1** delivers the Outcome sentence exactly: start, close, bulk close, list — worktree isolation only, with the four P0 leaks.
- **Slice 2** adds observer sessions, cheap `node_modules`, and restart/adopt/update.
- **Slice 3** adds the reaper, its UX, and the three riskier hygiene fixes (each of which can delete pre-upgrade user data and needs its own care).

**Out of scope entirely:** shared-worktree cohorts with declared-file leases — see *Deferred* at the end.

---

## Architectural spine

### S1 — `electron/services/SessionOrchestrator.ts` (new) · **Slice 1, first story**

> *Checker correction:* the first draft described this as spine-only with no story, no AC and no place in the sequence. It is the class every later story delegates to, so it is now story #1.

Today "create a session" is split across two layers and "close a session" does not exist:

- `AgentInstanceService.createInstance()` ([:535-732](electron/services/AgentInstanceService.ts:535)) performs 12 side effects.
- It does **not** start the file watcher. Three separate IPC sites do: [:407](electron/ipc/index.ts:407) (create), [:495](electron/ipc/index.ts:495) (restart), [:1639](electron/ipc/index.ts:1639)/[:1685](electron/ipc/index.ts:1685) (startup rehydration). Any non-IPC caller silently gets a session where auto-commit never runs.
- There is no close-without-delete. `'closed'` is a status set only by internal reapers; `updateInstanceStatus` ([:3334](electron/services/AgentInstanceService.ts:3334)) has exactly one caller. A real teardown exists as `SessionService.close()` ([SessionService.ts:144](electron/services/SessionService.ts:144)) but operates on a separate legacy model nothing in the AgentInstance flow touches.

`SessionOrchestrator` becomes the single funnel — **both** the IPC layer and the MCP tool layer call it.

```ts
class SessionOrchestrator {
  startSession(input): Promise<IpcResult<StartedSession>>
  adoptSession(input): Promise<IpcResult<StartedSession>>
  closeSession(sessionId, opts): Promise<IpcResult<CloseResult>>
  closeSessions(selector, opts): Promise<IpcResult<BulkCloseResult>>
  restartSession(sessionId, opts): Promise<IpcResult<RestartResult>>
  updateSession(sessionId, patch): Promise<IpcResult<UpdateResult>>
  listSessions(filter): SessionSummary[]
  getSessionStatus(sessionId, opts): Promise<IpcResult<SessionStatus>>
  reapExpiredAgentSessions(): Promise<ReapResult>
  expandSessionAliases(id): string[]                     // [id, ...predecessors, ...successors]
  private teardownSession(id, opts?: { unbindMcp?: boolean; keepDisk?: boolean })
}
```

**Why not move `startWithPath` into `createInstance`:** a record-creation service should not own a background process — `AgentInstanceService` is a zero-arg-constructor singleton ([:208](electron/services/AgentInstanceService.ts:208), [:3716](electron/services/AgentInstanceService.ts:3716)) that receives deps via setters and public callback fields, and giving it a watcher handle inverts that. *(The first draft justified this with "it would break the existing unit tests"; that evidence was false — `AgentInstanceService.test.ts` never constructs the class. The architectural reason stands on its own.)*

*AC:* `IPC.INSTANCE_CREATE` routes through `orchestrator.startSession()` with byte-identical observable behaviour, and the watcher is started in exactly one place. `IPC.INSTANCE_RESTART` ([:492-501](electron/ipc/index.ts:492)) also composes a watcher today — it routes through the orchestrator in Slice 2 (M5), and until then is explicitly listed as the second compose site.

### S2 — `shared/worktree-path.ts` (new, pure) · Slice 1

`resolveRepoRootFromWorktree(p)`, `isKitWorktreePath(p)`, `getWorktreeBaseDir(repoPath)`. The layout rule lives at [AgentInstanceService.ts:93](electron/services/AgentInstanceService.ts:93); the reverse regex is inlined at [WatcherService.ts:271-279](electron/services/WatcherService.ts:271).

**It must return `{root, confidence: 'exact' | 'derived'} | null`.** The current-layout regex *reconstructs* a repo path from a directory name — if the source repo was renamed, it resolves to a path that does not exist. H5's destructive `~/.claude.json` guard must require `'exact'` (verified via `git rev-parse --git-common-dir`). Must recognise both the legacy `local_deploy/` and current `KIT-DevOps-*` layouts, since `migrateLegacyWorktrees()` leaves a store containing both mid-migration.

### S3 — `shared/async-mutex.ts` (new, pure) · Slice 1

A `KeyedMutex` — promise chain per key, released in `finally`. Needed by the admission race (G1), by **per-repo serialisation of `git worktree add`** (see Failure Modes), and by concurrent `~/.claude.json` writes (H5).

### S4 — `shared/mcp-session-errors.ts` (new) · Slice 1

Existing tools return free-text `{error: 'Unknown session'}` ([tools.ts:947](electron/services/mcp/tools.ts:947)). Lifecycle tools need machine-readable failures so an orchestrator can self-remediate rather than retry-loop.

```ts
type KitLifecycleErrorCode =
  | 'NOT_FOUND' | 'INVALID_REPO' | 'BRANCH_IN_USE' | 'BRANCH_NOT_FOUND'
  | 'SINGLE_SESSION_MODE_ACTIVE' | 'SESSION_LIMIT_REACHED' | 'DISK_SPACE_LOW'
  | 'AGENT_SESSION_CREATION_DISABLED' | 'NOT_PERMITTED'
  | 'DIRTY_REFUSED' | 'UNPUSHED_REFUSED' | 'REMOTE_DELETE_NOT_PERMITTED'
  | 'OBSERVER_SESSION_READ_ONLY' | 'OBSERVERS_ATTACHED' | 'PARENT_NOT_FOUND'
  | 'WORKTREE_CREATE_FAILED' | 'WORKTREE_MISSING' | 'NESTED_WORKTREE_REFUSED'
  | 'NO_SELECTOR' | 'SELECTOR_TOO_BROAD' | 'NO_UPDATES'
  | 'SERVICE_UNAVAILABLE' | 'INTERNAL';

interface KitLifecycleError {
  ok: false; error_code: KitLifecycleErrorCode; message: string;
  retryable: boolean; details?: Record<string, unknown>;
  retry_with?: Record<string, unknown>;   // e.g. { force_dirty: true }
  instruction?: string;                    // what the agent should do instead
}
```

`SINGLE_SESSION_MODE_ACTIVE` reuses `SINGLE_SESSION_MODE_ERROR_CODE` from [shared/single-session-guard.ts:13](shared/single-session-guard.ts:13) so the layers cannot drift.

### S5 — Type changes

On `AgentInstanceConfig` ([shared/types.ts:586](shared/types.ts:586)):
```ts
createdBy?: 'ui' | 'mcp' | 'adopted';   // absent ⇒ 'ui' — agents can never close a legacy human session
parentSessionId?: string;
isolation?: 'worktree' | 'observer';     // absent ⇒ 'worktree'
observedPath?: string;                   // observer only
strictWorktree?: boolean;                // true for createdBy:'mcp' — no silent in-place fallback
useWorktree: boolean;                    // NOW @deprecated — keep required & keep writing it for one release
```

On `AgentInstance` ([:622](shared/types.ts:622)): `worktreeStatus?: 'created'|'reused'|'legacy'|'observer'|'failed'`, `nodeModules?`, `closedAt?`, `closeReason?`, `expiresAt?`, `pinned?`.

**Two type changes the first draft missed:**
1. `InstanceStatus` ([shared/types.ts:582](shared/types.ts:582)) is `'pending'|'initializing'|'waiting'|'active'|'error'` — `'closed'`/`'completed'`/`'failed'` are assigned via casts today. `markSessionClosed` and the `status[]` filters on the list tools need the union widened.
2. **`SessionReport.worktreePath` is required, non-optional** ([shared/agent-protocol.ts:106](shared/agent-protocol.ts:106)). Observers need it optional, and the report must additionally carry `createdBy`, `parentSessionId`, `isolation`, `observedPath`, `worktreeStatus` — see the recovery fix below. This is a `shared/agent-protocol.ts` change, not just `shared/types.ts`.

**Persistence — the second-writer problem must be fixed, not documented.** `SessionRecoveryService` opens its own `Store('kanvas-instances')` ([:41](electron/services/SessionRecoveryService.ts:41)) and does read → push → set ([:160](electron/services/SessionRecoveryService.ts:160)), while `AgentInstanceService` holds the authoritative map and rewrites the whole array on every create/close ([saveInstances :3446](electron/services/AgentInstanceService.ts:3446)). Any subsequent `saveInstances()` silently drops the recovered record. Today that is rare because creates are human-paced; at fan-out it becomes routine. Worse, `recoverSession` rebuilds `config` from the `SessionReport`, which carries none of the new fields and hardcodes `baseBranch: 'main'` ([:148](electron/services/SessionRecoveryService.ts:148)) — so recovering an MCP session **converts it into a UI session**: permanently un-closable by its parent, invisible to the reaper, cut off the wrong base.

*Fix (Slice 1):* delete the second store handle. Give `SessionRecoveryService` an `AgentInstanceService` reference and an `importRecoveredInstance(instance)` that writes through the map. Extend `SessionReport` with the five fields above.

Also add a `storeSchemaVersion` key now — six startup migrations already run unconditionally on every launch and this epic adds more with destructive tails.

---

# Slice 1 — Start, close, cleanup

Delivers the Outcome sentence. Worktree isolation only. No observers, no `node_modules` work, no reaper.

## Phase 0 — P0 hygiene

| # | Leak | Verified |
|---|---|---|
| 1 | `McpSessionBinder.unregisterSession` ([:38](electron/services/mcp/session-binder.ts:38)) is **never called in production**. Deleted sessions stay MCP-resolvable until app restart | ✓ zero prod callers |
| 2 | No delete path stops `RebaseWatcherService.stopWatching` ([:275](electron/services/RebaseWatcherService.ts:275)) — an orphaned 60s `setInterval` per dead session | ✓ |
| 6 | `deleteInstanceWithCleanup` never runs `git worktree prune` (contrast [MergeService.ts:1416](electron/services/MergeService.ts:1416), [GitService.ts:251](electron/services/GitService.ts:251)) | ✓ |
| 7 | `WatcherService.stopAll` ([:467](electron/services/WatcherService.ts:467)) has zero callers — multi-repo sessions leak N−1 chokidar watchers per close (compound keys built at [:449](electron/services/WatcherService.ts:449)) | ✓ |

**H0 — Spine primitives.** S2 + S3; migrate [WatcherService.ts:271](electron/services/WatcherService.ts:271) and [AgentInstanceService.ts:93](electron/services/AgentInstanceService.ts:93) onto them. Must run **after** `migrateLegacyWorktrees()` in the startup order.
*AC:* both call sites produce byte-identical results for legacy and current layouts; `confidence:'derived'` is returned for a renamed source repo rather than a wrong path.
*Tests:* `WorktreePath.test.ts` (legacy, current, renamed-source, non-worktree, trailing slash, symlinked parent); `AsyncMutex.test.ts` (100 concurrent tasks serialise; exception still releases; key removed after drain).

**H1 — `teardownSession()` on the orchestrator.** Fixes leaks 2, 6, 7 in one place: `watcher.stopAll` + `rebaseWatcher.stopWatching` + `lock.releaseSessionLocks` + `git worktree prune`. Called from `INSTANCE_DELETE` ([:445](electron/ipc/index.ts:445)), `INSTANCE_DELETE_SESSION` ([:451](electron/ipc/index.ts:451)), `INSTANCE_DELETE_WITH_CLEANUP` ([:474](electron/ipc/index.ts:474)), `INSTANCE_RESTART` ([:487](electron/ipc/index.ts:487)), and the MCP close path.

*Latent bug fixed here:* `IPC.INSTANCE_DELETE` at [:443-445](electron/ipc/index.ts:443) passes **`instanceId`** to `watcher.stop`, but watchers key on `sessionId` ([:263](electron/services/WatcherService.ts:263)) and the two id spaces can never collide (`inst_…` vs `sess_…`, [:590-591](electron/services/AgentInstanceService.ts:590)). That call has always matched nothing. Needs an instance→session lookup.
*Note:* `stopAll` already handles the single-key case ([:469-472](electron/services/WatcherService.ts:469)) — no conditional needed. The `Services` key is `lock`, not `lockService` ([services/index.ts:53](electron/services/index.ts:53)).
*AC (sharpened — `debugCounts()` is **global**, not per-session):* with a 3-repo session plus one unrelated single-repo session running, closing the multi-repo session drops `debugCounts().watchers` by exactly 3, leaves the unrelated session watching and still auto-committing, leaves no rebase interval for the closed id, and `git worktree list --porcelain` reports no `prunable` entry.

**H2 — Binder unregister.** Leak 1. Add `onSessionClosed?: (sessionId) => void` beside `onSessionCreated` ([:130](electron/services/AgentInstanceService.ts:130)), wired at [services/index.ts:335](electron/services/index.ts:335). **Must also unregister every `predecessorSessionIds` alias** — `registerExistingSessionsWithBinder` registers each predecessor as its own entry ([:2317](electron/services/AgentInstanceService.ts:2317)), so unregistering only the current id leaves live aliases and `kit_commit` keeps working against a closed session.

**Hook site matters.** Fire it from `teardownSession` **only** — not from `deleteInstance`. Two paths remove records without going through `deleteInstance`: `restartInstance` ([:3035-3037](electron/services/AgentInstanceService.ts:3035)) and `purgeInstancesOnBranch` ([:2855](electron/services/AgentInstanceService.ts:2855)). Make `purgeInstancesOnBranch` call `teardownSession(id, {unbindMcp: true, keepDisk: true})`, and give the restart path `teardownSession(id, {unbindMcp: false})` so it does not unbind ids it is about to re-alias.
*AC:* close a session with 2 predecessors → all 3 ids return `undefined` and `kit_commit` under any of them errors. **Separately:** restart a live session with 2 predecessors → all 3 ids still resolve (regression guard on the shared hook).

**H4a — DB telemetry purge (the safe half).** `DatabaseService.purgeSessionTelemetry(sessionId)` deleting `activity_logs`, `terminal_logs`, `mcp_calls` in one transaction, **keyed over `expandSessionAliases(id)`** so predecessor-keyed rows go too. Keep `commits` and `session_history` — `commits` is the only KIT-side hash→session link and `backfillMcpCallsByLineage` ([:1842](electron/services/AgentInstanceService.ts:1842)) exists to rescue history across restarts.

**Called on *delete*, not on safe close.** A safe close calls `markSessionClosed`, not `deleteInstance` — so telemetry survives a safe close, which is correct (the reaper needs `mcp_calls` for liveness). *(The first draft said "purge inside `deleteInstance`, which the reaper calls" — no reaper calls `deleteInstance`; `reapOrphanInstances` only sets status at [:2239](electron/services/AgentInstanceService.ts:2239).)*
*Deferred to Slice 3:* extending the 30-day sweep to `commits`/`session_history`. On a year-old install that would delete almost all history on the first launch after upgrade.

## Phase 1 — Admission control

> *Checker correction:* the first draft sequenced G1 before G2/G3, but G1's critical section calls G3's evaluator and enforces G2's caps. Reordered to **G3 → G2 → G1**.

**G3 — `shared/session-admission.ts`.** Pure evaluator, modelled on `shared/single-session-guard.ts`: kill switch → caps (global, per-repo) → single-session guard.

**Counts `isActiveInstance`, which includes `'waiting'`.** Every MCP session starts `'waiting'` ([:612](electron/services/AgentInstanceService.ts:612)) and stays there until its subagent's first tool call — which may never come. `isRunningInstance` excludes `waiting`, so with it an orchestrator could create 200 sessions. The cost of `isActiveInstance` — eight never-connected sessions from a crashed fan-out blocking the budget — is paid down by making `SESSION_LIMIT_REACHED` return the `waiting` sessions with their ages so the orchestrator can self-remediate.

*Note on composition:* `evaluateSingleSessionGuard(mode, count)` takes a bare count from `getActiveSessionsForRepo`. Any per-isolation exemption (Slice 2) changes the *count*, i.e. every caller — so "compose, don't replace" is not automatically cheaper. Compose in Slice 1 (no exemptions yet); revisit at A-stories.
*AC:* table-driven — every combination of mode × createdBy × counts yields the documented code.

**G2 — Settings + kill switch + UI.** Home: the `settings` table ([DatabaseService.ts:107-113](electron/services/DatabaseService.ts:107)) — global machine-protection limits, not per-repo preferences, and `getSetting` is *already* on the `McpServiceDeps` shim ([McpServerService.ts:112](electron/services/McpServerService.ts:112)).

| Key | Default |
|---|---|
| `mcp.session_create.enabled` | `true` (default-on, opt-out) |
| `mcp.session_create.max_concurrent_global` | `8` |
| `mcp.session_create.max_concurrent_per_repo` | `4` |
| `mcp.session_close.allow_remote_branch_delete` | `false` |

**Kill switch is default-on (opt-out).** The checker argued for default-off on the grounds that shipping an update which lets any connected MCP client silently create eight worktrees is the least conservative default in an otherwise conservative spec. Decision: **stay default-on**, and pay the consent cost through discovery instead — the first agent-created session in an app run raises a renderer notification ("An agent created a KIT session — manage this in Settings → MCP") and lights a live `3 / 8` counter in `McpTab.tsx`, where the user is already watching MCP traffic. The caps (8 global / 4 per repo) and the SAFE close default are the real protection. Flipping the switch off offers — confirm dialog, never automatic — an immediate safe-close sweep of live MCP sessions, because blocking only *future* creates leaves on screen the mess the user reached for the switch about.

**Do not add `setSetting` to the `McpServiceDeps` shim at all.** The shim exposes `getSetting` and a narrow `getSessionLimits()` only; writes go through IPC/UI. Otherwise an agent raises its own cap.
*AC (sharpened):* a test asserts no registered tool schema accepts a settings key, and `setSetting` is unreachable from `tools.ts`. Toggling the switch off blocks create and does **not** block close — an agent must always be able to clean up after itself.

*Per-repo cap rationale, corrected:* the first draft cited `.git/index.lock` contention. Each worktree has its **own** index, so that lock is not contended. The real per-repo contention is `.git/config.lock` (every `git worktree add` writes the worktree registry), `.git/packed-refs.lock`, and pack writes — see Failure Modes.

**G1 — Mutex around the admission decision.** MCP fan-out makes concurrent `createInstance` the *normal* case, and the single-session guard is a creation-time check with no mutex. The race: the guard reads at [:583](electron/services/AgentInstanceService.ts:583), the reservation `instances.set` happens at [:622](electron/services/AgentInstanceService.ts:622), and `validateRepository` ([:542](electron/services/AgentInstanceService.ts:542)) / `initializeKanvasDirectory` ([:555](electron/services/AgentInstanceService.ts:555)) yield the event loop in between.

Fix: hoist the slow I/O above the lock, then take **one global mutex** spanning [:562](electron/services/AgentInstanceService.ts:562) (`BRANCH_IN_USE`) through [:622-623](electron/services/AgentInstanceService.ts:622). Inside: branch-in-use, single-session guard, caps, kill switch, id generation, reservation — synchronous `Map` reads plus one store write. `setupAgentEnvironment` ([:678](electron/services/AgentInstanceService.ts:678)) and multi-repo stay outside.

**`createWorktreeIfNeeded` ([:641](electron/services/AgentInstanceService.ts:641)) also stays outside the admission mutex but takes its own per-source-repo lock** — see Failure Modes; unserialised concurrent `git worktree add` on one repo fails on `.git/config.lock`.

**Restart re-enters `createInstance`**, so the mutex, caps and kill switch would apply to restarts. A restart is not net-new capacity: exempt it explicitly, and put `purgeInstancesOnBranch` + `createInstance` inside the **same** critical section, or a restart transiently frees a slot another agent grabs and then fails `BRANCH_IN_USE`.
*AC:* 20 concurrent creates into an `'in-place'` repo → exactly 1 success, 19 `SINGLE_SESSION_MODE_ACTIVE`. 20 concurrent creates with `max_concurrent_global=8` → exactly 8 successes, 12 `SESSION_LIMIT_REACHED`. With `createWorktreeIfNeeded` instrumented, invocations across *different* repos overlap in time while same-repo ones do not.

## Phase 2 — Strict worktree

**A1 — `worktreeStatus` + strict worktree.** `createWorktreeIfNeeded` returns a bare string and **silently returns `config.repoPath` on any failure** ([:895-898](electron/services/AgentInstanceService.ts:895)). For the UI that is a survivable annoyance; for a 20-way fan-out it means 20 agents writing into the user's real checkout.

**Split the function — the `try` block currently spans too much.** It covers `git worktree add` ([:862-864](electron/services/AgentInstanceService.ts:862)) *and* `initializeKanvasDirectory` / `linkEnvIntoWorktree` / `installPreCommitHookIntoWorktree` ([:877-893](electron/services/AgentInstanceService.ts:877)), so a failed `.env` symlink currently returns "no worktree". As written, the first draft's hard-fail-and-rollback would delete a perfectly good worktree because a symlink threw.

- `addWorktree()` — fatal. Failure ⇒ `worktreeStatus:'failed'`; for `createdBy:'mcp'` hard-fail with `WORKTREE_CREATE_FAILED` + git stderr and roll back the reservation.
- `provisionWorktree()` — best-effort. Failures feed `warnings[]` and never fail creation.
- `createdBy:'ui'` keeps degrade-and-continue, but records `worktreeStatus:'failed'` and the renderer shows a banner — that state becomes visible for the first time.
- Define `'legacy'` explicitly: set when the pre-existing `local_deploy/` layout is reused.

`useWorktree` becomes `@deprecated` but stays **required and still written** for one release — it is non-optional today, constructed in [CreateAgentWizard.tsx:433](renderer/components/features/CreateAgentWizard.tsx:433) and `restartInstance`, and migrated on every launch by `migrateUseWorktreeFlag()` ([:1617](electron/services/AgentInstanceService.ts:1617)).
*AC:* a fixture store of 5 pre-upgrade instances (no `createdBy`, mixed `useWorktree`) survives `migrateUseWorktreeFlag` → `migrateLegacyWorktrees` → `repairOrphanWorktrees` → `registerExistingSessionsWithBinder` byte-identically apart from added optional fields.

## Phase 3 — The MCP surface

> *Checker correction:* **M6 lands first**, not last. It adds a test asserting `registerTools` registers exactly `Object.values(MCP_TOOLS)`; landing it last means CI is red for the whole of Phase 3.

**M6 — Registry hygiene (first).** `MCP_TOOLS` in [shared/mcp-types.ts:70](shared/mcp-types.ts:70) lists 8 of the 22 live tools and is already stale. Make it authoritative with all new names **pre-declared**, and have the test assert `registered ⊆ MCP_TOOLS` until the last tool lands, then flip to equality. The registration-capture harnesses already exist (`McpTools.test.ts:24-28`, `McpToolsV25.test.ts:33-36`).

Add the state-changing lifecycle tools to `STATE_CHANGING_TOOLS` ([:202](electron/services/mcp/tools.ts:202)); the read tools stay out. The activity log type is hardcoded `'git'` at **[tools.ts:534](electron/services/mcp/tools.ts:534)** *(not :222 — that line is inside `preCommitSanityCheck`)*; replace with a `TOOL_LOG_TYPE` lookup mapping lifecycle tools to `'info'` (a valid `LogType`, [shared/types.ts:166](shared/types.ts:166)).

**Actor vs target.** `withCallLog` extracts `args.session_id` at [tools.ts:510](electron/services/mcp/tools.ts:510) and treats it as the caller — but for `kit_close_session`, `session_id` is the **target**. Left unfixed, the `waiting → idle` flip and the activity log fire against the session being closed, and `driftDirectiveFor` runs `git branch --show-current` against a worktree that may have just been removed. Add `actorSessionIdFor(toolName, args)` in `tools.ts` and key every `withCallLog` concern off it; name the target param `target_session_id` on the close tools.

**M1 — `kit_start_session`** (state-changing). Agent supplies `repo_path`, `task`, and its own `session_id` (recorded as `parentSessionId`). Optional: `agent_type` (default `'claude'`), `branch_name`, `base_branch`, `auto_commit`, `rebase_frequency`, `system_prompt`, `ttl_minutes`, `include_prompt`, `dry_run`.

**`repo_path` must be normalised at the MCP boundary.** `getActiveSessionsForRepo` compares by exact string ([:177](electron/services/AgentInstanceService.ts:177)) and `validateRepository` does no normalisation — so a trailing slash or a symlinked path silently creates a second bucket and bypasses *both* the per-repo cap and single-session mode. `realpathSync` + `path.resolve`, and refuse when `isKitWorktreePath(repo_path)` with `NESTED_WORKTREE_REFUSED`: an orchestrator running inside its own KIT worktree will naturally pass its cwd, producing a nested `KIT-DevOps-<branch>/` inside the parent's worktree that the parent's watcher then auto-commits.

**Branch naming — the first draft's premise was wrong.** It claimed a free-form MCP branch name "would start polluting" the base-branch picker. In fact `isSessionOrRemoteBranch` ([CreateAgentWizard.tsx:1219-1235](renderer/components/features/CreateAgentWizard.tsx:1219)) filters `codex-`, `cursor-`, `copilot-`, `aider-`, `warp-`, `cline-` — **there is no `claude-session-` case**, so for the epic's default agent type session branches already pollute it today. And the real generated shape ([:368-370](renderer/components/features/CreateAgentWizard.tsx:368)) is `<type>-session-<timestamp>-<rand4>` with **no slug segment**. Corrected plan: match the existing shape exactly, and add `claude-` to the filter list as a drive-by fix. Extract `pickDefaultBaseBranch` ([:1209](renderer/components/features/CreateAgentWizard.tsx:1209)) to `shared/branch-naming.ts` — **confirm it is pure first**; if it consults a branch list the renderer holds, this is a rewrite against a different data source, not a move.

Created sessions get status **`'waiting'`**, matching the UI path.

Returns `session_id`, `instance_id`, `worktree_path`, `branch`, `base_branch`, `parent_session_id`, an `mcp{url, rpc_url, config_path, tool_prefix}` block, a `launch{cwd, suggested_command, must_pass_session_id}` block, the `prompt` (suppressible), `watcher_started`, and `warnings[]` — which surfaces the partial failures currently swallowed to `console.warn` at [:718](electron/services/AgentInstanceService.ts:718) and invisible to a headless caller.

**M2 — `kit_close_session`** (state-changing). `target_session_id`, `reason`, `delete_worktree`, `delete_local_branch`, `delete_remote_branch`, `force_dirty`, `force_unpushed`, `allow_foreign`, `caller_session_id`.

**Two `force` flags, not one.** A single `force` that bypasses both the dirty check and the unpushed check is too blunt — especially given the next point.

**`getDeleteSafetyInfo` returns nonsense on repos with no remote.** When both `origin/<branch>` and `origin/<base>` are absent it falls back to `git rev-list --count HEAD` — the entire history. On a local-only repo every destructive close would return `UNPUSHED_REFUSED: 4,183 unpushed commits`. Branch on "no remote configured" and skip the unpushed gate. Also state which gate applies to which flag: dirty gates `delete_worktree`; unpushed gates `delete_local_branch` and `delete_remote_branch`.

`delete_remote_branch` additionally requires `mcp.session_close.allow_remote_branch_delete` (default `false`).

**Permission model:**

| Target | Allowed? |
|---|---|
| Caller itself | yes |
| Transitive descendant (via `expandSessionAliases`) | yes |
| Another `createdBy:'mcp'` session | only with `allow_foreign` |
| `createdBy:'adopted'` | safe close yes; **destructive never** |
| `createdBy !== 'mcp'` **or absent** and not caller/descendant | **never** |

Treating `undefined` as `'ui'` means agents can never close a pre-upgrade human session.

**`markSessionClosed`'s contract must be explicit**, because the sidebar is driven by `SessionReport.status` via `emitStoredSessions`, which maps *every* instance status to `'active' | 'idle'` ([:3527](electron/services/AgentInstanceService.ts:3527)). Without a defined contract a safe-closed session is re-emitted as `idle` on the next window load and **looks alive**. It must: write the on-disk `SessionReport` with a closed status, emit `instance:status-changed`, and not emit `session:closed` (which the renderer treats as deletion).

**Teardown order** (best-effort, reported in `actions`): `watcher.stopAll` → `rebaseWatcher.stopWatching` → `heartbeat.stopMonitoring` (first caller ever) → `binder.unregisterSession` **plus every predecessor alias** → `markSessionClosed` → if destructive: `getDeleteSafetyInfo` gate → `deleteInstanceWithCleanup` → `git worktree prune` → `recordSessionEvent(id, 'closed')` (the enum already supports it at [:722](electron/services/DatabaseService.ts:722); note the shim is 3-arity at [McpServerService.ts:111](electron/services/McpServerService.ts:111)).

**Cost note (corrected):** a SAFE close performs zero git/network I/O. The destructive path's safety check costs **two 15s-timeout `git fetch` calls ([:2463-2464](electron/services/AgentInstanceService.ts:2463)) plus an untimed `git ls-remote` ([:2498](electron/services/AgentInstanceService.ts:2498))**.

*AC (the first draft had none for the most dangerous tool):* table-driven over the permission matrix, explicitly including — a legacy record with `createdBy` absent is closable by nobody but the UI; an adopted session is not destructively closable by its adopter; a descendant reached only via a predecessor id **is** closable; `already_closed:true` (not `NOT_FOUND`) for a second safe close and for a second destructive close after the record is gone; a local-only repo does not trigger `UNPUSHED_REFUSED`.

**M3 — `kit_close_sessions`** (state-changing). Selectors AND together and require a scope anchor — `session_ids`, `parent_session_id`, or `repo_path`. `{created_by:'mcp'}` alone → `SELECTOR_TOO_BROAD`.

**Every selector runs through `expandSessionAliases`.** `restartInstance` mints a new `sessionId` ([:3050-3065](electron/services/AgentInstanceService.ts:3050)), so children created before a parent restarted still carry the parent's *old* id. Without alias expansion, `kit_close_sessions(parent_session_id=<self>)` — the sentence this whole epic is built on — returns `matched: 0` after any KIT restart.

`created_by` defaults to `'mcp'` so a bulk close can never sweep up UI-created sessions. Returns `matched`, `closed[]`, `skipped[]`, `failed[]`, and **`has_more`** rather than a silent truncation at `limit`. `ok` stays `true` on partial failure.
*AC:* after a KIT restart that re-ids the parent, `kit_close_sessions(parent_session_id=<original id>)` matches all children; after a *child* restart the child is still matched.

**M4 — `kit_list_sessions` + `kit_get_session_status`** (read-only). List filters by repo, parent (+ descendants), `created_by`, status, `include_closed` (default false), `fields`. Per-session output includes lineage and `mcp_registered` + `watcher_running` — together these expose the leak class. `watcher_running` needs a **new per-session accessor**: `isWatching` matches the exact key only, and `debugCounts()` is global.

`include_remote` on the status tool is **off by default** — see the cost note above.

## Slice 1 UX

**R3a — Visibility.** The first draft asserted safe-closed sessions "vanish from the sidebar". **That is backwards** — the Sidebar filters `SessionReport.status` ([Sidebar.tsx:33](renderer/components/layouts/Sidebar.tsx:33)), and `emitStoredSessions` maps every instance status to `'active'|'idle'`, so at 20-way fan-out the sidebar fills with **phantom live sessions**. Needs: an agent badge on MCP-created rows, parent→child nesting, and a distinct "Closed (worktree retained)" treatment.
*AC:* after a safe close the session renders as closed-with-retained-worktree, not as `idle`, both before and after an app restart.

**Slice 1 order:** `S1 → H0 → H1, H2 → H4a → G3 → G2 → G1 → A1 → M6 → M1 → M2 → M3 → M4 → R3a`

---

# Slice 2 — Observers, cheap worktrees, control tools

**A2 — Observer creation path.** An observer is a real `AgentInstance` with its own id, status lifecycle, activity log, session file, binder registration and lineage. It is **not** a branch owner (`branchName` is a synthetic `observer/<short-id>` never passed to git; skip `BRANCH_IN_USE`) or a worktree owner.

> **`instance.worktreePath` stays `undefined` for observers.** `deleteInstanceWithCleanup` computes at [:2540-2541](electron/services/AgentInstanceService.ts:2540):
> ```ts
> worktreePath = resolved.instance.worktreePath && resolved.instance.worktreePath !== repoPath
>   ? resolved.instance.worktreePath : null;
> ```
> A truthy, `!== repoPath` value reaches `git worktree remove --force` at [:2561](electron/services/AgentInstanceService.ts:2561) — so an observer storing the borrowed path there would destroy the **parent's** worktree on its own close.
>
> **Do not rely on that accident alone.** Several existing sites read `instance.worktreePath || config.repoPath` and would hand back the observed directory: `repairOrphanWorktrees` [:1786](electron/services/AgentInstanceService.ts:1786), `registerExistingSessionsWithBinder` [:2301](electron/services/AgentInstanceService.ts:2301), `restartInstance` [:3006](electron/services/AgentInstanceService.ts:3006), `emitStoredSessions` [:3523](electron/services/AgentInstanceService.ts:3523). Add an explicit `if (config.isolation === 'observer') return` at the top of `deleteInstanceWithCleanup` and every other destructive site — one grep-able invariant instead of an implicit one.
>
> **Ghost-mode delete** ([:2542-2549](electron/services/AgentInstanceService.ts:2542)) takes `hints.worktreePath` from the renderer, and `createSessionFile` writes `worktreePath: worktreePath || config.repoPath` ([:757](electron/services/AgentInstanceService.ts:757)). The report must omit it for observers and carry `isolation` — requiring the `SessionReport` type change in S5.

**Session-file location (the first draft contradicted itself).** It required a session file *and* asserted "zero files written into the observed directory" — but for the raw-checkout flavour `repoPath === observedPath`, so both cannot hold. Resolution: an observer's `config.repoPath` is the resolved **source repo root** of `observedPath` via H0; the AC becomes "zero writes into `observedPath` **and its subtree**".

Skipped for observers: `git worktree add`, `initializeKanvasDirectory(worktreeDir)`, `linkEnvIntoWorktree`, `installPreCommitHookIntoWorktree`, the **file watcher** (critical — it would double-commit the parent's worktree), the rebase watcher (force `rebaseFrequency:'never'`), and **all of `setupAgentEnvironment`** ([:1433](electron/services/AgentInstanceService.ts:1433)) — which writes into `worktreePath || repoPath` and would otherwise plant `.agent-config` carrying the *observer's* session id into the parent's directory, corrupting the parent's commit attribution, plus clobber `.mcp.json` and `.claude/settings.json`.

An observer therefore writes nothing to the observed directory and is configured **in-band** from `kit_start_session`'s response, plus an `observer` block in `shared/agent-instructions.ts`.

**Three questions the first draft left open, now answered:** an observer **cannot** spawn children (add `kit_start_session` to the forbidden set); an observer **cannot** observe an observer (refuse, do not flatten); when an observer's parent is restarted, `observerOfSessionId` is rewritten via `expandSessionAliases` — otherwise `getObserversOf()` returns empty and the attachment guard silently stops protecting.

*Note:* the first draft warned that `migrateUseWorktreeFlag` would convert observers. It cannot — [:1622](electron/services/AgentInstanceService.ts:1622) short-circuits on `if (!wt || wt === cfg.repoPath) continue`, and observers have `worktreePath === undefined` by design.

**A3 — Binder observer support + parent coupling.** Extend `BoundSession` ([:7](electron/services/mcp/session-binder.ts:7)) with `isolation` / `ownerSessionId`; add `registerObserverSession()` and `getObserversOf()`. The flag lives on the binder because `isObserver()` runs on every tool call and `expectedBranchFor` already does a full list scan per call.

New invariant: **at most one non-observer registration per realpath**. It must be **non-throwing on startup replay** — `registerExistingSessionsWithBinder` replays every non-terminal instance, and pre-upgrade stores demonstrably contain duplicates on one path (in-place sessions register `config.repoPath`; `purgeInstancesOnBranch` exists because same-branch duplicates accumulate). On conflict during startup: keep the most recently created, log, never throw. Hard-enforce only for registrations originating from `startSession`.

**Coupling — refuse, don't cascade, and don't detach on safe close either.** Before worktree removal, if `deleteWorktree` and the session has ≥1 live observer and no `force`, return `OBSERVERS_ATTACHED` naming them. A **safe** close leaves observers entirely untouched — it touches no disk, so the observer's read-only view stays valid. *(The first draft detached them on safe close, which is the same class of surprise it correctly rejects for cascade, for zero benefit.)* Define "live" explicitly and put it in the error's `instruction`, or an observer stuck in `waiting` blocks every destructive parent close.

**A4 — Read-only enforcement.** One central guard in `withCallLog` ([:504](electron/services/mcp/tools.ts:504)), keyed off `actorSessionIdFor` (M6), with `binder` already in scope from [tools.ts:170](electron/services/mcp/tools.ts:170).

```ts
const OBSERVER_FORBIDDEN_TOOLS = new Set([
  'kit_commit', 'kit_commit_all', 'kit_merge', 'kit_rebase', 'kit_request_review',
  'kit_lock_file', 'kit_unlock_file', 'kit_set_repo_worktree_mode', 'kit_start_session',
]);
```

**`kit_set_repo_worktree_mode` takes no `session_id`** ([:1459](electron/services/mcp/tools.ts:1459)) — only `{repo_path, mode}` — so the central guard resolves `'unknown'` and **cannot** block it. It needs an added optional `session_id` param, or its own per-tool check. The first draft's AC ("each of the 8 forbidden tools returns `OBSERVER_SESSION_READ_ONLY`") was unachievable as specified.

`kit_workspace_*` / `kit_project_group_add` stay allowed — they mutate KIT's own registry, not the repo.

`checkDivergence` ([:419](electron/services/mcp/tools.ts:419)): **keep** layer 1 (realpath), **disable** layer 2 and the `DETACHED_HEAD` branch. Layer 2 lives at [:458](electron/services/mcp/tools.ts:458) and is already conditional on `!repo` (secondary repos are exempt today). `driftDirectiveFor` ([:480](electron/services/mcp/tools.ts:480), `DRIFT_TTL_MS = 8000` at [:479](electron/services/mcp/tools.ts:479)) **replaces** rather than suppresses its nag for observers.
*AC:* add a **membership test** asserting `OBSERVER_FORBIDDEN_TOOLS ∪ allowed == every registered tool name`, so a newly-added tool fails the suite until classified.

**A5 — Cheap `node_modules`.** Moved off the Slice 1 critical path — it is the most platform-dependent, hardest-to-CI story in the epic and nothing depends on it. Ships behind `worktree.node_modules_strategy`, **default `'none'`** until measured.

Ladder in `shared/node-modules-plan.ts` (pure) + `provisionNodeModules()`: (1) no source → `'none'`; (2) source is a symlink (**this repo's own situation**) → recreate it; (3) macOS `cp -c -R` (clonefile; errors on non-APFS rather than silently copying); (4) Linux `cp -a --reflink=always` — **`always`, never `auto`**, which silently does a full byte copy; (5) Windows junction (consider defaulting Windows to `'skip'`); (6) POSIX symlink; (7) `'skipped'` + activity entry.

**Two hazards the first draft got wrong or missed:**
- **Disk accounting is inverted.** It claimed `shared/disk-usage.ts` and `RepoCleanupService.ts:621` "already exclude `node_modules`". They do the **opposite** — `node_modules` is in `RECLAIMABLE_CATEGORIES` ([shared/disk-usage.ts:41-45](shared/disk-usage.ts:41)) and is explicitly measured per-repo ([:616-629](electron/services/RepoCleanupService.ts:616)). And `getDirectoryBytes` shells to `du -sk`, which reports *allocated* blocks — so CoW clones read near-zero, not "full apparent size". Surface clones with a "cloned / shared" badge rather than hiding them.
- **CoW `node_modules` lands inside the chokidar-watched tree** for the first time in KIT's history. Verify and state that `WatcherService`'s ignore config excludes it, or every session's initial scan walks ~200k extra files × 20.
- Shared-mutable rungs (2, 5, 6) mean `npm install` mutates the user's main repo — warn in the agent instructions and badge it. Lockfile mismatch sets `stale` and instructs `npm ci`; **never auto-install**.

**Why not a warm pool:** it fights the branch-per-session identity model (directory named after the branch; reuse, `BRANCH_IN_USE`, and the watcher's repo-derivation regex all key on that name); recycling with `git reset --hard` inside a directory a previous agent may still have live processes in is strictly more dangerous than deleting; and it optimises the cheap half — `git worktree add` is ~1.5s, `node_modules` is the cost.

**M5 — `kit_restart_session`, `kit_adopt_session`, `kit_update_session`, `kit_extend_session`.**

- **Restart** must pass `teardownSession(id, { unbindMcp: false })`. Otherwise H2 unregisters the current id *and every predecessor alias* before `aliasOldSessionInBinder` re-adds them ([:3063-3066](electron/services/AgentInstanceService.ts:3063)) — any in-flight `kit_commit` in that window gets "Unknown session", and if the create half fails the break is permanent. Also routes the restart-path watcher compose through the orchestrator, closing the second compose site S1 left open. Must specify what happens to **children** of a restarted parent (answer: `expandSessionAliases` covers them; assert it).
- **Adopt** stamps `createdBy: 'adopted'` — **never** `'mcp'`. Otherwise an agent adopts a human's branch and then legally deletes its worktree, punching straight through the epic's central fail-safe. `if_exists: 'take_over'` is restricted to `createdBy:'mcp'` only. Must state whether it runs `initializeKanvasDirectory` and `setupAgentEnvironment` on the adopted worktree (recommendation: initialise the KIT dir, **do not** run `setupAgentEnvironment` — it would clobber whatever the human has; write `.agent-config` only if absent).
- **Update** changes `base_branch`, `task`, `auto_commit`, `rebase_frequency`, `ttl_minutes`, `system_prompt`, and must state its side effects: `rebase_frequency` starts/stops `RebaseWatcherService`, `auto_commit` starts/stops the file watcher. `branch_name` is deliberately not updatable — renaming a branch under a live worktree, watcher, binder entry and session file has no safe implementation.
- **`kit_extend_session`** — the ninth tool, which the first draft introduced in the reaper section with no story. Defined here; overlaps `kit_update_session(ttl_minutes)`, so make it an alias with a cap of one 4h extension **per window**, every extension logged.

**Multi-repo sessions are out of scope for the MCP surface** — `kit_start_session` has no `multi_repo` param, though the close path handles multi-repo teardown.

**Slice 2 order:** `A1 → A2 → A3 → A4 → M5 → A5`

---

# Slice 3 — Reaper and the riskier hygiene

**R1 — `reapExpiredAgentSessions()`.** A **new** reaper, not an extension of `checkForStaleSessions` ([electron/index.ts:105-200](electron/index.ts:105)), which is wrong on five axes: runs once at startup ([:320](electron/index.ts:320)), 14-day TTL ([:103](electron/index.ts:103)), mtime liveness ([:133](electron/index.ts:133)), skips `active`/`initializing` ([:120](electron/index.ts:120)), skips no-distinct-worktree sessions ([:125](electron/index.ts:125)) — which excludes every observer.

**Scope: only `createdBy === 'mcp'`, and only non-terminal statuses.** The status set was undefined in the first draft and the two readings are opposite: if the reaper considers `'closed'` sessions it deletes the worktrees that a SAFE close deliberately retained — destroying the entire point of the safe default, four hours later, silently. It must not. A retained worktree is cleaned only by the 14-day `checkForStaleSessions` scan or by the user via R3a's filter.

**TTL: 240 min idle + 24h hard ceiling.** Liveness resets on every MCP tool call, so "thinking hard" only trips it after four hours of total silence.

**Liveness = max of:** `MAX(timestamp) FROM mcp_calls` **over `expandSessionAliases(id)`** — otherwise a session that survived a restart is reaped for its new id having no history; `MAX(timestamp) FROM activity_logs`; worktree mtime as a floor. **Add a composite `(session_id, timestamp)` index** — the existing indexes ([:199-200](electron/services/DatabaseService.ts:199)) are single-column, so the "one indexed `MAX()`" claim needed a schema change to be true. Explicitly **not** heartbeats: `HeartbeatService.startMonitoring`/`stopMonitoring` have zero callers and `WorkerBridgeService.startHeartbeatMonitor` is only reachable from the dead one — heartbeat liveness is not running today.

**Grace period:** never reap younger than `max(10 min, TTL)` from `createdAt`.

**Re-entrancy guard + the right safety check.** Not `getDeleteSafetyInfo` (two 15s fetches + an untimed `ls-remote`; 20 candidates could exceed the 5-minute interval and overlap passes). Add an in-flight boolean.

> **CORRECTED DURING IMPLEMENTATION — `getWorktreeSafetyInfo` is unsafe here.** This section originally said to use it. It compares HEAD against a hardcoded `main` and `development`, both wrapped in a swallow-all `safe()`. On a repo whose primary branch is `trunk` or `master` **both comparisons fail silently** and it returns `unmergedCommitCount: 0` with `mergedIntoBranches: ['main','development']` — a branch full of unmerged work presented as clean and fully merged. Verified against a real repo holding a real unmerged commit, and pinned as a regression test in `ReapSafetyInfo.test.ts`.
>
> That is survivable for the dialog it feeds, where a human reads the result. It is **not** survivable for the reaper, which would have read it as authorisation to delete the worktree *and* the local branch — the exact "clean + merged ⇒ delete" rule below.
>
> Implemented instead as `GitService.getReapSafetyInfo(worktreePath, baseBranch)`, which compares against the session's **own recorded base branch** and returns `conclusive: false` when the comparison cannot be made. An inconclusive result never authorises deletion; a failed probe is inconclusive, never clean.

**On expiry — safe by default:** observer → full delete; clean+merged worktree session → `deleteInstanceWithCleanup({deleteWorktree, deleteLocalBranch})`, **never** `deleteRemoteBranch`; uncommitted/unmerged → snapshot ref + status `closed` + teardown, **no delete**; `worktreeStatus:'failed'` → teardown only, never git-touch.

*AC:* (a) `createdBy:'ui'` idle 48h is not reaped; (b) a `createdBy:'mcp'` session safe-closed with a retained worktree is not reaped; (c) a session whose only liveness is an `mcp_calls` row under a **predecessor** id is not reaped; (d) two overlapping passes never both call `deleteInstanceWithCleanup` for the same id.

**R2 — Expiry UX.** `AGENT_SESSIONS_EXPIRED` channel beside `STALE_SESSIONS_FOUND` ([shared/ipc-channels.ts:203](shared/ipc-channels.ts:203)), dialog modelled on `StaleSessionsDialog.tsx`, per-row Keep / Clean up, plus `instance.pinned` from the session row menu. *(Note: `REQUEST_CHANNELS`/`EVENT_CHANNELS` are **not enforced anywhere** — the only importer is a test, and `STALE_SESSIONS_FOUND` itself is absent from `EVENT_CHANNELS` and works fine. Adding new channels there is documentation, not a requirement.)*

**H3 — Snapshot ref cleanup.** Gate deletion on `deleteWorktree && deleteLocalBranch` — these refs are the only copy of a crashed agent's uncommitted work.

**The `gcOldSnapshots` extension is the dangerous half.** "Drop refs whose sessionId matches no instance" would, on first launch after upgrade, delete a large set of real work: `purgeInstancesOnBranch` deliberately deletes instance records on every restart, so many `refs/kit-autosave/<old-id>` already match no instance. Require **all three**: matches no instance *and no predecessor id*, older than N days, *and* the session branch no longer exists. Also extend it to `refs/kit-idle-end/`, which is never GC'd at all today.

**H4b — 30-day sweep for `commits`/`session_history`.** Sweep only rows matching no instance and no predecessor id; ship the first release in dry-run-log mode.

**H5 — `~/.claude.json` unseed.** Riskiest of the eight. Guards: never touch `config.repoPath`'s entry (the user's own project entry with their history and trust state) — gate on `isKitWorktreePath()` with `confidence:'exact'`; observers never trigger it; serialise every mutation through `KeyedMutex` keyed on the config path, because at fan-out N concurrent read-modify-writes lose entries even with atomic rename. Add a one-time backfill sweep for already-orphaned entries, **gated behind an explicit user action**.

**H6 — LockService unification.** Normalise every lock root to the source repo root; delete the dead `sessionLocks` map that `checkConflicts` never reads; call `cleanupExpiredLocks` from the reaper and `releaseSessionLocks` from `teardownSession`.

**Three consequences to plan for:** (1) *do not* delete orphaned `<worktree>/locks.json` on migration — they hold the auto-locks of sessions running at upgrade time; merge then delete, or leave them inert. (2) After unification all sessions in a repo share one map and one `MAX_LOCKS_PER_REPO = 5000` ceiling ([LockService.ts:45](electron/services/LockService.ts:45)), past which `autoLockFile` **silently no-ops** — raise or partition it. (3) Two sessions touching the same relative path in *different* worktrees becomes a conflict by construction; that is the intent, but at fan-out every repo where two agents touch `package.json` will see it. Needs an allowlist or per-repo opt-out.

---

## Failure modes at 8–20× fan-out

| Risk | Mitigation |
|---|---|
| ~~**`.git/config.lock` contention** on concurrent `git worktree add`~~ — **DISPROVEN, 2026-08-29.** Measured during G1: 40 concurrent `git worktree add` on one repo (git 2.50.1) all succeeded, zero lock errors. The per-repo lock this row prescribed was implemented, measured, and removed — it would have serialised the slow half of fan-out for a hazard that does not reproduce. `packed-refs.lock` contention from concurrent fetch / `branch -D` remains **unmeasured** and should not be assumed either | No lock. If a real failure is ever observed, add bounded retry-with-jitter on `.lock` errors rather than serialising creation |
| **electron-store write amplification + lost updates.** `saveInstances()` synchronously serialises the entire array on the main thread; each record carries multi-KB `instructions` + `prompt`; `createInstance` calls it 2–3× | Coalesce behind a 250ms debounce with a synchronous flush on quit; stop persisting `prompt`/`instructions` (`refreshStoredPrompts` already regenerates them); single writer only (S5) |
| **Disk exhaustion is invisible.** SAFE close *keeps* worktrees, A5 clones `node_modules`, and `node_modules` is a *reclaimable measured* category — so growth is at least visible, but nothing pre-checks free space | Pre-flight `statfs` before `git worktree add` and before cloning; `DISK_SPACE_LOW` error code; "cloned / shared" badge with real block counts |
| **App quit with 12 live sessions.** `app.on('before-quit', async …)` ([electron/index.ts:428](electron/index.ts:428)) — Electron does not await async listeners, so `disposeServices()` races the exit. No session marked closed, MCP server dies mid-request, 12 external agents keep writing with no watcher | `event.preventDefault()` + a bounded 5s drain stamping live MCP sessions `closeReason:'app_quit'`, then `app.exit()`; surface them on next boot |
| **MCP contract does not fully survive a KIT restart.** Predecessor aliasing rescues `kit_commit`, but not: the `mcp{url, rpc_url}` snapshot (the port comes from `detectPort(39100)` and can move), nor a safe-closed session — `registerExistingSessionsWithBinder` skips `status === 'closed'` ([:2300](electron/services/AgentInstanceService.ts:2300)), so its retained worktree becomes MCP-unreachable | Add an endpoint-rediscovery read tool; document the resume path (adopt or restart) and make it work for safe-closed sessions |
| **Startup git storms.** `repairOrphanWorktrees` → `reapOrphanInstances` → `migrateLegacyWorktrees` → orphan scan (1.5s) → stale scan (3s, serial per candidate) → reaper boot pass, all contending on the same repos with 20 retained worktrees | Sequence them behind one queue; stagger |

**Design risks:**

| Risk | Mitigation |
|---|---|
| Observer close deletes the parent's worktree | `worktreePath` undefined **plus** an explicit `isolation === 'observer'` early-return at every destructive site; `SessionReport` type change; ghost-mode-delete AC with an `execaCmd` spy |
| Fan-out creates N sessions in the user's real checkout | `strictWorktree` for `createdBy:'mcp'` — hard-fail + rollback, with `addWorktree` / `provisionWorktree` split so a symlink failure doesn't delete a good worktree |
| Agent closes a human's session | `createdBy` absent ⇒ `'ui'` ⇒ never closable; adopt stamps `'adopted'`; bulk close defaults to `created_by:'mcp'` |
| `kit_lock_file` starts reporting real conflicts (H6) | Own story, own tests, changelog note, allowlist for shared files |
| Partial creation — worktree created but env setup throws | Orchestrator rollback of the *fatal* half only; the best-effort half feeds `warnings[]` |

---

## Verification

> **CORRECTED DURING IMPLEMENTATION — `npm run build` is not a type gate.** Several stories were signed off on the strength of a green build. electron-vite compiles with **esbuild, which strips TypeScript types without checking them**: a clean build proves the code parses and nothing more. Two undeclared properties on `AgentInstance` (`closedAt`, `closeReason`, assigned by `markSessionClosed` in M2) shipped this way, and a `declareFiles` arity change in H6 broke three call sites with the build still green.
>
> The gate is `scripts/typecheck-gate.sh`: it runs `tsc --noEmit` over **both** tsconfigs, strips line numbers, and diffs against a recorded baseline, failing on anything new. Checking only `tsconfig.electron.json` leaves the renderer ungated, which is how those two got in. The project does not type-check cleanly today (~785 errors, mostly `TS7006` implicit-any on pre-`noImplicitAny` code), so a zero-error gate is not reachable without an unrelated cleanup — hence the baseline.


**Unit / integration** (`jest.kanvas.config.cjs`, `tests/kanvas/unit/`): per-story tests above. **`tests/kanvas/integration/McpAgentStory.test.ts` already exists** with its own binder + tool-capture harness — extend it, don't create it. All other named test and component files were verified to exist.

End-to-end story: start → spawn 2 children → close one safely → verify worktree retained and sidebar shows "closed (retained)" → restart KIT → `kit_close_sessions(parent_session_id=<original id>)` still matches → destructive close → assert **zero residue**: no binder entries (including aliases), no watchers, no rebase intervals, no ghost worktrees, no orphan telemetry rows.

**Manual, in the running app** (`npm run dev`), from a Claude Code session with the KIT MCP connected:
1. `kit_start_session(repo_path=<test repo>, task="probe", session_id=<self>)` → session appears in the sidebar, worktree exists, clean `git status`.
2. Edit a file in the returned worktree → the watcher auto-commits. *(This is the regression that catches the watcher-start gap.)*
3. Fire 8 concurrent `kit_start_session` calls at one repo → all 8 succeed, no `.git/config.lock` failures.
4. `kit_close_session(<child>)` with no flags → marked closed, **worktree and branch still on disk**, sidebar shows it as closed not idle.
5. Same with `delete_worktree=true` on a dirty worktree → `DIRTY_REFUSED` with `retry_with`.
6. Repeat step 5 on a **local-only repo** → must not report thousands of unpushed commits.
7. Restart KIT, then `kit_close_sessions(parent_session_id=<original self id>, dry_run=true)` → still matches the children.
8. Toggle the kill switch → `kit_start_session` returns `AGENT_SESSION_CREATION_DISABLED`; `kit_close_session` still works.

**Perf (Slice 2):** time `kit_start_session` on a repo with ~1GB `node_modules` before and after A5 — target <3s end to end on APFS.

---

## Deliverables (before any code)

1. **`pm_artefacts/mcp-session-lifecycle-EPICS-STORIES.md`** — this document as the version-controlled source of truth, matching the existing convention (`epics-stories-2026-01-14.md`, `test-contracts-EPICS-STORIES.md`, `agent-instance-creation-EXECUTE.md`).
2. **Notion page in the SeKondBrain workspace** — mirrored for tracking, with each story (S1, H0–H6, G1–G3, A1–A5, M1–M6, R1–R3a) as a trackable item carrying its slice, acceptance criteria, and test files. I'll locate the right parent page by searching for where the existing KIT/DevOps-Agent project pages live before creating anything, rather than guessing a location.

The markdown file is authoritative; Notion is the tracking mirror. When the spec changes, the file changes first.

---

## Deferred: shared-worktree cohorts

Evaluated at the user's request and excluded. N sessions sharing one worktree, admitted only when their declared file globs do not intersect a live lease, would need:

1. **A path-scoped commit helper on `GitService`.** Every commit path today is `git add -A` over the whole worktree — [GitService.ts:315](electron/services/GitService.ts:315) (`commit`), [:434](electron/services/GitService.ts:434) (`commitWorktree`, its own separate call), plus the watcher's auto-commit [:915](electron/services/WatcherService.ts:915) and idle checkpoint [:757](electron/services/WatcherService.ts:757). *(Path-scoped `git add -- <paths>` does already exist in the conflict-resolution paths — [MergeService.ts:380](electron/services/MergeService.ts:380), [MergeConflictService.ts:517](electron/services/MergeConflictService.ts:517) — so the primitive is proven; what's missing is a commit helper that uses it.)*
2. **A cohort branch.** A worktree has one HEAD, and `checkDivergence` requires it to equal the session's own branch ([tools.ts:458](electron/services/mcp/tools.ts:458), for the primary repo) — so sharing sessions share a branch, losing per-session revert granularity.
3. **A real lease registry** — the declared-file loop does not close today (H6), leases are exact-path with no globs, and the TTL is never enforced.
4. Refcounted worktree teardown, a relaxed divergence guard, and watcher attribution of changed files back to the leasing session.

Item 1 is the blocker: it modifies the path already carrying a pre-commit sanity gate written after a 1120-line truncation reached main. Observer sessions capture most of the value — read-only fan-out at zero disk and zero git risk — for a fraction of the risk. Revisit only if measurement shows many *writing* agents per repo is the real bottleneck.
