/**
 * Unit tests for GitSyncStatus drift level calculation (FR-3.2 ranges)
 * Drift levels: 0=green, 1-5=yellow, 6-20=orange, 21+=red
 */

import { describe, it, expect } from '@jest/globals';
import { getSyncDriftLevel } from '../../../renderer/utils/gitDrift';

describe('getSyncDriftLevel', () => {
  it('returns green for 0 behind (up to date)', () => {
    expect(getSyncDriftLevel(0)).toBe('green');
  });

  it('returns yellow for 1 behind', () => {
    expect(getSyncDriftLevel(1)).toBe('yellow');
  });

  it('returns yellow for 5 behind (upper boundary of yellow)', () => {
    expect(getSyncDriftLevel(5)).toBe('yellow');
  });

  it('returns orange for 6 behind (lower boundary of orange)', () => {
    expect(getSyncDriftLevel(6)).toBe('orange');
  });

  it('returns orange for 20 behind (upper boundary of orange - inclusive per FR-3.2)', () => {
    expect(getSyncDriftLevel(20)).toBe('orange');
  });

  it('returns red for 21 behind (lower boundary of red)', () => {
    expect(getSyncDriftLevel(21)).toBe('red');
  });

  it('returns red for 50 behind', () => {
    expect(getSyncDriftLevel(50)).toBe('red');
  });

  it('returns red for 100 behind', () => {
    expect(getSyncDriftLevel(100)).toBe('red');
  });

  it('handles boundary at 5 vs 6 correctly (yellow->orange transition)', () => {
    expect(getSyncDriftLevel(5)).toBe('yellow');
    expect(getSyncDriftLevel(6)).toBe('orange');
  });

  it('handles boundary at 20 vs 21 correctly (orange->red transition)', () => {
    expect(getSyncDriftLevel(20)).toBe('orange');
    expect(getSyncDriftLevel(21)).toBe('red');
  });
});
