/**
 * Unit Tests for Q4 — Coverage merge-gate consumer
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateCoverageGate } from '../../../shared/coverage-gate';

const NOW = new Date('2026-05-01T00:00:00.000Z').getTime();
const fresh = new Date(NOW - 60_000).toISOString(); // 1 min ago
const stale = new Date(NOW - 60 * 60_000).toISOString(); // 1 hr ago

describe('evaluateCoverageGate — disabled / missing signal (Q4)', () => {
  it('allows when policy disabled', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: false },
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-policy-disabled');
  });

  it('allows when signal missing (with explanatory message)', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.7 },
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-signal-missing');
    expect(r.message).toMatch(/QA Agent/);
  });

  it('treats stale signal as missing', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, maxSignalAgeMinutes: 30 },
      signal: { coverage: 0.5, baseCoverage: 0.9, emittedAt: stale },
      now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-signal-missing');
  });
});

describe('evaluateCoverageGate — pass / fail (Q4)', () => {
  it('allows when coverage at or above floor and drop within limit', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.7, maxDropPp: 1 },
      signal: { coverage: 0.85, baseCoverage: 0.85, emittedAt: fresh },
      now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-passed');
    expect(r.dropPp).toBe(0);
  });

  it('blocks when coverage is below absolute floor', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.7 },
      signal: { coverage: 0.65, baseCoverage: 0.7, emittedAt: fresh },
      now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-below-floor');
    expect(r.message).toMatch(/below the absolute floor/);
  });

  it('blocks when drop exceeds maxDropPp', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, maxDropPp: 1 },
      signal: { coverage: 0.85, baseCoverage: 0.9, emittedAt: fresh },
      now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-drop-exceeded');
    expect(r.dropPp).toBeCloseTo(5);
    expect(r.message).toMatch(/dropped/);
  });

  it('floor check wins over drop check (lowest threshold blocks)', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.8, maxDropPp: 100 },
      signal: { coverage: 0.5, baseCoverage: 0.5, emittedAt: fresh },
      now: NOW,
    });
    expect(r.kind).toBe('blocked-below-floor');
  });
});

describe('evaluateCoverageGate — override (Q4)', () => {
  it('allows blocked PR with override + non-empty reason', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.9 },
      signal: { coverage: 0.5, baseCoverage: 0.95, emittedAt: fresh },
      override: true,
      overrideReason: 'experimental file excluded; coverage instrumented next PR',
      now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-override');
    expect(r.overrideMetadata?.reason).toMatch(/experimental/);
  });

  it('blocks override when reason is empty / whitespace', () => {
    const r = evaluateCoverageGate({
      policy: { enabled: true, absoluteFloor: 0.9 },
      signal: { coverage: 0.5, baseCoverage: 0.95, emittedAt: fresh },
      override: true,
      overrideReason: '   ',
      now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-override-without-reason');
  });
});
