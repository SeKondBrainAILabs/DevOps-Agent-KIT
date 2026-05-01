/**
 * Unit Tests for I7 — Production drift alert
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateDriftAlert } from '../../../shared/prod-drift-alert';

const NOW = new Date('2026-05-01T00:00:00.000Z').getTime();
const hoursAgo = (h: number): string => new Date(NOW - h * 60 * 60 * 1000).toISOString();

describe('evaluateDriftAlert (I7)', () => {
  it('does not alert when prod is in sync (sha match)', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'abc', commitsAhead: 0, lastDeployAt: hoursAgo(48) },
      { now: NOW }
    );
    expect(r.shouldAlert).toBe(false);
    expect(r.kind).toBe('no-drift-in-sync');
  });

  it('does not alert when commitsAhead is 0 even if shas differ (rebase edge case)', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 0, lastDeployAt: hoursAgo(48) },
      { now: NOW }
    );
    expect(r.shouldAlert).toBe(false);
    expect(r.kind).toBe('no-drift-in-sync');
  });

  it('does not alert when prod is recently deployed (within 24h default)', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 3, lastDeployAt: hoursAgo(2) },
      { now: NOW }
    );
    expect(r.shouldAlert).toBe(false);
    expect(r.kind).toBe('no-drift-just-deployed');
  });

  it('alerts when behind + stale (>24h since deploy)', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 3, lastDeployAt: hoursAgo(36) },
      { now: NOW }
    );
    expect(r.shouldAlert).toBe(true);
    expect(r.kind).toBe('alert-stale-prod');
    expect(r.commitsAhead).toBe(3);
    expect(r.message).toMatch(/3 commit/);
  });

  it('respects custom staleAfterHours', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 1, lastDeployAt: hoursAgo(2) },
      { now: NOW, staleAfterHours: 1 }
    );
    expect(r.shouldAlert).toBe(true);
  });

  it('does not alert after user dismisses', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 5, lastDeployAt: hoursAgo(72) },
      { now: NOW, dismissed: true }
    );
    expect(r.shouldAlert).toBe(false);
    expect(r.kind).toBe('dismissed');
  });

  it('treats unparseable lastDeployAt as infinitely stale', () => {
    const r = evaluateDriftAlert(
      { deployedSha: 'abc', mainHeadSha: 'def', commitsAhead: 1, lastDeployAt: 'not-a-date' },
      { now: NOW }
    );
    expect(r.shouldAlert).toBe(true);
    expect(r.hoursBehind).toBe(Infinity);
  });
});
