/**
 * Correct "at-risk unpushed commit" count for the delete-session safety check.
 *
 * The old metric was `git rev-list --count origin/<branch>..<branch>` with NO
 * fetch first. That is wrong for two reasons:
 *
 *   1. It reads the LOCALLY-CACHED `origin/<branch>` ref, which is stale until
 *      a fetch runs.
 *   2. It compares against the branch's OWN remote ref. After a rebase (KIT's
 *      periodic rebase / on-demand rebase), that ref points at pre-rebase
 *      history, so every rebased commit counts as "unpushed" even though the
 *      work is already on the base branch. Observed in the wild: a dialog
 *      warned "322 unpushed commits will be lost" when the true at-risk count
 *      was 1 (a single WIP auto-save) — the other 321 were patch-present on
 *      origin/main.
 *
 * Correct metric: a commit is only truly "at risk" if its PATCH content is
 * present on NEITHER the branch's remote ref NOR the base/integration branch.
 * We compute a patch-equivalence-aware count against each candidate baseline
 * (via `git rev-list --count --cherry-pick --right-only <base>...HEAD`) and
 * take the MINIMUM — because if the work survives on any baseline, deleting
 * the local branch does not lose it.
 */

export interface UnpushedCountInputs {
  /**
   * Patch-equivalence-aware count of HEAD-only commits vs the branch's own
   * remote ref (`origin/<branch>`), or null when that ref doesn't exist.
   */
  vsRemoteBranch: number | null;
  /**
   * Same, but vs the base / integration branch (`origin/<baseBranch>`), or
   * null when it couldn't be computed.
   */
  vsBaseBranch: number | null;
}

/**
 * Resolve the true at-risk count from the two candidate baselines.
 *
 * - Both present → MIN (work is safe if present on either baseline).
 * - One present → that one.
 * - Neither present (brand-new branch with no remote + unknown base) →
 *   fall back to `fallbackTotalCommits` when provided (the raw commit count
 *   on the branch — genuinely all at risk), else 0 (fail-safe-low so we
 *   never fabricate a scary number we can't justify).
 */
export function resolveUnpushedCount(
  input: UnpushedCountInputs,
  fallbackTotalCommits?: number
): number {
  const candidates: number[] = [];
  if (typeof input.vsRemoteBranch === 'number') candidates.push(input.vsRemoteBranch);
  if (typeof input.vsBaseBranch === 'number') candidates.push(input.vsBaseBranch);

  if (candidates.length === 0) {
    return typeof fallbackTotalCommits === 'number' ? Math.max(0, fallbackTotalCommits) : 0;
  }
  return Math.max(0, Math.min(...candidates));
}
