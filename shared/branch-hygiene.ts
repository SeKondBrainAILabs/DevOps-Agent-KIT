/**
 * Branch hygiene classifier (Epic C / story C7).
 *
 * Pure rules for tagging a branch as stale / merged / deleted-on-remote /
 * has-worktree. Used by the Branch Manager Panel (story C1) and the
 * filter chips on the Branch table.
 *
 * The shape is intentionally narrow — callers (GitService, BranchTree, etc.)
 * collect the raw inputs and pass them in.
 */

export interface BranchHygieneInputs {
  /** Branch name. */
  name: string;
  /** Most-recent commit timestamp on the branch (ms since epoch). */
  lastCommitMs: number;
  /** True when the branch is fully merged into the default branch. */
  mergedIntoDefault: boolean;
  /** True when the branch was deleted on the remote (local still exists). */
  deletedOnRemote: boolean;
  /** True when an active worktree references this branch. */
  hasWorktree: boolean;
  /** Whether this is the currently-checked-out branch. */
  isCurrent: boolean;
}

export interface BranchHygieneOptions {
  /** Reference time for staleness (ms since epoch). Defaults to now. */
  now?: number;
  /** Stale threshold in days. Default 30 (matches Karol's spec / S9N stories). */
  staleThresholdDays?: number;
}

export interface BranchHygieneFlags {
  stale: boolean;
  merged: boolean;
  deletedOnRemote: boolean;
  hasWorktree: boolean;
  isCurrent: boolean;
  /** True when the branch is safe to delete (merged, no worktree, not current). */
  safeToDelete: boolean;
}

export const DEFAULT_STALE_THRESHOLD_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function classifyBranch(
  input: BranchHygieneInputs,
  options: BranchHygieneOptions = {}
): BranchHygieneFlags {
  const now = options.now ?? Date.now();
  const thresholdDays = options.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const ageMs = now - input.lastCommitMs;
  const stale = ageMs >= thresholdDays * MS_PER_DAY;

  const safeToDelete =
    input.mergedIntoDefault &&
    !input.hasWorktree &&
    !input.isCurrent;

  return {
    stale,
    merged: input.mergedIntoDefault,
    deletedOnRemote: input.deletedOnRemote,
    hasWorktree: input.hasWorktree,
    isCurrent: input.isCurrent,
    safeToDelete,
  };
}

export type BranchFilterChip =
  | 'all'
  | 'active'
  | 'merged'
  | 'stale'
  | 'deleted-on-remote'
  | 'has-worktree';

/** Apply a filter chip selection to a branch's hygiene flags. */
export function matchesBranchFilter(
  flags: BranchHygieneFlags,
  chip: BranchFilterChip
): boolean {
  switch (chip) {
    case 'all':
      return true;
    case 'active':
      return !flags.merged && !flags.stale && !flags.deletedOnRemote;
    case 'merged':
      return flags.merged;
    case 'stale':
      return flags.stale;
    case 'deleted-on-remote':
      return flags.deletedOnRemote;
    case 'has-worktree':
      return flags.hasWorktree;
  }
}
