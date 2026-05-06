/**
 * Regression Tests for R1 — Wrong session count on repo selection
 *
 * Bug: the repo-picker in "Setup new instance" displayed an inflated
 * `RecentRepo.agentCount` because the count included completed/closed/failed
 * sessions. Fix:
 *  1. `shared/instance-status.ts` exposes `isActiveInstance()` — single source
 *     of truth for active vs inactive.
 *  2. `AgentInstanceService.recalculateRepoAgentCounts()` filters via that
 *     predicate.
 *  3. `AgentInstanceService.updateInstanceStatus()` recalculates whenever a
 *     session crosses the active/inactive boundary, so the picker count
 *     stays accurate live.
 *
 * Tested at the predicate level so we don't have to load electron-store.
 */

import { describe, it, expect } from '@jest/globals';
import {
  isActiveInstance,
  isActiveStatus,
  INACTIVE_INSTANCE_STATUSES,
} from '../../../shared/instance-status';
import type { AgentInstance } from '../../../shared/types';

const inst = (status: string): Pick<AgentInstance, 'status'> =>
  ({ status: status as AgentInstance['status'] });

describe('isActiveInstance / isActiveStatus (R1)', () => {
  it('treats running/active/initializing/waiting/pending as active', () => {
    for (const s of ['active', 'running', 'initializing', 'waiting', 'pending']) {
      expect(isActiveStatus(s)).toBe(true);
      expect(isActiveInstance(inst(s))).toBe(true);
    }
  });

  it('treats error as active (still surfaces in the picker — user must address it)', () => {
    expect(isActiveStatus('error')).toBe(true);
    expect(isActiveInstance(inst('error'))).toBe(true);
  });

  it('treats completed / closed / failed as INACTIVE — not counted in the picker', () => {
    for (const s of ['completed', 'closed', 'failed']) {
      expect(isActiveStatus(s)).toBe(false);
      expect(isActiveInstance(inst(s))).toBe(false);
    }
  });

  it('exports the inactive status set so other services can stay consistent', () => {
    expect(INACTIVE_INSTANCE_STATUSES.has('completed')).toBe(true);
    expect(INACTIVE_INSTANCE_STATUSES.has('closed')).toBe(true);
    expect(INACTIVE_INSTANCE_STATUSES.has('failed')).toBe(true);
    expect(INACTIVE_INSTANCE_STATUSES.has('active')).toBe(false);
    expect(INACTIVE_INSTANCE_STATUSES.has('running')).toBe(false);
  });

  it('regression intent: filtering a mixed list yields only active sessions', () => {
    const mixed = [
      inst('active'),
      inst('running'),
      inst('completed'), // excluded
      inst('closed'),    // excluded
      inst('failed'),    // excluded
      inst('error'),     // included
    ];
    const activeCount = mixed.filter(isActiveInstance).length;
    expect(activeCount).toBe(3);
  });

  it('an unknown status defaults to active (forward-compatible)', () => {
    // If the codebase introduces a new status string we haven't seen,
    // the safer behavior is to treat it as active so it surfaces in the UI.
    expect(isActiveStatus('paused-by-user')).toBe(true);
    expect(isActiveInstance(inst('mystery-status'))).toBe(true);
  });
});
