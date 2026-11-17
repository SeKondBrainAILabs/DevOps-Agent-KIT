/**
 * Unit tests for gitDrift utility module
 * Tests the getSyncDriftLevel function exported from renderer/utils/gitDrift.ts
 */

import { describe, it, expect } from '@jest/globals';
import { getSyncDriftLevel } from '../../../renderer/utils/gitDrift';

// Note: This test file verifies the gitDrift module exports correctly
// The actual drift calculation logic is tested in SyncDriftLevel.test.ts
describe('gitDrift module', () => {
  it('exports getSyncDriftLevel function', () => {
    expect(typeof getSyncDriftLevel).toBe('function');
  });

  it('getSyncDriftLevel handles edge cases', () => {
    // Test negative values (should not happen in practice but function should handle)
    expect(getSyncDriftLevel(-1)).toBe('green'); // Treat negative as 0
    
    // Test very large values
    expect(getSyncDriftLevel(999999)).toBe('red');
  });

  it('getSyncDriftLevel is deterministic', () => {
    // Same input should always produce same output
    const result1 = getSyncDriftLevel(10);
    const result2 = getSyncDriftLevel(10);
    expect(result1).toBe(result2);
    expect(result1).toBe('orange');
  });
});
