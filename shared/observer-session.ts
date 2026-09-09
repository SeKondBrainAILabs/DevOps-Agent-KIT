/**
 * Observer sessions (story KIT-MCP-A2).
 *
 * An observer is a real KIT session — own id, status lifecycle, activity log,
 * MCP binding, lineage — that owns NO worktree. It borrows a directory: either
 * another session's worktree, or a plain repo checkout. Every write tool
 * refuses for it.
 *
 * The point is fan-out economics. A large share of subagent work is read-only
 * (explore, review, analyse test output), and giving each of those its own
 * worktree costs a directory, a chokidar watcher, three timer sets and a branch
 * for nothing. An observer costs a map entry.
 *
 * ## The rule that everything else hangs off
 *
 * An observer's `worktreePath` is `undefined`. Never the borrowed path.
 *
 * `deleteInstanceWithCleanup` computes:
 *
 *     worktreePath = instance.worktreePath && instance.worktreePath !== repoPath
 *       ? instance.worktreePath : null
 *
 * and feeds a non-null result to `git worktree remove --force`. If an observer
 * of a worktree session stored the borrowed path there, closing the OBSERVER
 * would destroy the OWNER's worktree and every uncommitted change in it.
 *
 * Leaving it undefined makes that existing expression produce the right answer
 * with no new code — but this module exports an explicit predicate anyway, and
 * the destructive call sites check it. Relying on a path-equality accident to
 * prevent data loss is not a safety property, it is a coincidence.
 */

import { resolveRepoRootFromWorktree } from './worktree-path';

export type SessionIsolation = 'worktree' | 'observer';

export const OBSERVER_BRANCH_PREFIX = 'observer/';

/** Errors an observer request can be refused with. */
export const OBSERVER_ERRORS = {
  MISSING_PATH: 'OBSERVER_PATH_REQUIRED',
  NESTED: 'OBSERVER_OF_OBSERVER_REFUSED',
  CANNOT_SPAWN: 'OBSERVER_CANNOT_SPAWN',
} as const;

export interface ObserverConfigInput {
  /** The directory to borrow — a session's worktree, or a plain checkout. */
  observedPath?: string;
  /** The session whose worktree is being borrowed, when there is one. */
  ownerSessionId?: string;
  /** True when the owner is itself an observer. */
  ownerIsObserver?: boolean;
  /** Short id used to name the synthetic branch. */
  sessionKey?: string;
}

export interface ObserverConfigResult {
  ok: boolean;
  error?: { code: string; message: string; instruction?: string };
  config?: {
    /** The source repo root, so session files never land in the borrowed dir. */
    repoPath: string;
    observedPath: string;
    /** Synthetic. NEVER passed to git — an observer owns no branch. */
    branchName: string;
    isolation: 'observer';
    observerOfSessionId?: string;
  };
}

/** True for a config describing an observer session. */
export function isObserverSession(
  config: { isolation?: SessionIsolation } | undefined | null
): boolean {
  return config?.isolation === 'observer';
}

/**
 * Build the config fragment for an observer, or explain the refusal.
 *
 * `repoPath` resolves to the SOURCE repo root rather than the borrowed
 * directory. That matters because `createSessionFile` and
 * `initializeKanvasDirectory` both write under `config.repoPath`: pointing it
 * at the borrowed path would put KIT's own bookkeeping inside a directory the
 * observer is forbidden to write to — and, when borrowing a plain checkout,
 * would make "writes nothing to the observed directory" impossible to satisfy.
 */
export function deriveObserverConfig(
  input: ObserverConfigInput
): ObserverConfigResult {
  const { observedPath, ownerSessionId, ownerIsObserver, sessionKey } = input;

  if (!observedPath) {
    return {
      ok: false,
      error: {
        code: OBSERVER_ERRORS.MISSING_PATH,
        message:
          'An observer session must borrow a directory. Pass the session whose ' +
          'worktree it should observe, or a repository path.',
      },
    };
  }

  if (ownerIsObserver) {
    return {
      ok: false,
      error: {
        code: OBSERVER_ERRORS.NESTED,
        message:
          'Cannot observe an observer. Observers own nothing to observe, and ' +
          'chaining them would make the borrowed path ambiguous.',
        instruction:
          'Observe the underlying worktree session directly, or the repository.',
      },
    };
  }

  // The borrowed path may be a worktree; the session's own bookkeeping belongs
  // with the source repo either way.
  const resolved = resolveRepoRootFromWorktree(observedPath);
  const repoPath = resolved?.root ?? observedPath;

  const key = (sessionKey ?? Math.random().toString(36).slice(2, 10)).slice(0, 8);

  return {
    ok: true,
    config: {
      repoPath,
      observedPath,
      // Synthetic, and deliberately not in the `<agent>-session-` shape so it
      // can never be mistaken for a real session branch by the base-branch
      // picker. It is never passed to git.
      branchName: `${OBSERVER_BRANCH_PREFIX}${key}`,
      isolation: 'observer',
      observerOfSessionId: ownerSessionId,
    },
  };
}

/**
 * Guard for the destructive paths.
 *
 * Returns true when the operation must be refused because the session owns
 * nothing it could legitimately destroy. Call this BEFORE any `git worktree
 * remove`, `branch -D`, or ref deletion.
 */
export function refuseDestructiveForObserver(config: {
  isolation?: SessionIsolation;
}): boolean {
  return isObserverSession(config);
}

/** An observer may not spawn sessions — see kit_start_session's forbidden set. */
export function observerCannotSpawn(): {
  code: string;
  message: string;
  instruction: string;
} {
  return {
    code: OBSERVER_ERRORS.CANNOT_SPAWN,
    message:
      'This is an observer session. It is read-only and cannot create other ' +
      'sessions.',
    instruction:
      'Ask the orchestrator that created you to start the session you need.',
  };
}
