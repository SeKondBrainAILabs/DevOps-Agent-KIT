/**
 * summarizePrChecks — the pure summariser behind the CI badge on the Review tab.
 *
 * The badge is only as trustworthy as this function: it turns a list of
 * `gh pr checks` rows into one of four states plus counts, and the whole point
 * of doing it in a pure module is that the priority rules (failing beats
 * pending beats passing) and the bucket override are testable without a
 * renderer or a network call.
 *
 * Classification is deliberately the same rule the merge gate uses
 * (electron/services/MergeService.ts): a FAILURE/ERROR/CANCELLED/TIMED_OUT
 * state or a `fail`/`cancel` bucket is failing; PENDING/IN_PROGRESS/QUEUED or
 * a `pending` bucket is pending; everything else is passing.
 */

import { describe, it, expect } from '@jest/globals';

import { summarizePrChecks } from '../../../shared/pr-checks-summary';

type CheckRow = { name: string; state: string; bucket?: string };

const passing = (name: string): CheckRow => ({ name, state: 'SUCCESS', bucket: 'pass' });
const failing = (name: string): CheckRow => ({ name, state: 'FAILURE', bucket: 'fail' });
const pending = (name: string): CheckRow => ({ name, state: 'IN_PROGRESS', bucket: 'pending' });

describe('summarizePrChecks', () => {
  it('reports "none" for an empty check list', () => {
    const s = summarizePrChecks([] as CheckRow[]);
    expect(s.state).toBe('none');
    expect(s.counts).toEqual({ passing: 0, failing: 0, pending: 0, total: 0 });
  });

  it('reports "passing" when every check passed', () => {
    const s = summarizePrChecks([passing('build'), passing('test')] as CheckRow[]);
    expect(s.state).toBe('passing');
    expect(s.counts).toEqual({ passing: 2, failing: 0, pending: 0, total: 2 });
  });

  it('reports "pending" when a check is still running and none failed', () => {
    const s = summarizePrChecks([passing('build'), pending('test')] as CheckRow[]);
    expect(s.state).toBe('pending');
    expect(s.counts).toEqual({ passing: 1, failing: 0, pending: 1, total: 2 });
  });

  it('reports "failing" when any check failed, even alongside pending and passing', () => {
    const s = summarizePrChecks([passing('build'), pending('test'), failing('lint')] as CheckRow[]);
    expect(s.state).toBe('failing');
    expect(s.counts).toEqual({ passing: 1, failing: 1, pending: 1, total: 3 });
  });

  it('classifies by bucket when the state string is unfamiliar', () => {
    const s = summarizePrChecks([
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'lint', state: 'COMPLETED', bucket: 'fail' },
    ] as CheckRow[]);
    expect(s.state).toBe('failing');
    expect(s.counts.failing).toBe(1);
    expect(s.counts.passing).toBe(1);
  });

  it('treats a fail bucket as failing even when the state reads as success', () => {
    // A bucket is GitHub's own roll-up and wins over a stale-looking state.
    const s = summarizePrChecks([{ name: 'build', state: 'SUCCESS', bucket: 'fail' }] as CheckRow[]);
    expect(s.state).toBe('failing');
    expect(s.counts.failing).toBe(1);
  });

  it('treats a pending bucket as pending even when the state reads as success', () => {
    const s = summarizePrChecks([{ name: 'build', state: 'SUCCESS', bucket: 'pending' }] as CheckRow[]);
    expect(s.state).toBe('pending');
    expect(s.counts.pending).toBe(1);
  });

  it('counts total correctly regardless of state', () => {
    const s = summarizePrChecks([
      passing('a'),
      failing('b'),
      pending('c'),
      { name: 'd', state: 'SUCCESS', bucket: 'success' },
    ] as CheckRow[]);
    expect(s.counts.total).toBe(4);
    expect(s.counts.passing + s.counts.failing + s.counts.pending).toBe(4);
    expect(s.state).toBe('failing');
  });

  it('recognises the full set of failing states the merge gate treats as red', () => {
    const states = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'];
    for (const state of states) {
      const s = summarizePrChecks([{ name: 'x', state }] as CheckRow[]);
      expect(s.state).toBe('failing');
      expect(s.counts.failing).toBe(1);
    }
  });

  it('recognises the full set of pending states the merge gate treats as running', () => {
    const states = ['PENDING', 'IN_PROGRESS', 'QUEUED'];
    for (const state of states) {
      const s = summarizePrChecks([{ name: 'x', state }] as CheckRow[]);
      expect(s.state).toBe('pending');
      expect(s.counts.pending).toBe(1);
    }
  });
});
