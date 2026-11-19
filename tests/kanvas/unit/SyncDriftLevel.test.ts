/**
 * Unit tests for sync drift level and color logic
 * Tests for AC1: Drift level color thresholds
 */

import { getDriftLevel, getDriftColor, getDriftColorFromCount } from '../../../shared/git-sync-drift';

describe('getDriftLevel', () => {
  test('0 behind returns level 0 (green)', () => {
    expect(getDriftLevel(0)).toBe(0);
  });

  test('1 behind returns level 1 (yellow)', () => {
    expect(getDriftLevel(1)).toBe(1);
  });

  test('5 behind returns level 1 (yellow)', () => {
    expect(getDriftLevel(5)).toBe(1);
  });

  test('6 behind returns level 2 (orange)', () => {
    expect(getDriftLevel(6)).toBe(2);
  });

  test('20 behind returns level 2 (orange) - inclusive upper bound', () => {
    expect(getDriftLevel(20)).toBe(2);
  });

  test('21 behind returns level 3 (red)', () => {
    expect(getDriftLevel(21)).toBe(3);
  });

  test('100 behind returns level 3 (red)', () => {
    expect(getDriftLevel(100)).toBe(3);
  });

  test('negative values return level 0', () => {
    expect(getDriftLevel(-1)).toBe(0);
  });
});

describe('getDriftColor', () => {
  test('level 0 returns green-500', () => {
    expect(getDriftColor(0)).toBe('green-500');
  });

  test('level 1 returns yellow-500', () => {
    expect(getDriftColor(1)).toBe('yellow-500');
  });

  test('level 2 returns orange-500', () => {
    expect(getDriftColor(2)).toBe('orange-500');
  });

  test('level 3 returns red-500', () => {
    expect(getDriftColor(3)).toBe('red-500');
  });
});

describe('getDriftColorFromCount', () => {
  test('0 behind returns green-500', () => {
    expect(getDriftColorFromCount(0)).toBe('green-500');
  });

  test('3 behind returns yellow-500', () => {
    expect(getDriftColorFromCount(3)).toBe('yellow-500');
  });

  test('10 behind returns orange-500', () => {
    expect(getDriftColorFromCount(10)).toBe('orange-500');
  });

  test('50 behind returns red-500', () => {
    expect(getDriftColorFromCount(50)).toBe('red-500');
  });
});
