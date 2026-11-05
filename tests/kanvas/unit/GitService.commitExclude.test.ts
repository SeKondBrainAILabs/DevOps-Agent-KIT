/**
 * GitService commit exclude tests (KC-S3.1.5 AC1)
 *
 * Tests that GitService.commit with an `exclude` array:
 * 1. Stages all changes first
 * 2. Runs `git reset -q -- <paths>` in chunks of 200 to unstage excluded paths
 * 3. Throws "nothing to commit" when nothing remains staged
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock execa module
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

import { GitService } from '../../../electron/services/GitService';

describe('GitService.commit with exclude', () => {
  let gitService: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
  });

  const mockSessionId = 'sess_test_exclude';
  const mockWorktree = '/tmp/worktree-exclude-test';

  // Helper to register a worktree
  function registerWorktree() {
    (gitService as any).registerWorktree(mockSessionId, '/tmp/repo', mockWorktree);
  }

  // Helper to mock successful git commands for a normal commit
  function mockSuccessfulCommit() {
    // stageAllChanges -> git add -A
    mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
    // git commit -m
    mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] feat: test' } as never);
    // git rev-parse HEAD
    mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
    // git rev-parse --short HEAD
    mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
    // git log -1 --format=%an
    mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
    // git log -1 --format=%aI
    mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
    // git show --name-status
    mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);
  }

  describe('exclude parameter', () => {
    it('calls git reset with excluded paths after staging', async () => {
      registerWorktree();
      const excludePaths = ['houserules.md', 'FOLDER_STRUCTURE.md', '.vscode/settings.json'];

      // stageAllChanges -> git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only (to check what's staged)
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts\nhouserules.md\nFOLDER_STRUCTURE.md\n.vscode/settings.json' } as never);
      // git reset -q -- <paths>
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git commit -m
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] feat: test' } as never);
      // git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      // git rev-parse --short HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      // git log -1 --format=%an
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      // git log -1 --format=%aI
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, excludePaths);

      expect(result.success).toBe(true);
      // git reset should be called with the excluded paths
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        ['reset', '-q', '--', ...excludePaths],
        mockWorktree
      );
    });

    it('chunks git reset calls when exclude paths exceed 200', async () => {
      registerWorktree();
      // Create 250 exclude paths
      const excludePaths = Array.from({ length: 250 }, (_, i) => `file-${i}.ts`);

      // stageAllChanges -> git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: excludePaths.join('\n') + '\nsrc/file.ts' } as never);
      // First chunk of git reset (200 paths)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Second chunk of git reset (50 paths)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git commit -m
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] feat: test' } as never);
      // git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      // git rev-parse --short HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      // git log -1 --format=%an
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      // git log -1 --format=%aI
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, excludePaths);

      expect(result.success).toBe(true);
      // Should have two git reset calls: first with 200 paths, second with 50
      expect(mockedExeca).toHaveBeenCalledTimes(10); // 1 add + 2 reset + 1 commit + 5 commit info + 1 show
      const resetCalls = mockedExeca.mock.calls.filter(call => call[1][0] === 'reset');
      expect(resetCalls).toHaveLength(2);
      expect(resetCalls[0][1].slice(3)).toHaveLength(200); // First chunk has 200 paths
      expect(resetCalls[1][1].slice(3)).toHaveLength(50);  // Second chunk has 50 paths
    });

    it('throws "nothing to commit" when exclude leaves no staged files', async () => {
      registerWorktree();
      const excludePaths = ['src/file.ts'];

      // stageAllChanges -> git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only (only the excluded file is staged)
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts' } as never);
      // git reset -q -- <paths>
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only (now empty)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, excludePaths);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('nothing to commit');
      // git commit should NOT be called
      const commitCalls = mockedExeca.mock.calls.filter(call => call[1][0] === 'commit');
      expect(commitCalls).toHaveLength(0);
    });

    it('proceeds with commit when some files remain after exclude', async () => {
      registerWorktree();
      const excludePaths = ['houserules.md'];

      // stageAllChanges -> git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts\nhouserules.md' } as never);
      // git reset -q -- <paths>
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only (still has src/file.ts)
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts' } as never);
      // git commit -m
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] feat: test' } as never);
      // git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      // git rev-parse --short HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      // git log -1 --format=%an
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      // git log -1 --format=%aI
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, excludePaths);

      expect(result.success).toBe(true);
      expect(result.data?.hash).toBe('abc123def456');
    });

    it('works without exclude parameter (backward compatibility)', async () => {
      registerWorktree();
      mockSuccessfulCommit();

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined);

      expect(result.success).toBe(true);
      expect(result.data?.hash).toBe('abc123def456');
      // git reset should NOT be called when exclude is omitted
      const resetCalls = mockedExeca.mock.calls.filter(call => call[1][0] === 'reset');
      expect(resetCalls).toHaveLength(0);
    });

    it('works with empty exclude array', async () => {
      registerWorktree();
      mockSuccessfulCommit();

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, []);

      expect(result.success).toBe(true);
      expect(result.data?.hash).toBe('abc123def456');
      // git reset should NOT be called when exclude is empty
      const resetCalls = mockedExeca.mock.calls.filter(call => call[1][0] === 'reset');
      expect(resetCalls).toHaveLength(0);
    });

    it('handles git reset errors gracefully', async () => {
      registerWorktree();
      const excludePaths = ['nonexistent-file.ts'];

      // stageAllChanges -> git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts\nnonexistent-file.ts' } as never);
      // git reset -q -- <paths> fails
      mockedExeca.mockRejectedValueOnce(new Error('fatal: ambiguous argument') as never);

      const result = await gitService.commit(mockSessionId, 'feat: test', undefined, excludePaths);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('fatal: ambiguous argument');
    });
  });
});
