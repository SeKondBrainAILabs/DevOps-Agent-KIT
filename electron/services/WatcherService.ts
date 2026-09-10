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
import { resolveRepoRootFromWorktree } from '../../shared/worktree-path';
import { evaluateAutoCommitGuardForWorktree } from './GitRewriteGuardIO';
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
  // Periodic safety-net snapshot timers (key = compound watcher key).
  private periodicCommitTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly PERIODIC_COMMIT_MS = 5 * 60 * 1000; // snapshot every 5 min when dirty
  // Idle-end detection state. When an agent makes a burst of writes and then
  // goes quiet, that's a natural checkpoint — we log it to the activity feed
  // and (in the future) can nudge the agent to commit.
  private writeHistory: Map<string, number[]> = new Map(); // sessionId → recent timestamps
  private lastIdleEndAt: Map<string, number> = new Map();  // sessionId → last idle-end tick
  private idleEndTimer: NodeJS.Timeout | null = null;
  private static readonly IDLE_END_TICK_MS = 60 * 1000;
  /** 30 min of no writes to ANY tracked file in the session before idle-end
   *  fires. Was 5 min — easily exhausted by an agent pausing mid-thought,
   *  which caused auto-checkpoint attempts on files still being iterated on.
   *  30 min is high enough that "quiet" actually means the agent has moved
   *  on, low enough that the auto-checkpoint still lands within the hour. */
  private static readonly IDLE_END_QUIET_MS = 30 * 60 * 1000;
  /** Burst window widened to match — a "burst" spans 90 min of accumulated
   *  writes so idle-end after 30 min of quiet still sees the burst it's
   *  responding to. Was 30 min. */
  private static readonly IDLE_END_BURST_WINDOW_MS = 90 * 60 * 1000;
  private static readonly IDLE_END_MIN_WRITES = 3;
  /** Don't emit two idle-end notifications for the same session within 15 min. */
  private static readonly IDLE_END_COOLDOWN_MS = 15 * 60 * 1000;
  /** Auto-commit on idle-end when it's been longer than this since HEAD moved.
   *  Anything shorter and the agent is probably mid-flow; anything much longer
   *  and we're accumulating the kind of blob-merge (98 files at once) the
   *  screenshot showed. */
  private static readonly AUTO_COMMIT_STALE_HEAD_MS = 3 * 60 * 60 * 1000;
  /** Minimum gap between two AUTO commits on the same session, so a flurry of
   *  idle-ends doesn't stack five checkpoint commits in ten minutes. */
  private static readonly AUTO_COMMIT_COOLDOWN_MS = 60 * 60 * 1000;
  /** Timestamp of last auto-commit per session (Date.now() ms). */
  private lastAutoCommitAt: Map<string, number> = new Map();

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

      // Register the worktree with GitService so commits can work. The layout
      // rules (legacy <repo>/local_deploy/<branch> and current
      // <repo_parent>/KIT-DevOps-<repo_name>/<branch>) live in
      // shared/worktree-path.ts, which owns both directions of the mapping.
      // A path that is not a KIT worktree falls back to itself, unchanged.
      const repoPath = resolveRepoRootFromWorktree(worktreePath)?.root ?? worktreePath;
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
        this.startPeriodicCommit(instance);
        this.startIdleEndTimer();
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
          // Nested worktree containers (`local_deploy`, `.worktrees`): recursing
          // into a worktree that holds other sessions' worktrees produces a
          // phantom-event storm → main-process memory runaway. Check segments
          // RELATIVE to the watched root (substring would self-ignore the root,
          // whose path contains '/local_deploy/').
          const rel = path.relative(worktreePath, filePath);
          if (rel) {
            const segs = rel.split(path.sep);
            if (segs.includes('local_deploy') || segs.includes('.worktrees')) return true;
          }
          if (filePath.includes('node_modules')) return true;
          if (filePath.includes('.git')) return true;
          if (filePath.includes('/dist/')) return true;
          if (filePath.includes('/build/')) return true;
          return false;
        },
        persistent: true,
        ignoreInitial: true,
        // Don't follow symlinks into sibling repos (unbounded cross-repo recursion).
        followSymlinks: false,
        awaitWriteFinish: {
          // 30s of "no writes" before we consider the file settled. Was 1s,
          // which was short enough that an agent saving a burst of files
          // could trigger auto-lock / commit-msg-file / idle-end tracking
          // while a later file in the burst was still mid-write. 30s
          // eliminates that class of mid-change catch. Adds up to 30s of
          // latency on the activity feed's "file X changed" line — a fair
          // trade for correctness.
          stabilityThreshold: 30_000,
          pollInterval: 2_000,
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
      this.startPeriodicCommit(instance);
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

      // Clear commit debounce timer
      const timer = this.debounceTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(sessionId);
      }

      // Clear periodic auto-commit timer
      const periodic = this.periodicCommitTimers.get(sessionId);
      if (periodic) {
        clearInterval(periodic);
        this.periodicCommitTimers.delete(sessionId);
      }

      // Clear analysis debounce timer — must also clear here (not just dispose())
      // so that a pending analysis doesn't fire after the session is torn down
      const analysisTimer = this.analysisDebounceTimers.get(sessionId);
      if (analysisTimer) {
        clearTimeout(analysisTimer);
        this.analysisDebounceTimers.delete(sessionId);
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

  /** Live resource counts for diagnostics (watchers + outstanding timers). */
  debugCounts(): { watchers: number; debounce: number; periodic: number; analysis: number } {
    return {
      watchers: this.watchers.size,
      debounce: this.debounceTimers.size,
      periodic: this.periodicCommitTimers.size,
      analysis: this.analysisDebounceTimers.size,
    };
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

    // Hard guard: drop events under nested worktree containers. A worktree
    // checkout can contain its own `local_deploy/` (or `.worktrees/`) holding
    // OTHER sessions' worktrees — and via symlinks/submodules the tree can nest
    // arbitrarily deep. Processing those produces a phantom-event storm (one
    // session emitted 6,759 add events) → activity rows + locks + IPC + DB per
    // event → main-process memory runaway. This is the authoritative filter:
    // it cannot be bypassed by chokidar's (unreliable) directory pruning.
    const segments = relativePath.split(path.sep);
    if (segments.includes('local_deploy') || segments.includes('.worktrees')) {
      return;
    }

    // Track for idle-end detection. Only 'change' / 'add' count as real work;
    // 'unlink' can be part of a burst too so include it. Bounded — we cap at
    // 100 entries per session and drop anything older than the burst window.
    if (type === 'change' || type === 'add' || type === 'unlink') {
      const now = Date.now();
      const cutoff = now - WatcherService.IDLE_END_BURST_WINDOW_MS;
      const hist = (this.writeHistory.get(sessionId) || []).filter(t => t > cutoff);
      hist.push(now);
      if (hist.length > 100) hist.splice(0, hist.length - 100);
      this.writeHistory.set(sessionId, hist);
    }

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

  /**
   * Periodic safety-net snapshot. Replaces the old WIP periodic auto-commit
   * (which polluted history AND, fatally, let truncated/broken files reach
   * origin/main — see the Kemory ai_chat_service.py case in 2026-06).
   *
   * Every PERIODIC_COMMIT_MS we pin the worktree state (tracked + untracked)
   * to `refs/kit-autosave/<sessionId>` via `git stash create` + `update-ref`.
   * HEAD, the index, and `git log` are untouched. The pinned ref is reachable
   * for crash recovery — `git diff refs/kit-autosave/<sessionId>` shows what
   * the worktree looked like at last snapshot — without ever creating a
   * commit, and so without ever bypassing pre-commit hooks or risking a push.
   *
   * Real commits stay agent-driven via `kit_commit` (which is gated by the
   * parser + diff-size checks added alongside this change).
   */
  private startPeriodicCommit(instance: WatcherInstance): void {
    const key = instance.sessionId;
    const existing = this.periodicCommitTimers.get(key);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      this.triggerPeriodicSnapshot(instance).catch((err) =>
        console.warn(`[WatcherService] periodic snapshot failed for ${key}:`, err));
    }, WatcherService.PERIODIC_COMMIT_MS);
    this.periodicCommitTimers.set(key, timer);
  }

  /**
   * Periodic idle-end evaluator. Runs on a single shared timer (not per-session)
   * so we don't multiply timer overhead by session count. For each active
   * watcher, checks: was there a burst of writes AND has the agent been quiet
   * for IDLE_END_QUIET_MS? If yes, and not on cooldown, emit an activity feed
   * entry AND fire an extra snapshot pinned to `refs/kit-idle-end/<sessionId>`
   * so the burst-end state is separately recoverable from the rolling
   * kit-autosave ref (which the next periodic snapshot would overwrite).
   *
   * If HEAD hasn't moved in AUTO_COMMIT_STALE_HEAD_MS AND the worktree parses
   * cleanly (Python/JS syntax check), also lay down an auto-checkpoint commit
   * so the eventual merge is a series of small chunks rather than the 98-file
   * blob-merge the screenshot in v2.6.89 was arguing against. Auto-commits are
   * self-labeled (`[Kanvas] auto-checkpoint after Xh idle`) so squash on merge
   * is trivial. Never pushed. Falls back to snapshot-only when the parse gate
   * blocks — a broken worktree never reaches `git log`.
   */
  private startIdleEndTimer(): void {
    if (this.idleEndTimer) return;
    this.idleEndTimer = setInterval(() => {
      this.evaluateIdleEnd().catch(err => console.warn('[WatcherService] idle-end eval failed:', err));
    }, WatcherService.IDLE_END_TICK_MS);
  }

  private async evaluateIdleEnd(): Promise<void> {
    const now = Date.now();
    // Distinct sessionIds first (a session may have multiple compound watchers
    // in multi-repo mode; we only nudge once per session).
    const sessionsSeen = new Set<string>();
    for (const [key, instance] of this.watchers) {
      const sessionId = key.includes(':') ? key.split(':')[0] : key;
      if (sessionsSeen.has(sessionId)) continue;
      sessionsSeen.add(sessionId);

      const hist = this.writeHistory.get(sessionId);
      if (!hist || hist.length < WatcherService.IDLE_END_MIN_WRITES) continue;
      const lastWrite = hist[hist.length - 1];
      if (now - lastWrite < WatcherService.IDLE_END_QUIET_MS) continue; // still active
      const lastNudge = this.lastIdleEndAt.get(sessionId) || 0;
      if (now - lastNudge < WatcherService.IDLE_END_COOLDOWN_MS) continue; // cooldown

      // Idle-end confirmed. Pin an extra snapshot to a dedicated ref namespace
      // so the burst-end state doesn't get overwritten by the next periodic
      // kit-autosave snapshot.
      try {
        const snap = await this.gitService.createSnapshot(instance.worktreePath, `${sessionId}-idle-end`);
        this.lastIdleEndAt.set(sessionId, now);
        this.writeHistory.set(sessionId, []); // reset burst so we don't re-fire immediately
        const nWrites = hist.length;
        const quietMin = Math.round((now - lastWrite) / 60_000);
        const refHint = snap.success && snap.data ? snap.data.refName : null;

        // Second stage: consider an auto-commit if HEAD has been stationary long
        // enough that the agent is racking up blob-merge material.
        const autoCommitResult = await this.tryIdleEndAutoCommit(instance, sessionId, nWrites, now);

        if (autoCommitResult.committed) {
          this.activityService.log(
            sessionId,
            'commit',
            `Auto-checkpoint [${autoCommitResult.shortHash}] after ${autoCommitResult.staleHours}h idle (${nWrites} writes). Merge will squash — self-labeled '[Kanvas] auto-checkpoint'.`
          );
        } else {
          this.activityService.log(
            sessionId,
            'snapshot',
            `Idle-end detected — ${nWrites} write(s) in the last burst, quiet ${quietMin} min. ` +
            (autoCommitResult.skipReason ? `Auto-commit skipped: ${autoCommitResult.skipReason}. ` : '') +
            (refHint ? `Burst-end snapshot: git checkout ${refHint}. ` : '') +
            `Consider calling kit_commit to lock in progress.`
          );
        }
      } catch (err) {
        console.warn(`[WatcherService] idle-end snapshot failed for ${sessionId}:`, err);
      }
    }
  }

  /**
   * Attempt an auto-checkpoint commit on idle-end. Returns `{ committed: true }`
   * on success, `{ committed: false, skipReason }` when we deliberately declined
   * (head recent, cooldown active, parse failure, empty tree). Never pushes.
   */
  private async tryIdleEndAutoCommit(
    instance: WatcherInstance,
    sessionId: string,
    nWrites: number,
    now: number
  ): Promise<{ committed: true; shortHash: string; staleHours: number } | { committed: false; skipReason?: string }> {
    // 0. Source-repo guard. If the "worktree" path is the same directory as
    //    the user's source checkout, an auto-commit would land on whatever
    //    branch they happen to have checked out there — the opposite of the
    //    isolation KIT is meant to provide. Refuse the auto-commit; the
    //    snapshot ref still recovers the work. This can only happen in a
    //    truly in-place session (useWorktree: false with no sibling worktree
    //    ever created); v2.6.91 migrates the stale useWorktree drift on
    //    startup so this branch is essentially dead code — but the guard
    //    stays as a defense-in-depth line the auto path never crosses.
    if (instance.worktreePath === instance.repoPath) {
      return { committed: false, skipReason: 'in-place session — never auto-commit against source-repo HEAD' };
    }

    // 0.5. History-rewrite guard (from origin/main track, merged at v2.7.0).
    //      Refuse if a rebase/merge/cherry-pick/bisect is in progress or the
    //      worktree is on a detached HEAD — a commit landing in any of those
    //      states can silently orphan the real work git is mid-rewriting.
    const guard = evaluateAutoCommitGuardForWorktree(instance.worktreePath);
    if (!guard.allowed) {
      return { committed: false, skipReason: `${guard.kind}: ${guard.message}` };
    }

    // 1. Cooldown between auto-commits per session.
    const lastAuto = this.lastAutoCommitAt.get(sessionId) || 0;
    if (now - lastAuto < WatcherService.AUTO_COMMIT_COOLDOWN_MS) {
      return { committed: false }; // silent skip — cooldown, don't clutter feed
    }

    // 2. HEAD age. If the branch is being committed to at normal cadence the
    //    agent doesn't need our help.
    let staleMs = Infinity;
    try {
      const commitTs = await this.gitCmd(instance.worktreePath, ['log', '-1', '--format=%ct', 'HEAD']);
      const secs = parseInt(commitTs.trim(), 10);
      if (Number.isFinite(secs) && secs > 0) staleMs = now - secs * 1000;
    } catch { /* no HEAD yet — treat as infinitely stale so first commit lands */ }
    if (staleMs < WatcherService.AUTO_COMMIT_STALE_HEAD_MS) {
      return { committed: false }; // recent enough, silent skip
    }

    // 3. Anything to commit?
    let dirty = '';
    try {
      dirty = await this.gitCmd(instance.worktreePath, ['status', '--porcelain']);
    } catch {
      return { committed: false, skipReason: 'git status failed' };
    }
    if (!dirty.trim()) return { committed: false }; // clean tree — nothing to do

    // 4. Parse-check any changed source files we understand. Reuses the same
    //    logic as kit_commit's sanity gate — a broken file never lands as
    //    an auto-commit. The user still has the snapshot ref for recovery.
    const parseFailure = await this.parseCheckChangedFiles(instance.worktreePath, dirty);
    if (parseFailure) {
      return { committed: false, skipReason: `parse error in ${parseFailure.file} (${parseFailure.error})` };
    }

    // 5. Do it.
    const staleHours = Math.max(1, Math.round(staleMs / 3600_000));
    const baseMsg = `[Kanvas] auto-checkpoint after ${staleHours}h idle (${nWrites} writes)`;
    const commitMessage = instance.primaryRepoName
      ? `[Upgrade From ${instance.primaryRepoName}] ${baseMsg}`
      : baseMsg;
    const result = await this.gitService.commit(sessionId, commitMessage, instance.repoName);
    if (!result.success || !result.data) {
      return { committed: false, skipReason: `git commit failed: ${result.error?.message || 'unknown'}` };
    }
    this.lastAutoCommitAt.set(sessionId, now);
    return { committed: true, shortHash: result.data.shortHash || result.data.hash.substring(0, 7), staleHours };
  }

  /** Run one raw git command in a worktree, return stdout. Thin wrapper so the
   *  auto-commit path can reach the same execa the rest of KIT uses without
   *  going through GitService's IPC-shaped API. */
  private async gitCmd(cwd: string, args: string[]): Promise<string> {
    const mod: any = await import('execa');
    const execa = typeof mod.execa === 'function' ? mod.execa
      : typeof mod.default === 'function' ? mod.default
      : mod.default?.execa;
    const { stdout } = await execa('git', args, { cwd, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  }

  /** Parse-check changed source files. Returns null on success, or the first
   *  offending file (name + short error) so the caller can log which one
   *  blocked the auto-commit. Mirrors the syntactic gate in tools.ts —
   *  Python via `python3 -c ast.parse`, JS/MJS/CJS via `node --check`.
   *  TS/TSX/JSX skipped (no cheap parser available — kit_commit uses a
   *  structural check but that's more code than the auto path needs).
   */
  private async parseCheckChangedFiles(
    worktreePath: string,
    porcelain: string
  ): Promise<{ file: string; error: string } | null> {
    for (const line of porcelain.split('\n')) {
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      if (xy.includes('D')) continue; // deleted, nothing to parse
      const rel = line.slice(3).replace(/^"|"$/g, '');
      const ext = rel.toLowerCase().split('.').pop() || '';
      let bin = ''; let args: string[] = [];
      const abs = `${worktreePath}/${rel}`;
      if (!existsSync(abs)) continue;
      if (ext === 'py') { bin = 'python3'; args = ['-c', 'import ast,sys\nast.parse(open(sys.argv[1]).read())', abs]; }
      else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') { bin = 'node'; args = ['--check', abs]; }
      else continue;
      try {
        const mod: any = await import('execa');
        const execa = typeof mod.execa === 'function' ? mod.execa : typeof mod.default === 'function' ? mod.default : mod.default?.execa;
        await execa(bin, args, { cwd: worktreePath, timeout: 5_000 });
      } catch (err: any) {
        const stderr = (err?.stderr || err?.message || '').toString().split('\n').slice(0, 2).join(' ');
        return { file: rel, error: stderr.slice(0, 120) };
      }
    }
    return null;
  }

  private async triggerPeriodicSnapshot(instance: WatcherInstance): Promise<void> {
    const sessionId = instance.sessionId.includes(':')
      ? instance.sessionId.split(':')[0]
      : instance.sessionId;

    // Worktree must still exist.
    if (!existsSync(instance.worktreePath)) return;
    // Don't race an agent-triggered commit that's debouncing.
    if (this.debounceTimers.has(sessionId)) return;

    // SAFETY (from origin/main track): never touch the worktree during a
    // rebase / merge / cherry-pick / bisect / detached HEAD, or while a
    // history-rewrite lockfile is held. Even for snapshot-only paths this
    // avoids racing with `git stash create` against a transient index.
    const guard = evaluateAutoCommitGuardForWorktree(instance.worktreePath);
    if (!guard.allowed) {
      console.warn(
        `[WatcherService] Periodic snapshot skipped for ${sessionId}: ${guard.kind} — ${guard.message}`
      );
      return;
    }

    // Only snapshot when there's actually uncommitted work.
    const status = await this.gitService.getStatus(sessionId).catch(() => null);
    const changed = status?.data?.changes?.length || 0;
    if (!status?.success || changed === 0) return;

    const snap = await this.gitService.createSnapshot(instance.worktreePath, sessionId);
    if (!snap.success || !snap.data) return;

    // Info-level activity log so the user can see snapshots happening without
    // noise — kept quieter than the old 'commit' line.
    this.activityService.log(
      sessionId,
      'snapshot',
      `Crash-safety snapshot saved (${changed} file${changed === 1 ? '' : 's'}) — recover via git checkout ${snap.data.refName}`
    );
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

        // v2.7.5 — Rebase BEFORE push so the commit sits on top of the
        // latest base, then push (force-with-lease if the rebase rewrote
        // history). If the rebase fails, the branch is left at pre-rebase
        // state and push is skipped so we don't publish a stale-base commit.
        const rebaseInfo = await this.attemptPostCommitRebase(sessionId, instance.repoName);
        if (rebaseInfo.ok) {
          try {
            await this.gitService.push(
              sessionId,
              instance.repoName,
              rebaseInfo.rewrote ? { forceWithLease: true } : undefined,
            );
          } catch (err) {
            this.activityService.log(sessionId, 'warning', `Push failed after commit: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          this.activityService.log(sessionId, 'warning', `Push skipped — post-commit rebase failed: ${rebaseInfo.message}`);
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

  /**
   * Fire the "on-demand" rebase logic after a successful commit. Attempts,
   * in order:
   *
   *   1. `rebaseWatcher.forceCheck(sessionId)` — works when the session is
   *      registered with the rebase watcher (i.e. rebaseFrequency !== 'never').
   *      For on-demand sessions this is the intended path.
   *   2. Direct fallback — resolve the instance's baseBranch, fetch origin,
   *      and if we're behind, run `performRebaseForPath` (AI-assisted so
   *      conflicts auto-resolve). Covers sessions with rebaseFrequency:
   *      'never' or where the watcher wasn't registered on this app run.
   *
   * Non-fatal — a rebase failure is logged as a warning and doesn't propagate.
   * Public so both the debounced .commit-msg-file path AND the MCP kit_commit
   * handler can call it; before extraction, only the .commit-msg path fired
   * a post-commit rebase and agent-driven MCP commits silently skipped it.
   */
  async attemptPostCommitRebase(sessionId: string, repoName?: string): Promise<{
    ok: boolean;
    rewrote: boolean;
    commitsIntegrated: number;
    baseBranch?: string;
    message: string;
    conflictFiles?: string[];
  }> {
    // Best-effort abort helper. Called when the rebase raised or conflicted so
    // we leave a clean tree behind rather than a half-applied rebase state.
    // ENOENT and "no rebase in progress" both come back as thrown errors — we
    // swallow both since they mean the tree is already clean.
    const abortIfInProgress = async (cwd: string): Promise<void> => {
      try { await this.gitService.rebase(cwd, `--abort`); } catch { /* clean already */ }
    };

    let baseBranch: string | undefined;
    let repoPath: string | undefined;

    try {
      if (this.agentInstanceService) {
        const instResult = this.agentInstanceService.getInstance(sessionId);
        const inst = instResult?.data;
        baseBranch = inst?.config?.baseBranch || 'main';
        // Use ROOT repo path — worktrees can vanish, source repo is always present.
        repoPath = inst?.config?.repoPath;
      }
      if (!repoPath || !baseBranch) {
        return { ok: true, rewrote: false, commitsIntegrated: 0, message: 'Post-commit rebase skipped: session config unresolved' };
      }

      // 1. Fetch so origin/<base> reflects the current remote.
      await this.gitService.fetchRemote(repoPath);
      const checkResult = await this.gitService.checkRemoteChanges(repoPath, baseBranch);
      const behind = checkResult.success && checkResult.data ? (checkResult.data.behind || 0) : 0;

      if (behind === 0) {
        // Up-to-date — no rebase needed, no history rewrite, push can go
        // fast-forward.
        return { ok: true, rewrote: false, commitsIntegrated: 0, baseBranch, message: `Already up to date with ${baseBranch}` };
      }

      console.log(`[WatcherService] Post-commit rebase: ${behind} commits behind ${baseBranch}`);
      const rebaseResult = this.rebaseWatcher
        ? await this.rebaseWatcher.performRebaseForPath(sessionId, repoPath, baseBranch)
        : await this.gitService.rebase(repoPath, `origin/${baseBranch}`).then(r => ({
            success: r.success && !!r.data?.success,
            message: r.data?.message || r.error?.message || '',
            incomingCommits: r.data?.incomingCommits,
          }));

      if (rebaseResult.success) {
        const incoming = (rebaseResult as { incomingCommits?: string[] }).incomingCommits || [];
        const commitDetails = incoming.length > 0
          ? `: ${incoming.slice(0, 3).join('; ')}${incoming.length > 3 ? ` +${incoming.length - 3} more` : ''}`
          : '';
        const msg = `Rebased onto ${baseBranch} (${behind} commit${behind !== 1 ? 's' : ''} integrated${commitDetails})`;
        this.terminalLogService?.log('info', msg, { sessionId, source: 'Watcher' });
        this.activityService.log(sessionId, 'git', msg);
        return { ok: true, rewrote: true, commitsIntegrated: behind, baseBranch, message: msg };
      }

      // Rebase failed. Abort any in-progress state so the tree is clean,
      // then surface an actionable message. Push should NOT happen after a
      // failed rebase — otherwise the agent publishes a stale-base commit.
      await abortIfInProgress(repoPath);
      const errMsg = `Rebase onto ${baseBranch} failed — session branch left at pre-rebase state. Push skipped. ${rebaseResult.message || 'Resolve conflicts and retry via kit_rebase.'}`;
      console.warn(`[WatcherService] Post-commit rebase failed:`, rebaseResult.message);
      this.activityService.log(sessionId, 'warning', errMsg, { detail: rebaseResult.message });
      return {
        ok: false,
        rewrote: false,
        commitsIntegrated: 0,
        baseBranch,
        message: errMsg,
        conflictFiles: (rebaseResult as { conflictFiles?: string[] }).conflictFiles,
      };
    } catch (rebaseError) {
      if (repoPath) await abortIfInProgress(repoPath);
      const errMsg = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
      console.warn(`[WatcherService] Post-commit rebase threw:`, rebaseError);
      this.activityService.log(sessionId, 'warning', `Post-commit rebase failed: ${errMsg}. Push skipped.`);
      return { ok: false, rewrote: false, commitsIntegrated: 0, baseBranch, message: `Post-commit rebase threw: ${errMsg}` };
    }
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

    // Clear any lingering periodic auto-commit timers
    for (const timer of this.periodicCommitTimers.values()) {
      clearInterval(timer);
    }
    this.periodicCommitTimers.clear();
  }
}
