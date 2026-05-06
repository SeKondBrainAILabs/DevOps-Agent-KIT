/**
 * Dangling worktree detector (Epic G / story G2).
 *
 * `git worktree list` records a worktree even after its folder is deleted.
 * This module classifies a list of worktrees against an existsOnDisk lookup
 * and reports the dangling ones for the Cleanup Wizard.
 */

export interface WorktreeRecord {
  /** Absolute path the worktree was registered at. */
  path: string;
  /** Branch checked out in the worktree (or '(detached)'). */
  branch: string;
  /** True iff the path still exists on disk. Caller resolves via fs.access. */
  existsOnDisk: boolean;
  /** Last activity ms, used to suppress alerts on freshly-created worktrees. */
  lastActivityMs?: number;
  /** True iff this is the primary worktree (i.e. the main repo path itself). */
  isPrimary?: boolean;
}

export interface DanglingClassification {
  dangling: WorktreeRecord[];
  live: WorktreeRecord[];
  /** Banner message when at least one is dangling, else null. */
  banner: string | null;
}

export function classifyDanglingWorktrees(
  worktrees: ReadonlyArray<WorktreeRecord>
): DanglingClassification {
  const dangling: WorktreeRecord[] = [];
  const live: WorktreeRecord[] = [];
  for (const w of worktrees) {
    // The primary worktree is never "dangling" in our sense — even if its
    // existsOnDisk flag misfires, never recommend pruning it.
    if (w.isPrimary) {
      live.push(w);
      continue;
    }
    if (w.existsOnDisk) live.push(w);
    else dangling.push(w);
  }
  const banner =
    dangling.length === 0
      ? null
      : `${dangling.length} dangling worktree${dangling.length === 1 ? '' : 's'} detected. ` +
        'Run "Prune dangling" in the Worktree Manager to clean up.';
  return { dangling, live, banner };
}

/** Plan a prune: list the worktree paths to remove via `git worktree prune` + manual delete. */
export function planPrune(worktrees: ReadonlyArray<WorktreeRecord>): {
  prunePaths: string[];
  reclaimableCount: number;
} {
  const { dangling } = classifyDanglingWorktrees(worktrees);
  return {
    prunePaths: dangling.map((d) => d.path),
    reclaimableCount: dangling.length,
  };
}
