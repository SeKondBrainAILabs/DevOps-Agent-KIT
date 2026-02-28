/**
 * Unit Tests for RebaseWatcherService — AI rebase & conflict file parsing
 * Tests the performAutoRebase path with MergeConflictService and
 * parsing of conflicted files from raw rebase error output.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { IpcResult } from '../../../shared/types';

// Mock child_process before imports
jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('util', () => ({
  promisify: jest.fn((fn) => fn),
}));

// Define mock function types
type FetchRemoteFn = (repoPath: string, remote: string) => Promise<IpcResult<void>>;
type CheckRemoteChangesFn = (repoPath: string, branch: string) => Promise<IpcResult<{ behind: number; ahead: number }>>;
type PerformRebaseFn = (repoPath: string, baseBranch: string) => Promise<IpcResult<{ success: boolean; message: string; hadChanges: boolean; rawError?: string }>>;
type PerformRebaseWithAIFn = (repoPath: string, baseBranch: string, mergeConflictService: any) => Promise<IpcResult<{
  success: boolean; message: string; hadChanges: boolean; conflictsResolved?: number; conflictsFailed?: number; rawError?: string;
}>>;

// Mock GitService
const mockFetchRemote = jest.fn<FetchRemoteFn>();
const mockCheckRemoteChanges = jest.fn<CheckRemoteChangesFn>();
const mockPerformRebase = jest.fn<PerformRebaseFn>();
const mockPerformRebaseWithAI = jest.fn<PerformRebaseWithAIFn>();

const mockGitService = {
  fetchRemote: mockFetchRemote,
  checkRemoteChanges: mockCheckRemoteChanges,
  performRebase: mockPerformRebase,
  performRebaseWithAI: mockPerformRebaseWithAI,
};

// Mock MergeConflictService
const mockMergeConflictService = {
  rebaseWithResolution: jest.fn(),
};

import { RebaseWatcherService, type RebaseWatchConfig } from '../../../electron/services/RebaseWatcherService';

describe('RebaseWatcherService — AI rebase & conflict parsing', () => {
  let service: RebaseWatcherService;

  const defaultConfig: RebaseWatchConfig = {
    sessionId: 'test-session-ai',
    repoPath: '/test/repo',
    baseBranch: 'main',
    currentBranch: 'feature/ai-test',
    rebaseFrequency: 'on-demand',
    pollIntervalMs: 1000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers(); // These tests use real timers for async

    mockFetchRemote.mockResolvedValue({ success: true, data: undefined });
    mockCheckRemoteChanges.mockResolvedValue({
      success: true,
      data: { behind: 0, ahead: 0 },
    });
    mockPerformRebase.mockResolvedValue({
      success: true,
      data: { success: true, message: 'Rebase successful', hadChanges: false },
    });
    mockPerformRebaseWithAI.mockResolvedValue({
      success: true,
      data: { success: true, message: 'AI rebase successful', hadChanges: false, conflictsResolved: 0, conflictsFailed: 0 },
    });

    service = new RebaseWatcherService(mockGitService as any);
  });

  afterEach(async () => {
    for (const sessionId of service.getWatchedSessions()) {
      await service.stopWatching(sessionId);
    }
  });

  describe('AI-powered rebase via MergeConflictService', () => {
    it('should use performRebaseWithAI when MergeConflictService is set', async () => {
      service.setMergeConflictService(mockMergeConflictService as any);

      // Start watching, then force a rebase
      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 3, ahead: 0 } });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockPerformRebaseWithAI).toHaveBeenCalledWith(
        defaultConfig.repoPath,
        defaultConfig.baseBranch,
        mockMergeConflictService,
      );
      expect(mockPerformRebase).not.toHaveBeenCalled();
    });

    it('should fall back to performRebase when MergeConflictService is NOT set', async () => {
      // Do NOT call setMergeConflictService

      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 3, ahead: 0 } });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockPerformRebase).toHaveBeenCalledWith(
        defaultConfig.repoPath,
        defaultConfig.baseBranch,
      );
      expect(mockPerformRebaseWithAI).not.toHaveBeenCalled();
    });

    it('should report AI-resolved conflicts in success log', async () => {
      service.setMergeConflictService(mockMergeConflictService as any);

      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      mockPerformRebaseWithAI.mockResolvedValue({
        success: true,
        data: {
          success: true,
          message: 'AI rebase successful - resolved 3 conflicts',
          hadChanges: false,
          conflictsResolved: 3,
          conflictsFailed: 0,
        },
      });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = service.getWatchStatus(defaultConfig.sessionId);
      expect(status?.behindCount).toBe(0);
      expect(status?.lastRebaseResult?.success).toBe(true);
    });
  });

  describe('conflict file parsing from raw error output', () => {
    it('should parse conflicted files from CONFLICT lines in rawError', async () => {
      const mockEmit = jest.fn();
      (service as any).emitToRenderer = mockEmit;

      const rawError = [
        'CONFLICT (content): Merge conflict in backend/src/main.ts',
        'CONFLICT (content): Merge conflict in backend/src/routes/auth.ts',
        'CONFLICT (content): Merge conflict in backend/src/routes/profiles.ts',
      ].join('\n');

      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      mockPerformRebase.mockResolvedValue({
        success: true,
        data: {
          success: false,
          message: 'Rebase failed due to merge conflicts.',
          hadChanges: false,
          rawError,
        },
      });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Find the REBASE_ERROR_DETECTED emission
      const errorEmit = mockEmit.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('rebase:error')
      );
      expect(errorEmit).toBeDefined();

      const payload = errorEmit![1] as any;
      expect(payload.conflictedFiles).toEqual([
        'backend/src/main.ts',
        'backend/src/routes/auth.ts',
        'backend/src/routes/profiles.ts',
      ]);
    });

    it('should return empty conflictedFiles when rawError has no CONFLICT lines', async () => {
      const mockEmit = jest.fn();
      (service as any).emitToRenderer = mockEmit;

      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      mockPerformRebase.mockResolvedValue({
        success: true,
        data: {
          success: false,
          message: 'Rebase failed - unknown error',
          hadChanges: false,
          rawError: 'fatal: some git error',
        },
      });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      const errorEmit = mockEmit.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('rebase:error')
      );
      expect(errorEmit).toBeDefined();
      expect((errorEmit![1] as any).conflictedFiles).toEqual([]);
    });

    it('should parse mixed CONFLICT types (content, add/add)', async () => {
      const mockEmit = jest.fn();
      (service as any).emitToRenderer = mockEmit;

      const rawError = [
        'Auto-merging src/index.ts',
        'CONFLICT (content): Merge conflict in src/index.ts',
        'CONFLICT (add/add): Merge conflict in src/newfile.ts',
      ].join('\n');

      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 2, ahead: 0 } });

      mockPerformRebase.mockResolvedValue({
        success: true,
        data: { success: false, message: 'Conflicts', hadChanges: false, rawError },
      });

      await service.startWatching(defaultConfig);
      await service.forceCheck(defaultConfig.sessionId);
      await new Promise(resolve => setTimeout(resolve, 50));

      const errorEmit = mockEmit.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('rebase:error')
      );
      expect((errorEmit![1] as any).conflictedFiles).toEqual([
        'src/index.ts',
        'src/newfile.ts',
      ]);
    });
  });
});
