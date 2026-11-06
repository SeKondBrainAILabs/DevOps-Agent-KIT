/**
 * GitService commit with exclude parameter - Unit tests
 * Tests for AC1: GitService.commit with exclude unstages those paths with git reset after staging,
 * and throws 'nothing to commit' when nothing is left staged.
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

describe('GitService commit with exclude parameter', () => {
  let gitService: InstanceType<typeof GitService>;
  const mockSessionId = 'test-session-123';
  const mockWorktreePath = '/test/worktree';
  const mockRepoPath = '/test/repo';

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
    // Register a mock worktree path
    (gitService as any).registerWorktree(mockSessionId, mockRepoPath, mockWorktreePath);
  });

  describe('exclude parameter', () => {
    it('calls git reset with excluded paths after staging', async () => {
      // Mock git add -A (stage all)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only (has staged files)
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file1.ts\nsrc/file2.ts\nhouserules.md' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] Test message' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123def456' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log for author and date
      mockedExeca.mockResolvedValueOnce({ stdout: 'Test Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-21T10:00:00Z' } as never);
      // Mock git show --name-status
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file1.ts\nA\tsrc/file2.ts' } as never);

      const excludePaths = ['houserules.md', '.vscode/settings.json'];
      const result = await gitService.commit(mockSessionId, 'Test message', undefined, excludePaths);

      // Verify git reset was called with the excluded paths
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        ['reset', '-q', '--', ...excludePaths],
        expect.objectContaining({ cwd: mockWorktreePath })
      );

      expect(result.success).toBe(true);
    });

    it('throws "nothing to commit" when exclude removes all staged files', async () => {
      // Mock git add -A (stage all)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only (has staged files)
      mockedExeca.mockResolvedValueOnce({ stdout: 'houserules.md' } as never);
      // Mock git reset (unstage the only file)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only again (now empty)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const excludePaths = ['houserules.md'];
      
      await expect(gitService.commit(mockSessionId, 'Test message', undefined, excludePaths))
        .rejects.toThrow('nothing to commit');
    });

    it('chunks git reset calls when exclude exceeds 200 paths', async () => {
      // Create 450 paths to test chunking (200 + 200 + 50)
      const manyPaths = Array.from({ length: 450 }, (_, i) => `file${i}.txt`);

      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: manyPaths.join('\n') } as never);
      // Mock git reset for each chunk (3 chunks)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never); // chunk 1
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never); // chunk 2
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never); // chunk 3
      // Mock git diff --cached --name-only after reset (empty)
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await gitService.commit(mockSessionId, 'Test message', undefined, manyPaths);

      // Verify git reset was called 3 times with correct chunk sizes
      const resetCalls = mockedExeca.mock.calls.filter(
        (call: any) => call[0] === 'git' && call[1][0] === 'reset'
      );

      expect(resetCalls).toHaveLength(3);

      // First chunk: 200 paths + 3 command args = 203 total
      expect(resetCalls[0][1].length).toBe(203);
      expect(resetCalls[0][1]).toEqual(['reset', '-q', '--', ...manyPaths.slice(0, 200)]);

      // Second chunk: 200 paths + 3 command args = 203 total
      expect(resetCalls[1][1].length).toBe(203);
      expect(resetCalls[1][1]).toEqual(['reset', '-q', '--', ...manyPaths.slice(200, 400)]);

      // Third chunk: 50 paths + 3 command args = 53 total
      expect(resetCalls[2][1].length).toBe(53);
      expect(resetCalls[2][1]).toEqual(['reset', '-q', '--', ...manyPaths.slice(400, 450)]);
    });

    it('does not call git reset when exclude is empty', async () => {
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] Test' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log
      mockedExeca.mockResolvedValueOnce({ stdout: 'Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-21T10:00:00Z' } as never);
      // Mock git show
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);

      await gitService.commit(mockSessionId, 'Test message', undefined, []);

      // Verify no git reset was called
      const resetCalls = mockedExeca.mock.calls.filter(
        (call: any) => call[0] === 'git' && call[1][0] === 'reset'
      );
      expect(resetCalls).toHaveLength(0);
    });

    it('does not call git reset when exclude is undefined', async () => {
      // Mock git add -A
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);
      // Mock git diff --cached --name-only
      mockedExeca.mockResolvedValueOnce({ stdout: 'src/file.ts' } as never);
      // Mock git commit
      mockedExeca.mockResolvedValueOnce({ stdout: '[main abc123] Test' } as never);
      // Mock git rev-parse HEAD
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc123' } as never);
      // Mock git log
      mockedExeca.mockResolvedValueOnce({ stdout: 'Author' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '2026-01-21T10:00:00Z' } as never);
      // Mock git show
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tsrc/file.ts' } as never);

      // Call without exclude parameter (undefined)
      await gitService.commit(mockSessionId, 'Test message');

      // Verify no git reset was called
      const resetCalls = mockedExeca.mock.calls.filter(
        (call: any) => call[0] === 'git' && call[1][0] === 'reset'
      );
      expect(resetCalls).toHaveLength(0);
    });
  });
});
