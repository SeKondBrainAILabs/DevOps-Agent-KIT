/**
 * Unit Tests for RebaseWatcherService
 * Tests auto-rebase on remote changes (on-demand mode)
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
type PerformRebaseFn = (repoPath: string, baseBranch: string) => Promise<IpcResult<{ success: boolean; message: string; hadChanges: boolean }>>;

// Mock GitService with typed mocks
const mockFetchRemote = jest.fn<FetchRemoteFn>();
const mockCheckRemoteChanges = jest.fn<CheckRemoteChangesFn>();
const mockPerformRebase = jest.fn<PerformRebaseFn>();

const mockGitService = {
  fetchRemote: mockFetchRemote,
  checkRemoteChanges: mockCheckRemoteChanges,
  performRebase: mockPerformRebase,
};

// Import after mocking
import { RebaseWatcherService, type RebaseWatchConfig } from '../../../electron/services/RebaseWatcherService';

describe('RebaseWatcherService', () => {
  let service: RebaseWatcherService;

  const defaultConfig: RebaseWatchConfig = {
    sessionId: 'test-session-1',
    repoPath: '/test/repo',
    baseBranch: 'main',
    currentBranch: 'feature/test',
    rebaseFrequency: 'on-demand',
    pollIntervalMs: 1000, // 1 second for tests
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset mock implementations with proper return values
    mockFetchRemote.mockResolvedValue({ success: true, data: undefined });
    mockCheckRemoteChanges.mockResolvedValue({
      success: true,
      data: { behind: 0, ahead: 0 },
    });
    mockPerformRebase.mockResolvedValue({
      success: true,
      data: { success: true, message: 'Rebase successful', hadChanges: false },
    });

    service = new RebaseWatcherService(mockGitService as any);
  });

  afterEach(async () => {
    // Stop all watchers
    for (const sessionId of service.getWatchedSessions()) {
      await service.stopWatching(sessionId);
    }
    jest.useRealTimers();
  });

  describe('startWatching', () => {
    it('should start watching a session with on-demand frequency', async () => {
      const result = await service.startWatching(defaultConfig);

      expect(result.success).toBe(true);
      expect(service.getWatchedSessions()).toContain(defaultConfig.sessionId);
    });

    it("watches 'never' sessions too — for status and fast-forward, not auto-rebase", async () => {
      // 'never' governs rewriting the session's own work. The watcher still
      // has to run so the behind count is right and a session with no
      // commits of its own catches up (see SessionFastForward.test.ts).
      const config: RebaseWatchConfig = {
        ...defaultConfig,
        rebaseFrequency: 'never',
      };

      const result = await service.startWatching(config);

      expect(result.success).toBe(true);
      expect(service.getWatchedSessions()).toContain(config.sessionId);
    });

    it('should fetch initial remote status on start', async () => {
      await service.startWatching(defaultConfig);

      expect(mockFetchRemote).toHaveBeenCalledWith(defaultConfig.repoPath, 'origin');
      expect(mockCheckRemoteChanges).toHaveBeenCalledWith(defaultConfig.repoPath, defaultConfig.baseBranch);
    });

    it('should replace existing watcher for same session', async () => {
      await service.startWatching(defaultConfig);
      await service.startWatching({ ...defaultConfig, baseBranch: 'develop' });

      expect(service.getWatchedSessions()).toHaveLength(1);
    });
  });

  describe('stopWatching', () => {
    it('should stop watching a session', async () => {
      await service.startWatching(defaultConfig);
      expect(service.getWatchedSessions()).toContain(defaultConfig.sessionId);

      await service.stopWatching(defaultConfig.sessionId);
      expect(service.getWatchedSessions()).not.toContain(defaultConfig.sessionId);
    });

    it('should handle stopping non-existent session gracefully', async () => {
      const result = await service.stopWatching('non-existent-session');
      expect(result.success).toBe(true);
    });
  });

  describe('pauseWatching / resumeWatching', () => {
    it('should pause and resume watching', async () => {
      await service.startWatching(defaultConfig);

      service.pauseWatching(defaultConfig.sessionId);
      let status = service.getWatchStatus(defaultConfig.sessionId);
      expect(status?.isPaused).toBe(true);

      service.resumeWatching(defaultConfig.sessionId);
      status = service.getWatchStatus(defaultConfig.sessionId);
      expect(status?.isPaused).toBe(false);
    });
  });

  describe('getWatchStatus', () => {
    it('should return null for non-watched session', () => {
      const status = service.getWatchStatus('non-existent');
      expect(status).toBeNull();
    });

    it('should return current status for watched session', async () => {
      mockCheckRemoteChanges.mockResolvedValue({
        success: true,
        data: { behind: 5, ahead: 2 },
      });

      await service.startWatching(defaultConfig);
      const status = service.getWatchStatus(defaultConfig.sessionId);

      expect(status).toBeDefined();
      expect(status?.sessionId).toBe(defaultConfig.sessionId);
      expect(status?.isWatching).toBe(true);
      expect(status?.isPaused).toBe(false);
      expect(status?.isRebasing).toBe(false);
      expect(status?.behindCount).toBe(5);
      expect(status?.aheadCount).toBe(2);
      expect(status?.lastChecked).toBeDefined();
    });
  });

  describe('polling for changes', () => {
    it('should poll for changes at configured interval', async () => {
      await service.startWatching(defaultConfig);

      // Initial fetch on start
      expect(mockFetchRemote).toHaveBeenCalledTimes(1);

      // Advance timer by poll interval
      jest.advanceTimersByTime(defaultConfig.pollIntervalMs);
      await Promise.resolve(); // Let async operations complete

      // Should have polled again
      expect(mockFetchRemote).toHaveBeenCalledTimes(2);
    });

    it('should not poll when paused', async () => {
      await service.startWatching(defaultConfig);
      service.pauseWatching(defaultConfig.sessionId);

      const initialCalls = mockFetchRemote.mock.calls.length;

      // Advance timer
      jest.advanceTimersByTime(defaultConfig.pollIntervalMs * 3);
      await Promise.resolve();

      // Should not have polled
      expect(mockFetchRemote).toHaveBeenCalledTimes(initialCalls);
    });
  });

  describe('auto-rebase on changes detected', () => {
    // Use real timers for these async tests since fake timers don't work well with async
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      jest.useFakeTimers();
    });

    it('should trigger rebase when forceCheck detects changes', async () => {
      // Start with 0 behind, then return 5 behind on force check
      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      await service.startWatching(defaultConfig);

      // Force check should trigger rebase when behind
      await service.forceCheck(defaultConfig.sessionId);

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockPerformRebase).toHaveBeenCalledWith(defaultConfig.repoPath, defaultConfig.baseBranch);
    });

    it('should pause watcher on rebase failure', async () => {
      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      mockPerformRebase.mockResolvedValue({
        success: true,
        data: { success: false, message: 'Conflict detected', hadChanges: false },
      });

      await service.startWatching(defaultConfig);

      // Force check to trigger rebase
      await service.forceCheck(defaultConfig.sessionId);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = service.getWatchStatus(defaultConfig.sessionId);
      expect(status?.isPaused).toBe(true);
      expect(status?.lastRebaseResult?.success).toBe(false);
    });

    it('should reset behind count after successful rebase', async () => {
      mockCheckRemoteChanges
        .mockResolvedValueOnce({ success: true, data: { behind: 0, ahead: 0 } })
        .mockResolvedValueOnce({ success: true, data: { behind: 5, ahead: 0 } });

      await service.startWatching(defaultConfig);

      // Force check to trigger rebase
      await service.forceCheck(defaultConfig.sessionId);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = service.getWatchStatus(defaultConfig.sessionId);
      expect(status?.behindCount).toBe(0);
      expect(status?.lastRebaseResult?.success).toBe(true);
    });
  });

  describe('forceCheck', () => {
    it('should force an immediate check for changes', async () => {
      await service.startWatching(defaultConfig);

      // Reset call counts
      mockFetchRemote.mockClear();
      mockCheckRemoteChanges.mockClear();

      const result = await service.forceCheck(defaultConfig.sessionId);

      expect(result.success).toBe(true);
      expect(mockFetchRemote).toHaveBeenCalled();
      expect(mockCheckRemoteChanges).toHaveBeenCalled();
    });

    it('should fail for non-watched session', async () => {
      const result = await service.forceCheck('non-existent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REBASE_FORCE_CHECK_FAILED');
    });
  });

  describe('triggerRebase', () => {
    it('should manually trigger rebase for watched session', async () => {
      await service.startWatching(defaultConfig);

      const result = await service.triggerRebase(defaultConfig.sessionId);

      expect(result.success).toBe(true);
      expect(result.data?.success).toBe(true);
      expect(mockPerformRebase).toHaveBeenCalledWith(defaultConfig.repoPath, defaultConfig.baseBranch);
    });

    it('should fail for non-watched session', async () => {
      const result = await service.triggerRebase('non-existent');

      expect(result.success).toBe(false);
    });

    it('should return error if rebase already in progress', async () => {
      // Use real timers for this test
      jest.useRealTimers();

      mockCheckRemoteChanges.mockResolvedValue({
        success: true,
        data: { behind: 5, ahead: 0 },
      });

      // Make performRebase take a while
      let resolveRebase: (value: any) => void;
      mockPerformRebase.mockImplementation(
        () => new Promise((resolve) => {
          resolveRebase = resolve;
        })
      );

      await service.startWatching(defaultConfig);

      // Start a rebase manually (it will hang)
      const rebasePromise = service.triggerRebase(defaultConfig.sessionId);

      // Wait a tick
      await new Promise(resolve => setTimeout(resolve, 10));

      // Try to trigger another rebase while first is in progress
      const result = await service.triggerRebase(defaultConfig.sessionId);

      expect(result.data?.success).toBe(false);
      expect(result.data?.message).toContain('already in progress');

      // Clean up: resolve the pending rebase
      resolveRebase!({
        success: true,
        data: { success: true, message: 'Done', hadChanges: false },
      });
      await rebasePromise;

      // Restore fake timers
      jest.useFakeTimers();
    });
  });

  describe('dispose', () => {
    it('should stop all watchers on dispose', async () => {
      await service.startWatching(defaultConfig);
      await service.startWatching({ ...defaultConfig, sessionId: 'session-2' });

      expect(service.getWatchedSessions()).toHaveLength(2);

      await service.dispose();

      expect(service.getWatchedSessions()).toHaveLength(0);
    });
  });

  describe('event emission', () => {
    it('should emit status updates', async () => {
      // Mock emitToRenderer
      const mockEmitToRenderer = jest.fn();
      (service as any).emitToRenderer = mockEmitToRenderer;

      await service.startWatching(defaultConfig);

      // Should have emitted initial status
      expect(mockEmitToRenderer).toHaveBeenCalled();
    });
  });
});
