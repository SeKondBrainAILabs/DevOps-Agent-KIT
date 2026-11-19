/**
 * CI checks summariser (story KC-S1.2.2.4 AC1)
 *
 * A pure module that turns `gh pr checks --json name,state,bucket` rows into
 * a summary with passing/failing/pending/none plus counts. Classification
 * matches `MergeService.checkMergeGate` so the review badge and the merge gate
 * can never disagree.
 */

import { describe, it, expect } from '@jest/globals';

// Import the actual implementation
import { classifyChecks, summarizeChecks } from '../../../renderer/lib/summary/pr-checks-summary';

type Check = { name: string; state: string; bucket?: string };

describe('classifyChecks', () => {
  it('returns passing when all checks are passing', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS' },
      { name: 'test', state: 'SUCCESS' },
    ];
    expect(classifyChecks(checks)).toBe('passing');
  });

  it('returns failing when any check has bucket fail', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS', bucket: 'fail' },
    ];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns failing when any check has bucket cancel', () => {
    const checks: Check[] = [
      { name: 'build', state: 'CANCELLED', bucket: 'cancel' },
    ];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns failing when any check has state FAILURE', () => {
    const checks: Check[] = [{ name: 'lint', state: 'FAILURE' }];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns failing when any check has state ERROR', () => {
    const checks: Check[] = [{ name: 'lint', state: 'ERROR' }];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns failing when any check has state CANCELLED', () => {
    const checks: Check[] = [{ name: 'lint', state: 'CANCELLED' }];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns failing when any check has state TIMED_OUT', () => {
    const checks: Check[] = [{ name: 'lint', state: 'TIMED_OUT' }];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns pending when any check has bucket pending', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS', bucket: 'pending' },
    ];
    expect(classifyChecks(checks)).toBe('pending');
  });

  it('returns pending when any check has state PENDING', () => {
    const checks: Check[] = [{ name: 'build', state: 'PENDING' }];
    expect(classifyChecks(checks)).toBe('pending');
  });

  it('returns pending when any check has state IN_PROGRESS', () => {
    const checks: Check[] = [{ name: 'build', state: 'IN_PROGRESS' }];
    expect(classifyChecks(checks)).toBe('pending');
  });

  it('returns pending when any check has state QUEUED', () => {
    const checks: Check[] = [{ name: 'build', state: 'QUEUED' }];
    expect(classifyChecks(checks)).toBe('pending');
  });

  it('failing takes precedence over pending', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS', bucket: 'pending' },
      { name: 'test', state: 'FAILURE' },
    ];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns passing when checks exist but have no failures or pending', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS' },
      { name: 'test', state: 'SUCCESS', bucket: 'success' },
    ];
    expect(classifyChecks(checks)).toBe('passing');
  });

  it('handles case-insensitive state values', () => {
    const checks: Check[] = [
      { name: 'build', state: 'failure' },
      { name: 'test', state: 'Success' },
    ];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('handles case-insensitive bucket values', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS', bucket: 'FAIL' },
    ];
    expect(classifyChecks(checks)).toBe('failing');
  });

  it('returns passing for an empty list of checks', () => {
    expect(classifyChecks([])).toBe('passing');
  });
});

describe('summarizeChecks', () => {
  it('counts passing, pending, and failing correctly', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS' },
      { name: 'test', state: 'PENDING' },
      { name: 'lint', state: 'FAILURE' },
      { name: 'security', state: 'SUCCESS' },
    ];
    const summary = summarizeChecks(checks);
    expect(summary.overall).toBe('failing');
    expect(summary.counts).toEqual({ passing: 2, pending: 1, failing: 1, total: 4 });
  });

  it('returns passing overall when all checks pass', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS' },
      { name: 'test', state: 'SUCCESS' },
    ];
    const summary = summarizeChecks(checks);
    expect(summary.overall).toBe('passing');
    expect(summary.counts).toEqual({ passing: 2, pending: 0, failing: 0, total: 2 });
  });

  it('returns pending overall when all non-passing checks are pending', () => {
    const checks: Check[] = [
      { name: 'build', state: 'PENDING' },
      { name: 'test', state: 'IN_PROGRESS' },
    ];
    const summary = summarizeChecks(checks);
    expect(summary.overall).toBe('pending');
    expect(summary.counts).toEqual({ passing: 0, pending: 2, failing: 0, total: 2 });
  });

  it('returns failing overall when any check fails', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS' },
      { name: 'test', state: 'FAILURE' },
    ];
    const summary = summarizeChecks(checks);
    expect(summary.overall).toBe('failing');
    expect(summary.counts).toEqual({ passing: 1, pending: 0, failing: 1, total: 2 });
  });

  it('handles checks with bucket values', () => {
    const checks: Check[] = [
      { name: 'build', state: 'SUCCESS', bucket: 'success' },
      { name: 'test', state: 'PENDING', bucket: 'pending' },
      { name: 'lint', state: 'SUCCESS', bucket: 'fail' },
    ];
    const summary = summarizeChecks(checks);
    expect(summary.overall).toBe('failing');
    expect(summary.counts).toEqual({ passing: 1, pending: 1, failing: 1, total: 3 });
  });

  it('returns passing with zero counts for an empty list', () => {
    const summary = summarizeChecks([]);
    expect(summary.overall).toBe('passing');
    expect(summary.counts).toEqual({ passing: 0, pending: 0, failing: 0, total: 0 });
  });
});

describe('classification matches MergeService.checkMergeGate contract', () => {
  it('classifies the same as the merge gate would on a mixed matrix', () => {
    // This table mirrors the logic in MergeService.ts lines 299-310.
    type Classification = 'passing' | 'pending' | 'failing';
    const matrix: Array<{ checks: Check[]; expected: Classification }> = [
      // All passing
      { checks: [{ name: 'a', state: 'SUCCESS' }], expected: 'passing' },
      // Failing by state
      { checks: [{ name: 'a', state: 'FAILURE' }], expected: 'failing' },
      { checks: [{ name: 'a', state: 'ERROR' }], expected: 'failing' },
      { checks: [{ name: 'a', state: 'CANCELLED' }], expected: 'failing' },
      { checks: [{ name: 'a', state: 'TIMED_OUT' }], expected: 'failing' },
      // Failing by bucket
      { checks: [{ name: 'a', state: 'SUCCESS', bucket: 'fail' }], expected: 'failing' },
      { checks: [{ name: 'a', state: 'SUCCESS', bucket: 'cancel' }], expected: 'failing' },
      // Pending by state
      { checks: [{ name: 'a', state: 'PENDING' }], expected: 'pending' },
      { checks: [{ name: 'a', state: 'IN_PROGRESS' }], expected: 'pending' },
      { checks: [{ name: 'a', state: 'QUEUED' }], expected: 'pending' },
      // Pending by bucket
      { checks: [{ name: 'a', state: 'SUCCESS', bucket: 'pending' }], expected: 'pending' },
      // Failing overrides pending
      { checks: [{ name: 'a', state: 'PENDING' }, { name: 'b', state: 'FAILURE' }], expected: 'failing' },
      // Pending overrides passing
      { checks: [{ name: 'a', state: 'SUCCESS' }, { name: 'b', state: 'PENDING' }], expected: 'pending' },
      // Empty list
      { checks: [], expected: 'passing' },
    ];

    for (const row of matrix) {
      expect(classifyChecks(row.checks)).toBe(row.expected);
    }
  });
});
