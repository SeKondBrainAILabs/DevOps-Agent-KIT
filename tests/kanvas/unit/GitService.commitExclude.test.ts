/**
 * GitService.commit exclude parameter tests (AC1)
 *
 * Tests that GitService.commit with exclude: string[] unstages those paths
 * with `git reset -q -- <paths>` after staging, and throws 'nothing to commit'
 * when nothing is left staged.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock execa module — provide both default and named execa to handle all import patterns
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

// Import the GitService class
import { GitService } from '../../../electron/services/GitService';

describe('GitService.commit with exclude', () => {
  let gitService: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
  });

  function mockWorktree(sessionId: string, worktreePath: string) {
    gitService.registerWorktree(sessionId, worktreePath, worktreePath);
  }

  // Helper to mock git commands for a successful commit
  function mockSuccessfulCommit() {
    // git add -A (stageAllChanges)
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
    // git commit -m
    mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] feat: test' } as never);
    // git rev-parse HEAD
    mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456789' } as never);
    // git rev-parse --short HEAD
    mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
    // git log -1 --format=%an
    mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
    // git log -1 --format=%aI
    mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
    // git show --name-status
    mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/new.ts' } as never);
  }

  it('calls git reset with excluded paths after staging', async () => {
    const sessionId = 'sess_exclude';
    const worktree = '/tmp/worktree-exclude';
    mockWorktree(sessionId, worktree);

    // git add -A succeeds
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // When exclude is provided, commit should call git reset for those paths
    // Mock git reset (chunked, but with 2 paths it's one chunk)
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // git diff --cached --name-only (should have remaining files)
    mockedExeca.mockResolvedValueOnce({ stdout: 'src/kept.ts' } as never);

    // Commit succeeds
    mockSuccessfulCommit();

    const result = await gitService.commit(sessionId, 'feat: exclude test', undefined, ['src/ignored.ts', 'houserules.md']);

    expect(result.success).toBe(true);
    // Verify git reset was called with the excluded paths
    expect(mockedExeca).toHaveBeenCalledWith(
      'git',
      ['reset', '-q', '--', 'src/ignored.ts', 'houserules.md'],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it('chunks git reset calls when exclude exceeds 200 paths', async () => {
    const sessionId = 'sess_chunked';
    const worktree = '/tmp/worktree-chunked';
    mockWorktree(sessionId, worktree);

    const excludePaths = Array.from({ length: 450 }, (_, i) => `file${i}.ts`);

    // git add -A succeeds
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // Two chunks of git reset (200 + 200 + 50)
    mockedExeca.mockResolvedValue({ stdout: '' } as never);

    // git diff --cached --name-only
    mockedExeca.mockResolvedValueOnce({ stdout: 'kept.ts' } as never);

    // Commit succeeds
    mockSuccessfulCommit();

    const result = await gitService.commit(sessionId, 'feat: chunked exclude', undefined, excludePaths);

    expect(result.success).toBe(true);
    // Should have been called 3 times (chunks of 200)
    const resetCalls = mockedExeca.mock.calls.filter(
      (call) => call[0] === 'git' && call[1]?.[0] === 'reset'
    );
    expect(resetCalls.length).toBe(3);
    // First chunk should have 200 paths
    expect(resetCalls[0][1].length).toBe(202); // ['reset', '-q', '--', ...200 paths]
    // Second chunk should have 200 paths
    expect(resetCalls[1][1].length).toBe(202);
    // Third chunk should have 52 paths (50 paths + reset -q --)
    expect(resetCalls[2][1].length).toBe(52);
  });

  it('throws "nothing to commit" when exclude leaves no staged files', async () => {
    const sessionId = 'sess_nothing';
    const worktree = '/tmp/worktree-nothing';
    mockWorktree(sessionId, worktree);

    // git add -A succeeds
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // git reset unstages everything
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // git diff --cached --name-only is empty
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    const result = await gitService.commit(sessionId, 'feat: nothing to commit', undefined, ['src/all.ts']);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('nothing to commit');
    // git commit should NOT have been called
    const commitCall = mockedExeca.mock.calls.find(
      (call) => call[0] === 'git' && call[1]?.[0] === 'commit'
    );
    expect(commitCall).toBeUndefined();
  });

  it('does not call git reset when exclude is undefined', async () => {
    const sessionId = 'sess_normal';
    const worktree = '/tmp/worktree-normal';
    mockWorktree(sessionId, worktree);

    mockSuccessfulCommit();

    const result = await gitService.commit(sessionId, 'feat: normal commit', undefined);

    expect(result.success).toBe(true);
    // No git reset calls
    const resetCalls = mockedExeca.mock.calls.filter(
      (call) => call[0] === 'git' && call[1]?.[0] === 'reset'
    );
    expect(resetCalls.length).toBe(0);
  });

  it('does not call git reset when exclude is empty array', async () => {
    const sessionId = 'sess_empty';
    const worktree = '/tmp/worktree-empty';
    mockWorktree(sessionId, worktree);

    mockSuccessfulCommit();

    const result = await gitService.commit(sessionId, 'feat: empty exclude', undefined, []);

    expect(result.success).toBe(true);
    // No git reset calls
    const resetCalls = mockedExeca.mock.calls.filter(
      (call) => call[0] === 'git' && call[1]?.[0] === 'reset'
    );
    expect(resetCalls.length).toBe(0);
  });

  it('continues with commit when git reset fails on a path', async () => {
    const sessionId = 'sess_reset_fail';
    const worktree = '/tmp/worktree-reset-fail';
    mockWorktree(sessionId, worktree);

    // git add -A succeeds
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // git reset fails (path doesn't exist or already unstaged)
    mockedExeca.mockRejectedValueOnce(new Error('fatal: path does not exist') as never);

    const result = await gitService.commit(sessionId, 'feat: reset error', undefined, ['nonexistent.ts']);

    // Error propagates — the commit fails rather than silently succeeding
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('fatal: path does not exist');
  });

  it('handles single excluded path without chunking', async () => {
    const sessionId = 'sess_single';
    const worktree = '/tmp/worktree-single';
    mockWorktree(sessionId, worktree);

    // git add -A succeeds
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // Single git reset call
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

    // git diff --cached --name-only has remaining files
    mockedExeca.mockResolvedValueOnce({ stdout: 'kept.ts' } as never);

    // Commit succeeds
    mockSuccessfulCommit();

    const result = await gitService.commit(sessionId, 'feat: single exclude', undefined, ['one.ts']);

    expect(result.success).toBe(true);
    expect(mockedExeca).toHaveBeenCalledWith(
      'git',
      ['reset', '-q', '--', 'one.ts'],
      expect.objectContaining({ cwd: worktree })
    );
  });
});
