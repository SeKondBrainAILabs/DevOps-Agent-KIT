/**
 * Unit Tests for resolveUnpushedCount — the delete-safety at-risk count fix.
 *
 * Real incident: a delete dialog warned "322 unpushed commits will be lost"
 * when the branch had been rebased and only 1 commit was genuinely at risk
 * (the other 321 were patch-present on origin/main). The metric must take the
 * MIN over the candidate baselines so work present on either isn't counted
 * as lost.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveUnpushedCount } from '../../../shared/unpushed-count';

describe('resolveUnpushedCount', () => {
  it('replays the 322-vs-1 incident: MIN over {remote-branch, base-branch}', () => {
    // vs stale origin/<branch> the rebased branch looks 322 ahead;
    // vs origin/main only 1 commit is genuinely new.
    expect(resolveUnpushedCount({ vsRemoteBranch: 322, vsBaseBranch: 1 })).toBe(1);
  });

  it('takes MIN regardless of ordering', () => {
    expect(resolveUnpushedCount({ vsRemoteBranch: 1, vsBaseBranch: 322 })).toBe(1);
  });

  it('uses the only available baseline when the other is null', () => {
    expect(resolveUnpushedCount({ vsRemoteBranch: 5, vsBaseBranch: null })).toBe(5);
    expect(resolveUnpushedCount({ vsRemoteBranch: null, vsBaseBranch: 7 })).toBe(7);
  });

  it('returns 0 when work is fully present on a baseline (clean, already pushed)', () => {
    expect(resolveUnpushedCount({ vsRemoteBranch: 0, vsBaseBranch: 12 })).toBe(0);
    expect(resolveUnpushedCount({ vsRemoteBranch: 12, vsBaseBranch: 0 })).toBe(0);
  });

  it('neither baseline available + fallback provided → fallback (all at risk)', () => {
    // Brand-new never-pushed branch with unknown base: every commit is at risk.
    expect(resolveUnpushedCount({ vsRemoteBranch: null, vsBaseBranch: null }, 8)).toBe(8);
  });

  it('neither baseline + no fallback → 0 (never fabricate a scary number)', () => {
    expect(resolveUnpushedCount({ vsRemoteBranch: null, vsBaseBranch: null })).toBe(0);
  });

  it('clamps negative inputs to 0', () => {
    expect(resolveUnpushedCount({ vsRemoteBranch: -3, vsBaseBranch: null })).toBe(0);
    expect(resolveUnpushedCount({ vsRemoteBranch: null, vsBaseBranch: null }, -5)).toBe(0);
  });

  it('genuinely-unpushed branch: both baselines agree on a positive count', () => {
    // Work committed locally, not on remote branch, not on base → real risk.
    expect(resolveUnpushedCount({ vsRemoteBranch: 4, vsBaseBranch: 4 })).toBe(4);
  });
});
