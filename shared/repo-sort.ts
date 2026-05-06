/**
 * Repo Status Card sort comparators (Epic B / story B5).
 *
 * Default sort = last-touched (most recently edited working tree first),
 * tie-broken by most recent commit, then alphabetical name. This is what
 * Karol called out (S14): "default sort = last-touched so Core_Kora floats
 * to the top when I'm working on it."
 *
 * Pure comparators — UI passes its data shape and picks a sort key.
 */

export type RepoSortKey = 'last-touched' | 'alphabetical' | 'size';

export interface RepoSortInputs {
  name: string;
  /** Working-tree mtime (ms since epoch). Drives last-touched sort. */
  workingTreeMtimeMs: number;
  /** Most recent commit timestamp (ms). Used as tie-breaker. */
  lastCommitMs: number;
  /** Total size in bytes. Drives size sort. */
  sizeBytes: number;
}

export const DEFAULT_REPO_SORT_KEY: RepoSortKey = 'last-touched';

export function compareReposByLastTouched(a: RepoSortInputs, b: RepoSortInputs): number {
  // Newer first.
  if (b.workingTreeMtimeMs !== a.workingTreeMtimeMs) {
    return b.workingTreeMtimeMs - a.workingTreeMtimeMs;
  }
  if (b.lastCommitMs !== a.lastCommitMs) {
    return b.lastCommitMs - a.lastCommitMs;
  }
  return a.name.localeCompare(b.name);
}

export function compareReposByAlpha(a: RepoSortInputs, b: RepoSortInputs): number {
  return a.name.localeCompare(b.name);
}

export function compareReposBySize(a: RepoSortInputs, b: RepoSortInputs): number {
  // Largest first.
  if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.name.localeCompare(b.name);
}

export function getRepoComparator(
  key: RepoSortKey
): (a: RepoSortInputs, b: RepoSortInputs) => number {
  switch (key) {
    case 'last-touched':
      return compareReposByLastTouched;
    case 'alphabetical':
      return compareReposByAlpha;
    case 'size':
      return compareReposBySize;
  }
}
