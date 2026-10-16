/**
 * When a session may be fast-forwarded to its base branch automatically.
 *
 * A session with no commits of its own that is behind origin/<base> has
 * nothing to rebase — bringing it up to date is a pure fast-forward, which
 * adds commits on top and never rewrites history. So it is done for every
 * session, whatever its rebase setting (including "never", which governs
 * rewriting the session's own work, not catching up a branch that has none).
 *
 * Pure, so the rule is testable without git.
 */

export interface FastForwardInput {
  /** Commits on the session branch that are not on origin/<base>. */
  ahead: number;
  /** Commits on origin/<base> that are not on the session branch. */
  behind: number;
  isRebasing: boolean;
  isPaused: boolean;
  /** HEAD is a branch (not detached) and no rebase/merge is in progress. */
  onBranchAndIdle: boolean;
  /** origin/<base> commit now. */
  remoteHead: string | null;
  /**
   * origin/<base> commit the last refused attempt was against. A refusal
   * (uncommitted edits in the way) is not retried until the remote moves.
   */
  lastRefusedFor: string | null;
}

export function shouldFastForward(i: FastForwardInput): boolean {
  if (i.isRebasing || i.isPaused || !i.onBranchAndIdle) return false;
  if (i.ahead !== 0 || i.behind <= 0) return false;
  if (i.remoteHead && i.lastRefusedFor === i.remoteHead) return false;
  return true;
}
