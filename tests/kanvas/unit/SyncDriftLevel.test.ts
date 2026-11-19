/**
 * Unit Tests for Sync Drift Level Calculation
 * Tests the drift level color coding: 0=green, 1-5=yellow, 6-20=orange, 21+=red
 */

import { describe, it, expect } from '@jest/globals';

// Import the functions we're testing (will be created by the Coder)
import { getSyncDriftLevel, getColorClass } from '../../../shared/git-sync-drift';

describe('getSyncDriftLevel', () => {
  it('returns level 1 (green) for 0 commits behind', () => {
    expect(getSyncDriftLevel(0)).toBe(1);
  });

  it('returns level 2 (yellow) for 1 commit behind', () => {
    expect(getSyncDriftLevel(1)).toBe(2);
  });

  it('returns level 2 (yellow) for 5 commits behind', () => {
    expect(getSyncDriftLevel(5)).toBe(2);
  });

  it('returns level 3 (orange) for 6 commits behind', () => {
    expect(getSyncDriftLevel(6)).toBe(3);
  });

  it('returns level 3 (orange) for 20 commits behind (inclusive)', () => {
    expect(getSyncDriftLevel(20)).toBe(3);
  });

  it('returns level 4 (red) for 21 commits behind', () => {
    expect(getSyncDriftLevel(21)).toBe(4);
  });

  it('returns level 4 (red) for 100 commits behind', () => {
    expect(getSyncDriftLevel(100)).toBe(4);
  });

  it('handles negative values gracefully (treats as 0)', () => {
    expect(getSyncDriftLevel(-1)).toBe(1);
  });
});

describe('getColorClass', () => {
  it('returns green color class for level 1', () => {
    expect(getColorClass(1)).toBe('text-green-500');
  });

  it('returns yellow color class for level 2', () => {
    expect(getColorClass(2)).toBe('text-yellow-500');
  });

  it('returns orange color class for level 3', () => {
    expect(getColorClass(3)).toBe('text-orange-500');
  });

  it('returns red color class for level 4', () => {
    expect(getColorClass(4)).toBe('text-red-500');
  });

  it('defaults to gray for unknown levels', () => {
    expect(getColorClass(0)).toBe('text-gray-400');
    expect(getColorClass(5)).toBe('text-gray-400');
  });
});

describe('Integration: drift level to color mapping', () => {
  it('0 behind → green', () => {
    const level = getSyncDriftLevel(0);
    expect(getColorClass(level)).toBe('text-green-500');
  });

  it('1-5 behind → yellow', () => {
    [1, 2, 3, 4, 5].forEach(behind => {
      const level = getSyncDriftLevel(behind);
      expect(getColorClass(level)).toBe('text-yellow-500');
    });
  });

  it('6-20 behind → orange', () => {
    [6, 10, 15, 20].forEach(behind => {
      const level = getSyncDriftLevel(behind);
      expect(getColorClass(level)).toBe('text-orange-500');
    });
  });

  it('21+ behind → red', () => {
    [21, 30, 50, 100].forEach(behind => {
      const level = getSyncDriftLevel(behind);
      expect(getColorClass(level)).toBe('text-red-500');
    });
  });
});
