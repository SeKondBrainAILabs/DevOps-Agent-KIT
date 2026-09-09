/**
 * Per-file churn + regression-rate (Epic Q / story Q3).
 *
 * Pure aggregator: take a list of commits (each with subject + ISO date +
 * touched-file paths) and produce per-file metrics for the dashboard.
 *
 * Definitions:
 *  - commitsLastWeek: number of commits touching the file in the last 7 days
 *  - commitsTotal:    total commits touching the file
 *  - fixCommits:      commits whose subject matched the fix heuristic
 *  - regressionRate:  fixCommits / commitsTotal (0 when commitsTotal === 0)
 *
 * Renderer sorts by commitsLastWeek (default) or regressionRate.
 */

import { isLikelyFixSubject } from './revert-detector';

export interface CommitSummary {
  sha: string;
  subject: string;
  /** ISO timestamp. */
  at: string;
  /** Files this commit touched. */
  files: ReadonlyArray<string>;
}

export interface FileChurnRow {
  filePath: string;
  commitsTotal: number;
  commitsLastWeek: number;
  fixCommits: number;
  regressionRate: number;
}

export interface ComputeChurnInputs {
  commits: ReadonlyArray<CommitSummary>;
  /** "Now" for deterministic tests. Default Date.now(). */
  now?: number;
  /** Lookback window for "last week" metric. Default 7 days. */
  recentDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeFileChurn(input: ComputeChurnInputs): FileChurnRow[] {
  const now = input.now ?? Date.now();
  const cutoff = now - (input.recentDays ?? 7) * MS_PER_DAY;

  const map = new Map<string, FileChurnRow>();
  for (const c of input.commits) {
    const at = Date.parse(c.at);
    const isFix = isLikelyFixSubject(c.subject);
    const isRecent = !Number.isNaN(at) && at >= cutoff;
    for (const f of c.files) {
      const row = map.get(f) ?? {
        filePath: f,
        commitsTotal: 0,
        commitsLastWeek: 0,
        fixCommits: 0,
        regressionRate: 0,
      };
      row.commitsTotal += 1;
      if (isRecent) row.commitsLastWeek += 1;
      if (isFix) row.fixCommits += 1;
      map.set(f, row);
    }
  }

  for (const row of map.values()) {
    row.regressionRate = row.commitsTotal === 0 ? 0 : row.fixCommits / row.commitsTotal;
  }

  return Array.from(map.values());
}

export type ChurnSortKey = 'last-week' | 'regression-rate' | 'total';

export function sortChurnRows(
  rows: ReadonlyArray<FileChurnRow>,
  key: ChurnSortKey
): FileChurnRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    switch (key) {
      case 'last-week':
        return b.commitsLastWeek - a.commitsLastWeek || a.filePath.localeCompare(b.filePath);
      case 'regression-rate':
        return b.regressionRate - a.regressionRate || a.filePath.localeCompare(b.filePath);
      case 'total':
        return b.commitsTotal - a.commitsTotal || a.filePath.localeCompare(b.filePath);
    }
  });
  return out;
}

/** Take top N rows by sort key — convenience for the leaderboard widget. */
export function topChurnRows(
  rows: ReadonlyArray<FileChurnRow>,
  key: ChurnSortKey,
  limit: number
): FileChurnRow[] {
  return sortChurnRows(rows, key).slice(0, Math.max(0, limit));
}
