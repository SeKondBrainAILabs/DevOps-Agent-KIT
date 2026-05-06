/**
 * Unit Tests for F3 — Bulk action runner + aggregator
 */

import { describe, it, expect } from '@jest/globals';
import { formatBulkMessage, runBulkAction } from '../../../shared/bulk-action';

describe('formatBulkMessage (F3)', () => {
  it('handles empty list', () => {
    expect(formatBulkMessage('pull', 0, 0)).toMatch(/No repos to pull/);
  });
  it('all-success message uses "succeeded on all"', () => {
    expect(formatBulkMessage('fetch', 4, 0)).toBe('fetch succeeded on all 4 repos.');
    expect(formatBulkMessage('fetch', 1, 0)).toBe('fetch succeeded on all 1 repo.');
  });
  it('all-fail message uses "failed on all"', () => {
    expect(formatBulkMessage('status', 0, 3)).toBe('status failed on all 3 repos.');
  });
  it('mixed message lists counts', () => {
    expect(formatBulkMessage('pull', 2, 1)).toBe('pull: 2 succeeded, 1 failed (of 3).');
  });
});

describe('runBulkAction (F3)', () => {
  it('runs the op against every repo and aggregates results', async () => {
    let tick = 100;
    const out = await runBulkAction({
      repos: [{ repoName: 'a' }, { repoName: 'b' }],
      op: async (repo) => `ok:${repo.repoName}`,
      actionLabel: 'pull',
      now: () => {
        tick += 1;
        return tick;
      },
    });
    expect(out.okCount).toBe(2);
    expect(out.failedCount).toBe(0);
    expect(out.results.map((r) => r.data)).toEqual(['ok:a', 'ok:b']);
    expect(out.message).toMatch(/succeeded on all 2/);
  });

  it('isolates failures — one bad repo does not affect the others', async () => {
    const out = await runBulkAction({
      repos: [{ repoName: 'a' }, { repoName: 'b' }, { repoName: 'c' }],
      op: async (repo) => {
        if (repo.repoName === 'b') throw new Error('boom');
        return `ok:${repo.repoName}`;
      },
      actionLabel: 'fetch',
    });
    expect(out.okCount).toBe(2);
    expect(out.failedCount).toBe(1);
    const fail = out.results.find((r) => !r.ok)!;
    expect(fail.repoName).toBe('b');
    expect(fail.error).toBe('boom');
    expect(out.message).toMatch(/2 succeeded, 1 failed/);
  });

  it('captures non-Error throws as strings', async () => {
    const out = await runBulkAction({
      repos: [{ repoName: 'a' }],
      op: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string-error';
      },
      actionLabel: 'pull',
    });
    expect(out.results[0].error).toBe('string-error');
  });

  it('records per-attempt + total durationMs', async () => {
    let now = 0;
    const out = await runBulkAction({
      repos: [{ repoName: 'a' }],
      op: async () => 'ok',
      actionLabel: 'status',
      now: () => {
        now += 5;
        return now;
      },
    });
    expect(out.results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(out.durationMs).toBeGreaterThanOrEqual(out.results[0].durationMs);
  });

  it('handles empty repo list', async () => {
    const out = await runBulkAction({
      repos: [],
      op: async () => 'never',
      actionLabel: 'pull',
    });
    expect(out.results).toEqual([]);
    expect(out.message).toMatch(/No repos to pull/);
  });
});
