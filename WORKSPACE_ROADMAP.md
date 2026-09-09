# Workspace View Roadmap

## Current State Assessment
**Daily utility: 5/10** — good for repo awareness + session creation, but requires leaving the app to answer critical questions (CI status, local stack health, what changed where).

### Critical gaps limiting daily value
1. **No GitHub integration** — no PR/CI status visible
2. **No Docker/local-stack health** — can't see if dev services are healthy
3. **No resource footprint visibility** — large reclaimable disk usage is hidden (Docker images/volumes/build cache, node modules, Python packages, abandoned worktrees)
4. **No task runner** — no visibility into common tasks
5. **Worktrees are problematic by default** — fights Docker hot-reload workflow
6. **No activity/commit timeline** — can't see what happened in each repo without switching

---

## Phase 1 (1–2 weeks): Make current view operationally trustworthy
**Goal:** Workspace becomes reliable for daily scanning.

**Changes:**
- Add repo health signals on cards:
  - last fetch age
  - unpushed commits warning
  - stale branch indicator
- Improve repo sorting presets:
  - "Needs attention" (dirty, behind, failing checks)
  - "Recently active"
- Add bulk actions:
  - open terminal/IDE for selected repos
  - fetch all visible repos
- Add performance hardening for 20+ repos (incremental loading + background refresh)

**Exit criteria:** Open app and identify top 3 repos needing action in <30s.

---
## Priority Track P0 (1–2 weeks): Resource footprint + cleanup intelligence
**Goal:** Surface reclaimable disk waste and make cleanup safe + actionable from the workspace.

**Changes:**
- Add a global **Disk & Cleanup** panel in Workspace view with top-level totals + reclaimable percentages.
- Add dedicated breakdown sections for:
  - Docker images (total + reclaimable %)
  - Docker local volumes (total + unused %)
  - Docker build cache
  - `node_modules` footprint by repo (largest-first)
  - Python package footprint by repo/env (`.venv`, Poetry, pip/venv, Conda)
  - Abandoned/stale Git worktrees (age, size, branch existence)
- Display values in the same format as operational output, for example:
  - `19.88 GiB images (54% of total)`
  - `26.38 GiB local volumes (100% unused)`
  - `21.73 GiB build cache`
- Add safe cleanup actions with preview and expected reclaim:
  - Docker: image/volume/build-cache prune
  - Node: remove `node_modules` for selected repos
  - Python: remove stale virtualenvs/environments
  - Git: prune abandoned worktrees
- Add guardrails:
  - dry-run first (required)
  - explicit confirmation for destructive cleanup
  - operation log for audit/retry visibility

**Exit criteria:** User can identify top disk offenders and reclaim >10 GiB in <5 minutes without dropping to terminal.

---

## Phase 2 (2–3 weeks): GitHub visibility (biggest productivity unlock)
**Goal:** Replace morning GitHub tab sweep.

**Changes:**
- Integrate GitHub token + per-repo mapping
- Show on each repo card:
  - open PR count (your PRs + review requests)
  - latest CI status (pass/fail/running)
  - default-branch protection warnings
- Add repo detail tab for:
  - PR list with direct links
  - CI run history summary

**Exit criteria:** Decide "what to review/fix first" without opening GitHub.

---

## Phase 3 (2–3 weeks): Local dev stack awareness (Docker + task workflow)
**Goal:** Make workspace useful during active coding.

**Changes:**
- Per-repo container/status strip:
  - running/degraded/down
  - quick log tail
- Task runner panel:
  - detect common tasks (`dev:up`, `test`, `lint`)
  - run task with live output
- Surface port conflicts + restart actions

**Exit criteria:** Validate "is my local stack healthy?" from workspace.

---

## Phase 4 (2 weeks): In-place agent mode as default
**Goal:** Remove worktree friction for hot-reload workflows.

**Changes:**
- Default agent creation to **in-place mode**
- Preflight checks before session start:
  - dirty tree notice
  - branch mismatch warning
  - conflict-risk hints
- Keep worktrees as explicit opt-in for isolation use cases

**Exit criteria:** Agent sessions no longer disrupt normal branch/Docker loop.

---

## Phase 5 (2 weeks): Commit/working-tree workflow in workspace
**Goal:** Reduce terminal dependency for common git hygiene.

**Changes:**
- Working tree inspector from repo card
- Stage/unstage + commit compose
- Push status + upstream mismatch indicators
- Quick "sync branch" actions

**Exit criteria:** Common day-to-day repo maintenance is possible from UI.

---

## Phase 6 (1–2 weeks): Senior-engineer control plane layer
**Goal:** Make this the first screen you check each morning.

**Changes:**
- Add **Morning Check** view:
  - repos needing rebase
  - failing CI
  - blocked PRs
  - local stack issues
- Add notification center with actionable alerts
- Add cross-repo activity feed

**Exit criteria:** Workspace answers "what should I do next?" in one glance.

---

## Suggested priority order for your workflow
1. **Priority Track P0 (resource footprint + cleanup)** — immediate operational savings and reduced local-env drift
2. **Phase 2 (GitHub)** — unblock morning review/CI checks
3. **Phase 4 (in-place mode default)** — fix agent/Docker friction
4. **Phase 3 (Docker/task health)** — eliminate Docker Desktop context switch
5. Phase 5 — reduce terminal dependency for git operations
6. Phase 6 — single-pane morning check

---

## Timeline estimate
- Priority Track P0 + Phases 2 + 4 + 3: **8–10 weeks** to go from "context-switch overhead" to "daily driver"
- Full roadmap (P0 + Phases 1–6): **14–16 weeks** to "primary control plane"
