/**
 * Unit Tests for F4 — Multi-repo branch sync visualizer
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildBranchSyncMatrix,
  majorityBranch,
} from '../../../shared/branch-sync-matrix';

const r = (repoName: string, currentBranch: string) => ({ repoName, currentBranch });

describe('majorityBranch (F4)', () => {
  it('picks the most common branch', () => {
    expect(
      majorityBranch([r('a', 'main'), r('b', 'main'), r('c', 'develop')])
    ).toBe('main');
  });
  it('breaks ties by first occurrence', () => {
    expect(majorityBranch([r('a', 'develop'), r('b', 'main')])).toBe('develop');
  });
  it('empty input returns ""', () => {
    expect(majorityBranch([])).toBe('');
  });
});

describe('buildBranchSyncMatrix — sync state (F4)', () => {
  it('allInSync=true when every repo is on the expected branch', () => {
    const m = buildBranchSyncMatrix({
      repos: [r('a', 'main'), r('b', 'main')],
      expectedBranch: 'main',
    });
    expect(m.allInSync).toBe(true);
    expect(m.divergent).toEqual([]);
    expect(m.suggestion).toBeUndefined();
  });

  it('flags divergent repos', () => {
    const m = buildBranchSyncMatrix({
      repos: [r('a', 'main'), r('b', 'feat/x'), r('c', 'main')],
      expectedBranch: 'main',
    });
    expect(m.allInSync).toBe(false);
    expect(m.divergent.map((d) => d.repoName)).toEqual(['b']);
    expect(m.suggestion).toBe('Switch all to "main"');
  });

  it('falls back to majority branch when expected not provided', () => {
    const m = buildBranchSyncMatrix({
      repos: [r('a', 'main'), r('b', 'main'), r('c', 'develop')],
    });
    expect(m.expectedBranch).toBe('main');
    expect(m.divergent.map((d) => d.repoName)).toEqual(['c']);
  });
});

describe('buildBranchSyncMatrix — matrix shape (F4)', () => {
  it('rows[i][j] = true iff repo i is on branch j', () => {
    const m = buildBranchSyncMatrix({
      repos: [r('a', 'main'), r('b', 'feat/x')],
      expectedBranch: 'main',
    });
    expect(m.branches).toEqual(['main', 'feat/x']);
    expect(m.rows).toEqual([
      [true, false], // a on main
      [false, true], // b on feat/x
    ]);
  });

  it('places expected branch first in the columns even when not currently used', () => {
    const m = buildBranchSyncMatrix({
      repos: [r('a', 'feat/x'), r('b', 'develop')],
      expectedBranch: 'main',
    });
    expect(m.branches[0]).toBe('main');
    // No repo is on main → both rows have `false` for column 0.
    expect(m.rows.every((row) => row[0] === false)).toBe(true);
  });
});
