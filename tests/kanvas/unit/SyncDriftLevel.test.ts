/**
 * Unit tests for driftLevel function
 * Tests boundary values per story: 0 green, 1-5 yellow, 6-20 orange (inclusive), 21+ red
 */

import { describe, test, expect } from '@jest/globals';
import { driftLevel } from '../../../shared/git-sync-drift';

describe('driftLevel', () => {
  // Green: 0 commits behind
  test('returns green for 0 commits behind', () => {
    expect(driftLevel(0)).toBe('green');
  });

  // Yellow: 1-5 commits behind
  test('returns yellow for 1 commit behind', () => {
    expect(driftLevel(1)).toBe('yellow');
  });

  test('returns yellow for 5 commits behind (upper boundary)', () => {
    expect(driftLevel(5)).toBe('yellow');
  });

  // Orange: 6-20 commits behind (inclusive of 20)
  test('returns orange for 6 commits behind (lower boundary)', () => {
    expect(driftLevel(6)).toBe('orange');
  });

  test('returns orange for 20 commits behind (upper boundary, inclusive)', () => {
    expect(driftLevel(20)).toBe('orange');
  });

  test('returns orange for 12 commits behind (mid-range)', () => {
    expect(driftLevel(12)).toBe('orange');
  });

  // Red: 21+ commits behind
  test('returns red for 21 commits behind (lower boundary)', () => {
    expect(driftLevel(21)).toBe('red');
  });

  test('returns red for 50 commits behind', () => {
    expect(driftLevel(50)).toBe('red');
  });

  // Edge cases
  test('returns green for negative values', () => {
    expect(driftLevel(-1)).toBe('green');
    expect(driftLevel(-10)).toBe('green');
  });
});
