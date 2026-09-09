/**
 * Unit Tests for K1 — Notification dedup + aggregation
 */

import { describe, it, expect } from '@jest/globals';
import {
  aggregateNotifications,
  type RawNotification,
} from '../../../shared/notification-dedup';

const minute = 60 * 1000;
const t = (offsetMs: number, baseMs = Date.parse('2026-05-01T00:00:00.000Z')) =>
  new Date(baseMs + offsetMs).toISOString();

const event = (
  type: string,
  dedupKey: string,
  atMs: number,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'warning',
  extras: Partial<RawNotification> = {}
): RawNotification => ({
  type,
  dedupKey,
  at: t(atMs),
  severity,
  title: `${type}/${dedupKey}`,
  ...extras,
});

describe('aggregateNotifications — dedup window (K1)', () => {
  it('collapses identical events within 5 minutes', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0),
      event('ci-failure', 'pr-1', minute * 2),
      event('ci-failure', 'pr-1', minute * 4),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].firstAt).toBe(t(0));
    expect(out[0].lastAt).toBe(t(minute * 4));
  });

  it('starts a new bucket when window is exceeded', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0),
      event('ci-failure', 'pr-1', minute * 6), // >5min
    ]);
    expect(out).toHaveLength(2);
  });

  it('honors a custom dedup window', () => {
    const out = aggregateNotifications(
      [event('ci-failure', 'pr-1', 0), event('ci-failure', 'pr-1', minute * 6)],
      { dedupWindowMinutes: 10 }
    );
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });
});

describe('aggregateNotifications — distinct buckets (K1)', () => {
  it('different types are not merged', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0),
      event('pr-review', 'pr-1', minute),
    ]);
    expect(out).toHaveLength(2);
  });

  it('different dedupKeys are not merged', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0),
      event('ci-failure', 'pr-2', minute),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('aggregateNotifications — severity escalation (K1)', () => {
  it('merged record carries the highest severity seen', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0, 'warning'),
      event('ci-failure', 'pr-1', minute, 'critical'),
      event('ci-failure', 'pr-1', minute * 2, 'info'),
    ]);
    expect(out[0].severity).toBe('critical');
  });
});

describe('aggregateNotifications — last-wins context (K1)', () => {
  it('uses the most recent title / body / source', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'pr-1', 0, 'warning', {
        title: 'old title',
        body: 'old body',
        source: 'old',
      }),
      event('ci-failure', 'pr-1', minute, 'warning', {
        title: 'new title',
        body: 'new body',
        source: 'new',
      }),
    ]);
    expect(out[0].title).toBe('new title');
    expect(out[0].body).toBe('new body');
    expect(out[0].source).toBe('new');
  });
});

describe('aggregateNotifications — sort order (K1)', () => {
  it('output is newest-lastAt first', () => {
    const out = aggregateNotifications([
      event('ci-failure', 'old', 0),
      event('ci-failure', 'new', minute * 60), // 1h later
      event('ci-failure', 'middle', minute * 30),
    ]);
    expect(out.map((n) => n.dedupKey)).toEqual(['new', 'middle', 'old']);
  });
});
