/**
 * The result of the rebase KIT runs after a commit and before the push
 * (WatcherService.attemptPostCommitRebase), and the push it permits.
 */
export interface PostCommitRebaseResult {
  /** false: the rebase failed and the branch was left as it was. Do not push. */
  ok: boolean;
  /** true: a rebase ran, succeeded and replayed commits, so the push needs force-with-lease. */
  rewrote: boolean;
  /** true: no rebase was attempted (rebaseFrequency 'never', an MCP session, no worktree). */
  skipped?: boolean;
  commitsIntegrated: number;
  baseBranch?: string;
  /** Human-readable summary for the activity feed / agent response. */
  message: string;
  /** When ok=false because of conflicts or a rejected AI resolution. */
  conflictFiles?: string[];
}

/** Whether a commit may be pushed after its post-commit rebase. */
export function mayPushAfterPostCommitRebase(result: PostCommitRebaseResult | undefined): boolean {
  return !result || result.ok;
}

/**
 * Push options after a post-commit rebase. Force-with-lease only when a rebase
 * actually ran, succeeded and rewrote history; a skipped or failed rebase
 * never leads to a force-push.
 */
export function postCommitPushOptions(
  result: PostCommitRebaseResult | undefined,
): { forceWithLease: true } | undefined {
  if (!result || !result.ok || result.skipped || !result.rewrote) return undefined;
  return { forceWithLease: true };
}
