/**
 * PR Approval Gate tests (KC-S1.2.2.3)
 *
 * Tests that protected merges can optionally require reviewDecision === 'APPROVED'
 * via the merge.require_pr_approval setting.
 *
 * IMPORTANT: The approval gate is ONLY reached when:
 *   - resolved strategy is 'direct' AND
 *   - isProtectedTarget (main/master/production/release) AND
 *   - !skipCiGate
 *
 * Tests using via:'auto' with canOpenPr:true will resolve to 'pr' mode and
 * never reach the gate. Use via:'direct' (or make canOpenPr false) to
 * exercise the gate.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock github-cli BEFORE importing MergeService so the mock takes effect
jest.mock('../../../shared/github-cli', () => ({
  createGhRunner: jest.fn(),
  classifyGhFailure: jest.requireActual('../../../shared/github-cli').classifyGhFailure,
  describeGhFailure: jest.requireActual('../../../shared/github-cli').describeGhFailure,
}));

import { MergeService } from '../../../electron/services/MergeService';
import type { MergeVia } from '../../../shared/merge-strategy';
import { createGhRunner } from '../../../shared/github-cli';

// Mock config service interface (avoid electron-store ESM dependency)
interface MockConfigService {
  getAll: () => { success: boolean; data?: any };
  get: <K extends string>(key: K) => { success: boolean; data?: any };
  set: <K extends string>(key: K, value: any) => { success: boolean };
}

describe('PR Approval Gate', () => {
  let mergeService: MergeService;
  let mockConfig: MockConfigService;
  let configValue: any;

  beforeEach(() => {
    mergeService = new MergeService();
    configValue = {
      theme: 'dark',
      defaultAgentType: 'claude',
      recentProjects: [],
      autoWatch: true,
      autoPush: true,
      onboardingCompleted: false,
      telemetryOptIn: false,
      defaultLandingView: 'last-visited',
      // mergeRequirePrApproval defaults to undefined/false
    };

    // Create a mock config service
    mockConfig = {
      getAll: () => ({ success: true, data: { ...configValue } }),
      get: (key: string) => ({ success: true, data: configValue[key as keyof typeof configValue] }),
      set: (key: string, value: any) => {
        (configValue as any)[key] = value;
        return { success: true };
      },
    };

    mergeService.setConfigService(mockConfig as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /** AC2: merge.require_pr_approval defaults to false */
  it('default: mergeRequirePrApproval is false by default', () => {
    const result = mockConfig.getAll();
    expect(result.success).toBe(true);
    // The field should be absent or false when not set
    expect(result.data.mergeRequirePrApproval).toBeUndefined();
  });

  /** AC1: When flag is off, approval is never consulted */
  it('when require_pr_approval=false, approval is never consulted', async () => {
    // Set flag to false
    mockConfig.set('mergeRequirePrApproval', false);

    // Mock git commands to simulate a clean merge into protected branch
    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[],
      cwd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      // Simulate successful operations for merge
      if (args[0] === 'merge') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'push') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 }; // Not tracked
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'commit') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-branch', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'checkout') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'restore') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'log') {
        return { stdout: '', stderr: '', exitCode: 0 }; // No WIP commits
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    // Mock gh runner - track if reviewDecision is checked
    let reviewDecisionChecked = false;
    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      if (args[0] === 'pr' && args[1] === 'view') {
        // Check if we're asking for reviewDecision
        if (args.includes('--json')) {
          const jsonIdx = args.indexOf('--json');
          if (jsonIdx >= 0 && args[jsonIdx + 1]?.includes('reviewDecision')) {
            reviewDecisionChecked = true;
          }
        }
        // PR exists and is open
        return {
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN', url: 'https://github.com/test/pr/1' }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS', bucket: 'pass' }]),
          stderr: '',
          code: 0,
        };
      }
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    // When flag is off, merge should succeed without consulting approval
    expect(result.success).toBe(true);
    expect(result.gateReason).toBeUndefined();
    expect(reviewDecisionChecked).toBe(false);

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });

  /** AC1: When flag is on and reviewDecision is not APPROVED, merge is refused */
  it('refuses merge when require_pr_approval=true and reviewDecision=CHANGES_REQUESTED', async () => {
    mockConfig.set('mergeRequirePrApproval', true);

    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[]
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === 'log') {
        return { stdout: '', stderr: '', exitCode: 0 }; // No WIP commits
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-branch', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) {
        const jsonIdx = args.indexOf('--json');
        if (jsonIdx >= 0 && args[jsonIdx + 1]?.includes('reviewDecision')) {
          return {
            ok: true,
            stdout: JSON.stringify({ reviewDecision: 'CHANGES_REQUESTED' }),
            stderr: '',
            code: 0,
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN', url: 'https://github.com/test/pr/1' }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS', bucket: 'pass' }]),
          stderr: '',
          code: 0,
        };
      }
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    expect(result.success).toBe(false);
    expect(result.gateReason).toBe('PR_NOT_APPROVED');
    expect(result.message).toMatch(/approved/i);

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });

  /** AC1: When flag is on and reviewDecision is REVIEW_REQUIRED, merge is refused */
  it('refuses merge when require_pr_approval=true and reviewDecision=REVIEW_REQUIRED', async () => {
    mockConfig.set('mergeRequirePrApproval', true);

    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[]
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === 'log') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-branch', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) {
        const jsonIdx = args.indexOf('--json');
        if (jsonIdx >= 0 && args[jsonIdx + 1]?.includes('reviewDecision')) {
          return {
            ok: true,
            stdout: JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED' }),
            stderr: '',
            code: 0,
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN' }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]),
          stderr: '',
          code: 0,
        };
      }
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    expect(result.success).toBe(false);
    expect(result.gateReason).toBe('PR_NOT_APPROVED');

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });

  /** AC1: When flag is on and reviewDecision is APPROVED, merge is allowed */
  it('allows merge when require_pr_approval=true and reviewDecision=APPROVED', async () => {
    mockConfig.set('mergeRequirePrApproval', true);

    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[],
      cwd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === 'log') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'push') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'commit') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-branch', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'checkout') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'restore') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) {
        const jsonIdx = args.indexOf('--json');
        if (jsonIdx >= 0 && args[jsonIdx + 1]?.includes('reviewDecision')) {
          return {
            ok: true,
            stdout: JSON.stringify({ reviewDecision: 'APPROVED' }),
            stderr: '',
            code: 0,
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({ state: 'OPEN' }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return {
          ok: true,
          stdout: JSON.stringify([{ name: 'CI', state: 'SUCCESS' }]),
          stderr: '',
          code: 0,
        };
      }
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-branch',
      'main',
      { via: 'direct' }
    );

    expect(result.success).toBe(true);
    expect(result.gateReason).toBeUndefined();

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });

  /** AC3: Non-protected targets are unaffected */
  it('non-protected targets are unaffected by the approval gate', async () => {
    mockConfig.set('mergeRequirePrApproval', true);

    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[]
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === 'merge') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'push') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'commit') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-1', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    // Mock gh runner (should not be called for non-protected targets)
    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    // Merge into non-protected branch (feature-2) should succeed
    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-1',
      'feature-2',
      { via: 'direct' }
    );

    expect(result.success).toBe(true);
    expect(result.gateReason).toBeUndefined();

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });

  /** AC3: skipCiGate bypasses the approval gate entirely */
  it('override: skipCiGate=true bypasses the approval gate even when flag is on', async () => {
    mockConfig.set('mergeRequirePrApproval', true);

    const mockGit = jest.spyOn(mergeService as any, 'git').mockImplementation(async (
      args: string[],
      cwd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === 'log') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'push') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'commit') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature-branch', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'worktree') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'checkout') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'restore') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    // Mock gh runner (should not be called when skipCiGate is true)
    const mockRunner = jest.fn(async (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });

    (createGhRunner as jest.Mock).mockReturnValue(mockRunner);

    // skipCiGate should bypass the approval check entirely
    const result = await mergeService.executeMerge(
      '/fake/repo',
      'feature-branch',
      'main',
      { via: 'direct', skipCiGate: true }
    );

    expect(result.success).toBe(true);
    expect(result.gateReason).toBeUndefined();

    mockGit.mockRestore();
    (createGhRunner as jest.Mock).mockRestore();
  });
});
