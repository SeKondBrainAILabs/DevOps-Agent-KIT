/**
 * Unit Tests for G2 — Dangling worktree detector
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyDanglingWorktrees,
  planPrune,
  type WorktreeRecord,
} from '../../../shared/dangling-worktrees';

const wt = (path: string, existsOnDisk: boolean, opts: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  path,
  branch: opts.branch ?? 'feat/x',
  existsOnDisk,
  ...opts,
});

describe('classifyDanglingWorktrees (G2)', () => {
  it('returns empty banner when nothing is dangling', () => {
    const out = classifyDanglingWorktrees([wt('/a', true), wt('/b', true)]);
    expect(out.dangling).toEqual([]);
    expect(out.live).toHaveLength(2);
    expect(out.banner).toBeNull();
  });

  it('flags worktrees whose folder no longer exists', () => {
    const out = classifyDanglingWorktrees([wt('/a', true), wt('/b', false), wt('/c', false)]);
    expect(out.dangling.map((d) => d.path)).toEqual(['/b', '/c']);
    expect(out.live.map((l) => l.path)).toEqual(['/a']);
    expect(out.banner).toMatch(/2 dangling worktrees/);
  });

  it('singular wording when exactly one is dangling', () => {
    const out = classifyDanglingWorktrees([wt('/a', false)]);
    expect(out.banner).toMatch(/1 dangling worktree(?!s)/);
  });

  it('never marks the primary worktree as dangling, even if existsOnDisk=false', () => {
    const out = classifyDanglingWorktrees([
      wt('/main', false, { isPrimary: true }),
      wt('/wt', false),
    ]);
    expect(out.dangling.map((d) => d.path)).toEqual(['/wt']);
    expect(out.live.map((l) => l.path)).toEqual(['/main']);
  });
});

describe('planPrune (G2)', () => {
  it('lists only dangling paths', () => {
    const out = planPrune([wt('/a', true), wt('/b', false), wt('/c', false)]);
    expect(out.prunePaths).toEqual(['/b', '/c']);
    expect(out.reclaimableCount).toBe(2);
  });

  it('returns empty when nothing to prune', () => {
    const out = planPrune([wt('/a', true)]);
    expect(out.prunePaths).toEqual([]);
    expect(out.reclaimableCount).toBe(0);
  });
});
