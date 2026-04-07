/**
 * Watcher Service
 * File watching and auto-commit engine
 * Migrated from: cs-devops-agent-worker.js
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type {
  FileChangeEvent,
  CommitTriggerEvent,
  CommitCompleteEvent,
  IpcResult,
} from '../../shared/types';
import type { GitService } from './GitService';
import type { ActivityService } from './ActivityService';
import type { TerminalLogService } from './TerminalLogService';
import type { AgentInstanceService } from './AgentInstanceService';
import type { LockService } from './LockService';
import type { ASTParserService } from './analysis/ASTParserService';
import type { RepositoryAnalysisService } from './analysis/RepositoryAnalysisService';
import type { CommitAnalysisService } from './CommitAnalysisService';
import type { WorkerBridgeService } from './WorkerBridgeService';
import type { RebaseWatcherService } from './RebaseWatcherService';
import { databaseService } from './DatabaseService';
import type { AgentType } from '../../shared/types';
import chokidar, { type FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';

interface WatcherInstance {
  sessionId: string;           // May be compound key sessionId:repoName in multi-repo mode
  worktreePath: string;
  watcher: FSWatcher | null;  // null when monitored by utility process
  commitMsgFile: string;
  claudeCommitMsgFile: string; // Fallback: .claude-commit-msg
  repoPath: string;           // Main repo path (for locking)
  agentType: AgentType;       // Agent type (for locking)
  branchName?: string;        // Branch name (for locking)
  repoName?: string;          // Which repo this watcher monitors (multi-repo mode)
  primaryRepoName?: string;   // Set on secondary repos — traces commits back to root repo
}

export class WatcherService extends BaseService {
  private watchers: Map<string, WatcherInstance> = new Map();
  private gitService: GitService;
  private activityService: ActivityService;
  private terminalLogService: TerminalLogService | null = null;
  private agentInstanceService: AgentInstanceService | null = null;
  private lockService: LockService | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  // Phase 4: Analysis services for incremental analysis
  private astParser: ASTParserService | null = null;
  private repositoryAnalysis: RepositoryAnalysisService | null = null;
  private incrementalAnalysisEnabled = false;
  private analysisDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  // Auto-lock: Enable/disable file locking on change
  private autoLockEnabled = true;

  // Commit Analysis: AI-enhanced commit message generation
  private commitAnalysisService: CommitAnalysisService | null = null;
  private enhancedCommitsEnabled = false;

  // Worker bridge: when set, file monitoring runs in utility process
  private workerBridge: WorkerBridgeService | null = null;

  // Rebase watcher: when set, triggers post-commit rebase to stay in sync
  private rebaseWatcher: RebaseWatcherService | null = null;

  // Contract auto-check: detect and regenerate affected contracts after each commit
  private contractDetectionService: any = null;
  private contractGenerationService: any = null;
  private contractCheckInProgress: Set<string> = new Set();

  constructor(git: GitService, activity: ActivityService) {
    super();
    this.gitService = git;
    this.activityService = activity;
  }

  /**
   * Set analysis services for incremental analysis (Phase 4)
   */
  setAnalysisServices(
    astParser: ASTParserService,
    repositoryAnalysis: RepositoryAnalysisService
  ): void {
    this.astParser = astParser;
    this.repositoryAnalysis = repositoryAnalysis;
    console.log('[WatcherService] Analysis services configured for incremental analysis');
  }

  /**
   * Enable/disable incremental analysis on file changes
   */
  setIncrementalAnalysisEnabled(enabled: boolean): void {
    this.incrementalAnalysisEnabled = enabled;
    console.log(`[WatcherService] Incremental analysis ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set the agent instance service for tracking commits (crash recovery)
   */
  setAgentInstanceService(agentInstance: AgentInstanceService): void {
    this.agentInstanceService = agentInstance;
  }

  /**
   * Set the terminal log service for logging to terminal view
   */
  setTerminalLogService(terminalLog: TerminalLogService): void {
    this.terminalLogService = terminalLog;
  }

  /**
   * Set the lock service for auto-locking files on change
   */
  setLockService(lockService: LockService): void {
    this.lockService = lockService;
    console.log('[WatcherService] LockService configured for auto-locking');
  }

  /**
   * Enable/disable auto-locking of files when they change
   */
  setAutoLockEnabled(enabled: boolean): void {
    this.autoLockEnabled = enabled;
    console.log(`[WatcherService] Auto-locking ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set the commit analysis service for AI-enhanced commit messages
   */
  setCommitAnalysisService(commitAnalysis: CommitAnalysisService): void {
    this.commitAnalysisService = commitAnalysis;
    console.log('[WatcherService] CommitAnalysisService configured for enhanced commits');
  }

  /**
   * Enable/disable AI-enhanced commit message generation
   * When enabled, commits will use the CommitAnalysisService to generate
   * detailed messages from actual file diffs instead of using the agent's message.
   */
  setEnhancedCommitsEnabled(enabled: boolean): void {
    this.enhancedCommitsEnabled = enabled;
    console.log(`[WatcherService] Enhanced commit messages ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set worker bridge for utility process monitoring.
   * When set, file watching runs in a separate process.
   */
  setWorkerBridge(bridge: WorkerBridgeService): void {
    this.workerBridge = bridge;
    console.log('[WatcherService] Worker bridge configured — file monitoring delegated to utility process');
  }

  /**
   * Set rebase watcher for post-commit rebase.
   * When set, a rebase check is triggered after every successful commit + push.
   */
  setRebaseWatcher(rebaseWatcher: RebaseWatcherService): void {
    this.rebaseWatcher = rebaseWatcher;
    console.log('[WatcherService] RebaseWatcher configured — post-commit rebase enabled');
  }

  /**
   * Set the contract detection and generation services for commit-level contract auto-checks.
   */
  setContractServices(detection: any, generation: any): void {
    this.contractDetectionService = detection;
    this.contractGenerationService = generation;
    console.log('[WatcherService] Contract services configured for auto-check');
  }

  /**
   * Handle a file change event from the utility process worker.
   * Called by WorkerBridgeService when the worker detects file changes.
   */
  handleExternalFileChange(sessionId: string, filePath: string, changeType: 'add' | 'change' | 'unlink'): void {
    const instance = this.watchers.get(sessionId);
    if (!instance) return;
    this.handleFileChange(instance, filePath, changeType);
  }

  /**
   * Handle a commit message file detection from the utility process worker.
   * Called by WorkerBridgeService when the worker detects a commit msg file.
   */
  handleExternalCommitMsg(sessionId: string, commitMsgFilePath: string): void {
    const instance = this.watchers.get(sessionId);
    if (!instance) return;
    console.log(`[WatcherService] External commit msg detected for ${sessionId}: ${commitMsgFilePath}`);
    this.triggerCommit(instance, commitMsgFilePath);
  }

  async start(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      if (this.watchers.has(sessionId)) {
        return; // Already watching
      }

      // Get session worktree path from git service
      // This would normally come from SessionService, but we'll use a simple approach
      const worktreePath = await this.getWorktreePath(sessionId);
      if (!worktreePath) {
        throw new Error('Session worktree not found - use startWithPath instead');
      }

      await this.startWithPath(sessionId, worktreePath);
    }, 'WATCHER_START_FAILED');
  }

  /**
   * Start watching a specific path (called by AgentInstanceService)
   * @param sessionId - Session ID
   * @param worktreePath - Path to the worktree to watch
   * @param agentType - Type of agent (for auto-locking)
   * @param branchName - Branch name (for auto-locking)
   */
  async startWithPath(
    sessionId: string,
    worktreePath: string,
    agentType: AgentType = 'custom',
    branchName?: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      if (this.watchers.has(sessionId)) {
        return; // Already watching
      }

      // Register the worktree with GitService so commits can work
      // For worktrees, repoPath is the parent of local_deploy
      const repoPath = worktreePath.includes('/local_deploy/')
        ? worktreePath.split('/local_deploy/')[0]
        : worktreePath;
      this.gitService.registerWorktree(sessionId, repoPath, worktreePath);
      console.log(`[WatcherService] Registered worktree for ${sessionId}: ${worktreePath} (repo: ${repoPath})`);

      const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
      const commitMsgFile = path.join(worktreePath, `.devops-commit-${shortSessionId}.msg`);
      // Also watch for common Claude commit msg file
      const claudeCommitMsgFile = path.join(worktreePath, '.claude-commit-msg');

      // When worker bridge is available, delegate file monitoring to utility process
      if (this.workerBridge) {
        const instance: WatcherInstance = {
          sessionId,
          worktreePath,
          watcher: null, // Monitored by utility process
          commitMsgFile,
          claudeCommitMsgFile,
          repoPath,
          agentType,
          branchName,
        };

        this.watchers.set(sessionId, instance);
        this.workerBridge.startFileMonitor(sessionId, worktreePath, commitMsgFile, claudeCommitMsgFile);
        console.log(`[WatcherService] Delegated file monitoring to worker for ${sessionId}`);
        this.activityService.log(sessionId, 'success', `File watcher started (worker process) for ${worktreePath}`);
        this.terminalLogService?.logSystem(`Watcher started (worker): ${worktreePath}`, sessionId);
        return;
      }

      // Fallback: in-process chokidar watcher
      const watcher = chokidar.watch(worktreePath, {
        ignored: (filePath: string) => {
          const basename = path.basename(filePath);
          // Allow commit message files (dotfiles we want to watch)
          if (basename === '.claude-commit-msg' ||
              basename.startsWith('.devops-commit-') ||
              basename.startsWith('.claude-session-')) {
            return false; // Don't ignore these
          }
          // Ignore other dotfiles and common directories
          if (basename.startsWith('.')) return true;
          if (filePath.includes('node_modules')) return true;
          if (filePath.includes('.git')) return true;
          if (filePath.includes('.worktrees')) return true;
          if (filePath.includes('/dist/')) return true;
          if (filePath.includes('/build/')) return true;
          return false;
        },
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 1000,
          pollInterval: 500,
        },
      });

      const instance: WatcherInstance = {
        sessionId,
        worktreePath,
        watcher,
        commitMsgFile,
        claudeCommitMsgFile,
        repoPath,
        agentType,
        branchName,
      };

      // Handle file events
      watcher.on('add', (filePath) => this.handleFileChange(instance, filePath, 'add'));
      watcher.on('change', (filePath) => this.handleFileChange(instance, filePath, 'change'));
      watcher.on('unlink', (filePath) => this.handleFileChange(instance, filePath, 'unlink'));

      watcher.on('error', (error) => {
        this.activityService.log(sessionId, 'error', `Watcher error: ${error.message}`);
      });

      this.watchers.set(sessionId, instance);
      console.log(`[WatcherService] Started watching ${worktreePath} for session ${sessionId}`);
      this.activityService.log(sessionId, 'success', `File watcher started for ${worktreePath}`);
      this.terminalLogService?.logSystem(`Watcher started: ${worktreePath}`, sessionId);
    }, 'WATCHER_START_FAILED');
  }

  async stop(sessionId: string, releaseLocks = true): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const instance = this.watchers.get(sessionId);
      if (!instance) return;

      if (instance.watcher) {
        await instance.watcher.close();
      } else if (this.workerBridge) {
        this.workerBridge.stopFileMonitor(sessionId);
      }
      this.watchers.delete(sessionId);

      // Clear debounce timer
      const timer = this.debounceTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(sessionId);
      }

      // Release all locks for this session
      if (releaseLocks && this.lockService) {
        const result = await this.lockService.releaseSessionLocks(instance.repoPath, sessionId);
        if (result.success && result.data && result.data > 0) {
          console.log(`[WatcherService] Released ${result.data} locks for session ${sessionId}`);
        }
      }

      this.activityService.log(sessionId, 'info', 'File watcher stopped');
    }, 'WATCHER_STOP_FAILED');
  }

  /**
   * Start watching all repos for a multi-repo session.
   * Each repo gets its own WatcherInstance keyed by sessionId:repoName.
   */
  async startMultiRepo(
    sessionId: string,
    repos: Array<{
      repoName: string;
      worktreePath: string;
      repoPath: string;
      agentType: AgentType;
      branchName?: string;
      role?: 'primary' | 'secondary';
    }>
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const primaryRepo = repos.find(r => r.role === 'primary') || repos[0];
      for (const repo of repos) {
        const key = `${sessionId}:${repo.repoName}`;
        await this.startWithPath(key, repo.worktreePath, repo.agentType, repo.branchName);
        // Patch the instance with repoName and primary linkage
        const instance = this.watchers.get(key);
        if (instance) {
          instance.repoName = repo.repoName;
          // Secondary repos get primaryRepoName so commits are prefixed
          if (repo.repoName !== primaryRepo.repoName) {
            instance.primaryRepoName = primaryRepo.repoName;
          }
        }
      }
    }, 'WATCHER_START_MULTI_FAILED');
  }

  /**
   * Stop all watchers for a session (both single and multi-repo compound keys).
   */
  async stopAll(sessionId: string, releaseLocks = true): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const keysToStop: string[] = [];
      for (const key of this.watchers.keys()) {
        if (key === sessionId || key.startsWith(`${sessionId}:`)) {
          keysToStop.push(key);
        }
      }
      for (const key of keysToStop) {
        await this.stop(key, releaseLocks);
      }
    }, 'WATCHER_STOP_ALL_FAILED');
  }

  async isWatching(sessionId: string): Promise<IpcResult<boolean>> {
    return this.success(this.watchers.has(sessionId));
  }

  private handleFileChange(
    instance: WatcherInstance,
    filePath: string,
    type: 'add' | 'change' | 'unlink'
  ): void {
    const { commitMsgFile } = instance;
    // Extract real sessionId from compound key (sessionId:repoName → sessionId)
    const realSessionId = instance.sessionId.includes(':')
      ? instance.sessionId.split(':')[0]
      : instance.sessionId;
    const sessionId = realSessionId;
    const relativePath = path.relative(instance.worktreePath, filePath);

    // Emit file change event
    const event: FileChangeEvent = {
      sessionId,
      filePath: relativePath,
      type,
      timestamp: new Date().toISOString(),
      repoName: instance.repoName,
    };
    console.log(`[WatcherService] File ${type}: ${relativePath} (session: ${sessionId}${instance.repoName ? `, repo: ${instance.repoName}` : ''})`);
    this.emitToRenderer(IPC.FILE_CHANGED, event);

    // Log file activity with path for commit linking
    this.activityService.logFileActivity(
      sessionId,
      'file',
      `File ${type}: ${relativePath}`,
      relativePath,
      { type, fullPath: filePath }
    );

    this.terminalLogService?.log('info', `File ${type}: ${relativePath}`, { sessionId, source: 'Watcher' });

    // Auto-lock the file when it's modified (add or change)
    if (this.autoLockEnabled && this.lockService && (type === 'add' || type === 'change')) {
      this.lockService.autoLockFile(
        instance.repoPath,
        relativePath,
        sessionId,
        instance.agentType,
        instance.branchName
      ).catch(err => {
        console.warn(`[WatcherService] Failed to auto-lock ${relativePath}:`, err);
      });
    }

    // Check if this is a commit message file (either session-specific or .claude-commit-msg)
    const isCommitMsgFile = filePath === instance.commitMsgFile || filePath === instance.claudeCommitMsgFile;
    // Trigger commit on both 'add' (first creation) and 'change' (update) events
    if (isCommitMsgFile && (type === 'change' || type === 'add')) {
      console.log(`[WatcherService] Commit message file ${type}: ${relativePath}`);
      this.triggerCommit(instance, filePath);
    }

    // Phase 4: Trigger incremental analysis for source files
    this.triggerIncrementalAnalysis(instance, filePath, type);
  }

  private async triggerCommit(instance: WatcherInstance, commitMsgFilePath?: string): Promise<void> {
    // Extract real sessionId from compound key (sessionId:repoName → sessionId)
    const sessionId = instance.sessionId.includes(':')
      ? instance.sessionId.split(':')[0]
      : instance.sessionId;
    // Use the provided path or default to session-specific file
    const commitMsgFile = commitMsgFilePath || instance.commitMsgFile;

    // Debounce commits
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(sessionId);

      try {
        // Read commit message from agent
        if (!existsSync(commitMsgFile)) return;
        let message = (await fs.readFile(commitMsgFile, 'utf8')).trim();
        if (!message) return;

        // Optionally enhance commit message using AI analysis of actual diffs
        if (this.enhancedCommitsEnabled && this.commitAnalysisService) {
          try {
            const analysis = await this.commitAnalysisService.analyzeStaged(
              instance.worktreePath,
              {
                includeBody: true,
                contextTask: message, // Use agent's message as context
                contextBranch: instance.branchName,
                useAI: true,
              }
            );

            if (analysis.success && analysis.data) {
              const enhancedMessage = analysis.data.suggestedMessage;
              console.log(`[WatcherService] Enhanced commit message from "${message.substring(0, 30)}..." to "${enhancedMessage.substring(0, 50)}..."`);
              this.terminalLogService?.log('info', `Commit message enhanced with AI analysis`, { sessionId, source: 'CommitAnalysis' });
              message = enhancedMessage;
            }
          } catch (error) {
            console.warn('[WatcherService] Commit message enhancement failed, using original:', error);
            this.terminalLogService?.log('warn', `Commit enhancement failed, using original message`, { sessionId, source: 'CommitAnalysis' });
          }
        }

        // Emit commit triggered event
        const triggerEvent: CommitTriggerEvent = {
          sessionId,
          message,
          timestamp: new Date().toISOString(),
        };
        this.emitToRenderer(IPC.COMMIT_TRIGGERED, triggerEvent);
        this.activityService.log(sessionId, 'commit', `Commit triggered: ${message.substring(0, 50)}...`);

        // For secondary repos, prefix message with "Upgrade From {RootRepo}"
        // so child repo history clearly traces back to the root repo session
        const commitMessage = instance.primaryRepoName
          ? `[Upgrade From ${instance.primaryRepoName}] ${message}`
          : message;

        // Perform commit (pass repoName for multi-repo sessions)
        const result = await this.gitService.commit(sessionId, commitMessage, instance.repoName);
        if (!result.success) {
          throw new Error(result.error?.message || 'Commit failed');
        }

        // Clear commit message file
        await fs.writeFile(commitMsgFile, '');

        // Get file count
        const status = await this.gitService.getStatus(sessionId);
        const filesChanged = status.data?.changes.length || 0;

        const commitHash = result.data!.hash;
        const timestamp = new Date().toISOString();

        // Emit commit completed event
        const completeEvent: CommitCompleteEvent = {
          sessionId,
          commitHash,
          message,
          filesChanged,
          timestamp,
          repoName: instance.repoName,
        };
        this.emitToRenderer(IPC.COMMIT_COMPLETED, completeEvent);
        this.activityService.log(
          sessionId,
          'success',
          `Commit complete: ${result.data!.shortHash}`
        );

        // Link all uncommitted activities to this commit
        // This associates file changes, messages, etc. with the commit that included them
        try {
          const linkedCount = this.activityService.linkToCommit(sessionId, commitHash);
          console.log(`[WatcherService] Linked ${linkedCount} activities to commit ${result.data!.shortHash}`);
        } catch (error) {
          console.warn('[WatcherService] Failed to link activities to commit:', error);
        }

        // Record the commit in the database for history tracking
        try {
          databaseService.recordCommit(commitHash, sessionId, message, timestamp, {
            filesChanged,
          });
          databaseService.recordSessionEvent(sessionId, 'commit', { message, filesChanged }, commitHash);
        } catch (error) {
          console.warn('[WatcherService] Failed to record commit in database:', error);
        }

        // Track the commit for crash recovery
        if (this.agentInstanceService) {
          this.agentInstanceService.updateLastProcessedCommit(sessionId, commitHash);
        }

        // Post-commit cross-session overlap detection
        if (this.lockService) {
          try {
            // Get files changed in this commit via git status (already have this from above)
            const changedFilePaths = (status.data?.changes || []).map((c: { path: string }) => c.path);
            if (changedFilePaths.length > 0) {
              const conflictsResult = await this.lockService.checkConflicts(
                instance.repoPath, changedFilePaths, sessionId
              );
              if (conflictsResult.success && conflictsResult.data && conflictsResult.data.length > 0) {
                const overlaps = conflictsResult.data.map((c: any) => ({
                  file: c.file,
                  committedBySession: sessionId,
                  lockedBySession: c.session || c.sessionId,
                }));
                this.emitToRenderer(IPC.CROSS_SESSION_OVERLAP_DETECTED, {
                  sessionId,
                  repoPath: instance.repoPath,
                  overlaps,
                  commitHash,
                  timestamp: new Date().toISOString(),
                });
                console.log(`[WatcherService] Cross-session overlap detected: ${overlaps.length} file(s) committed by ${sessionId} overlap with other sessions`);
              }
            }
          } catch {
            // Non-fatal: overlap detection is informational
          }
        }

        // Auto-push (could be configurable)
        await this.gitService.push(sessionId, instance.repoName);

        // Post-commit rebase: fetch + rebase if behind remote to stay in sync
        // Try rebase watcher first (for sessions with on-demand rebase), fall back to direct rebase
        try {
          let rebased = false;
          if (this.rebaseWatcher) {
            try {
              const rebaseResult = await this.rebaseWatcher.forceCheck(sessionId);
              if (rebaseResult.success && rebaseResult.data?.hasChanges) {
                console.log(`[WatcherService] Post-commit rebase: synced with remote (was ${rebaseResult.data.behindCount} commits behind)`);
                this.terminalLogService?.log('info', `Post-commit rebase: synced with remote`, { sessionId, source: 'Watcher' });
                rebased = true;
              } else if (rebaseResult.success) {
                rebased = true; // Checked successfully, just nothing to rebase
              }
            } catch {
              // Session not in rebase watcher — fall through to direct rebase
            }
          }

          // Direct rebase fallback: fetch + rebase onto baseBranch
          if (!rebased && this.agentInstanceService) {
            const instResult = this.agentInstanceService.getInstance(sessionId);
            const inst = instResult?.data;
            const baseBranch = inst?.config?.baseBranch || 'main';
            const repoPath = inst?.worktreePath || inst?.config?.repoPath || instance.worktreePath;
            if (repoPath) {
              await this.gitService.fetchRemote(repoPath);
              const checkResult = await this.gitService.checkRemoteChanges(repoPath, baseBranch);
              if (checkResult.success && checkResult.data && checkResult.data.behind > 0) {
                console.log(`[WatcherService] Direct post-commit rebase: ${checkResult.data.behind} commits behind ${baseBranch}`);
                // Use AI rebase through rebaseWatcher so conflicts are auto-resolved
                const rebaseResult = this.rebaseWatcher
                  ? await this.rebaseWatcher.performRebaseForPath(sessionId, repoPath, baseBranch)
                  : await this.gitService.rebase(repoPath, `origin/${baseBranch}`).then(r => ({
                      success: r.success && !!r.data?.success,
                      message: r.data?.message || r.error?.message || '',
                      incomingCommits: r.data?.incomingCommits,
                    }));
                if (rebaseResult.success) {
                  const incoming = (rebaseResult as { incomingCommits?: string[] }).incomingCommits;
                  const commitDetails = incoming && incoming.length > 0
                    ? ` | Changes: ${incoming.join('; ')}`
                    : '';
                  console.log(`[WatcherService] Direct post-commit rebase: synced with ${baseBranch} (${checkResult.data.behind} commits)${commitDetails}`);
                  this.terminalLogService?.log('info', `Post-commit rebase: synced with ${baseBranch} (${checkResult.data.behind} commits integrated)${commitDetails}`, { sessionId, source: 'Watcher' });
                } else {
                  console.warn(`[WatcherService] Direct post-commit rebase failed:`, rebaseResult.message);
                }
              }
            }
          }
        } catch (rebaseError) {
          // Non-fatal: log and continue
          console.warn(`[WatcherService] Post-commit rebase check failed:`, rebaseError);
        }

        // Post-commit contract auto-check (non-fatal)
        this.triggerCommitContractCheck(instance, commitHash).catch(() => {/* already handled inside */});
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.activityService.log(sessionId, 'error', `Commit failed: ${message}`);
      }
    }, 1000);

    this.debounceTimers.set(sessionId, timer);
  }

  private async getWorktreePath(sessionId: string): Promise<string | null> {
    // This would normally query SessionService
    // For now, return null and let caller handle
    return null;
  }

  /**
   * Trigger incremental analysis for a changed file (Phase 4)
   */
  private triggerIncrementalAnalysis(
    instance: WatcherInstance,
    filePath: string,
    changeType: 'add' | 'change' | 'unlink'
  ): void {
    if (!this.incrementalAnalysisEnabled || !this.astParser) {
      return;
    }

    const { sessionId, worktreePath } = instance;

    // Only analyze source files
    const ext = path.extname(filePath).toLowerCase();
    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
    if (!sourceExtensions.includes(ext)) {
      return;
    }

    // Debounce analysis per session
    const existingTimer = this.analysisDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.analysisDebounceTimers.delete(sessionId);

      try {
        // 1. Invalidate AST cache for the changed file
        if (changeType === 'unlink') {
          // File was deleted - invalidate cache
          this.astParser!.invalidateCache(filePath);
          console.log(`[WatcherService] Invalidated AST cache for deleted file: ${filePath}`);
        } else {
          // File was added or modified - re-parse
          const ast = await this.astParser!.parseFile(filePath);
          if (ast) {
            console.log(`[WatcherService] Re-parsed file: ${filePath} (${ast.exports.length} exports)`);
          }
        }

        // 2. Emit incremental analysis event
        this.emitToRenderer(IPC.ANALYSIS_PROGRESS, {
          phase: 'incremental',
          totalFiles: 1,
          processedFiles: 1,
          currentFile: path.relative(worktreePath, filePath),
          errors: [],
          startedAt: new Date().toISOString(),
        });

        // 3. Optionally trigger full feature re-analysis
        // This is expensive, so only do it for significant changes
        if (this.repositoryAnalysis && changeType !== 'unlink') {
          // Detect which feature this file belongs to
          const relativePath = path.relative(worktreePath, filePath);
          const featureName = relativePath.split(path.sep)[0];

          console.log(`[WatcherService] File ${relativePath} may affect feature: ${featureName}`);
          // Note: Full re-analysis is deferred to user action to avoid performance impact
        }

        this.terminalLogService?.log('info', `Incremental analysis: ${path.basename(filePath)}`, { sessionId, source: 'Analysis' });
      } catch (error) {
        console.error('[WatcherService] Incremental analysis error:', error);
      }
    }, 2000); // 2 second debounce for analysis

    this.analysisDebounceTimers.set(sessionId, timer);
  }

  /**
   * After a successful commit, analyze the commit for contract changes and
   * regenerate contracts for any affected features.
   */
  private async triggerCommitContractCheck(instance: WatcherInstance, commitHash: string): Promise<void> {
    // Guard: services not wired
    if (!this.contractDetectionService || !this.contractGenerationService) return;

    // Guard: repo has no contract generation metadata
    const metaFile = `${instance.worktreePath}/.devops-kit/.contract-generation-meta.json`;
    if (!existsSync(metaFile)) return;

    // Guard: prevent overlapping checks for the same session
    const { sessionId } = instance;
    if (this.contractCheckInProgress.has(sessionId)) return;
    this.contractCheckInProgress.add(sessionId);

    try {
      const analysisResult = await this.contractDetectionService.analyzeCommit(instance.worktreePath, commitHash);
      if (!analysisResult.success || !analysisResult.data || !analysisResult.data.hasContractChanges) return;

      const { changes, breakingChanges } = analysisResult.data;
      const changedFiles: string[] = changes.map((c: { file: string }) => c.file);

      const effectiveRepoPath = instance.repoPath || instance.worktreePath;
      const cachedFeatures: any[] = databaseService.getSetting(`discovered_features:${effectiveRepoPath}`, []) || [];
      if (!cachedFeatures.length) return;

      // Find features whose basePath is a parent of any changed file
      const affectedFeatures = cachedFeatures.filter((feature: any) => {
        const relativeFeatPath = path.relative(effectiveRepoPath, feature.basePath);
        return changedFiles.some((f: string) => f.startsWith(relativeFeatPath + '/'));
      });

      if (affectedFeatures.length === 0) return;

      console.log(`[WatcherService] Commit ${commitHash.substring(0, 7)} affects ${affectedFeatures.length} feature(s) — regenerating contracts...`);

      const updatedFeatures: string[] = [];
      for (const feature of affectedFeatures) {
        try {
          const result = await this.contractGenerationService.generateFeatureContract(instance.worktreePath, feature);
          if (result.success) {
            updatedFeatures.push(feature.name);
          } else {
            console.warn(`[WatcherService] Contract update failed for ${feature.name}: ${result.error?.message}`);
          }
        } catch (err) {
          console.warn(`[WatcherService] Contract update failed for ${feature.name}:`, err);
        }
      }

      if (updatedFeatures.length === 0) return;

      const fileBasenames = changedFiles.map((f: string) => path.basename(f));
      const displayFiles = fileBasenames.length > 5
        ? `${fileBasenames.slice(0, 5).join(', ')} +${fileBasenames.length - 5} more`
        : fileBasenames.join(', ');
      const message = `Contracts updated for ${updatedFeatures.length} feature(s): ${updatedFeatures.join(', ')} (${changedFiles.length} files: ${displayFiles})`;

      this.activityService.log(sessionId, 'info', message, {
        type: 'contract-auto-update',
        commitHash,
        updatedFeatures,
        filesChanged: changedFiles,
        breakingChanges: breakingChanges.length,
      });

      this.emitToRenderer(IPC.CONTRACT_CHANGES_DETECTED, {
        repoPath: instance.worktreePath,
        commitHash,
        updatedFeatures,
        hasBreakingChanges: breakingChanges.length > 0,
      });
    } catch (err) {
      console.error('[WatcherService] Contract auto-check error:', err);
    } finally {
      this.contractCheckInProgress.delete(sessionId);
    }
  }

  async dispose(): Promise<void> {
    for (const [sessionId] of this.watchers) {
      await this.stop(sessionId);
    }

    // Clear analysis debounce timers
    for (const timer of this.analysisDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.analysisDebounceTimers.clear();
  }
}
