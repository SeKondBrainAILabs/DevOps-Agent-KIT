/**
 * Unit Tests for G3 — Cleanup wizard plan reducer
 */

import { describe, it, expect } from '@jest/globals';
import {
  isConfirmationValid,
  reduceCleanupPlan,
  type CleanupCandidate,
} from '../../../shared/cleanup-plan';

const c = (
  category: CleanupCandidate['category'],
  id: string,
  bytes?: number
): CleanupCandidate => ({ category, id, bytes });

describe('reduceCleanupPlan (G3)', () => {
  it('selects only enabled categories', () => {
    const plan = reduceCleanupPlan({
      candidates: [
        c('node-modules', '/repo/a/node_modules', 1000),
        c('stale-branches', 'feat/old'),
        c('venv', '/repo/a/.venv', 500),
      ],
      enabled: ['node-modules', 'stale-branches'],
    });
    expect(plan.selected.map((s) => s.id)).toEqual(['/repo/a/node_modules', 'feat/old']);
  });

  it('sums reclaimable bytes (skipping items without bytes / non-finite)', () => {
    const plan = reduceCleanupPlan({
      candidates: [
        c('node-modules', 'a', 1000),
        c('node-modules', 'b', NaN),
        c('node-modules', 'c'), // no bytes
        c('node-modules', 'd', -50), // negative
      ],
      enabled: ['node-modules'],
    });
    expect(plan.totalReclaimableBytes).toBe(1000);
  });

  it('counts per category for the wizard preview', () => {
    const plan = reduceCleanupPlan({
      candidates: [
        c('stale-branches', 'feat/a'),
        c('stale-branches', 'feat/b'),
        c('dangling-worktrees', '/wt/x'),
        c('node-modules', '/n', 500),
      ],
      enabled: ['stale-branches', 'dangling-worktrees', 'node-modules'],
    });
    expect(plan.countsByCategory).toEqual({
      'stale-branches': 2,
      'dangling-worktrees': 1,
      'node-modules': 1,
    });
  });

  it('returns an empty plan when no categories enabled', () => {
    const plan = reduceCleanupPlan({
      candidates: [c('node-modules', 'a', 1000)],
      enabled: [],
    });
    expect(plan.selected).toEqual([]);
    expect(plan.totalReclaimableBytes).toBe(0);
    expect(plan.countsByCategory).toEqual({});
  });
});

describe('isConfirmationValid (G3)', () => {
  const planWithSelection = reduceCleanupPlan({
    candidates: [c('node-modules', '/n', 1000)],
    enabled: ['node-modules'],
  });
  const emptyPlan = reduceCleanupPlan({ candidates: [], enabled: ['node-modules'] });

  it('accepts CLEAN / DELETE / CLEANUP (case-insensitive, trimmed)', () => {
    expect(isConfirmationValid(planWithSelection, 'clean')).toBe(true);
    expect(isConfirmationValid(planWithSelection, ' DELETE ')).toBe(true);
    expect(isConfirmationValid(planWithSelection, 'CleanUp')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isConfirmationValid(planWithSelection, 'yes')).toBe(false);
    expect(isConfirmationValid(planWithSelection, '')).toBe(false);
  });

  it('rejects when plan is empty (no destructive op to confirm)', () => {
    expect(isConfirmationValid(emptyPlan, 'CLEAN')).toBe(false);
  });
});
