/**
 * GitService.commit exclude paths unit tests
 *
 * Tests AC1, AC4: GitService.commit with exclude parameter unstages those paths
 * with git reset after staging, and throws 'nothing to commit' when nothing is
 * left staged. Also tests chunking at 200 paths.
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
  const mockSessionId = 'test-session-123';
  const mockWorktree = '/tmp/test-worktree';
  const mockRepoPath = '/tmp/test-repo';

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
    
    // Register a worktree for the session
    gitService.registerWorktree(mockSessionId, mockRepoPath, mockWorktree);
  });

  describe('exclude parameter behavior', () => {
    it('should run git reset for excluded paths after staging', async () => {
      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status (empty for this test)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const excludePaths = ['houserules.md', 'FOLDER_STRUCTURE.md', '.vscode/settings.json'];
      const result = await gitService.commit(mockSessionId, 'test commit', undefined, excludePaths);

      // Should have called git add -A first
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['add', '-A']),
        expect.objectContaining({ cwd: mockWorktree })
      );

      // Should have called git reset with exclude paths
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['reset', '-q', '--', ...excludePaths]),
        expect.objectContaining({ cwd: mockWorktree })
      );

      expect(result.success).toBe(true);
    });

    it('should throw "nothing to commit" when exclude leaves nothing staged', async () => {
      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git diff --cached --name-only returning empty (nothing left after reset)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const excludePaths = ['all-files.md'];
      
      await expect(gitService.commit(mockSessionId, 'test commit', undefined, excludePaths))
        .rejects.toThrow('nothing to commit');

      // Should NOT have called git commit
      const commitCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.includes('commit')
      );
      expect(commitCalls.length).toBe(0);
    });

    it('should NOT run git reset when exclude is undefined or empty', async () => {
      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      // Call without exclude
      const result = await gitService.commit(mockSessionId, 'test commit', undefined);

      // Should NOT have called git reset
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.includes('reset')
      );
      expect(resetCalls.length).toBe(0);

      expect(result.success).toBe(true);
    });
  });

  describe('chunking at 200 paths', () => {
    it('should chunk git reset calls at 200 paths', async () => {
      // Create 250 exclude paths
      const excludePaths = Array.from({ length: 250 }, (_, i) => `file${i}.md`);

      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git diff --cached --name-only returning non-empty (so commit proceeds)
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);

      const result = await gitService.commit(mockSessionId, 'test commit', undefined, excludePaths);

      // Should have exactly 2 git reset calls (250 paths / 200 = 2 chunks)
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.[1] === 'reset'
      );
      
      expect(resetCalls.length).toBe(2);

      // First chunk should have 200 paths
      const firstResetPaths = resetCalls[0][1].slice(3); // Skip 'reset', '-q', '--'
      expect(firstResetPaths.length).toBe(200);

      // Second chunk should have 50 paths
      const secondResetPaths = resetCalls[1][1].slice(3);
      expect(secondResetPaths.length).toBe(50);

      expect(result.success).toBe(true);
    });

    it('should handle exactly 200 paths with a single reset call', async () => {
      // Create exactly 200 exclude paths
      const excludePaths = Array.from({ length: 200 }, (_, i) => `file${i}.md`);

      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git diff --cached --name-only returning non-empty
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);

      const result = await gitService.commit(mockSessionId, 'test commit', undefined, excludePaths);

      // Should have exactly 1 git reset call
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.[1] === 'reset'
      );
      
      expect(resetCalls.length).toBe(1);

      // The reset should have exactly 200 paths
      const resetPaths = resetCalls[0][1].slice(3);
      expect(resetPaths.length).toBe(200);

      expect(result.success).toBe(true);
    });

    it('should handle 201 paths with two reset calls', async () => {
      // Create 201 exclude paths
      const excludePaths = Array.from({ length: 201 }, (_, i) => `file${i}.md`);

      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git diff --cached --name-only returning non-empty
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'some-file.ts\n' } as never);

      const result = await gitService.commit(mockSessionId, 'test commit', undefined, excludePaths);

      // Should have exactly 2 git reset calls
      const resetCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.[1] === 'reset'
      );
      
      expect(resetCalls.length).toBe(2);

      // First chunk should have 200 paths
      const firstResetPaths = resetCalls[0][1].slice(3);
      expect(firstResetPaths.length).toBe(200);

      // Second chunk should have 1 path
      const secondResetPaths = resetCalls[1][1].slice(3);
      expect(secondResetPaths.length).toBe(1);

      expect(result.success).toBe(true);
    });
  });

  describe('stageAllChanges, sanity gate, push, rebase unchanged', () => {
    it('should still stage all changes before excluding paths', async () => {
      const excludePaths = ['file1.md', 'file2.md'];

      // Mock git add -A success
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'other-file.ts\n' } as never);
      
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123d' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-01T00:00:00Z' } as never);
      
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'other-file.ts\n' } as never);

      await gitService.commit(mockSessionId, 'test commit', undefined, excludePaths);

      // Verify git add -A was called (stageAllChanges is still used)
      const addCalls = mockedExeca.mock.calls.filter(
        call => call[0] === 'git' && call[1]?.includes('add')
      );
      expect(addCalls.length).toBeGreaterThan(0);
      expect(addCalls[0][1]).toContain('-A');
    });
  });
});
