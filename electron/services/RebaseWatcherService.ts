/**
 * Rebase Watcher Service
 * Monitors remote branches and auto-rebases when changes are detected
 * Implements US-1: Auto-Rebase on Remote Changes (On-Demand Mode)
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type { GitService } from './GitService';
import type { MergeConflictService } from './MergeConflictService';
import type { WorkerBridgeService } from './WorkerBridgeService';
import type { DebugLogService } from './DebugLogService';
import type { IpcResult, RebaseFrequency } from '../../shared/types';

// Watch configuration for a session
export interface RebaseWatchConfig {
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  rebaseFrequency: RebaseFrequency;
  pollIntervalMs: number;
}

// Watch state for tracking
interface WatchState {
  config: RebaseWatchConfig;
  intervalId: NodeJS.Timeout | null;
  lastChecked: Date | null;
  lastRemoteCommit: string | null;
  isRebasing: boolean;
  isPaused: boolean;
  behindCount: number;
  aheadCount: number;
  lastRebaseResult: {
    success: boolean;
    message: string;
    timestamp: Date;
  } | null;
}

// Event payloads
export interface RebaseWatcherStatus {
  sessionId: string;
  isWatching: boolean;
  isPaused: boolean;
  isRebasing: boolean;
  behindCount: number;
  aheadCount: number;
  lastChecked: string | null;
  lastRebaseResult: {
    success: boolean;
    message: string;
    timestamp: string;
  } | null;
}

export interface RemoteChangesDetectedEvent {
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  behindCount: number;
  newCommits: number;
}

export interface AutoRebaseResultEvent {
  sessionId: string;
  success: boolean;
  message: string;
  hadUncommittedChanges: boolean;
}

// Default poll interval: 60 seconds
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

export class RebaseWatcherService extends BaseService {
  private gitService: GitService;
  private mergeConflictService: MergeConflictService | null = null;
  private watchedSessions: Map<string, WatchState> = new Map();
  private workerBridge: WorkerBridgeService | null = null;
  private debugLog: DebugLogService | null = null;

  constructor(gitService: GitService) {
    super();
    this.gitService = gitService;
  }

  /**
   * Set merge conflict service for AI-powered conflict resolution during rebase
   */
  setMergeConflictService(service: MergeConflictService): void {
    this.mergeConflictService = service;
    console.log('[RebaseWatcher] MergeConflictService configured — AI conflict resolution enabled');
  }

  /**
   * Set debug log service for persistent error logging
   */
  setDebugLog(debugLog: DebugLogService): void {
    this.debugLog = debugLog;
  }

  /**
   * Set worker bridge for utility process polling.
   * When set, git fetch polling runs in a separate process.
   */
  setWorkerBridge(bridge: WorkerBridgeService): void {
    this.workerBridge = bridge;
    console.log('[RebaseWatcher] Worker bridge configured — polling delegated to utility process');
  }

  /**
   * Handle remote status update from the utility process worker.
   * Called by WorkerBridgeService when the worker completes a poll cycle.
   */
  handleExternalRemoteStatus(
    sessionId: string,
    behind: number,
    ahead: number,
    remoteBranch: string,
    localBranch: string
  ): void {
    const state = this.watchedSessions.get(sessionId);
    if (!state || state.isPaused || state.isRebasing) return;

    state.lastChecked = new Date();
    const previousBehind = state.behindCount;
    state.behindCount = behind;
    state.aheadCount = ahead;

    // Emit updated status to renderer
    this.emitStatus(sessionId);

    // Detect new commits
    const hasNewCommits = behind > 0 && behind > previousBehind;
    if (hasNewCommits) {
      console.log(`[RebaseWatcher] Worker detected ${behind} commits behind for ${sessionId}`);
      this.emitToRenderer(IPC.REBASE_REMOTE_CHANGES_DETECTED, {
        sessionId,
        repoPath: state.config.repoPath,
        baseBranch: state.config.baseBranch,
        behindCount: behind,
        newCommits: behind - previousBehind,
      });
    }
  }

  /**
   * Start watching a session for remote changes
   */
  async startWatching(config: RebaseWatchConfig): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const sessionId = config.sessionId;

      // Stop existing watcher if any
      if (this.watchedSessions.has(sessionId)) {
        await this.stopWatching(sessionId);
      }

      // Only watch if frequency is 'on-demand'
      if (config.rebaseFrequency !== 'on-demand') {
        console.log(`[RebaseWatcher] Skipping watch for ${sessionId} - frequency is ${config.rebaseFrequency}`);
        return;
      }

      const pollInterval = config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

      // When worker bridge is available, delegate polling to utility process
      if (this.workerBridge) {
        const state: WatchState = {
          config: { ...config, pollIntervalMs: pollInterval },
          intervalId: null,
          lastChecked: null,
          lastRemoteCommit: null,
          isRebasing: false,
          isPaused: false,
          behindCount: 0,
          aheadCount: 0,
          lastRebaseResult: null,
        };
        this.watchedSessions.set(sessionId, state);
        this.workerBridge.startRebaseMonitor(sessionId, config.repoPath, config.baseBranch, 'origin', pollInterval);
        console.log(`[RebaseWatcher] Delegated polling to worker for ${sessionId}`);
        this.emitStatus(sessionId);
        return;
      }

      // Fallback: in-process polling
      // Get initial remote state
      const initialStatus = await this.checkRemoteStatus(config.repoPath, config.baseBranch);

      const state: WatchState = {
        config: { ...config, pollIntervalMs: pollInterval },
        intervalId: null,
        lastChecked: new Date(),
        lastRemoteCommit: initialStatus.lastCommit,
        isRebasing: false,
        isPaused: false,
        behindCount: initialStatus.behind,
        aheadCount: initialStatus.ahead,
        lastRebaseResult: null,
      };

      // Start polling
      state.intervalId = setInterval(() => {
        this.pollForChanges(sessionId);
      }, pollInterval);

      this.watchedSessions.set(sessionId, state);

      this.debugLog?.info('RebaseWatcher', `Started watching session`, { sessionId, repoPath: config.repoPath, pollIntervalMs: pollInterval });
    console.log(`[RebaseWatcher] Started watching ${sessionId} (${config.repoPath}) - polling every ${pollInterval / 1000}s`);

      // Emit initial status
      this.emitStatus(sessionId);
    }, 'REBASE_WATCH_START_FAILED');
  }

  /**
   * Stop watching a session
   */
  async stopWatching(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const state = this.watchedSessions.get(sessionId);
      if (!state) {
        return;
      }

      if (state.intervalId) {
        clearInterval(state.intervalId);
      } else if (this.workerBridge) {
        this.workerBridge.stopRebaseMonitor(sessionId);
      }

      this.watchedSessions.delete(sessionId);
      console.log(`[RebaseWatcher] Stopped watching ${sessionId}`);

      // Emit stopped status
      this.emitToRenderer(IPC.REBASE_WATCHER_STOPPED, { sessionId });
    }, 'REBASE_WATCH_STOP_FAILED');
  }

  /**
   * Pause watching (e.g., during manual operations)
   */
  pauseWatching(sessionId: string): void {
    const state = this.watchedSessions.get(sessionId);
    if (state) {
      state.isPaused = true;
      console.log(`[RebaseWatcher] Paused watching ${sessionId}`);
      this.emitStatus(sessionId);
    }
  }

  /**
   * Resume watching after pause
   */
  resumeWatching(sessionId: string): void {
    const state = this.watchedSessions.get(sessionId);
    if (state) {
      state.isPaused = false;
      console.log(`[RebaseWatcher] Resumed watching ${sessionId}`);
      this.emitStatus(sessionId);
      // Immediately check for changes
      this.pollForChanges(sessionId);
    }
  }

  /**
   * Get current watch status for a session
   */
  getWatchStatus(sessionId: string): RebaseWatcherStatus | null {
    const state = this.watchedSessions.get(sessionId);
    if (!state) {
      return null;
    }

    return {
      sessionId,
      isWatching: true,
      isPaused: state.isPaused,
      isRebasing: state.isRebasing,
      behindCount: state.behindCount,
      aheadCount: state.aheadCount,
      lastChecked: state.lastChecked?.toISOString() || null,
      lastRebaseResult: state.lastRebaseResult
        ? {
            success: state.lastRebaseResult.success,
            message: state.lastRebaseResult.message,
            timestamp: state.lastRebaseResult.timestamp.toISOString(),
          }
        : null,
    };
  }

  /**
   * Get all watched sessions
   */
  getWatchedSessions(): string[] {
    return Array.from(this.watchedSessions.keys());
  }

  /**
   * Force an immediate check for changes (manual trigger)
   */
  async forceCheck(sessionId: string): Promise<IpcResult<{ hasChanges: boolean; behindCount: number }>> {
    return this.wrap(async () => {
      const state = this.watchedSessions.get(sessionId);
      if (!state) {
        throw new Error(`Session ${sessionId} is not being watched`);
      }

      const result = await this.checkAndRebaseIfNeeded(state, true);
      return {
        hasChanges: result.hasChanges,
        behindCount: state.behindCount,
      };
    }, 'REBASE_FORCE_CHECK_FAILED');
  }

  /**
   * Manually trigger rebase for a watched session
   */
  async triggerRebase(sessionId: string): Promise<IpcResult<{ success: boolean; message: string }>> {
    return this.wrap(async () => {
      const state = this.watchedSessions.get(sessionId);
      if (!state) {
        throw new Error(`Session ${sessionId} is not being watched`);
      }

      if (state.isRebasing) {
        return { success: false, message: 'Rebase already in progress' };
      }

      return await this.performAutoRebase(state);
    }, 'REBASE_TRIGGER_FAILED');
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  /**
   * Poll for remote changes (called by interval)
   */
  private async pollForChanges(sessionId: string): Promise<void> {
    const state = this.watchedSessions.get(sessionId);
    if (!state || state.isPaused || state.isRebasing) {
      return;
    }

    try {
      await this.checkAndRebaseIfNeeded(state, false);
    } catch (error) {
      this.debugLog?.error('RebaseWatcher', `Error polling for remote changes`, {
        sessionId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      console.error(`[RebaseWatcher] Error polling ${sessionId}:`, error);
    }
  }

  /**
   * Check remote and rebase if changes detected
   */
  private async checkAndRebaseIfNeeded(
    state: WatchState,
    forceRebase: boolean
  ): Promise<{ hasChanges: boolean }> {
    const { config } = state;

    // Fetch and check remote status
    const status = await this.checkRemoteStatus(config.repoPath, config.baseBranch);

    state.lastChecked = new Date();
    const previousBehind = state.behindCount;
    state.behindCount = status.behind;
    state.aheadCount = status.ahead;

    // Emit updated status
    this.emitStatus(config.sessionId);

    // Check if there are new commits
    const hasNewCommits = status.behind > 0 && (
      forceRebase ||
      state.lastRemoteCommit !== status.lastCommit ||
      status.behind > previousBehind
    );

    if (hasNewCommits) {
      console.log(`[RebaseWatcher] Detected ${status.behind} new commits behind ${config.baseBranch} for ${config.sessionId}`);

      // Emit changes detected event - notify UI but do NOT auto-rebase
      // User should explicitly trigger rebase via the UI
      this.emitToRenderer(IPC.REBASE_REMOTE_CHANGES_DETECTED, {
        sessionId: config.sessionId,
        repoPath: config.repoPath,
        baseBranch: config.baseBranch,
        behindCount: status.behind,
        newCommits: status.behind - previousBehind,
      } as RemoteChangesDetectedEvent);

      // Update last known commit
      state.lastRemoteCommit = status.lastCommit;

      // Only auto-rebase if explicitly forced (user-triggered), not during polling
      if (forceRebase && status.behind > 0) {
        await this.performAutoRebase(state);
      }

      return { hasChanges: true };
    }

    return { hasChanges: false };
  }

  /**
   * Check remote branch status
   */
  private async checkRemoteStatus(
    repoPath: string,
    baseBranch: string
  ): Promise<{ behind: number; ahead: number; lastCommit: string | null }> {
    // Fetch latest from remote
    await this.gitService.fetchRemote(repoPath, 'origin');

    // Check behind/ahead
    const checkResult = await this.gitService.checkRemoteChanges(repoPath, baseBranch);
    const behind = checkResult.success ? checkResult.data?.behind || 0 : 0;
    const ahead = checkResult.success ? checkResult.data?.ahead || 0 : 0;

    // Get latest commit hash on remote base branch
    let lastCommit: string | null = null;
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const result = await execAsync(`git rev-parse origin/${baseBranch}`, { cwd: repoPath });
      lastCommit = result.stdout.trim();
    } catch {
      // Ignore errors getting commit hash
    }

    return { behind, ahead, lastCommit };
  }

  /**
   * Perform automatic rebase
   */
  private async performAutoRebase(state: WatchState): Promise<{ success: boolean; message: string }> {
    const { config } = state;

    if (state.isRebasing) {
      return { success: false, message: 'Rebase already in progress' };
    }

    state.isRebasing = true;
    this.emitStatus(config.sessionId);

    this.debugLog?.info('RebaseWatcher', `Starting auto-rebase`, {
      sessionId: config.sessionId,
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      currentBranch: config.currentBranch,
      behindCount: state.behindCount,
      aheadCount: state.aheadCount,
    });
    console.log(`[RebaseWatcher] Starting auto-rebase for ${config.sessionId} onto ${config.baseBranch}`);

    try {
      // Use AI-powered rebase if MergeConflictService is available
      let result: IpcResult<{
        success: boolean;
        message: string;
        hadChanges?: boolean;
        rawError?: string;
        conflictsResolved?: number;
        conflictsFailed?: number;
      }>;

      if (this.mergeConflictService) {
        console.log(`[RebaseWatcher] Using AI-powered rebase for ${config.sessionId}`);
        result = await this.gitService.performRebaseWithAI(config.repoPath, config.baseBranch, this.mergeConflictService);
      } else {
        result = await this.gitService.performRebase(config.repoPath, config.baseBranch);
      }

      const rebaseResult = {
        success: result.success && result.data?.success || false,
        message: result.data?.message || result.error?.message || 'Unknown error',
        timestamp: new Date(),
        data: result.data,
      };

      state.lastRebaseResult = rebaseResult;
      state.isRebasing = false;

      // Emit result event
      this.emitToRenderer(IPC.REBASE_AUTO_COMPLETED, {
        sessionId: config.sessionId,
        success: rebaseResult.success,
        message: rebaseResult.message,
        hadUncommittedChanges: result.data?.hadChanges || false,
      } as AutoRebaseResultEvent);

      // Update status after rebase
      if (rebaseResult.success) {
        state.behindCount = 0;
        const aiInfo = result.data?.conflictsResolved
          ? ` (AI resolved ${result.data.conflictsResolved} conflicts)`
          : '';
        this.debugLog?.info('RebaseWatcher', `Auto-rebase successful${aiInfo}`, { sessionId: config.sessionId });
        console.log(`[RebaseWatcher] Auto-rebase successful for ${config.sessionId}${aiInfo}`);
      } else {
        // Pause watching on conflict to prevent repeated failures
        state.isPaused = true;

        // Parse conflict files from the raw error output (git rebase --abort cleans up
        // the working tree, so `git diff --diff-filter=U` returns nothing)
        const rawError = result.data?.rawError || rebaseResult.message;
        let conflictedFiles: string[] = [];
        if (rawError) {
          const conflictMatches = rawError.matchAll(/CONFLICT.*?:\s+Merge conflict in (.+)/g);
          for (const match of conflictMatches) {
            if (match[1]) conflictedFiles.push(match[1].trim());
          }
        }

        this.debugLog?.error('RebaseWatcher', `Auto-rebase FAILED — merge conflicts detected`, {
          sessionId: config.sessionId,
          repoPath: config.repoPath,
          baseBranch: config.baseBranch,
          currentBranch: config.currentBranch,
          errorMessage: rebaseResult.message,
          rawError,
          conflictedFiles,
          conflictedFileCount: conflictedFiles.length,
          behindCount: state.behindCount,
          aheadCount: state.aheadCount,
          watcherPaused: true,
        });
        console.log(`[RebaseWatcher] Auto-rebase failed for ${config.sessionId}, pausing watcher. Conflicts in: ${conflictedFiles.join(', ') || 'unknown'}`);

        this.emitToRenderer(IPC.REBASE_ERROR_DETECTED, {
          sessionId: config.sessionId,
          repoPath: config.repoPath,
          baseBranch: config.baseBranch,
          currentBranch: config.currentBranch,
          conflictedFiles,
          errorMessage: rebaseResult.message,
          rawError,
        });
      }

      this.emitStatus(config.sessionId);

      return { success: rebaseResult.success, message: rebaseResult.message };
    } catch (error) {
      state.isRebasing = false;
      state.isPaused = true; // Pause on error

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      state.lastRebaseResult = {
        success: false,
        message: errorMessage,
        timestamp: new Date(),
      };

      this.debugLog?.error('RebaseWatcher', `Auto-rebase threw exception`, {
        sessionId: config.sessionId,
        repoPath: config.repoPath,
        baseBranch: config.baseBranch,
        currentBranch: config.currentBranch,
        errorMessage,
        errorStack,
        behindCount: state.behindCount,
        aheadCount: state.aheadCount,
        watcherPaused: true,
      });

      this.emitStatus(config.sessionId);
      console.error(`[RebaseWatcher] Auto-rebase error for ${config.sessionId}:`, error);

      return { success: false, message: errorMessage };
    }
  }

  /**
   * Emit current status to renderer
   */
  private emitStatus(sessionId: string): void {
    const status = this.getWatchStatus(sessionId);
    if (status) {
      this.emitToRenderer(IPC.REBASE_WATCHER_STATUS, status);
    }
  }

  /**
   * Cleanup on shutdown
   */
  async dispose(): Promise<void> {
    // Stop all watchers
    for (const sessionId of this.watchedSessions.keys()) {
      await this.stopWatching(sessionId);
    }
  }
}
