/**
 * Unit Tests for the history-rewrite lockfile classifier.
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildLockPayload,
  classifyLockState,
  DEFAULT_STALE_MS,
} from '../../../shared/history-rewrite-lock';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const goodJson = (opts: {
  ageMs?: number;
  pid?: number;
  reason?: string;
} = {}) =>
  JSON.stringify({
    pid: opts.pid ?? 12345,
    reason: opts.reason ?? 'rebase feat/x onto origin/main',
    acquiredAt: iso(-(opts.ageMs ?? 60_000)),
    hostname: 'testhost',
  });

describe('classifyLockState', () => {
  it('returns absent when contents is null', () => {
    const r = classifyLockState({ contents: null, pidAlive: false, now: NOW });
    expect(r).toEqual({ present: false });
  });

  it('returns absent on malformed JSON', () => {
    const r = classifyLockState({ contents: '{not-json', pidAlive: true, now: NOW });
    expect(r).toEqual({ present: false });
  });

  it('returns absent when required fields are missing', () => {
    const r = classifyLockState({ contents: '{"pid":123}', pidAlive: true, now: NOW });
    expect(r).toEqual({ present: false });
  });

  it('present + fresh when lock is recent and PID alive', () => {
    const r = classifyLockState({ contents: goodJson(), pidAlive: true, now: NOW });
    expect(r.present).toBe(true);
    if (r.present) {
      expect(r.stale).toBe(false);
      expect(r.payload.pid).toBe(12345);
      expect(r.payload.reason).toMatch(/rebase feat\/x/);
    }
  });

  it('present + stale when PID is dead (regardless of age)', () => {
    const r = classifyLockState({
      contents: goodJson({ ageMs: 1000 }), // recent
      pidAlive: false,
      now: NOW,
    });
    if (r.present) expect(r.stale).toBe(true);
  });

  it('present + stale when age > DEFAULT_STALE_MS (even if PID alive)', () => {
    const r = classifyLockState({
      contents: goodJson({ ageMs: DEFAULT_STALE_MS + 60_000 }),
      pidAlive: true,
      now: NOW,
    });
    if (r.present) expect(r.stale).toBe(true);
  });

  it('honors a custom staleAfterMs threshold', () => {
    const r = classifyLockState({
      contents: goodJson({ ageMs: 5 * 60 * 1000 }),
      pidAlive: true,
      now: NOW,
      staleAfterMs: 60 * 1000, // 1 min
    });
    if (r.present) expect(r.stale).toBe(true);
  });
});

describe('buildLockPayload', () => {
  it('populates pid, reason, acquiredAt', () => {
    const p = buildLockPayload('test reason', { pid: 42, now: () => NOW });
    expect(p.pid).toBe(42);
    expect(p.reason).toBe('test reason');
    expect(p.acquiredAt).toBe('2026-07-22T12:00:00.000Z');
  });

  it('defaults pid to process.pid', () => {
    const p = buildLockPayload('r');
    expect(p.pid).toBe(process.pid);
  });
});
