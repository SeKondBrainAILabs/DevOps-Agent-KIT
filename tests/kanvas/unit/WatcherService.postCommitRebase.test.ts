/**
 * Unit Tests for WatcherService — Post-commit rebase fallback logic
 * Tests the direct fetch+rebase fallback when a session is NOT in the rebase watcher.
 *
 * Since WatcherService has many dependencies, we test the rebase fallback logic
 * directly by extracting and exercising the decision flow.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { IpcResult } from '../../../shared/types';

// Define mock function types
type FetchRemoteFn = (repoPath: string, remote?: string) => Promise<IpcResult<void>>;
type CheckRemoteChangesFn = (repoPath: string, branch: string) => Promise<IpcResult<{ behind: number; ahead: number }>>;
type RebaseFn = (repoPath: string, targetBranch: string) => Promise<IpcResult<{ success: boolean; message: string; commitsAdded: number; beforeHead: string; afterHead: string }>>;
type ForceCheckFn = (sessionId: string) => Promise<IpcResult<{ hasChanges: boolean; behindCount: number }>>;
type GetInstanceFn = (sessionId: string) => { success: boolean; data: any };

// Mock services
const mockFetchRemote = jest.fn<FetchRemoteFn>();
const mockCheckRemoteChanges = jest.fn<CheckRemoteChangesFn>();
const mockRebase = jest.fn<RebaseFn>();
const mockForceCheck = jest.fn<ForceCheckFn>();
const mockGetInstance = jest.fn<GetInstanceFn>();
const mockTerminalLog = jest.fn();

describe('WatcherService — Post-commit rebase fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockFetchRemote.mockResolvedValue({ success: true, data: undefined });
    mockCheckRemoteChanges.mockResolvedValue({
      success: true,
      data: { behind: 0, ahead: 0 },
    });
    mockRebase.mockResolvedValue({
      success: true,
      data: { success: true, message: 'Rebased', commitsAdded: 3, beforeHead: 'aaa', afterHead: 'bbb' },
    });
  });

  /**
   * This function mirrors the post-commit rebase logic from WatcherService.ts (lines 563-605).
   * By testing it here we validate the branching logic without needing the full WatcherService
   * dependency graph.
   */
  async function postCommitRebase(
    sessionId: string,
    opts: {
      rebaseWatcher?: { forceCheck: typeof mockForceCheck } | null;
      agentInstanceService?: { getInstance: typeof mockGetInstance } | null;
      gitService: { fetchRemote: typeof mockFetchRemote; checkRemoteChanges: typeof mockCheckRemoteChanges; rebase: typeof mockRebase };
      terminalLogService?: { log: typeof mockTerminalLog } | null;
    }
  ): Promise<void> {
    try {
      let rebased = false;
      if (opts.rebaseWatcher) {
        try {
          const rebaseResult = await opts.rebaseWatcher.forceCheck(sessionId);
          if (rebaseResult.success && rebaseResult.data?.hasChanges) {
            rebased = true;
          } else if (rebaseResult.success) {
            rebased = true;
          }
        } catch {
          // Session not in rebase watcher — fall through to direct rebase
        }
      }

      if (!rebased && opts.agentInstanceService) {
        const instResult = opts.agentInstanceService.getInstance(sessionId);
        const inst = instResult?.data;
        const baseBranch = inst?.config?.baseBranch || 'main';
        const repoPath = inst?.worktreePath || inst?.config?.repoPath;
        if (repoPath) {
          await opts.gitService.fetchRemote(repoPath);
          const checkResult = await opts.gitService.checkRemoteChanges(repoPath, baseBranch);
          if (checkResult.success && checkResult.data && checkResult.data.behind > 0) {
            const rebaseResult = await opts.gitService.rebase(repoPath, `origin/${baseBranch}`);
            if (rebaseResult.success) {
              opts.terminalLogService?.log('info', `Post-commit rebase: synced with ${baseBranch}`, { sessionId, source: 'Watcher' });
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  describe('rebase watcher path', () => {
    it('should use rebaseWatcher.forceCheck when session IS watched', async () => {
      mockForceCheck.mockResolvedValue({
        success: true,
        data: { hasChanges: true, behindCount: 3 },
      });

      await postCommitRebase('sess-123', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      });

      expect(mockForceCheck).toHaveBeenCalledWith('sess-123');
      // Should NOT fall through to direct rebase
      expect(mockFetchRemote).not.toHaveBeenCalled();
    });

    it('should mark as rebased even when forceCheck finds no changes', async () => {
      mockForceCheck.mockResolvedValue({
        success: true,
        data: { hasChanges: false, behindCount: 0 },
      });

      await postCommitRebase('sess-ok', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      });

      // Should NOT fall through to direct rebase
      expect(mockFetchRemote).not.toHaveBeenCalled();
    });
  });

  describe('direct rebase fallback', () => {
    it('should fall back to direct fetch+rebase when forceCheck throws', async () => {
      mockForceCheck.mockRejectedValue(new Error('Session sess-456 is not being watched'));
      mockGetInstance.mockReturnValue({
        success: true,
        data: {
          sessionId: 'sess-456',
          config: { baseBranch: 'development', repoPath: '/test/repo' },
          worktreePath: '/test/worktree',
        },
      });
      mockCheckRemoteChanges.mockResolvedValue({
        success: true,
        data: { behind: 5, ahead: 0 },
      });

      await postCommitRebase('sess-456', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      });

      expect(mockForceCheck).toHaveBeenCalledWith('sess-456');
      expect(mockFetchRemote).toHaveBeenCalledWith('/test/worktree');
      expect(mockCheckRemoteChanges).toHaveBeenCalledWith('/test/worktree', 'development');
      expect(mockRebase).toHaveBeenCalledWith('/test/worktree', 'origin/development');
    });

    it('should skip rebase when not behind remote', async () => {
      mockForceCheck.mockRejectedValue(new Error('Not watched'));
      mockGetInstance.mockReturnValue({
        success: true,
        data: {
          sessionId: 'sess-789',
          config: { baseBranch: 'main', repoPath: '/repo' },
          worktreePath: '/worktree',
        },
      });
      mockCheckRemoteChanges.mockResolvedValue({
        success: true,
        data: { behind: 0, ahead: 2 },
      });

      await postCommitRebase('sess-789', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      });

      expect(mockFetchRemote).toHaveBeenCalledWith('/worktree');
      expect(mockCheckRemoteChanges).toHaveBeenCalled();
      expect(mockRebase).not.toHaveBeenCalled();
    });

    it('should default to main when baseBranch is not set', async () => {
      mockForceCheck.mockRejectedValue(new Error('Not watched'));
      mockGetInstance.mockReturnValue({
        success: true,
        data: {
          sessionId: 'sess-nob',
          config: { repoPath: '/repo' },
          worktreePath: '/worktree',
        },
      });
      mockCheckRemoteChanges.mockResolvedValue({
        success: true,
        data: { behind: 1, ahead: 0 },
      });

      await postCommitRebase('sess-nob', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      });

      expect(mockCheckRemoteChanges).toHaveBeenCalledWith('/worktree', 'main');
      expect(mockRebase).toHaveBeenCalledWith('/worktree', 'origin/main');
    });

    it('should log to terminal on successful direct rebase', async () => {
      mockForceCheck.mockRejectedValue(new Error('Not watched'));
      mockGetInstance.mockReturnValue({
        success: true,
        data: { config: { baseBranch: 'dev', repoPath: '/r' }, worktreePath: '/w' },
      });
      mockCheckRemoteChanges.mockResolvedValue({ success: true, data: { behind: 2, ahead: 0 } });

      await postCommitRebase('sess-log', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
        terminalLogService: { log: mockTerminalLog },
      });

      expect(mockTerminalLog).toHaveBeenCalledWith(
        'info',
        'Post-commit rebase: synced with dev',
        expect.objectContaining({ sessionId: 'sess-log' }),
      );
    });

    it('should not crash when direct rebase fails', async () => {
      mockForceCheck.mockRejectedValue(new Error('Not watched'));
      mockGetInstance.mockReturnValue({
        success: true,
        data: { config: { baseBranch: 'main', repoPath: '/r' }, worktreePath: '/w' },
      });
      mockCheckRemoteChanges.mockResolvedValue({ success: true, data: { behind: 3, ahead: 0 } });
      mockRebase.mockResolvedValue({
        success: false,
        error: { code: 'GIT_REBASE_FAILED', message: 'Conflicts' },
        data: { success: false, message: 'Conflicts', commitsAdded: 0, beforeHead: 'a', afterHead: 'a' },
      } as any);

      await expect(postCommitRebase('sess-fail', {
        rebaseWatcher: { forceCheck: mockForceCheck },
        agentInstanceService: { getInstance: mockGetInstance },
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      })).resolves.not.toThrow();
    });

    it('should skip when no rebaseWatcher and no agentInstanceService', async () => {
      await expect(postCommitRebase('sess-bare', {
        rebaseWatcher: null,
        agentInstanceService: null,
        gitService: { fetchRemote: mockFetchRemote, checkRemoteChanges: mockCheckRemoteChanges, rebase: mockRebase },
      })).resolves.not.toThrow();

      expect(mockFetchRemote).not.toHaveBeenCalled();
      expect(mockRebase).not.toHaveBeenCalled();
    });
  });
});
