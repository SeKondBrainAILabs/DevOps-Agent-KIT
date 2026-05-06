/**
 * Disk usage breakdown + reclaimable-space calculator (Epic G / story G1).
 *
 * The DiskUsageService walks each repo and emits raw size entries per
 * folder. This module reduces those entries into the categorized
 * breakdown the UI displays, plus a reclaimable-space estimate for the
 * Cleanup Wizard.
 *
 * Categories (matched on basename):
 *   .git        → repo metadata (NOT reclaimable)
 *   node_modules → reclaimable
 *   .venv       → reclaimable
 *   dist | build → reclaimable
 *   .worktrees  → checked separately by the caller (dangling vs live)
 *   <other>     → 'source'
 */

export interface RawDirSize {
  /** Path relative to the repo root. */
  relPath: string;
  bytes: number;
}

export type DiskCategory =
  | '.git'
  | 'node_modules'
  | '.venv'
  | 'dist-or-build'
  | '.worktrees'
  | 'source';

export const CATEGORY_LABELS: Record<DiskCategory, string> = {
  '.git': '.git',
  'node_modules': 'node_modules',
  '.venv': '.venv',
  'dist-or-build': 'dist / build',
  '.worktrees': '.worktrees',
  'source': 'source',
};

export const RECLAIMABLE_CATEGORIES: ReadonlySet<DiskCategory> = new Set<DiskCategory>([
  'node_modules',
  '.venv',
  'dist-or-build',
]);

export interface DiskBreakdown {
  totalBytes: number;
  /** Per-category size (always present; 0 when category is empty). */
  byCategory: Record<DiskCategory, number>;
  /** Sum of categories in RECLAIMABLE_CATEGORIES. */
  reclaimableBytes: number;
  /** Reclaimable as a fraction of total (0 when total = 0). */
  reclaimableFraction: number;
}

/** Categorize a single relative path's first segment. */
export function categorizePath(relPath: string): DiskCategory {
  const head = relPath.replace(/^\/+/, '').split('/')[0];
  switch (head) {
    case '.git':
      return '.git';
    case 'node_modules':
      return 'node_modules';
    case '.venv':
    case 'venv':
      return '.venv';
    case 'dist':
    case 'build':
      return 'dist-or-build';
    case '.worktrees':
      return '.worktrees';
    default:
      return 'source';
  }
}

export function reduceDiskBreakdown(entries: ReadonlyArray<RawDirSize>): DiskBreakdown {
  const byCategory: Record<DiskCategory, number> = {
    '.git': 0,
    'node_modules': 0,
    '.venv': 0,
    'dist-or-build': 0,
    '.worktrees': 0,
    'source': 0,
  };
  let total = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.bytes) || e.bytes < 0) continue;
    total += e.bytes;
    byCategory[categorizePath(e.relPath)] += e.bytes;
  }
  let reclaimable = 0;
  for (const cat of RECLAIMABLE_CATEGORIES) reclaimable += byCategory[cat];
  return {
    totalBytes: total,
    byCategory,
    reclaimableBytes: reclaimable,
    reclaimableFraction: total === 0 ? 0 : reclaimable / total,
  };
}

/** Compact human-readable byte formatting (B / KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
