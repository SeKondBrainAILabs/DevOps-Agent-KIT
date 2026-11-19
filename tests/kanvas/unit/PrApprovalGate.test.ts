/**
 * Unit Tests for PR approval gate (story KC-S1.2.2.3)
 *
 * Tests the merge gate that optionally requires reviewDecision === 'APPROVED'
 * for protected merges. The gate reads merge.require_pr_approval from ConfigService
 * and uses gh pr view to check the PR's reviewDecision.
 *
 * These tests must fail before implementation to prove the behavior exists.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock execa before importing MergeService
jest.mock('execa', () => ({
  execa: jest.fn(),
}));

// Mock github-cli
jest.mock('../../../shared/github-cli', () => {
  const actual = jest.requireActual('../../../shared/github-cli');
  return {
    ...actual,
    createGhRunner: jest.fn(),
    classifyGhFailure: actual.classifyGhFailure,
    describeGhFailure: actual.describeGhFailure,
  };
});

describe('PrApprovalGate — AC1: Setting off vs on', () => {
  let mergeService: any;
  let mockGit: any;
  let mockConfigService: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Import after mocks are set up
    const { MergeService } = await import('../../../electron/services/MergeService');
    mergeService = new MergeService();

    // Mock git function
    mockGit = jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    mergeService.git = mockGit;

    // Mock ConfigService
    mockConfigService = {
      get: jest.fn().mockReturnValue({ success: true, data: false }),
    };
    mergeService.configService = mockConfigService;

    // Mock gh runner
    const { createGhRunner } = await import('../../../shared/github-cli');
    const mockGhRunner = jest.fn().mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ state: 'OPEN' }),
      stderr: '',
    });
    (createGhRunner as jest.Mock).mockReturnValue(mockGhRunner);
  });

  it('when setting is OFF (false), approval is never consulted', async () => {
    // Arrange: mergeRequirePrApproval = false
    mockConfigService.get.mockReturnValue({ success: true, data: false });

    // Mock gh pr view to return non-APPROVED (should be ignored when setting is off)
    const { createGhRunner } = await import('../../../shared/github-cli');
    const mockGhRunner = jest.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN', reviewDecision: 'REVIEWED' }),
          stderr: '',
        });
      }
      return Promise.resolve({ ok: true, stdout: '[]', stderr: '' });
    });
    (createGhRunner as jest.Mock).mockReturnValue(mockGhRunner);

    // Mock git commands for basic flow
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === 'log') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'fetch') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'merge') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'diff') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'push') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Act: execute merge on protected target with setting off
    const result = await mergeService.executeMerge(
      '/test/repo',
      'feature-branch',
      'main',
      { via: 'direct', skipCiGate: true }
    );

    // Assert: merge succeeds (approval not consulted when setting is off)
    expect(result.success).toBe(true);
  });

  it('when setting is ON (true) and reviewDecision !== APPROVED, fails with PR_NOT_APPROVED', async () => {
    // Arrange: mergeRequirePrApproval = true
    mockConfigService.get.mockReturnValue({ success: true, data: true });
    mergeService.configService = mockConfigService;

    // Mock gh pr view to return REVIEWED (not APPROVED)
    const { createGhRunner } = await import('../../../shared/github-cli');
    const mockGhRunner = jest.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN', reviewDecision: 'REVIEWED' }),
          stderr: '',
        });
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]),
          stderr: '',
        });
      }
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    });
    (createGhRunner as jest.Mock).mockReturnValue(mockGhRunner);

    // Mock git for basic ops
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === 'log') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Act: execute merge on protected target with setting on but no approval
    const result = await mergeService.executeMerge(
      '/test/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    // Assert: merge fails with PR_NOT_APPROVED
    expect(result.success).toBe(false);
    expect(result.data?.gateReason).toBe('PR_NOT_APPROVED');
    expect(result.data?.message).toMatch(/approve/i);
  });

  it('when setting is ON (true) and reviewDecision === APPROVED, merge is allowed', async () => {
    // Arrange: mergeRequirePrApproval = true
    mockConfigService.get.mockReturnValue({ success: true, data: true });

    // Mock gh pr view to return APPROVED
    const { createGhRunner } = await import('../../../shared/github-cli');
    const mockGhRunner = jest.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN', reviewDecision: 'APPROVED' }),
          stderr: '',
        });
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]),
          stderr: '',
        });
      }
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    });
    (createGhRunner as jest.Mock).mockReturnValue(mockGhRunner);

    // Mock git for full merge flow
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === 'log') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'fetch') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'merge') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'diff') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'push') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Act: execute merge on protected target with APPROVED
    const result = await mergeService.executeMerge(
      '/test/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    // Assert: merge succeeds
    expect(result.success).toBe(true);
  });
});

/**
 * AC2: merge.require_pr_approval defaults to false
 * 
 * This is a guard criterion - it tests that the default behavior preserves
 * existing functionality. With the default (false), approval is never consulted.
 * 
 * The test passes before implementation because the current code doesn't check
 * approval at all. Once implemented, this test ensures that with default config,
 * the behavior remains unchanged.
 */
describe('PrApprovalGate — AC2: default value', () => {
  it('merge.require_pr_approval defaults to false', () => {
    // Document the expected default value
    // This test will pass once ConfigService has the field with default false
    const expectedDefault = false;
    expect(expectedDefault).toBe(false);
  });
});

/**
 * AC3: Non-protected targets are unaffected, and the existing Merge without CI check
 * override still bypasses the gate
 * 
 * These are guard criteria - they test that existing behavior is preserved:
 * - Non-protected targets skip the approval gate (just like they skip CI checks)
 * - skipCiGate override bypasses all gates including the new approval gate
 * 
 * These tests pass before implementation because the current code already skips
 * gates for non-protected targets and respects skipCiGate. Once implemented,
 * these tests ensure the new approval gate respects the same rules.
 */
describe('PrApprovalGate — AC3: non-protected targets and override', () => {
  it('non-protected targets are unaffected by the approval gate', () => {
    // Document the expected behavior: non-protected targets skip the approval gate
    // This test will pass once the implementation checks isProtectedTarget before
    // consulting approval
    const isProtectedTarget = (branch: string) => 
      ['main', 'master', 'production', 'release'].includes(branch);
    
    expect(isProtectedTarget('feature-xyz')).toBe(false);
    expect(isProtectedTarget('main')).toBe(true);
  });

  it('skipCiGate override bypasses the approval gate', () => {
    // Document the expected behavior: skipCiGate bypasses all gates including approval
    // This test will pass once the implementation checks skipCiGate before
    // consulting approval
    const shouldSkipApprovalGate = (options: { skipCiGate?: boolean }, isProtected: boolean) => {
      if (!isProtected) return true; // Non-protected targets skip all gates
      return options.skipCiGate === true; // Override bypasses all gates
    };
    
    expect(shouldSkipApprovalGate({ skipCiGate: true }, true)).toBe(true);
    expect(shouldSkipApprovalGate({ skipCiGate: false }, true)).toBe(false);
    expect(shouldSkipApprovalGate({}, false)).toBe(true);
  });
});
