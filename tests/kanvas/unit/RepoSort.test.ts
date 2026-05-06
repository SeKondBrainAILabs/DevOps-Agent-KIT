/**
 * Unit Tests for B5 — Last-touched sort default
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_REPO_SORT_KEY,
  compareReposByAlpha,
  compareReposByLastTouched,
  compareReposBySize,
  getRepoComparator,
  type RepoSortInputs,
} from '../../../shared/repo-sort';

const r = (
  name: string,
  workingTreeMtimeMs: number,
  lastCommitMs = workingTreeMtimeMs,
  sizeBytes = 0
): RepoSortInputs => ({ name, workingTreeMtimeMs, lastCommitMs, sizeBytes });

describe('B5 — repo sort defaults', () => {
  it('default sort key is last-touched', () => {
    expect(DEFAULT_REPO_SORT_KEY).toBe('last-touched');
  });

  it('last-touched: newer working-tree mtime wins', () => {
    const list = [r('old', 1000), r('new', 2000), r('mid', 1500)];
    list.sort(compareReposByLastTouched);
    expect(list.map((x) => x.name)).toEqual(['new', 'mid', 'old']);
  });

  it('last-touched: tie on mtime falls back to most recent commit', () => {
    const list = [r('a', 1000, 50), r('b', 1000, 100)];
    list.sort(compareReposByLastTouched);
    expect(list.map((x) => x.name)).toEqual(['b', 'a']);
  });

  it('last-touched: full tie falls back to alphabetical name', () => {
    const list = [r('zeta', 1000, 100), r('alpha', 1000, 100)];
    list.sort(compareReposByLastTouched);
    expect(list.map((x) => x.name)).toEqual(['alpha', 'zeta']);
  });

  it('alphabetical: name ascending', () => {
    const list = [r('zed', 9), r('apple', 1), r('mango', 5)];
    list.sort(compareReposByAlpha);
    expect(list.map((x) => x.name)).toEqual(['apple', 'mango', 'zed']);
  });

  it('size: largest first, name tie-breaks', () => {
    const list = [
      r('small', 0, 0, 100),
      r('big-a', 0, 0, 999),
      r('big-b', 0, 0, 999),
    ];
    list.sort(compareReposBySize);
    expect(list.map((x) => x.name)).toEqual(['big-a', 'big-b', 'small']);
  });

  it('getRepoComparator returns the matching comparator', () => {
    const list = [r('z', 9), r('a', 1)];
    list.sort(getRepoComparator('alphabetical'));
    expect(list.map((x) => x.name)).toEqual(['a', 'z']);

    list.sort(getRepoComparator('last-touched'));
    expect(list.map((x) => x.name)).toEqual(['z', 'a']);
  });
});
