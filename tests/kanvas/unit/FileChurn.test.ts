/**
 * Unit Tests for Q3 — Per-file churn + regression-rate
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeFileChurn,
  sortChurnRows,
  topChurnRows,
  type CommitSummary,
} from '../../../shared/file-churn';

const NOW = new Date('2026-05-01T00:00:00.000Z').getTime();
const daysAgo = (n: number): string => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const c = (sha: string, subject: string, daysSince: number, files: string[]): CommitSummary => ({
  sha,
  subject,
  at: daysAgo(daysSince),
  files,
});

describe('computeFileChurn — counts (Q3)', () => {
  it('aggregates total + last-week + fix counts per file', () => {
    const rows = computeFileChurn({
      now: NOW,
      commits: [
        c('1', 'feat: add login', 1, ['src/auth.ts']),
        c('2', 'fix: null deref', 2, ['src/auth.ts']),
        c('3', 'chore: deps', 30, ['src/auth.ts']),
        c('4', 'feat: signup', 1, ['src/signup.ts']),
      ],
    });
    const auth = rows.find((r) => r.filePath === 'src/auth.ts')!;
    expect(auth.commitsTotal).toBe(3);
    expect(auth.commitsLastWeek).toBe(2);
    expect(auth.fixCommits).toBe(1);
    expect(auth.regressionRate).toBeCloseTo(1 / 3);
  });

  it('regressionRate is 0 when no fix commits', () => {
    const rows = computeFileChurn({
      now: NOW,
      commits: [c('1', 'feat: add', 1, ['src/x.ts'])],
    });
    expect(rows[0].regressionRate).toBe(0);
  });

  it('respects custom recentDays window', () => {
    const rows = computeFileChurn({
      now: NOW,
      recentDays: 30,
      commits: [c('1', 'feat: add', 25, ['src/x.ts'])],
    });
    expect(rows[0].commitsLastWeek).toBe(1);
  });

  it('handles unparseable timestamps as not-recent', () => {
    const rows = computeFileChurn({
      now: NOW,
      commits: [{ sha: '1', subject: 'feat', at: 'not-a-date', files: ['src/x.ts'] }],
    });
    expect(rows[0].commitsLastWeek).toBe(0);
    expect(rows[0].commitsTotal).toBe(1);
  });
});

describe('sortChurnRows (Q3)', () => {
  const rows = computeFileChurn({
    now: NOW,
    commits: [
      c('1', 'fix: a', 1, ['hot.ts']),
      c('2', 'fix: b', 1, ['hot.ts']),
      c('3', 'feat: c', 1, ['hot.ts']),
      c('4', 'feat: d', 1, ['cold.ts']),
      c('5', 'fix: e', 30, ['old.ts']),
      c('6', 'fix: f', 30, ['old.ts']),
      c('7', 'feat: g', 30, ['old.ts']),
      c('8', 'feat: h', 30, ['old.ts']),
    ],
  });

  it('sorts by last-week (default) descending', () => {
    const out = sortChurnRows(rows, 'last-week');
    expect(out.map((r) => r.filePath)).toEqual(['hot.ts', 'cold.ts', 'old.ts']);
  });

  it('sorts by regression-rate descending', () => {
    const out = sortChurnRows(rows, 'regression-rate');
    // hot.ts: 2/3 ≈ 0.667; old.ts: 2/4 = 0.5; cold.ts: 0
    expect(out.map((r) => r.filePath)).toEqual(['hot.ts', 'old.ts', 'cold.ts']);
  });

  it('sorts by total commits descending', () => {
    const out = sortChurnRows(rows, 'total');
    // old.ts: 4, hot.ts: 3, cold.ts: 1
    expect(out.map((r) => r.filePath)).toEqual(['old.ts', 'hot.ts', 'cold.ts']);
  });
});

describe('topChurnRows (Q3)', () => {
  it('returns top N by the given sort key', () => {
    const rows = computeFileChurn({
      now: NOW,
      commits: [
        c('1', 'feat', 1, ['a.ts']),
        c('2', 'feat', 1, ['a.ts']),
        c('3', 'feat', 1, ['b.ts']),
        c('4', 'feat', 1, ['c.ts']),
      ],
    });
    expect(topChurnRows(rows, 'last-week', 2).map((r) => r.filePath)).toEqual(['a.ts', 'b.ts']);
  });

  it('clamps a negative limit to []', () => {
    const rows = computeFileChurn({
      now: NOW,
      commits: [c('1', 'feat', 1, ['x.ts'])],
    });
    expect(topChurnRows(rows, 'total', -1)).toEqual([]);
  });
});
