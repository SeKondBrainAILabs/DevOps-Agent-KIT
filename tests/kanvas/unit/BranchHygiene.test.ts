/**
 * Unit Tests for C7 — Branch hygiene flags
 *
 * Pure classifier; no fs/git dependencies. Verifies the staleness threshold,
 * merged / deleted-on-remote signal pass-through, the safe-to-delete rule,
 * and the filter-chip matcher used by the Branch Manager Panel.
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyBranch,
  matchesBranchFilter,
  DEFAULT_STALE_THRESHOLD_DAYS,
  MS_PER_DAY,
  type BranchHygieneInputs,
} from '../../../shared/branch-hygiene';

const NOW = new Date('2026-05-01T00:00:00.000Z').getTime();

const baseInput: BranchHygieneInputs = {
  name: 'feat/x',
  lastCommitMs: NOW - 1 * MS_PER_DAY,
  mergedIntoDefault: false,
  deletedOnRemote: false,
  hasWorktree: false,
  isCurrent: false,
};

describe('classifyBranch — staleness (C7)', () => {
  it('not stale when last commit is within the threshold', () => {
    const flags = classifyBranch(baseInput, { now: NOW });
    expect(flags.stale).toBe(false);
  });

  it('stale when last commit is older than the default 30 day threshold', () => {
    const flags = classifyBranch(
      { ...baseInput, lastCommitMs: NOW - 31 * MS_PER_DAY },
      { now: NOW }
    );
    expect(flags.stale).toBe(true);
  });

  it('honors a custom threshold', () => {
    const flags = classifyBranch(
      { ...baseInput, lastCommitMs: NOW - 8 * MS_PER_DAY },
      { now: NOW, staleThresholdDays: 7 }
    );
    expect(flags.stale).toBe(true);
  });

  it('exposes the default threshold constant', () => {
    expect(DEFAULT_STALE_THRESHOLD_DAYS).toBe(30);
  });
});

describe('classifyBranch — merged + deleted-on-remote (C7)', () => {
  it('passes mergedIntoDefault through to the merged flag', () => {
    expect(classifyBranch({ ...baseInput, mergedIntoDefault: true }, { now: NOW }).merged).toBe(true);
  });

  it('passes deletedOnRemote through', () => {
    expect(classifyBranch({ ...baseInput, deletedOnRemote: true }, { now: NOW }).deletedOnRemote).toBe(true);
  });
});

describe('classifyBranch — safeToDelete (C7)', () => {
  it('safe-to-delete when merged + no worktree + not current', () => {
    const flags = classifyBranch(
      { ...baseInput, mergedIntoDefault: true },
      { now: NOW }
    );
    expect(flags.safeToDelete).toBe(true);
  });

  it('NOT safe when not merged', () => {
    expect(classifyBranch(baseInput, { now: NOW }).safeToDelete).toBe(false);
  });

  it('NOT safe when a worktree references it (even if merged)', () => {
    const flags = classifyBranch(
      { ...baseInput, mergedIntoDefault: true, hasWorktree: true },
      { now: NOW }
    );
    expect(flags.safeToDelete).toBe(false);
  });

  it('NOT safe when it is the current branch (even if merged)', () => {
    const flags = classifyBranch(
      { ...baseInput, mergedIntoDefault: true, isCurrent: true },
      { now: NOW }
    );
    expect(flags.safeToDelete).toBe(false);
  });
});

describe('matchesBranchFilter (C7)', () => {
  const merged = classifyBranch(
    { ...baseInput, mergedIntoDefault: true },
    { now: NOW }
  );
  const stale = classifyBranch(
    { ...baseInput, lastCommitMs: NOW - 60 * MS_PER_DAY },
    { now: NOW }
  );
  const active = classifyBranch(baseInput, { now: NOW });
  const deletedRemote = classifyBranch(
    { ...baseInput, deletedOnRemote: true },
    { now: NOW }
  );
  const withWorktree = classifyBranch(
    { ...baseInput, hasWorktree: true },
    { now: NOW }
  );

  it('"all" matches everything', () => {
    expect(matchesBranchFilter(merged, 'all')).toBe(true);
    expect(matchesBranchFilter(active, 'all')).toBe(true);
  });

  it('"active" excludes merged, stale, deleted-on-remote', () => {
    expect(matchesBranchFilter(active, 'active')).toBe(true);
    expect(matchesBranchFilter(merged, 'active')).toBe(false);
    expect(matchesBranchFilter(stale, 'active')).toBe(false);
    expect(matchesBranchFilter(deletedRemote, 'active')).toBe(false);
  });

  it('"merged" / "stale" / "deleted-on-remote" / "has-worktree" each match the right group', () => {
    expect(matchesBranchFilter(merged, 'merged')).toBe(true);
    expect(matchesBranchFilter(active, 'merged')).toBe(false);

    expect(matchesBranchFilter(stale, 'stale')).toBe(true);
    expect(matchesBranchFilter(active, 'stale')).toBe(false);

    expect(matchesBranchFilter(deletedRemote, 'deleted-on-remote')).toBe(true);
    expect(matchesBranchFilter(active, 'deleted-on-remote')).toBe(false);

    expect(matchesBranchFilter(withWorktree, 'has-worktree')).toBe(true);
    expect(matchesBranchFilter(active, 'has-worktree')).toBe(false);
  });
});
