/**
 * Auto-commit safety guard — prevents committing during history-rewriting
 * operations that would silently orphan real work.
 *
 * Root incident: a `git rebase origin/main` picked a stale
 * `WIP: periodic auto-save` commit as its base, leaving HEAD 15 commits
 * behind the real tip. The periodic auto-saver then covered the damage by
 * committing the reverted working tree, so the branch looked "clean" while
 * ~15 commits of work were orphaned in the reflog.
 *
 * These predicates are the first-line defense: the auto-committer MUST
 * check `evaluateAutoCommitGuard` and skip when it returns `blocked`.
 *
 * The service layer runs the fs checks (looking for `.git/rebase-merge`,
 * `.git/rebase-apply`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD`,
 * `.git/BISECT_LOG`, and the history-rewrite lockfile) and passes the
 * results to this pure predicate.
 */

export interface AutoCommitGuardInputs {
  /** `.git/rebase-merge` OR `.git/rebase-apply` exists. */
  midRebase: boolean;
  /** `.git/MERGE_HEAD` exists (a merge is in progress). */
  midMerge: boolean;
  /** `.git/CHERRY_PICK_HEAD` exists. */
  midCherryPick: boolean;
  /** `.git/BISECT_LOG` exists. */
  midBisect: boolean;
  /** `git symbolic-ref --quiet HEAD` failed (detached HEAD). */
  detachedHead: boolean;
  /**
   * A history-rewrite lockfile is present at
   * `<worktreePath>/.kanvas/history-rewrite.lock` (see history-rewrite-lock.ts).
   */
  historyRewriteLocked: boolean;
  /** Optional human-readable reason attached to the lockfile. */
  lockReason?: string;
}

export type AutoCommitGuardKind =
  | 'allowed'
  | 'blocked-mid-rebase'
  | 'blocked-mid-merge'
  | 'blocked-mid-cherry-pick'
  | 'blocked-mid-bisect'
  | 'blocked-detached-head'
  | 'blocked-history-rewrite-lock';

export interface AutoCommitGuardResult {
  allowed: boolean;
  kind: AutoCommitGuardKind;
  message?: string;
}

/**
 * Decide whether an auto-committer may commit now. Any single blocked signal
 * defers auto-commit — the goal is fail-safe, not fail-perfect.
 *
 * Precedence when multiple conditions are true simultaneously:
 *   mid-rebase > mid-merge > mid-cherry-pick > mid-bisect > detached-head
 *   > history-rewrite-lock
 * (the most-severe rewrite operation is reported first).
 */
export function evaluateAutoCommitGuard(
  input: AutoCommitGuardInputs
): AutoCommitGuardResult {
  if (input.midRebase) {
    return {
      allowed: false,
      kind: 'blocked-mid-rebase',
      message:
        'Refusing to auto-commit: a rebase is in progress (.git/rebase-merge or .git/rebase-apply present). Auto-committing during a rebase can silently reset the branch onto a stale commit.',
    };
  }
  if (input.midMerge) {
    return {
      allowed: false,
      kind: 'blocked-mid-merge',
      message:
        'Refusing to auto-commit: a merge is in progress (.git/MERGE_HEAD present).',
    };
  }
  if (input.midCherryPick) {
    return {
      allowed: false,
      kind: 'blocked-mid-cherry-pick',
      message:
        'Refusing to auto-commit: a cherry-pick is in progress (.git/CHERRY_PICK_HEAD present).',
    };
  }
  if (input.midBisect) {
    return {
      allowed: false,
      kind: 'blocked-mid-bisect',
      message: 'Refusing to auto-commit: a bisect is in progress.',
    };
  }
  if (input.detachedHead) {
    return {
      allowed: false,
      kind: 'blocked-detached-head',
      message:
        'Refusing to auto-commit: HEAD is detached. An auto-commit on a detached HEAD would create dangling commits that only exist in the reflog.',
    };
  }
  if (input.historyRewriteLocked) {
    return {
      allowed: false,
      kind: 'blocked-history-rewrite-lock',
      message:
        `Refusing to auto-commit: a history-rewrite operation is in progress` +
        (input.lockReason ? ` (${input.lockReason})` : '') +
        '. The lockfile at .kanvas/history-rewrite.lock will be released when the operation completes.',
    };
  }
  return { allowed: true, kind: 'allowed' };
}
