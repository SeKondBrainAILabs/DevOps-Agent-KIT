/**
 * Unit Tests for the rebase tip-count safety guard.
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateRebaseTipGuard } from '../../../shared/rebase-tip-guard';

describe('evaluateRebaseTipGuard', () => {
  it('safe when post-count equals pre-count (fast-forward or noop)', () => {
    const r = evaluateRebaseTipGuard({ preRebaseCommitCount: 10, postRebaseCommitCount: 10 });
    expect(r.safe).toBe(true);
    expect(r.kind).toBe('safe-same-or-grew');
    expect(r.shrinkageCommits).toBe(0);
  });

  it('safe when the branch grew (rebased on top adds base commits)', () => {
    const r = evaluateRebaseTipGuard({ preRebaseCommitCount: 10, postRebaseCommitCount: 25 });
    expect(r.safe).toBe(true);
    expect(r.kind).toBe('safe-same-or-grew');
  });

  it('BLOCKS on any drop by default (the incident signature)', () => {
    const r = evaluateRebaseTipGuard({
      preRebaseCommitCount: 20,
      postRebaseCommitCount: 5,
      branchName: 'feat/x',
    });
    expect(r.safe).toBe(false);
    expect(r.kind).toBe('blocked-tip-inverted');
    expect(r.shrinkageCommits).toBe(15);
    expect(r.message).toMatch(/feat\/x/);
    expect(r.message).toMatch(/dropped 15/);
    expect(r.message).toMatch(/ORIG_HEAD/);
  });

  it('replays the actual incident numbers (15 commits lost)', () => {
    const r = evaluateRebaseTipGuard({
      preRebaseCommitCount: 42, // hypothetical real tip
      postRebaseCommitCount: 27, // 15 orphaned
      branchName: 'claude-session-20260721-vfgi',
    });
    expect(r.safe).toBe(false);
    expect(r.shrinkageCommits).toBe(15);
  });

  it('honors allowedShrinkage for intentional squash-rebases', () => {
    // Squashed 3 fixups into a single commit → 3-count drop is expected.
    const r = evaluateRebaseTipGuard({
      preRebaseCommitCount: 20,
      postRebaseCommitCount: 17,
      allowedShrinkage: 3,
    });
    expect(r.safe).toBe(true);
    expect(r.kind).toBe('safe-within-allowed-shrinkage');
  });

  it('blocks when shrinkage exceeds allowedShrinkage', () => {
    const r = evaluateRebaseTipGuard({
      preRebaseCommitCount: 20,
      postRebaseCommitCount: 15,
      allowedShrinkage: 3,
    });
    expect(r.safe).toBe(false);
    expect(r.shrinkageCommits).toBe(5);
  });
});
