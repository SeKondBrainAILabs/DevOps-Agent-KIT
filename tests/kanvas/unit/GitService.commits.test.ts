/**
 * GitService Commit Methods Unit Tests
 * Tests for getCommitHistory and getCommitDiff methods
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

describe('GitService Commit Methods', () => {
  let gitService: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
  });

  describe('getCommitHistory', () => {
    const mockRepoPath = '/test/repo';
    const mockBaseBranch = 'main';

    it('should return empty array when no commits', async () => {
      // git log returns empty
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await gitService.getCommitHistory(mockRepoPath, mockBaseBranch);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should parse commit history with stats correctly', async () => {
      const mockLogOutput = `def456|def456|feat: add new feature|John Doe|2026-01-21T10:00:00Z
 3 files changed, 120 insertions(+), 30 deletions(-)
ghi789|ghi789|fix: bug fix|Jane Smith|2026-01-21T09:00:00Z
 1 file changed, 5 insertions(+)`;

      // git log
      mockedExeca.mockResolvedValueOnce({ stdout: mockLogOutput } as never);

      const result = await gitService.getCommitHistory(mockRepoPath, mockBaseBranch);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);

      expect(result.data?.[0]).toMatchObject({
        hash: 'def456',
        shortHash: 'def456',
        message: 'feat: add new feature',
        author: 'John Doe',
        filesChanged: 3,
        additions: 120,
        deletions: 30,
      });

      expect(result.data?.[1]).toMatchObject({
        hash: 'ghi789',
        shortHash: 'ghi789',
        message: 'fix: bug fix',
        author: 'Jane Smith',
        filesChanged: 1,
        additions: 5,
        deletions: 0,
      });
    });

    it('should handle commits without stats line', async () => {
      const mockLogOutput = `abc123|abc123|docs: update readme|Developer|2026-01-21T08:00:00Z`;

      mockedExeca.mockResolvedValueOnce({ stdout: mockLogOutput } as never);

      const result = await gitService.getCommitHistory(mockRepoPath, mockBaseBranch);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]).toMatchObject({
        hash: 'abc123',
        message: 'docs: update readme',
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    });

    it('should use branchName for range when provided', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      await gitService.getCommitHistory(mockRepoPath, mockBaseBranch, 50, 'feature-branch');

      // Should call git log with baseBranch..branchName range
      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['main..feature-branch']),
        expect.any(Object)
      );
    });

    it('should respect limit parameter', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as never);

      await gitService.getCommitHistory(mockRepoPath, mockBaseBranch, 10);

      expect(mockedExeca).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-10']),
        expect.any(Object)
      );
    });
  });

  describe('getCommitDiff', () => {
    const mockRepoPath = '/test/repo';
    const mockCommitHash = 'abc123def';

    it('should return commit details with file diffs', async () => {
      // Mock git log for commit info
      const logOutput = 'abc123def|abc123|feat: add feature|John Doe|2026-01-21T10:00:00Z\n 2 files changed, 50 insertions(+), 10 deletions(-)';
      mockedExeca.mockResolvedValueOnce({ stdout: logOutput } as never);

      // Mock numstat
      const numstatOutput = '30\t5\tsrc/component.tsx\n20\t5\tsrc/utils.ts';
      mockedExeca.mockResolvedValueOnce({ stdout: numstatOutput } as never);

      // Mock name-status
      const nameStatusOutput = 'M\tsrc/component.tsx\nA\tsrc/utils.ts';
      mockedExeca.mockResolvedValueOnce({ stdout: nameStatusOutput } as never);

      // Mock diffs for each file
      const diffOutput1 = `@@ -1,5 +1,35 @@
+import React from 'react';
+export function Component() {
+  return <div>Hello</div>;
+}`;
      mockedExeca.mockResolvedValueOnce({ stdout: diffOutput1 } as never);

      const diffOutput2 = `@@ -0,0 +1,20 @@
+export function helper() {
+  return true;
+}`;
      mockedExeca.mockResolvedValueOnce({ stdout: diffOutput2 } as never);

      const result = await gitService.getCommitDiff(mockRepoPath, mockCommitHash);

      expect(result.success).toBe(true);
      expect(result.data?.commit).toMatchObject({
        hash: 'abc123def',
        shortHash: 'abc123',
        message: 'feat: add feature',
        author: 'John Doe',
        filesChanged: 2,
        additions: 50,
        deletions: 10,
      });

      expect(result.data?.files).toHaveLength(2);
      expect(result.data?.files[0]).toMatchObject({
        path: 'src/component.tsx',
        status: 'modified',
        additions: 30,
        deletions: 5,
        language: 'typescript',
      });
      expect(result.data?.files[1]).toMatchObject({
        path: 'src/utils.ts',
        status: 'added',
        additions: 20,
        deletions: 5,
        language: 'typescript',
      });
    });

    it('should detect file status correctly', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc|abc|msg|author|2026-01-21T10:00:00Z\n 1 file changed' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '10\t0\tREADME.md' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tREADME.md' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '+# README' } as never);

      const result = await gitService.getCommitDiff(mockRepoPath, mockCommitHash);

      expect(result.data?.files[0].status).toBe('added');
    });

    it('should detect language from file extension', async () => {
      const testCases = [
        { file: 'app.ts', expected: 'typescript' },
        { file: 'app.tsx', expected: 'typescript' },
        { file: 'app.js', expected: 'javascript' },
        { file: 'app.py', expected: 'python' },
        { file: 'app.go', expected: 'go' },
        { file: 'styles.css', expected: 'css' },
        { file: 'data.json', expected: 'json' },
        { file: 'README.md', expected: 'markdown' },
        { file: 'unknown.xyz', expected: 'text' },
      ];

      for (const tc of testCases) {
        jest.clearAllMocks();

        mockedExeca.mockResolvedValueOnce({ stdout: 'abc|abc|msg|author|2026-01-21T10:00:00Z\n 1 file changed' } as never);
        mockedExeca.mockResolvedValueOnce({ stdout: `10\t0\t${tc.file}` } as never);
        mockedExeca.mockResolvedValueOnce({ stdout: `M\t${tc.file}` } as never);
        mockedExeca.mockResolvedValueOnce({ stdout: '+content' } as never);

        const result = await gitService.getCommitDiff(mockRepoPath, mockCommitHash);

        expect(result.data?.files[0].language).toBe(tc.expected);
      }
    });

    it('should truncate large diffs', async () => {
      const largeDiff = '+'.repeat(10000);

      mockedExeca.mockResolvedValueOnce({ stdout: 'abc|abc|msg|author|2026-01-21T10:00:00Z\n 1 file changed' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '500\t0\tbig-file.ts' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'M\tbig-file.ts' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: largeDiff } as never);

      const result = await gitService.getCommitDiff(mockRepoPath, mockCommitHash);

      expect(result.data?.files[0].diff.length).toBeLessThan(10000);
      expect(result.data?.files[0].diff).toContain('(diff truncated');
    });

    it('should handle first commit without parent', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'abc|abc|Initial commit|author|2026-01-21T10:00:00Z\n 1 file changed' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: '10\t0\tREADME.md' } as never);
      mockedExeca.mockResolvedValueOnce({ stdout: 'A\tREADME.md' } as never);
      // First diff attempt fails (no parent)
      mockedExeca.mockRejectedValueOnce(new Error('fatal: bad revision'));
      // Fallback to git show
      mockedExeca.mockResolvedValueOnce({ stdout: '+# README\n+Initial content' } as never);

      const result = await gitService.getCommitDiff(mockRepoPath, mockCommitHash);

      expect(result.success).toBe(true);
      expect(result.data?.files[0].diff).toContain('# README');
    });
  });
});
