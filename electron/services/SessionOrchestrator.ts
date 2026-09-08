/**
 * SessionOrchestrator — the single funnel for session lifecycle.
 *
 * ## Why this exists
 *
 * "Create a session" is currently split across two layers, and "close a
 * session" does not exist at all:
 *
 *   - `AgentInstanceService.createInstance()` performs twelve side effects
 *     (validation, guards, worktree creation, session file, agent environment,
 *     MCP binder registration, ...) but does NOT start the file watcher.
 *   - Three separate IPC sites start the watcher instead: create
 *     (`ipc/index.ts:407`), restart (`:495`), and startup rehydration
 *     (`:1639` / `:1685`).
 *
 * Any caller that is not one of those three gets a session where auto-commit
 * silently never runs. That is exactly the trap an MCP `kit_start_session`
 * would fall into, and it is invisible until someone notices a session that
 * never commits.
 *
 * The orchestrator owns the compose step so neither the IPC layer nor the MCP
 * tool layer reimplements it. Later stories add their own methods here:
 * `teardownSession` (H1), `closeSession` (M2), `closeSessions` (M3),
 * `getSessionStatus` (M4), `restartSession` / `adoptSession` /
 * `updateSession` (M5), `reapExpiredAgentSessions` (R1).
 *
 * ## Why the deps are injected
 *
 * jest cannot import `AgentInstanceService`: it pulls in `electron-store`,
 * which is ESM and untransformed, so the import throws "Cannot use import
 * statement outside a module". That is why the existing
 * `AgentInstanceService.test.ts` exercises the `window.api` mock surface
 * rather than the class itself.
 *
 * If this module statically imported the concrete services it would inherit
 * the same untestability — and it is on the critical path for every session
 * the app creates. So it takes narrow structural interfaces and uses
 * `import type` only, which is erased at compile time. This mirrors the
 * `McpServiceDeps` shim already established at `McpServerService.ts:58`.
 */

import type {
  AgentInstance,
  AgentInstanceConfig,
  AgentType,
  IpcResult,
} from '../../shared/types';
import {
  evaluateClosePermission,
  type SessionOrigin,
} from '../../shared/session-close-permission';
import {
  evaluateReapCandidate,
  planReapAction,
  DEFAULT_REAP_POLICY,
  type ReapCandidate,
  type ReapPolicy,
  type ReapAction,
  type MergeSafety,
} from '../../shared/session-reap';

/** The slice of AgentInstanceService the orchestrator needs. */
export interface OrchestratorAgentInstanceService {
  createInstance(config: AgentInstanceConfig): Promise<IpcResult<AgentInstance>>;
  listInstances(): IpcResult<AgentInstance[]>;
  markSessionClosed(
    sessionId: string,
    opts?: { reason?: string; closedBy?: string }
  ): IpcResult<void>;
  getDeleteSafetyInfo(sessionId: string, hints?: unknown): Promise<IpcResult<any>>;
  deleteInstanceWithCleanup(
    sessionId: string,
    options: {
      deleteWorktree?: boolean;
      deleteLocalBranch?: boolean;
      deleteRemoteBranch?: boolean;
    },
    hints?: unknown
  ): Promise<IpcResult<void>>;
  /**
   * Stamp `reapedAt` so a later pass does not reconsider a session it already
   * acted on — the reaper's own idempotence marker, independent of status.
   */
  markSessionReaped?(sessionId: string, action: string): IpcResult<void>;
  restartInstance?(
    sessionId: string,
    sessionData?: {
      repoPath: string;
      branchName: string;
      baseBranch?: string;
      worktreePath?: string;
      agentType?: AgentType;
      task?: string;
    },
    commitChanges?: boolean
  ): Promise<IpcResult<AgentInstance>>;
  /** Apply a validated config patch to a live session (M5). */
  updateSessionConfig?(
    sessionId: string,
    patch: Record<string, unknown>
  ): Promise<IpcResult<void>>;
}

export interface CloseSessionOptions {
  reason?: string;
  deleteWorktree?: boolean;
  deleteLocalBranch?: boolean;
  deleteRemoteBranch?: boolean;
  /** Proceed despite uncommitted changes. Destroys work. */
  forceDirty?: boolean;
  /** Proceed despite commits not present on the remote. Destroys work. */
  forceUnpushed?: boolean;
  allowForeign?: boolean;
  callerSessionId?: string;
}

export interface CloseSelector {
  sessionIds?: string[];
  parentSessionId?: string;
  includeDescendants?: boolean;
  repoPath?: string;
  createdBy?: 'ui' | 'mcp' | 'adopted' | 'any';
  status?: string[];
  olderThanMinutes?: number;
  excludeSessionIds?: string[];
  limit?: number;
  dryRun?: boolean;
}

export interface BulkCloseResult {
  dryRun: boolean;
  matched: number;
  hasMore: boolean;
  closed: Array<{ sessionId: string; branch?: string; worktreeDeleted: boolean }>;
  skipped: Array<{ sessionId: string; reasonCode: string }>;
  failed: Array<{ sessionId: string; errorCode: string; message: string }>;
}

export interface CloseResult {
  sessionId: string;
  alreadyClosed: boolean;
  previousStatus?: string;
  actions: TeardownActions & {
    statusSet?: string;
    worktreeDeleted: boolean;
    localBranchDeleted: boolean;
    remoteBranchDeleted: boolean;
  };
  preserved?: {
    worktreePath?: string;
    branch?: string;
    uncommittedChanges?: boolean;
    unpushedCommits?: number;
  };
}

/** The slice of WatcherService the orchestrator needs. */
export interface OrchestratorWatcherService {
  startWithPath(
    sessionId: string,
    worktreePath: string,
    agentType?: AgentType,
    branchName?: string
  ): Promise<IpcResult<void>>;
  /**
   * Stops every watcher for a session, including the multi-repo compound keys
   * `<sessionId>:<repoName>`. Always prefer this over `stop()` — it already
   * handles the single-key case, so there is no conditional to get wrong.
   */
  stopAll(sessionId: string, releaseLocks?: boolean): Promise<IpcResult<void>>;
}

/** The slice of RebaseWatcherService the orchestrator needs. */
export interface OrchestratorRebaseWatcherService {
  stopWatching(sessionId: string): Promise<IpcResult<void>>;
  startWatching?(config: {
    sessionId: string;
    repoPath: string;
    worktreePath?: string;
    baseBranch: string;
    currentBranch: string;
    rebaseFrequency: string;
    pollIntervalMs: number;
  }): Promise<IpcResult<void>>;
}

/** The slice of McpSessionBinder the orchestrator needs. */
export interface OrchestratorSessionBinder {
  unregisterSession(kitSessionId: string): void;
}

/**
 * What the reaper needs on top of the normal lifecycle deps (R1).
 *
 * Optional so every existing construction of the orchestrator keeps compiling;
 * `reapExpiredAgentSessions` refuses to run rather than half-run when it is
 * absent, because a reaper that silently no-ops is worse than one that errors.
 */
export interface OrchestratorReapDeps {
  /**
   * Most recent liveness timestamp across ALL the given session ids, or null.
   * The caller passes every alias, so a session that survived a restart is
   * judged on its predecessors' history too.
   */
  getLastActivityAt(sessionIds: string[]): Promise<string | null>;
  /**
   * Local, network-free safety probe. MUST distinguish "zero commits ahead"
   * from "the comparison could not be made" — see GitService.getReapSafetyInfo.
   */
  getReapSafetyInfo(
    worktreePath: string,
    baseBranch: string | undefined
  ): Promise<IpcResult<{
    conclusive: boolean;
    hasUncommittedChanges: boolean;
    unmergedCommitCount: number;
    inconclusiveReason?: string;
  }>>;
  createSnapshot(
    worktreePath: string,
    sessionId: string
  ): Promise<IpcResult<{ sha: string; refName: string } | null>>;
}

export interface SessionOrchestratorDeps {
  agentInstance: OrchestratorAgentInstanceService;
  watcher: OrchestratorWatcherService;
  rebaseWatcher: OrchestratorRebaseWatcherService;
  binder: OrchestratorSessionBinder;
  reap?: OrchestratorReapDeps;
}

export interface ReapPassOptions {
  now?: Date;
  policy?: ReapPolicy;
  /** Evaluate and report, change nothing. */
  dryRun?: boolean;
}

export interface ReapPassResult {
  dryRun: boolean;
  /** True when another pass was already running and this one declined. */
  skippedBecauseRunning?: boolean;
  scanned: number;
  reaped: Array<{
    sessionId: string;
    action: ReapAction;
    reasonCode: string;
    detail: string;
    idleMinutes: number;
    snapshotRef?: string;
    worktreeDeleted: boolean;
    localBranchDeleted: boolean;
  }>;
  skipped: Array<{ sessionId: string; reasonCode: string }>;
  failed: Array<{ sessionId: string; message: string }>;
}

export interface TeardownOptions {
  /**
   * Unregister the session from the MCP binder. Defaults to true.
   *
   * The restart path passes `false`. Restart tears down first, then re-aliases
   * the OLD session id onto the NEW worktree (`aliasOldSessionInBinder`,
   * `AgentInstanceService:2274`). Unbinding in between opens a window where the
   * old id resolves to nothing — any in-flight `kit_commit` from a subagent
   * launched with that id gets "Unknown session", and if the createInstance
   * half then fails the break is permanent, because the re-alias never runs.
   */
  unbindMcp?: boolean;
}

/** What a teardown actually managed to do. */
export interface TeardownActions {
  watchersStopped: boolean;
  rebaseWatcherStopped: boolean;
  mcpUnregistered: boolean;
  aliasesUnregistered: number;
  errors: Array<{ step: string; message: string }>;
}

export class SessionOrchestrator {
  constructor(private readonly deps: SessionOrchestratorDeps) {}

  /**
   * Create a session and bring up everything that has to run alongside it.
   *
   * Behaviourally identical to what `IPC.INSTANCE_CREATE` did inline before
   * this story, including three details that are easy to "improve" by
   * accident:
   *
   *   1. The watcher is fire-and-forget. Awaiting it would make session
   *      creation wait on a filesystem scan, and would turn a watcher failure
   *      into a creation failure.
   *   2. The rejection is swallowed with a warn, for the same reason.
   *   3. `worktreePath` falls back to `config.repoPath`, because
   *      `createWorktreeIfNeeded` silently returns the repo path when worktree
   *      creation fails.
   *
   * KNOWN, DELIBERATELY PRESERVED: `startWithPath` accepts
   * `(sessionId, worktreePath, agentType = 'custom', branchName?)`, and only
   * the first two are passed. Every session therefore auto-locks as agent type
   * 'custom' regardless of the real agent, and `branchName` is always
   * undefined. The config carries both values and passing them would be a
   * genuine improvement — but it would change what `LockService.autoLockFile`
   * records, and this story's acceptance criterion is byte-identical
   * behaviour. Tracked separately.
   */
  async startSession(config: AgentInstanceConfig): Promise<IpcResult<AgentInstance>> {
    const result = await this.deps.agentInstance.createInstance(config);

    // An observer must NEVER get a file watcher. It borrows someone else's
    // directory, so a watcher would auto-commit the OWNER's uncommitted work
    // onto the owner's branch under the observer's session id — a second
    // writer on a tree that already has one.
    const isObserver =
      (config as { isolation?: string }).isolation === 'observer';

    if (!isObserver && result.success && result.data?.sessionId) {
      const watchPath = result.data.worktreePath || config.repoPath;
      this.deps.watcher
        .startWithPath(result.data.sessionId, watchPath)
        .catch((err: unknown) => {
          console.warn(
            '[SessionOrchestrator] Failed to start watcher for new session:',
            err
          );
        });
    }

    return result;
  }

  /**
   * Stop every per-session background resource. Best-effort and idempotent.
   *
   * Three leaks are closed by having exactly one implementation of this:
   *
   *   - The delete paths called the exact-key `watcher.stop()`, which does not
   *     match the multi-repo compound keys `<sessionId>:<repoName>`, so an
   *     N-repo session leaked N-1 chokidar watchers on every close.
   *     `stopAll` matches both shapes.
   *   - No delete path stopped `RebaseWatcherService`, so every deleted
   *     session left a 60-second `setInterval` polling git for the life of the
   *     process. At fan-out that is the CPU leak that gets noticed first.
   *   - Doing it in four places meant a fifth caller (the MCP close path) would
   *     have had to remember all of it.
   *
   * Each step is caught individually: a session whose rebase watcher throws
   * must still get its file watchers stopped. Failures are reported rather
   * than swallowed, so `kit_close_session` (M2) can tell the calling agent what
   * actually happened instead of claiming a clean teardown that never was.
   *
   * NOTE: file locks are released as a side effect of `watcher.stop()`, but
   * only when a watcher is actually running — `stop()` returns early at
   * `WatcherService:383` when the session has none. Releasing locks for a
   * watcher-less session is leak 8c and belongs to H6, not here.
   */
  async teardownSession(
    sessionId: string,
    opts: TeardownOptions = {}
  ): Promise<TeardownActions> {
    const { unbindMcp = true } = opts;
    const actions: TeardownActions = {
      watchersStopped: false,
      rebaseWatcherStopped: false,
      mcpUnregistered: false,
      aliasesUnregistered: 0,
      errors: [],
    };

    const step = async (
      name: string,
      run: () => Promise<IpcResult<void>>
    ): Promise<boolean> => {
      try {
        const result = await run();
        // The services wrap everything and return IpcResult rather than
        // throwing, so a falsy `success` is the common failure shape.
        if (result && result.success === false) {
          actions.errors.push({
            step: name,
            message: result.error?.message ?? 'unknown error',
          });
          return false;
        }
        return true;
      } catch (err) {
        actions.errors.push({
          step: name,
          message: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    };

    actions.watchersStopped = await step('watchers', () =>
      this.deps.watcher.stopAll(sessionId)
    );
    actions.rebaseWatcherStopped = await step('rebaseWatcher', () =>
      this.deps.rebaseWatcher.stopWatching(sessionId)
    );

    if (unbindMcp) {
      // Unregister every id this session answers to, not just the current one.
      // `registerExistingSessionsWithBinder` gives each predecessor its own
      // binder entry (AgentInstanceService:2317), so clearing only the live id
      // leaves working aliases behind and kit_commit under an old id would
      // still resolve to a session the user has closed.
      //
      // Computed here rather than after deletion because every IPC path calls
      // teardownSession BEFORE deleteInstance, so the record is still present.
      actions.mcpUnregistered = await step('mcpBinder', async () => {
        const aliases = this.expandSessionAliases(sessionId);
        for (const alias of aliases) {
          this.deps.binder.unregisterSession(alias);
        }
        actions.aliasesUnregistered = aliases.length;
        return { success: true };
      });
      if (!actions.mcpUnregistered) actions.aliasesUnregistered = 0;
    }

    return actions;
  }

  /**
   * Map an instance id OR a session id to the session id.
   *
   * `IPC.INSTANCE_DELETE` receives an `instanceId` and passed it straight to
   * `watcher.stop()`, but watchers are keyed by `sessionId` and the two id
   * spaces can never collide (`inst_…` vs `sess_…`,
   * `AgentInstanceService:590-591`). That call has therefore always matched
   * nothing, and every session deleted by instance id leaked its watcher.
   *
   * Returns `undefined` when the id matches no live instance, so callers can
   * distinguish "nothing to tear down" from "tear down the wrong thing".
   */
  resolveSessionId(instanceOrSessionId: string): string | undefined {
    const match = this.listSessions().find(
      (inst) =>
        inst.id === instanceOrSessionId || inst.sessionId === instanceOrSessionId
    );
    return match?.sessionId;
  }

  /**
   * Close a session. SAFE by default.
   *
   * A safe close stops everything running, unbinds MCP, marks the record
   * closed, and KEEPS the worktree and branch. It performs zero git or network
   * I/O — the safety check that costs two 15s fetches plus an untimed
   * `ls-remote` only runs when a destructive flag is actually set.
   *
   * Destructive flags are gated separately: `forceDirty` covers uncommitted
   * changes, `forceUnpushed` covers commits missing from the remote. One
   * combined `force` would be too blunt, because those are different risks —
   * discarding edits you can still see versus discarding commits you cannot.
   */
  async closeSession(
    sessionId: string,
    opts: CloseSessionOptions = {}
  ): Promise<IpcResult<CloseResult>> {
    const destructive = Boolean(
      opts.deleteWorktree || opts.deleteLocalBranch || opts.deleteRemoteBranch
    );

    const instance = this.listSessions().find(
      (i) =>
        i.sessionId === sessionId ||
        (Array.isArray(i.predecessorSessionIds) &&
          i.predecessorSessionIds.includes(sessionId))
    );

    // Permission is evaluated even for an unknown session: a caller must not be
    // able to probe for ids it has no business touching.
    const permission = evaluateClosePermission({
      target: {
        sessionId: instance?.sessionId ?? sessionId,
        createdBy: (instance?.config as { createdBy?: SessionOrigin })?.createdBy,
      },
      callerSessionId: opts.callerSessionId,
      callerDescendantIds: opts.callerSessionId
        ? this.descendantSessionIds(opts.callerSessionId)
        : [],
      allowForeign: opts.allowForeign,
      destructive,
    });
    if (!permission.allowed) {
      return { success: false, error: permission.error };
    }

    const previousStatus = instance?.status as string | undefined;
    const alreadyClosed = previousStatus === 'closed';

    // Teardown is idempotent, so a second close still reconciles anything that
    // survived the first — a stray watcher, a binder alias.
    const teardown = await this.teardownSession(instance?.sessionId ?? sessionId);

    const actions = {
      ...teardown,
      statusSet: undefined as string | undefined,
      worktreeDeleted: false,
      localBranchDeleted: false,
      remoteBranchDeleted: false,
    };

    if (instance && !alreadyClosed) {
      const marked = this.deps.agentInstance.markSessionClosed(instance.sessionId!, {
        reason: opts.reason,
        closedBy: opts.callerSessionId,
      });
      if (marked.success) actions.statusSet = 'closed';
      else actions.errors.push({ step: 'markClosed', message: marked.error?.message ?? 'failed' });
    }

    const preserved = {
      worktreePath: instance?.worktreePath,
      branch: instance?.config?.branchName,
    } as CloseResult['preserved'];

    if (!destructive) {
      return {
        success: true,
        data: {
          sessionId: instance?.sessionId ?? sessionId,
          alreadyClosed,
          previousStatus,
          actions,
          preserved,
        },
      };
    }

    // ── Destructive path: gate on real work before removing anything ──────
    const safety = await this.deps.agentInstance.getDeleteSafetyInfo(
      instance?.sessionId ?? sessionId
    );
    const info: any = safety?.data ?? {};

    if (info.hasUncommittedChanges && opts.deleteWorktree && !opts.forceDirty) {
      return {
        success: false,
        error: {
          code: 'DIRTY_REFUSED',
          message:
            'The worktree has uncommitted changes. Commit them with kit_commit, or ' +
            'retry with force_dirty: true to discard them.',
          details: { ...info, retry_with: { force_dirty: true } },
        } as any,
      };
    }

    // A repo with no remote reports its ENTIRE history as unpushed:
    // getDeleteSafetyInfo falls back to `git rev-list --count HEAD` when
    // neither origin/<branch> nor origin/<base> resolves. Gating on that would
    // make every destructive close on a local-only repo impossible.
    const hasRemote = info.hasRemoteBranch !== false || info.unpushedCommitCount === 0;
    const unpushed = Number(info.unpushedCommitCount ?? 0);
    const gateUnpushed = opts.deleteLocalBranch || opts.deleteRemoteBranch;

    if (hasRemote && gateUnpushed && unpushed > 0 && !opts.forceUnpushed) {
      return {
        success: false,
        error: {
          code: 'UNPUSHED_REFUSED',
          message:
            `The branch has ${unpushed} commit(s) not present on the remote. ` +
            'Push them first, or retry with force_unpushed: true to discard them.',
          details: { ...info, retry_with: { force_unpushed: true } },
        } as any,
      };
    }

    const cleanup = await this.deps.agentInstance.deleteInstanceWithCleanup(
      instance?.sessionId ?? sessionId,
      {
        deleteWorktree: opts.deleteWorktree,
        deleteLocalBranch: opts.deleteLocalBranch,
        deleteRemoteBranch: opts.deleteRemoteBranch,
      }
    );

    if (cleanup?.success) {
      actions.worktreeDeleted = Boolean(opts.deleteWorktree);
      actions.localBranchDeleted = Boolean(opts.deleteLocalBranch);
      actions.remoteBranchDeleted = Boolean(opts.deleteRemoteBranch);
    } else {
      actions.errors.push({
        step: 'cleanup',
        message: cleanup?.error?.message ?? 'cleanup failed',
      });
    }

    return {
      success: true,
      data: {
        sessionId: instance?.sessionId ?? sessionId,
        alreadyClosed,
        previousStatus,
        actions,
        preserved,
      },
    };
  }

  /**
   * Close many sessions at once — typically everything one orchestrator spawned.
   *
   * Selectors AND together and require a SCOPE ANCHOR (`sessionIds`,
   * `parentSessionId` or `repoPath`). Without one, `{createdBy: 'mcp'}` alone
   * would match every agent session on the machine, which is a very easy thing
   * for an agent to type by accident.
   *
   * `createdBy` defaults to 'mcp' so a bulk close can never sweep up sessions a
   * human created in the UI, even with a broad anchor.
   *
   * Partial failure is normal and reported per session; the batch does not
   * abort. `ok` stays true because the batch did what it could — a false there
   * is reserved for a selector or permission error that produced no work at all.
   */
  async closeSessions(
    selector: CloseSelector,
    opts: CloseSessionOptions = {}
  ): Promise<IpcResult<BulkCloseResult>> {
    const hasAnchor =
      (selector.sessionIds && selector.sessionIds.length > 0) ||
      Boolean(selector.parentSessionId) ||
      Boolean(selector.repoPath);

    if (!hasAnchor) {
      const anyFilter =
        selector.createdBy || selector.status || selector.olderThanMinutes !== undefined;
      return {
        success: false,
        error: {
          code: anyFilter ? 'SELECTOR_TOO_BROAD' : 'NO_SELECTOR',
          message: anyFilter
            ? 'Refusing an unanchored bulk close. Add session_ids, parent_session_id ' +
              'or repo_path — filters alone would match every matching session on the machine.'
            : 'No selector given. Pass session_ids, parent_session_id or repo_path.',
        } as any,
      };
    }

    const createdBy = selector.createdBy ?? 'mcp';
    const limit = selector.limit ?? 50;
    const exclude = new Set(selector.excludeSessionIds ?? []);
    // A caller never closes itself in a bulk sweep — it would tear down the
    // session issuing the request half way through.
    if (opts.callerSessionId) exclude.add(opts.callerSessionId);

    // Alias-expand the anchors. A child spawned before its parent restarted
    // still carries the parent's OLD id, so matching the live id alone would
    // return nothing — which is exactly the call this epic is built around.
    const explicit = new Set<string>();
    for (const id of selector.sessionIds ?? []) {
      for (const alias of this.expandSessionAliases(id)) explicit.add(alias);
    }

    const subtree = selector.parentSessionId
      ? new Set(
          selector.includeDescendants === false
            ? this.directChildSessionIds(selector.parentSessionId)
            : this.descendantSessionIds(selector.parentSessionId)
        )
      : undefined;

    const now = Date.now();
    const candidates = this.listSessions().filter((inst) => {
      const sid = inst.sessionId;
      if (!sid || exclude.has(sid)) return false;
      if (explicit.size > 0 && !explicit.has(sid)) return false;
      if (subtree && !subtree.has(sid)) return false;
      if (selector.repoPath && inst.config?.repoPath !== selector.repoPath) return false;

      const origin = (inst.config as { createdBy?: string })?.createdBy ?? 'ui';
      if (createdBy !== 'any' && origin !== createdBy) return false;

      if (selector.status && !selector.status.includes(inst.status as string)) return false;

      if (selector.olderThanMinutes !== undefined) {
        const age = (now - new Date(inst.createdAt).getTime()) / 60000;
        if (age < selector.olderThanMinutes) return false;
      }
      return true;
    });

    const result: BulkCloseResult = {
      dryRun: Boolean(selector.dryRun),
      matched: candidates.length,
      // Surfaced explicitly rather than truncating silently: at a fan-out of
      // 200 an orchestrator cannot otherwise tell "all done" from "capped".
      hasMore: candidates.length > limit,
      closed: [],
      skipped: [],
      failed: [],
    };

    const batch = candidates.slice(0, limit);
    for (const inst of candidates.slice(limit)) {
      result.skipped.push({ sessionId: inst.sessionId!, reasonCode: 'LIMIT_REACHED' });
    }

    if (selector.dryRun) {
      for (const inst of batch) {
        result.skipped.push({ sessionId: inst.sessionId!, reasonCode: 'DRY_RUN' });
      }
      return { success: true, data: result };
    }

    for (const inst of batch) {
      const sid = inst.sessionId!;
      const one = await this.closeSession(sid, opts);
      if (one.success && one.data) {
        if (one.data.alreadyClosed) {
          result.skipped.push({ sessionId: sid, reasonCode: 'ALREADY_CLOSED' });
        } else {
          result.closed.push({
            sessionId: sid,
            branch: inst.config?.branchName,
            worktreeDeleted: one.data.actions.worktreeDeleted,
          });
        }
      } else {
        result.failed.push({
          sessionId: sid,
          errorCode: one.error?.code ?? 'INTERNAL',
          message: one.error?.message ?? 'close failed',
        });
      }
    }

    return { success: true, data: result };
  }

  /** Direct children only, alias-expanded. */
  directChildSessionIds(sessionId: string): string[] {
    const roots = new Set(this.expandSessionAliases(sessionId));
    const out = new Set<string>();
    for (const session of this.listSessions()) {
      const parent = (session.config as { parentSessionId?: string })?.parentSessionId;
      if (parent && roots.has(parent) && session.sessionId) {
        for (const alias of this.expandSessionAliases(session.sessionId)) out.add(alias);
      }
    }
    return [...out];
  }

  /**
   * Every session id descended from `sessionId`, alias-expanded at each hop.
   *
   * Alias expansion is what keeps this working across a restart: a child
   * created before its parent restarted still carries the parent's OLD id, so
   * matching on the live id alone would miss it.
   */
  descendantSessionIds(sessionId: string): string[] {
    const roots = new Set(this.expandSessionAliases(sessionId));
    const sessions = this.listSessions();
    const found = new Set<string>();

    let frontier = [...roots];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const session of sessions) {
        const parent = (session.config as { parentSessionId?: string })?.parentSessionId;
        if (!parent || !session.sessionId) continue;
        if (!frontier.includes(parent) || found.has(session.sessionId)) continue;
        for (const alias of this.expandSessionAliases(session.sessionId)) {
          found.add(alias);
          next.push(alias);
        }
      }
      frontier = next;
    }

    return [...found];
  }

  /** Every live instance. Empty when the underlying service reports failure. */
  listSessions(): AgentInstance[] {
    const listed = this.deps.agentInstance.listInstances();
    return listed?.success && listed.data ? listed.data : [];
  }

  /**
   * Every session id that refers to the same underlying session.
   *
   * A restart mints a NEW `sessionId` and records the old one on the new
   * instance's `predecessorSessionIds` (written by `recordPredecessor`,
   * `AgentInstanceService:1803`, oldest first). So a single session can be
   * referred to by any id in that chain, and callers receive whichever one the
   * agent happened to be launched with.
   *
   * Resolving from ANY member of the chain — not just the live id — is what
   * keeps `kit_close_sessions(parent_session_id=...)` working after a KIT
   * restart re-ids the parent: children created beforehand still carry the
   * parent's old id. Without this, that call, which the whole epic is built
   * around, matches nothing.
   *
   * An unknown id resolves to `[id]` rather than `[]`, so callers that filter
   * on the result degrade to "just this one" instead of silently matching
   * nothing.
   */
  /**
   * One reaper pass over agent-created sessions (R1).
   *
   * ## What this is not
   *
   * It is not an extension of `checkForStaleSessions`, and it deliberately
   * does not touch what that scan handles. In particular a SAFE-closed session
   * — worktree and branch retained on purpose — is never reaped here. Sweeping
   * those would delete exactly what the safe default promised to keep, hours
   * later and with no human in the loop. Retained worktrees are cleaned up by
   * the 14-day stale scan, or by the user from the expiry dialog.
   *
   * ## Safety posture
   *
   * Every decision defaults to keeping data:
   *   - only `createdBy: 'mcp'`, never a human's or an adopted session
   *   - liveness is resolved across restart aliases, so a session that
   *     survived a restart is not reaped for having no history under its new id
   *   - an inconclusive merge check refuses to delete (see MergeSafety)
   *   - a session whose worktree creation failed is never git-touched at all,
   *     because its "worktree" is the user's real checkout
   *   - the remote is never touched, on any path
   */
  async reapExpiredAgentSessions(
    opts: ReapPassOptions = {}
  ): Promise<ReapPassResult> {
    const { now = new Date(), policy = DEFAULT_REAP_POLICY, dryRun = false } = opts;

    const result: ReapPassResult = {
      dryRun,
      scanned: 0,
      reaped: [],
      skipped: [],
      failed: [],
    };

    // Re-entrancy guard. A pass can take longer than the interval between
    // passes (20 candidates x a git probe each), and two passes racing would
    // both resolve the same session as deletable and both call
    // deleteInstanceWithCleanup on it.
    if (this.reapInFlight) {
      return { ...result, skippedBecauseRunning: true };
    }
    this.reapInFlight = true;

    try {
      const reap = this.deps.reap;
      if (!reap) {
        // Loud rather than a silent no-op: a reaper that quietly does nothing
        // looks identical to a reaper with nothing to do.
        console.warn(
          '[SessionOrchestrator] reapExpiredAgentSessions called without reap deps wired; skipping pass'
        );
        return result;
      }

      const instances = this.listSessions();
      result.scanned = instances.length;

      for (const instance of instances) {
        const sessionId = instance.sessionId;
        if (!sessionId) continue;

        try {
          // Cheap, purely local rejections first, so we only pay for a liveness
          // query on sessions that could actually be reaped.
          const withoutLiveness = this.toReapCandidate(instance, undefined);
          const preVerdict = evaluateReapCandidate(withoutLiveness, now, policy);
          if (
            !preVerdict.expired &&
            preVerdict.reasonCode !== 'STILL_LIVE' &&
            preVerdict.reasonCode !== 'IDLE_TTL_EXCEEDED'
          ) {
            result.skipped.push({ sessionId, reasonCode: preVerdict.reasonCode });
            continue;
          }

          const aliases = this.expandSessionAliases(sessionId);
          const lastActivityAt = (await reap.getLastActivityAt(aliases)) ?? undefined;

          const candidate = this.toReapCandidate(instance, lastActivityAt);
          const verdict = evaluateReapCandidate(candidate, now, policy);
          if (!verdict.expired) {
            result.skipped.push({ sessionId, reasonCode: verdict.reasonCode });
            continue;
          }

          // Resolve the disposition. Observers and failed-worktree sessions
          // never reach git at all.
          let safety: MergeSafety = {
            conclusive: false,
            hasUncommittedChanges: false,
            unmergedCommitCount: 0,
          };
          let inconclusiveReason: string | undefined;

          const needsGit =
            candidate.isolation !== 'observer' && candidate.worktreeStatus !== 'failed';

          if (needsGit) {
            const worktreePath = instance.worktreePath;
            if (!worktreePath) {
              inconclusiveReason = 'session records no worktree path';
            } else {
              const probe = await reap.getReapSafetyInfo(
                worktreePath,
                instance.config?.baseBranch
              );
              if (probe?.success && probe.data) {
                safety = {
                  conclusive: probe.data.conclusive,
                  hasUncommittedChanges: probe.data.hasUncommittedChanges,
                  unmergedCommitCount: probe.data.unmergedCommitCount,
                };
                inconclusiveReason = probe.data.inconclusiveReason;
              } else {
                // A failed probe is inconclusive, never "clean".
                inconclusiveReason =
                  probe?.error?.message ?? 'safety probe failed';
              }
            }
          }

          const plan = planReapAction(candidate, safety);

          if (dryRun) {
            result.reaped.push({
              sessionId,
              action: plan.action,
              reasonCode: verdict.reasonCode,
              detail: inconclusiveReason ?? plan.reason,
              idleMinutes: Math.round(verdict.idleMinutes),
              worktreeDeleted: false,
              localBranchDeleted: false,
            });
            continue;
          }

          // Snapshot BEFORE anything is torn down, and only when we are
          // keeping the worktree — the delete path has already been proven
          // clean, so there is nothing to capture.
          let snapshotRef: string | undefined;
          if (plan.action === 'snapshot-and-close' && instance.worktreePath) {
            const snap = await reap.createSnapshot(instance.worktreePath, sessionId);
            if (snap?.success && snap.data) snapshotRef = snap.data.refName;
          }

          await this.teardownSession(sessionId);

          if (plan.action === 'delete-clean' || plan.action === 'delete-observer') {
            const del = await this.deps.agentInstance.deleteInstanceWithCleanup(sessionId, {
              deleteWorktree: plan.deleteWorktree,
              deleteLocalBranch: plan.deleteLocalBranch,
              deleteRemoteBranch: plan.deleteRemoteBranch,
            });
            if (del && del.success === false) {
              result.failed.push({
                sessionId,
                message: del.error?.message ?? 'delete failed',
              });
              continue;
            }
          } else {
            this.deps.agentInstance.markSessionClosed(sessionId, {
              reason: `reaped: ${verdict.reasonCode.toLowerCase()} (${plan.reason})`,
              closedBy: 'reaper',
            });
            this.deps.agentInstance.markSessionReaped?.(sessionId, plan.action);
          }

          result.reaped.push({
            sessionId,
            action: plan.action,
            reasonCode: verdict.reasonCode,
            detail: inconclusiveReason ?? plan.reason,
            idleMinutes: Math.round(verdict.idleMinutes),
            snapshotRef,
            worktreeDeleted: plan.deleteWorktree,
            localBranchDeleted: plan.deleteLocalBranch,
          });
        } catch (err) {
          // One bad session must not abort the pass.
          result.failed.push({
            sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    } finally {
      // Always released, including on an exception, or a single failure would
      // wedge the reaper for the lifetime of the app.
      this.reapInFlight = false;
    }
  }

  private reapInFlight = false;

  private toReapCandidate(
    instance: AgentInstance,
    lastActivityAt: string | undefined
  ): ReapCandidate {
    return {
      sessionId: instance.sessionId ?? '',
      createdBy: instance.config?.createdBy,
      status: String(instance.status),
      createdAt: instance.createdAt,
      lastActivityAt,
      isolation: instance.config?.isolation,
      worktreeStatus: instance.worktreeStatus,
      pinned: instance.pinned,
      expiresAt: instance.expiresAt,
      reapedAt: instance.reapedAt,
    };
  }

  /**
   * Restart a session (M5).
   *
   * This is the SECOND compose site the S1 story left open: `INSTANCE_RESTART`
   * previously did teardown -> restartInstance -> startWithPath inline, which
   * meant a non-IPC caller restarting a session got one with no watcher and
   * therefore no auto-commit.
   *
   * `unbindMcp: false` is the load-bearing detail and the reason this cannot
   * just reuse the close path. H2 made teardown unregister the session AND
   * every predecessor alias; `restartInstance` re-aliases the old id onto the
   * new worktree a few steps later. Unbinding in between opens a window where
   * the old id resolves to nothing — any in-flight `kit_commit` from a subagent
   * launched with that id fails with "Unknown session", and permanently so if
   * the create half then fails and the re-alias never runs.
   */
  async restartSession(
    sessionId: string,
    sessionData?: {
      repoPath: string;
      branchName: string;
      baseBranch?: string;
      worktreePath?: string;
      agentType?: AgentType;
      task?: string;
    },
    commitChanges = true
  ): Promise<IpcResult<AgentInstance>> {
    const restart = this.deps.agentInstance.restartInstance;
    if (!restart) {
      return {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'restartInstance is not available' },
      };
    }

    await this.teardownSession(sessionId, { unbindMcp: false });

    const result = await restart.call(
      this.deps.agentInstance,
      sessionId,
      sessionData,
      commitChanges
    );

    if (result.success && result.data?.sessionId) {
      // Fire-and-forget, exactly as startSession does: a watcher failure must
      // not turn a successful restart into a failure the caller has to unpick.
      const watchPath = result.data.worktreePath || result.data.config?.repoPath;
      if (watchPath) {
        Promise.resolve(
          this.deps.watcher.startWithPath(result.data.sessionId, watchPath)
        ).catch((err) => {
          console.warn('[SessionOrchestrator] watcher failed to start after restart:', err);
        });
      }
    }

    return result;
  }

  /**
   * Adopt an existing branch/worktree a human already had (M5).
   *
   * `createdBy` is stamped 'adopted', never 'mcp'. That distinction is the
   * whole safety story: `evaluateClosePermission` allows a safe close of an
   * adopted session but refuses a destructive one, so an agent can manage a
   * human's branch without being able to demolish it. Recording 'mcp' here
   * would let an agent adopt any branch and then legally delete its worktree,
   * straight through the epic's central fail-safe.
   */
  async adoptSession(input: {
    repoPath: string;
    branchName: string;
    baseBranch?: string;
    worktreePath?: string;
    agentType?: AgentType;
    task?: string;
    callerSessionId?: string;
    ifExists?: 'refuse' | 'take_over';
  }): Promise<IpcResult<AgentInstance>> {
    const { ifExists = 'refuse' } = input;

    const existing = this.listSessions().find(
      (i) =>
        i.config?.repoPath === input.repoPath &&
        i.config?.branchName === input.branchName &&
        !['closed', 'completed', 'failed'].includes(String(i.status))
    );

    if (existing) {
      if (ifExists !== 'take_over') {
        return {
          success: false,
          error: {
            code: 'BRANCH_IN_USE',
            message: `Session ${existing.sessionId} is already active on '${input.branchName}'.`,
          },
        };
      }
      // take_over is restricted to agent-created sessions. Without this it is
      // a way to seize a human's session: adopt with take_over, then own it.
      if (existing.config?.createdBy !== 'mcp') {
        return {
          success: false,
          error: {
            code: 'NOT_PERMITTED',
            message:
              `Session ${existing.sessionId} on '${input.branchName}' was not created by an agent, ` +
              'so it cannot be taken over. Ask the user to close it first.',
          },
        };
      }
      if (existing.sessionId) {
        await this.teardownSession(existing.sessionId);
        this.deps.agentInstance.markSessionClosed(existing.sessionId, {
          reason: `taken over by ${input.callerSessionId ?? 'an agent'}`,
          closedBy: 'adopt',
        });
      }
    }

    return this.deps.agentInstance.createInstance({
      repoPath: input.repoPath,
      agentType: (input.agentType ?? 'claude') as AgentType,
      taskDescription: input.task ?? 'Adopted session',
      branchName: input.branchName,
      baseBranch: input.baseBranch ?? 'development',
      // The branch and worktree already exist; adoption must not try to create
      // them again. `adoptedWorktreePath` below is what actually prevents that
      // — `createWorktreeIfNeeded` does not consult `useWorktree`.
      useWorktree: Boolean(input.worktreePath),
      autoCommit: true,
      commitInterval: 30,
      rebaseFrequency: 'never',
      systemPrompt: '',
      contextPreservation: '',
      createdBy: 'adopted',
      parentSessionId: input.callerSessionId,
      adoptedWorktreePath: input.worktreePath,
    } as unknown as AgentInstanceConfig);
  }

  /**
   * Change a live session's configuration (M5).
   *
   * `branchName` is deliberately NOT updatable. A live worktree directory, the
   * file watcher's key, the binder entry and the on-disk session report all key
   * on the branch name; renaming one under a running session has no safe
   * implementation, so it is refused rather than half-supported.
   */
  async updateSession(
    sessionId: string,
    patch: {
      taskDescription?: string;
      baseBranch?: string;
      autoCommit?: boolean;
      rebaseFrequency?: string;
      systemPrompt?: string;
      ttlMinutes?: number;
    }
  ): Promise<IpcResult<{ sessionId: string; updated: string[] }>> {
    if ((patch as Record<string, unknown>).branchName !== undefined) {
      return {
        success: false,
        error: {
          code: 'NOT_PERMITTED',
          message:
            'branch_name cannot be changed on a live session — the worktree, watcher, ' +
            'MCP binding and session file all key on it. Close the session and start a new one.',
        },
      };
    }

    const keys = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined
    );
    if (keys.length === 0) {
      return {
        success: false,
        error: { code: 'NO_UPDATES', message: 'No fields to update.' },
      };
    }

    const instance = this.listSessions().find(
      (i) =>
        i.sessionId === sessionId ||
        (Array.isArray(i.predecessorSessionIds) &&
          i.predecessorSessionIds.includes(sessionId))
    );
    if (!instance?.sessionId) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `No session ${sessionId}` },
      };
    }
    const liveId = instance.sessionId;

    const applied = await this.deps.agentInstance.updateSessionConfig?.(liveId, patch);
    if (applied && applied.success === false) return applied as any;

    // Side effects. These are the reason update is a lifecycle operation and
    // not a store write: the two flags each own a background process.
    if (patch.autoCommit !== undefined && patch.autoCommit !== instance.config?.autoCommit) {
      if (patch.autoCommit) {
        const watchPath = instance.worktreePath || instance.config?.repoPath;
        if (watchPath) {
          Promise.resolve(this.deps.watcher.startWithPath(liveId, watchPath)).catch((err) => {
            console.warn('[SessionOrchestrator] watcher failed to start on update:', err);
          });
        }
      } else {
        await this.deps.watcher.stopAll(liveId);
      }
    }

    if (
      patch.rebaseFrequency !== undefined &&
      patch.rebaseFrequency !== instance.config?.rebaseFrequency
    ) {
      if (patch.rebaseFrequency === 'never') {
        await this.deps.rebaseWatcher.stopWatching(liveId);
      } else if (this.deps.rebaseWatcher.startWatching) {
        // Stop first: startWatching on an already-watched session would
        // otherwise stack a second interval.
        await this.deps.rebaseWatcher.stopWatching(liveId);
        await this.deps.rebaseWatcher.startWatching({
          sessionId: liveId,
          repoPath: instance.config?.repoPath ?? '',
          worktreePath: instance.worktreePath,
          baseBranch: patch.baseBranch ?? instance.config?.baseBranch ?? 'development',
          currentBranch: instance.config?.branchName ?? '',
          rebaseFrequency: patch.rebaseFrequency,
          pollIntervalMs: 60_000,
        });
      }
    }

    return { success: true, data: { sessionId: liveId, updated: keys } };
  }

  /**
   * Push a session's expiry out (M5).
   *
   * Capped at one 4-hour extension per window so a runaway agent cannot keep
   * itself alive indefinitely by extending on a loop — which would make the
   * reaper's hard ceiling unreachable. Every extension is recorded.
   */
  async extendSession(
    sessionId: string,
    opts: { minutes: number; now?: Date }
  ): Promise<IpcResult<{ sessionId: string; expiresAt: string; extensionsUsed: number }>> {
    const now = opts.now ?? new Date();
    const MAX_EXTENSION_MINUTES = 240;

    if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'minutes must be a positive number.' },
      };
    }
    if (opts.minutes > MAX_EXTENSION_MINUTES) {
      return {
        success: false,
        error: {
          code: 'EXTENSION_TOO_LONG',
          message: `A single extension is capped at ${MAX_EXTENSION_MINUTES} minutes.`,
        },
      };
    }

    const instance = this.listSessions().find(
      (i) =>
        i.sessionId === sessionId ||
        (Array.isArray(i.predecessorSessionIds) &&
          i.predecessorSessionIds.includes(sessionId))
    );
    if (!instance?.sessionId) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `No session ${sessionId}` },
      };
    }
    const liveId = instance.sessionId;

    // One extension per window: the window being the period the last extension
    // bought. Once it has elapsed, another is allowed.
    const previous = this.extensions.get(liveId);
    if (previous && now.getTime() < previous.windowEndsAt) {
      return {
        success: false,
        error: {
          code: 'EXTENSION_LIMIT_REACHED',
          message:
            'This session has already been extended once in the current window. ' +
            `Another extension is available after ${new Date(previous.windowEndsAt).toISOString()}.`,
        },
      };
    }

    // Extend from the later of now and the current expiry: extending from a
    // deadline already in the past would produce one still in the past.
    const currentExpiry = instance.expiresAt ? Date.parse(instance.expiresAt) : NaN;
    const base = Number.isFinite(currentExpiry)
      ? Math.max(currentExpiry, now.getTime())
      : now.getTime();
    const expiresAt = new Date(base + opts.minutes * 60_000).toISOString();

    const used = (previous?.count ?? 0) + 1;
    this.extensions.set(liveId, { count: used, windowEndsAt: base + opts.minutes * 60_000 });

    const applied = await this.deps.agentInstance.updateSessionConfig?.(liveId, { expiresAt });
    if (applied && applied.success === false) return applied as any;

    console.log(
      `[SessionOrchestrator] session ${liveId} extended by ${opts.minutes}m to ${expiresAt} (extension #${used})`
    );

    return { success: true, data: { sessionId: liveId, expiresAt, extensionsUsed: used } };
  }

  /** Per-session extension bookkeeping for `extendSession`. */
  private extensions = new Map<string, { count: number; windowEndsAt: number }>();

  expandSessionAliases(sessionId: string): string[] {
    const match = this.listSessions().find(
      (inst) =>
        inst.sessionId === sessionId ||
        (Array.isArray(inst.predecessorSessionIds) &&
          inst.predecessorSessionIds.includes(sessionId))
    );

    if (!match?.sessionId) return [sessionId];

    const aliases = new Set<string>([match.sessionId, sessionId]);
    for (const predecessor of match.predecessorSessionIds ?? []) {
      if (predecessor) aliases.add(predecessor);
    }
    return Array.from(aliases);
  }
}
