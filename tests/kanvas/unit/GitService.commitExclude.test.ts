/**
 * GitService commit with exclude parameter - AC1
 *
 * Tests that GitService.commit() with an exclude array:
 * 1. Calls git reset to unstage the specified paths after staging
 * 2. Throws 'nothing to commit' when all staged files are excluded
 * 3. Uses chunking of 200 paths for git reset
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

// Import the GitService class
import { GitService } from '../../../electron/services/GitService';

describe('GitService.commit with exclude', () => {
  let gitService: InstanceType<typeof GitService>;
  const mockWorktreePath = '/test/worktree';

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
    
    // Register a mock worktree
    (gitService as any).worktreePaths = new Map([
      ['sess_1', { repoPath: '/test/repo', worktreePath: mockWorktreePath }]
    ]);
  });

  describe('exclude parameter - basic behavior', () => {
    it('calls git reset for excluded paths after staging', async () => {
      const excludePaths = ['houserules.md', '.vscode/settings.json', 'uv.lock'];
      
      // Mock git add -A (stageAllChanges)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author/date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tsrc/app.ts' } as never);
      // Mock git diff --cached --name-only (to check if anything is left staged)
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/app.ts' } as never);

      const result = await gitService.commit('sess_1', 'Test commit', undefined, excludePaths);

      expect(result.success).toBe(true);
      
      // Verify git reset was called with the excluded paths
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['reset', '-q', '--', ...excludePaths]),
        mockWorktreePath
      );
    });

    it('chunks git reset calls when exclude exceeds 200 paths', async () => {
      // Create 250 exclude paths
      const excludePaths = Array.from({ length: 250 }, (_, i) => `file${i}.txt`);
      
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only (something is staged)
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.txt' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author/date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tsrc/app.ts' } as never);

      const result = await gitService.commit('sess_1', 'Test commit', undefined, excludePaths);

      expect(result.success).toBe(true);

      // Should call git reset twice: 200 paths + 50 paths
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1][0] === 'reset'
      );
      
      expect(resetCalls.length).toBe(2);
      
      // First call should have 200 paths
      expect(resetCalls[0][1].length).toBe(200 + 2); // 'reset', '-q', '--', 200 paths
      // Second call should have 50 paths
      expect(resetCalls[1][1].length).toBe(50 + 2); // 'reset', '-q', '--', 50 paths
    });

    it('throws "nothing to commit" when all staged files are excluded', async () => {
      const excludePaths = ['file1.txt', 'file2.txt'];
      
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only (empty after reset)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await gitService.commit('sess_1', 'Test commit', undefined, excludePaths);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('nothing to commit');
      
      // Verify git commit was NOT called
      const commitCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1][0] === 'commit'
      );
      expect(commitCalls.length).toBe(0);
    });

    it('skips git reset when exclude is empty array', async () => {
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.txt' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author/date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tsrc/app.ts' } as never);

      const result = await gitService.commit('sess_1', 'Test commit', undefined, []);

      expect(result.success).toBe(true);
      
      // Verify git reset was NOT called
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1][0] === 'reset'
      );
      expect(resetCalls.length).toBe(0);
    });

    it('works without exclude parameter (backward compatibility)', async () => {
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.txt' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author/date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tsrc/app.ts' } as never);

      // Call without exclude parameter
      const result = await gitService.commit('sess_1', 'Test commit');

      expect(result.success).toBe(true);
      
      // Verify git reset was NOT called
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1][0] === 'reset'
      );
      expect(resetCalls.length).toBe(0);
    });
  });

  describe('exclude with repoName parameter', () => {
    it('respects exclude for a specific repo in multi-repo mode', async () => {
      const excludePaths = ['uv.lock'];
      
      // Register secondary repo worktree
      (gitService as any).worktreePaths.set('sess_1:secondary', { 
        repoPath: '/test/repo2', 
        worktreePath: '/test/worktree2' 
      });

      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/app.ts' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author/date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test User' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tsrc/app.ts' } as never);

      const result = await gitService.commit('sess_1', 'Test commit', 'secondary', excludePaths);

      expect(result.success).toBe(true);
      
      // Verify git reset was called in the correct worktree
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1][0] === 'reset'
      );
      expect(resetCalls.length).toBe(1);
      expect(resetCalls[0][2]).toBe('/test/worktree2');
    });
  });
});
