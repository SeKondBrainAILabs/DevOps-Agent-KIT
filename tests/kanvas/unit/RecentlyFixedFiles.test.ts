/**
 * Unit Tests for Q2 — Recently-fixed-file edit alert
 */

import { describe, it, expect } from '@jest/globals';
import {
  evaluateRecentlyFixedAlert,
  indexFixHistory,
  type FixHistoryEntry,
} from '../../../shared/recently-fixed-files';

const NOW = new Date('2026-05-01T00:00:00.000Z').getTime();
const daysAgo = (n: number): string => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const fix = (filePath: string, daysSince: number, sha = 'abc123def4'): FixHistoryEntry => ({
  filePath,
  lastFixAt: daysAgo(daysSince),
  fixSha: sha,
});

describe('evaluateRecentlyFixedAlert (Q2)', () => {
  it('does not warn when file has no fix history', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [],
      now: NOW,
    });
    expect(r.shouldWarn).toBe(false);
    expect(r.kind).toBe('no-fix-history');
  });

  it('does not warn when most-recent fix is OUTSIDE the window', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [fix('src/x.ts', 30)],
      now: NOW,
      windowDays: 7,
    });
    expect(r.shouldWarn).toBe(false);
    expect(r.kind).toBe('fix-outside-window');
    expect(r.daysSinceFix).toBe(30);
  });

  it('WARNS when fix is within the window (default 7 days)', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [fix('src/x.ts', 3)],
      now: NOW,
    });
    expect(r.shouldWarn).toBe(true);
    expect(r.kind).toBe('warn-recently-fixed');
    expect(r.fixSha).toBe('abc123def4');
    expect(r.message).toMatch(/abc123d/); // short sha in message
  });

  it('honors a custom window', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [fix('src/x.ts', 14)],
      now: NOW,
      windowDays: 30,
    });
    expect(r.shouldWarn).toBe(true);
  });

  it('does not warn when user has already acknowledged this session', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [fix('src/x.ts', 1)],
      now: NOW,
      acknowledged: true,
    });
    expect(r.shouldWarn).toBe(false);
    expect(r.kind).toBe('acknowledged');
  });

  it('treats unparseable lastFixAt as no-history (defensive)', () => {
    const r = evaluateRecentlyFixedAlert({
      filePath: 'src/x.ts',
      history: [{ filePath: 'src/x.ts', lastFixAt: 'not-a-date', fixSha: 'a' }],
      now: NOW,
    });
    expect(r.shouldWarn).toBe(false);
    expect(r.kind).toBe('no-fix-history');
  });
});

describe('indexFixHistory (Q2)', () => {
  it('keeps the most-recent fix on dup file paths', () => {
    const idx = indexFixHistory([
      fix('src/x.ts', 30, 'older'),
      fix('src/x.ts', 1, 'newer'),
      fix('src/y.ts', 5, 'just-y'),
    ]);
    expect(idx.size).toBe(2);
    expect(idx.get('src/x.ts')?.fixSha).toBe('newer');
    expect(idx.get('src/y.ts')?.fixSha).toBe('just-y');
  });
});
