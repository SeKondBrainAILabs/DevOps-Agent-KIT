/**
 * Unit Tests for shared/session-admission.ts limit clamping (story KIT-MCP-G2b)
 *
 * The caps became user-editable so people could spawn more than 4 sessions per
 * repo. `setSessionLimits` wrote whatever it was handed, which was tolerable
 * while only code called it — a number input makes 0, -1 and 3.5 reachable.
 *
 * 0 is the interesting one: it does not mean "unlimited", it means every
 * admission fails, and the user who typed it would have no idea why sessions
 * stopped being created.
 */

import { describe, it, expect } from '@jest/globals';
import { clampSessionLimit, SESSION_LIMIT_BOUNDS } from '../../../shared/session-admission';

describe('clampSessionLimit', () => {
  it('keeps a sensible value unchanged', () => {
    expect(clampSessionLimit(12)).toBe(12);
  });

  it('raises 0 to the minimum — 0 would refuse every session silently', () => {
    expect(clampSessionLimit(0)).toBe(SESSION_LIMIT_BOUNDS.min);
  });

  it('raises a negative to the minimum', () => {
    expect(clampSessionLimit(-5)).toBe(SESSION_LIMIT_BOUNDS.min);
  });

  it('caps an absurd value', () => {
    // Each session is a worktree, a watcher and a chokidar tree. Someone who
    // types 100000 has made a typo, not a capacity decision.
    expect(clampSessionLimit(100000)).toBe(SESSION_LIMIT_BOUNDS.max);
  });

  it('rounds a fractional value rather than storing it', () => {
    expect(clampSessionLimit(3.7)).toBe(4);
  });

  it('falls back to the default for NaN', () => {
    expect(clampSessionLimit(Number.NaN, 8)).toBe(8);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(clampSessionLimit('lots' as unknown as number, 8)).toBe(8);
  });

  it('falls back to the default for undefined', () => {
    expect(clampSessionLimit(undefined as unknown as number, 4)).toBe(4);
  });

  it('allows well past the old ceiling — the point of the change', () => {
    expect(clampSessionLimit(40)).toBe(40);
  });
});
