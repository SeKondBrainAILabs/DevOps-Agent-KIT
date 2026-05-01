/**
 * Multi-repo branch sync visualizer (Epic F / story F4).
 *
 * Karol's S4: when working on Core_Kora / Core_Backend / Core_Kanvas /
 * Core_AI_Backend together, it's easy to forget Backend is on `feat/auth-v2`
 * while Kanvas is still on `development`. This module builds the matrix
 * + flags repos that have diverged from the group's expected branch.
 */

export interface RepoBranchSnapshot {
  /** Display name (e.g. "Core_Kanvas"). */
  repoName: string;
  /** Currently checked-out branch. */
  currentBranch: string;
}

export interface BranchSyncMatrixInputs {
  /** Repos in the group, in display order. */
  repos: ReadonlyArray<RepoBranchSnapshot>;
  /**
   * Branch the group is supposed to be on.
   * If omitted, the matrix uses the *most common* current branch as the
   * implicit expected branch (majority rule).
   */
  expectedBranch?: string;
}

export interface BranchSyncMatrix {
  expectedBranch: string;
  /** All distinct branches in play, in stable insertion order. */
  branches: string[];
  /** rows[repoIndex][branchIndex] = true if that repo is on that branch. */
  rows: boolean[][];
  /** Repos whose currentBranch !== expectedBranch. */
  divergent: RepoBranchSnapshot[];
  /** True when every repo is on expectedBranch. */
  allInSync: boolean;
  /** Suggested action — "Switch all to <branch>" when divergent. */
  suggestion?: string;
}

export function buildBranchSyncMatrix(input: BranchSyncMatrixInputs): BranchSyncMatrix {
  const expected = input.expectedBranch ?? majorityBranch(input.repos);
  const branchSet: string[] = [];
  for (const r of input.repos) {
    if (!branchSet.includes(r.currentBranch)) branchSet.push(r.currentBranch);
  }
  if (!branchSet.includes(expected)) branchSet.unshift(expected); // expected always first

  const rows = input.repos.map((r) =>
    branchSet.map((b) => r.currentBranch === b)
  );
  const divergent = input.repos.filter((r) => r.currentBranch !== expected);
  const allInSync = divergent.length === 0;

  return {
    expectedBranch: expected,
    branches: branchSet,
    rows,
    divergent,
    allInSync,
    suggestion: allInSync ? undefined : `Switch all to "${expected}"`,
  };
}

/** Majority-vote helper: return the most common branch (ties broken by first occurrence). */
export function majorityBranch(repos: ReadonlyArray<RepoBranchSnapshot>): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const r of repos) {
    if (!counts.has(r.currentBranch)) order.push(r.currentBranch);
    counts.set(r.currentBranch, (counts.get(r.currentBranch) ?? 0) + 1);
  }
  if (order.length === 0) return '';
  let best = order[0];
  let bestCount = counts.get(best) ?? 0;
  for (const branch of order) {
    const n = counts.get(branch)!;
    if (n > bestCount) {
      best = branch;
      bestCount = n;
    }
  }
  return best;
}
