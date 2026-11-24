/**
 * pr-checks-summary — pure summariser for gh pr checks output
 *
 * AC1: A pure summariser turns gh pr checks --json name,state,bucket rows into
 * passing, failing, pending or none, with counts.
 *
 * The summariser must classify each row by its state and bucket, then aggregate
 * into a structured summary with state (passing|failing|pending|none) and counts
 * {passing, failing, pending, total}.
 */

import { describe, it, expect } from '@jest/globals';
import { summarizePrChecks } from '../../../renderer/lib/summary/pr-checks-summary';
import type { PrChecksSummary } from '../../../electron/services/GitHubService';

describe('summarizePrChecks', () => {
  it('returns none when input is empty', () => {
    const result: PrChecksSummary = summarizePrChecks([]);

    expect(result).toEqual({
      state: 'none',
      counts: { passing: 0, failing: 0, pending: 0, total: 0 },
    });
  });

  it('counts SUCCESS rows as passing', () => {
    const input = [
      { name: 'ci/test', state: 'SUCCESS', bucket: 'success' },
      { name: 'ci/lint', state: 'SUCCESS', bucket: 'success' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('passing');
    expect(result.counts.passing).toBe(2);
    expect(result.counts.total).toBe(2);
  });

  it('counts FAILURE rows as failing', () => {
    const input = [
      { name: 'ci/test', state: 'FAILURE', bucket: 'fail' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(1);
  });

  it('counts ERROR rows as failing', () => {
    const input = [
      { name: 'ci/test', state: 'ERROR', bucket: 'fail' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(1);
  });

  it('counts CANCELLED rows as failing', () => {
    const input = [
      { name: 'ci/test', state: 'CANCELLED', bucket: 'cancel' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(1);
  });

  it('counts TIMED_OUT rows as failing', () => {
    const input = [
      { name: 'ci/test', state: 'TIMED_OUT', bucket: 'fail' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('failing');
    expect(result.counts.failing).toBe(1);
  });

  it('counts PENDING rows as pending', () => {
    const input = [
      { name: 'ci/test', state: 'PENDING', bucket: 'pending' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('pending');
    expect(result.counts.pending).toBe(1);
  });

  it('counts IN_PROGRESS rows as pending', () => {
    const input = [
      { name: 'ci/test', state: 'IN_PROGRESS', bucket: 'in_progress' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('pending');
    expect(result.counts.pending).toBe(1);
  });

  it('counts QUEUED rows as pending', () => {
    const input = [
      { name: 'ci/test', state: 'QUEUED', bucket: 'queued' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('pending');
    expect(result.counts.pending).toBe(1);
  });

  it('bucket fail or cancel forces failing state even if other states present', () => {
    const input = [
      { name: 'ci/test', state: 'SUCCESS', bucket: 'success' },
      { name: 'ci/lint', state: 'SUCCESS', bucket: 'success' },
      { name: 'ci/security', state: 'SUCCESS', bucket: 'fail' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    // bucket overrides state
    expect(result.state).toBe('failing');
    expect(result.counts.passing).toBe(2);
    expect(result.counts.failing).toBe(1);
  });

  it('aggregates mixed states correctly', () => {
    const input = [
      { name: 'ci/test', state: 'SUCCESS', bucket: 'success' },
      { name: 'ci/lint', state: 'SUCCESS', bucket: 'success' },
      { name: 'ci/build', state: 'FAILURE', bucket: 'fail' },
      { name: 'ci/security', state: 'PENDING', bucket: 'pending' },
      { name: 'ci/docs', state: 'IN_PROGRESS', bucket: 'in_progress' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('failing'); // has a failure
    expect(result.counts.passing).toBe(2);
    expect(result.counts.failing).toBe(1);
    expect(result.counts.pending).toBe(2);
    expect(result.counts.total).toBe(5);
  });

  it('returns pending when all checks are pending', () => {
    const input = [
      { name: 'ci/test', state: 'PENDING', bucket: 'pending' },
      { name: 'ci/lint', state: 'IN_PROGRESS', bucket: 'in_progress' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('pending');
    expect(result.counts.pending).toBe(2);
  });

  it('bucket success overrides non-success state', () => {
    // Edge case: state says FAILURE but bucket says success — trust bucket
    const input = [
      { name: 'ci/test', state: 'FAILURE', bucket: 'success' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('passing');
    expect(result.counts.passing).toBe(1);
  });

  it('handles single check correctly', () => {
    const input = [
      { name: 'ci/test', state: 'SUCCESS', bucket: 'success' },
    ];
    const result: PrChecksSummary = summarizePrChecks(input);

    expect(result.state).toBe('passing');
    expect(result.counts).toEqual({ passing: 1, failing: 0, pending: 0, total: 1 });
  });
});
