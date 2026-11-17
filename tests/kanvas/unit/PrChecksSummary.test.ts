/**
 * Unit tests for summarizePrChecks (KC-S1.2.2.4 - AC1)
 *
 * A pure summariser turns `gh pr checks --json name,state,bucket` rows into
 * passing, failing, pending or none, with counts.
 */

import { describe, it, expect } from '@jest/globals';
import { summarizePrChecks } from '../../../src/kanvas/utils/pr-checks-summary';

describe('summarizePrChecks', () => {
  it('returns state="none" for an empty array', () => {
    const result = summarizePrChecks([]);
    expect(result.state).toBe('none');
    expect(result.counts).toEqual({ passing: 0, failing: 0, pending: 0, total: 0 });
  });

  it('returns state="passing" when all checks succeed', () => {
    const checks = [
      { name: 'lint', state: 'SUCCESS', bucket: 'success' },
      { name: 'test', state: 'COMPLETED', bucket: 'success' },
      { name: 'build', state: 'SUCCESS' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('passing');
    expect(result.counts).toEqual({ passing: 3, failing: 0, pending: 0, total: 3 });
  });

  it('returns state="failing" when any check fails', () => {
    const checks = [
      { name: 'lint', state: 'SUCCESS' },
      { name: 'test', state: 'FAILURE' },
      { name: 'build', state: 'COMPLETED' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts).toEqual({ passing: 2, failing: 1, pending: 0, total: 3 });
  });

  it('returns state="failing" for ERROR, CANCELLED, TIMED_OUT states', () => {
    const checks = [
      { name: 'check1', state: 'ERROR' },
      { name: 'check2', state: 'CANCELLED' },
      { name: 'check3', state: 'TIMED_OUT' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(3);
  });

  it('returns state="failing" when bucket is "fail" or "cancel"', () => {
    const checks = [
      { name: 'check1', state: 'COMPLETED', bucket: 'fail' },
      { name: 'check2', state: 'SUCCESS', bucket: 'cancel' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(2);
  });

  it('returns state="pending" when checks are PENDING, IN_PROGRESS, or QUEUED', () => {
    const checks = [
      { name: 'check1', state: 'PENDING' },
      { name: 'check2', state: 'IN_PROGRESS' },
      { name: 'check3', state: 'QUEUED' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('pending');
    expect(result.counts).toEqual({ passing: 0, failing: 0, pending: 3, total: 3 });
  });

  it('returns state="pending" when bucket is "pending"', () => {
    const checks = [
      { name: 'check1', state: 'COMPLETED', bucket: 'pending' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('pending');
    expect(result.counts.pending).toBe(1);
  });

  it('prioritizes failing over pending over passing', () => {
    const checks = [
      { name: 'failing-check', state: 'FAILURE' },
      { name: 'pending-check', state: 'PENDING' },
      { name: 'passing-check', state: 'SUCCESS' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts).toEqual({ passing: 1, failing: 1, pending: 1, total: 3 });
  });

  it('prioritizes pending over passing when no failures', () => {
    const checks = [
      { name: 'pending-check', state: 'PENDING' },
      { name: 'passing-check', state: 'SUCCESS' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('pending');
    expect(result.counts).toEqual({ passing: 1, failing: 0, pending: 1, total: 2 });
  });

  it('handles case-insensitive state values', () => {
    const checks = [
      { name: 'check1', state: 'success' },
      { name: 'check2', state: 'Success' },
      { name: 'check3', state: 'FAILURE' },
      { name: 'check4', state: 'pending' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts).toEqual({ passing: 2, failing: 1, pending: 1, total: 4 });
  });

  it('handles missing state or bucket fields gracefully', () => {
    const checks = [
      { name: 'check1' },
      { name: 'check2', state: '' },
      { name: 'check3', bucket: '' },
    ];
    const result = summarizePrChecks(checks);
    // Unknown states should not be counted as passing/failing/pending
    expect(result.state).toBe('none');
    expect(result.counts).toEqual({ passing: 0, failing: 0, pending: 0, total: 3 });
  });

  it('counts total correctly regardless of state', () => {
    const checks = [
      { name: 'check1', state: 'SUCCESS' },
      { name: 'check2', state: 'FAILURE' },
      { name: 'check3', state: 'PENDING' },
      { name: 'check4', state: 'COMPLETED', bucket: 'success' },
    ];
    const result = summarizePrChecks(checks);
    expect(result.counts.total).toBe(4);
    expect(result.counts.passing + result.counts.failing + result.counts.pending).toBe(3);
  });

  it('handles check with both state and bucket that disagree', () => {
    // Per GitHub's logic, bucket overrides state when present
    const checks = [
      { name: 'check1', state: 'SUCCESS', bucket: 'fail' }, // bucket wins
      { name: 'check2', state: 'FAILURE', bucket: 'success' }, // bucket wins
    ];
    const result = summarizePrChecks(checks);
    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(1);
    expect(result.counts.passing).toBe(1);
  });
});
