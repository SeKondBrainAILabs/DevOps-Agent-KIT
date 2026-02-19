/**
 * Electron Preload Script
 * Exposes type-safe API to renderer via contextBridge
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type {
  Session,
  CreateSessionRequest,
  CloseSessionRequest,
  GitStatus,
  GitCommit,
  BranchInfo,
  FileLock,
  FileConflict,
  RepoLockSummary,
  LockChangeEvent,
  FileChangeEvent,
  CommitTriggerEvent,
  CommitCompleteEvent,
  ChatMessage,
  ActivityLogEntry,
  AppConfig,
  Credentials,
  IpcResult,
  RepoVersionInfo,
  RepoVersionSettings,
  AppUpdateInfo,
} from '../shared/types';
import type {
  AgentInfo,
  AgentStatusUpdate,
  AgentActivityReport,
  SessionReport,
} from '../shared/agent-protocol';
import type {
  AgentInstance,
  AgentInstanceConfig,
  RepoValidation,
  RecentRepo,
  AgentType,
} from '../shared/types';

/**
 * Type-safe API exposed to renderer process
 */
const api = {
  // ==========================================================================
  // SESSION API
  // ==========================================================================
  session: {
    create: (request: CreateSessionRequest): Promise<IpcResult<Session>> =>
      ipcRenderer.invoke(IPC.SESSION_CREATE, request),

    list: (): Promise<IpcResult<Session[]>> =>
      ipcRenderer.invoke(IPC.SESSION_LIST),

    get: (id: string): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.SESSION_GET, id),

    close: (request: CloseSessionRequest): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.SESSION_CLOSE, request),

    claim: (sessionId: string): Promise<IpcResult<Session>> =>
      ipcRenderer.invoke(IPC.SESSION_CLAIM, sessionId),

    onCreated: (callback: (session: Session) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on(IPC.SESSION_CREATED, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_CREATED, handler);
    },

    onUpdated: (callback: (session: Session) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on(IPC.SESSION_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_UPDATED, handler);
    },

    onClosed: (callback: (sessionId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string) => callback(sessionId);
      ipcRenderer.on(IPC.SESSION_CLOSED, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_CLOSED, handler);
    },
  },

  // ==========================================================================
  // GIT API
  // ==========================================================================
  git: {
    status: (sessionId: string): Promise<IpcResult<GitStatus>> =>
      ipcRenderer.invoke(IPC.GIT_STATUS, sessionId),

    commit: (sessionId: string, message: string): Promise<IpcResult<GitCommit>> =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, sessionId, message),

    push: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.GIT_PUSH, sessionId),

    merge: (sessionId: string, targetBranch: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.GIT_MERGE, sessionId, targetBranch),

    branches: (sessionId: string): Promise<IpcResult<BranchInfo[]>> =>
      ipcRenderer.invoke(IPC.GIT_BRANCHES, sessionId),

    getChangedFiles: (repoPath: string, baseBranch?: string): Promise<IpcResult<Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>>> =>
      ipcRenderer.invoke(IPC.GIT_GET_CHANGED_FILES, repoPath, baseBranch),

    getFilesWithStatus: (repoPath: string, baseBranch?: string): Promise<IpcResult<Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      gitState: 'staged' | 'unstaged' | 'committed' | 'untracked';
      commitHash?: string;
      commitShortHash?: string;
      commitMessage?: string;
    }>>> =>
      ipcRenderer.invoke(IPC.GIT_GET_FILES_WITH_STATUS, repoPath, baseBranch),

    getDiffSummary: (repoPath: string): Promise<IpcResult<{
      totalFiles: number;
      totalAdditions: number;
      totalDeletions: number;
      filesByType: Record<string, number>;
      summary: string;
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        diff: string;
      }>;
    }>> =>
      ipcRenderer.invoke(IPC.GIT_GET_DIFF_SUMMARY, repoPath),

    getCommitHistory: (repoPath: string, baseBranch?: string, limit?: number): Promise<IpcResult<Array<{
      hash: string;
      shortHash: string;
      message: string;
      author: string;
      date: string;
      filesChanged: number;
      additions: number;
      deletions: number;
      files?: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        additions: number;
        deletions: number;
      }>;
    }>>> =>
      ipcRenderer.invoke(IPC.GIT_GET_COMMIT_HISTORY, repoPath, baseBranch, limit),

    getCommitDiff: (repoPath: string, commitHash: string): Promise<IpcResult<{
      commit: {
        hash: string;
        shortHash: string;
        message: string;
        author: string;
        date: string;
        filesChanged: number;
        additions: number;
        deletions: number;
      };
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        diff: string;
        language?: string;
      }>;
    }>> =>
      ipcRenderer.invoke(IPC.GIT_GET_COMMIT_DIFF, repoPath, commitHash),

    fetch: (repoPath: string, remote?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.GIT_FETCH, repoPath, remote),

    performRebase: (repoPath: string, baseBranch: string): Promise<IpcResult<{
      success: boolean;
      message: string;
      hadChanges: boolean;
      commitsAdded?: number;
      beforeHead?: string;
      afterHead?: string;
    }>> =>
      ipcRenderer.invoke(IPC.GIT_PERFORM_REBASE, repoPath, baseBranch),

    onStatusChanged: (callback: (data: { sessionId: string; status: GitStatus }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { sessionId: string; status: GitStatus }) => callback(data);
      ipcRenderer.on(IPC.GIT_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.GIT_STATUS_CHANGED, handler);
    },
  },

  // ==========================================================================
  // WATCHER API
  // ==========================================================================
  watcher: {
    start: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.WATCHER_START, sessionId),

    stop: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.WATCHER_STOP, sessionId),

    status: (sessionId: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.WATCHER_STATUS, sessionId),

    onFileChanged: (callback: (event: FileChangeEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: FileChangeEvent) => callback(data);
      ipcRenderer.on(IPC.FILE_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.FILE_CHANGED, handler);
    },

    onCommitTriggered: (callback: (event: CommitTriggerEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: CommitTriggerEvent) => callback(data);
      ipcRenderer.on(IPC.COMMIT_TRIGGERED, handler);
      return () => ipcRenderer.removeListener(IPC.COMMIT_TRIGGERED, handler);
    },

    onCommitCompleted: (callback: (event: CommitCompleteEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: CommitCompleteEvent) => callback(data);
      ipcRenderer.on(IPC.COMMIT_COMPLETED, handler);
      return () => ipcRenderer.removeListener(IPC.COMMIT_COMPLETED, handler);
    },
  },

  // ==========================================================================
  // LOCK API
  // ==========================================================================
  lock: {
    // Legacy session-based API
    declare: (sessionId: string, files: string[], operation: 'edit' | 'read' | 'delete'): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.LOCK_DECLARE, sessionId, files, operation),

    release: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.LOCK_RELEASE, sessionId),

    // New auto-lock API (repo/file-based)
    checkConflicts: (repoPath: string, files: string[], excludeSessionId?: string): Promise<IpcResult<FileConflict[]>> =>
      ipcRenderer.invoke(IPC.LOCK_CHECK, repoPath, files, excludeSessionId),

    getRepoLocks: (repoPath: string): Promise<IpcResult<RepoLockSummary>> =>
      ipcRenderer.invoke(IPC.LOCK_LIST, repoPath),

    forceRelease: (repoPath: string, filePath: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.LOCK_FORCE_RELEASE, repoPath, filePath),

    // Legacy list (for backwards compatibility)
    list: (): Promise<IpcResult<FileLock[]>> =>
      ipcRenderer.invoke(IPC.LOCK_LIST),

    // Backwards compatibility alias
    check: (files: string[]): Promise<IpcResult<FileConflict[]>> =>
      ipcRenderer.invoke(IPC.LOCK_CHECK, files),

    // Events
    onConflictDetected: (callback: (conflicts: FileConflict[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, conflicts: FileConflict[]) => callback(conflicts);
      ipcRenderer.on(IPC.CONFLICT_DETECTED, handler);
      return () => ipcRenderer.removeListener(IPC.CONFLICT_DETECTED, handler);
    },

    onLockChanged: (callback: (event: LockChangeEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, lockEvent: LockChangeEvent) => callback(lockEvent);
      ipcRenderer.on(IPC.LOCK_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.LOCK_CHANGED, handler);
    },
  },

  // ==========================================================================
  // CONFIG API
  // ==========================================================================
  config: {
    get: <K extends keyof AppConfig>(key: K): Promise<IpcResult<AppConfig[K]>> =>
      ipcRenderer.invoke(IPC.CONFIG_GET, key),

    set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONFIG_SET, key, value),

    getAll: (): Promise<IpcResult<AppConfig>> =>
      ipcRenderer.invoke(IPC.CONFIG_GET_ALL),
  },

  // ==========================================================================
  // CREDENTIAL API
  // ==========================================================================
  credential: {
    get: (key: keyof Credentials): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(IPC.CREDENTIAL_GET, key),

    set: (key: keyof Credentials, value: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CREDENTIAL_SET, key, value),

    has: (key: keyof Credentials): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.CREDENTIAL_HAS, key),
  },

  // ==========================================================================
  // AI/CHAT API
  // ==========================================================================
  ai: {
    chat: (messages: ChatMessage[]): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.AI_CHAT, messages),

    startStream: (messages: ChatMessage[]): void => {
      ipcRenderer.send(IPC.AI_STREAM_START, messages);
    },

    stopStream: (): void => {
      ipcRenderer.send(IPC.AI_STREAM_STOP);
    },

    onChunk: (callback: (chunk: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, chunk: string) => callback(chunk);
      ipcRenderer.on(IPC.AI_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC.AI_STREAM_CHUNK, handler);
    },

    onEnd: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.AI_STREAM_END, handler);
      return () => ipcRenderer.removeListener(IPC.AI_STREAM_END, handler);
    },

    onError: (callback: (error: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on(IPC.AI_STREAM_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC.AI_STREAM_ERROR, handler);
    },

    // Mode-based prompts
    chatWithMode: (options: {
      modeId: string;
      promptKey: string;
      variables?: Record<string, string>;
      userMessage?: string;
    }): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.AI_CHAT_WITH_MODE, options),

    startStreamWithMode: (options: {
      modeId: string;
      promptKey: string;
      variables?: Record<string, string>;
      userMessage?: string;
    }): void => {
      ipcRenderer.send(IPC.AI_STREAM_WITH_MODE, options);
    },

    listModes: (): Promise<IpcResult<Array<{ id: string; name: string; description: string }>>> =>
      ipcRenderer.invoke(IPC.AI_LIST_MODES),

    getMode: (modeId: string): Promise<IpcResult<{
      id: string;
      name: string;
      description: string;
      settings: { temperature?: number; max_tokens?: number; model?: string };
      prompts: Record<string, unknown>;
    } | null>> =>
      ipcRenderer.invoke(IPC.AI_GET_MODE, modeId),

    reloadConfig: (): Promise<IpcResult<{ modes: number; models: number }>> =>
      ipcRenderer.invoke(IPC.AI_RELOAD_CONFIG),

    getConfigSources: (): Promise<IpcResult<{
      modelsPath: string;
      modesDirectory: string;
      externalConfigPath: string | null;
      submodulePath: string | null;
    }>> =>
      ipcRenderer.invoke(IPC.AI_GET_CONFIG_SOURCES),
  },

  // ==========================================================================
  // ACTIVITY LOG API
  // ==========================================================================
  activity: {
    get: (sessionId: string, limit?: number, offset?: number): Promise<IpcResult<ActivityLogEntry[]>> =>
      ipcRenderer.invoke(IPC.LOG_GET, sessionId, limit, offset),

    clear: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.LOG_CLEAR, sessionId),

    getCommits: (sessionId: string, limit?: number): Promise<IpcResult<Array<{
      hash: string;
      message: string;
      timestamp: string;
      filesChanged: number;
      additions: number;
      deletions: number;
    }>>> =>
      ipcRenderer.invoke(IPC.LOG_GET_COMMITS, sessionId, limit),

    getTimeline: (sessionId: string, limit?: number): Promise<IpcResult<Array<{
      type: 'activity' | 'commit';
      timestamp: string;
      data: ActivityLogEntry | {
        hash: string;
        message: string;
        filesChanged: number;
        additions: number;
        deletions: number;
      };
    }>>> =>
      ipcRenderer.invoke(IPC.LOG_GET_TIMELINE, sessionId, limit),

    onLog: (callback: (entry: ActivityLogEntry) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, entry: ActivityLogEntry) => callback(entry);
      ipcRenderer.on(IPC.LOG_ENTRY, handler);
      return () => ipcRenderer.removeListener(IPC.LOG_ENTRY, handler);
    },
  },

  // ==========================================================================
  // AGENT API
  // Kanvas monitors agents that report into it (dashboard pattern)
  // ==========================================================================
  agent: {
    initialize: (baseDir: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.AGENT_INITIALIZE, baseDir),

    list: (): Promise<IpcResult<(AgentInfo & { isAlive: boolean; sessions: string[] })[]>> =>
      ipcRenderer.invoke(IPC.AGENT_LIST),

    get: (agentId: string): Promise<IpcResult<(AgentInfo & { isAlive: boolean; sessions: string[] }) | null>> =>
      ipcRenderer.invoke(IPC.AGENT_GET, agentId),

    getSessions: (agentId: string): Promise<IpcResult<SessionReport[]>> =>
      ipcRenderer.invoke(IPC.AGENT_SESSIONS, agentId),

    // Events - Agents report into Kanvas
    onRegistered: (callback: (agent: AgentInfo & { isAlive: boolean; sessions: string[] }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, agent: AgentInfo & { isAlive: boolean; sessions: string[] }) => callback(agent);
      ipcRenderer.on(IPC.AGENT_REGISTERED, handler);
      return () => ipcRenderer.removeListener(IPC.AGENT_REGISTERED, handler);
    },

    onUnregistered: (callback: (agentId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, agentId: string) => callback(agentId);
      ipcRenderer.on(IPC.AGENT_UNREGISTERED, handler);
      return () => ipcRenderer.removeListener(IPC.AGENT_UNREGISTERED, handler);
    },

    onHeartbeat: (callback: (data: { agentId: string; timestamp: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { agentId: string; timestamp: string }) => callback(data);
      ipcRenderer.on(IPC.AGENT_HEARTBEAT, handler);
      return () => ipcRenderer.removeListener(IPC.AGENT_HEARTBEAT, handler);
    },

    onStatusChanged: (callback: (data: { agentId: string; isAlive: boolean; lastHeartbeat: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { agentId: string; isAlive: boolean; lastHeartbeat: string }) => callback(data);
      ipcRenderer.on(IPC.AGENT_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.AGENT_STATUS_CHANGED, handler);
    },

    onSessionReported: (callback: (session: SessionReport) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, session: SessionReport) => callback(session);
      ipcRenderer.on(IPC.SESSION_REPORTED, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_REPORTED, handler);
    },

    onActivityReported: (callback: (activity: AgentActivityReport) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, activity: AgentActivityReport) => callback(activity);
      ipcRenderer.on(IPC.ACTIVITY_REPORTED, handler);
      return () => ipcRenderer.removeListener(IPC.ACTIVITY_REPORTED, handler);
    },
  },

  // ==========================================================================
  // INSTANCE API
  // Create and manage agent instances from Kanvas dashboard
  // ==========================================================================
  instance: {
    create: (config: AgentInstanceConfig): Promise<IpcResult<AgentInstance>> =>
      ipcRenderer.invoke(IPC.INSTANCE_CREATE, config),

    validateRepo: (path: string): Promise<IpcResult<RepoValidation>> =>
      ipcRenderer.invoke(IPC.INSTANCE_VALIDATE_REPO, path),

    initializeKanvas: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.INSTANCE_INITIALIZE_KANVAS, path),

    getInstructions: (agentType: AgentType, config: AgentInstanceConfig): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.INSTANCE_GET_INSTRUCTIONS, agentType, config),

    launch: (instanceId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.INSTANCE_LAUNCH, instanceId),

    list: (): Promise<IpcResult<AgentInstance[]>> =>
      ipcRenderer.invoke(IPC.INSTANCE_LIST),

    get: (instanceId: string): Promise<IpcResult<AgentInstance | null>> =>
      ipcRenderer.invoke(IPC.INSTANCE_GET, instanceId),

    delete: (instanceId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.INSTANCE_DELETE, instanceId),

    deleteSession: (sessionId: string, repoPath?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.INSTANCE_DELETE_SESSION, sessionId, repoPath),

    restart: (sessionId: string, sessionData?: {
      repoPath: string;
      branchName: string;
      baseBranch?: string;
      worktreePath?: string;
      agentType?: string;
      task?: string;
    }): Promise<IpcResult<AgentInstance>> =>
      ipcRenderer.invoke(IPC.INSTANCE_RESTART, sessionId, sessionData),

    clearAll: (): Promise<IpcResult<{ count: number }>> =>
      ipcRenderer.invoke(IPC.INSTANCE_CLEAR_ALL),

    updateBaseBranch: (sessionId: string, newBaseBranch: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.INSTANCE_UPDATE_BASE_BRANCH, sessionId, newBaseBranch),

    getRecentRepos: (): Promise<IpcResult<RecentRepo[]>> =>
      ipcRenderer.invoke(IPC.RECENT_REPOS_LIST),

    addRecentRepo: (repo: RecentRepo): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.RECENT_REPOS_ADD, repo),

    removeRecentRepo: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.RECENT_REPOS_REMOVE, path),

    onStatusChanged: (callback: (instance: AgentInstance) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, instance: AgentInstance) => callback(instance);
      ipcRenderer.on(IPC.INSTANCE_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.INSTANCE_STATUS_CHANGED, handler);
    },

    onDeleted: (callback: (instanceId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, instanceId: string) => callback(instanceId);
      ipcRenderer.on(IPC.INSTANCE_DELETED, handler);
      return () => ipcRenderer.removeListener(IPC.INSTANCE_DELETED, handler);
    },

    onCleared: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.INSTANCES_CLEARED, handler);
      return () => ipcRenderer.removeListener(IPC.INSTANCES_CLEARED, handler);
    },
  },

  // ==========================================================================
  // DIALOG API
  // ==========================================================================
  dialog: {
    openDirectory: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_DIRECTORY),

    showMessage: (options: { type: 'info' | 'warning' | 'error'; title: string; message: string }): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.DIALOG_SHOW_MESSAGE, options),
  },

  // ==========================================================================
  // APP API
  // ==========================================================================
  app: {
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke(IPC.APP_GET_VERSION),

    reload: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.APP_RELOAD),

    quit: (): void => {
      ipcRenderer.send(IPC.APP_QUIT);
    },
  },

  // ==========================================================================
  // VERSION MANAGEMENT API
  // ==========================================================================
  version: {
    getRepoVersion: (repoPath: string): Promise<IpcResult<RepoVersionInfo>> =>
      ipcRenderer.invoke(IPC.VERSION_GET, repoPath),

    bump: (repoPath: string, component: 'major' | 'minor' | 'patch'): Promise<IpcResult<RepoVersionInfo>> =>
      ipcRenderer.invoke(IPC.VERSION_BUMP, repoPath, component),

    getSettings: (repoPath: string): Promise<IpcResult<RepoVersionSettings>> =>
      ipcRenderer.invoke(IPC.VERSION_GET_SETTINGS, repoPath),

    setSettings: (repoPath: string, settings: RepoVersionSettings): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.VERSION_SET_SETTINGS, repoPath, settings),
  },

  // ==========================================================================
  // RECOVERY API
  // Session recovery for orphaned sessions
  // ==========================================================================
  recovery: {
    scanRepo: (repoPath: string): Promise<IpcResult<Array<{
      sessionId: string;
      repoPath: string;
      sessionData: { task?: string; branchName?: string; agentType?: string };
      lastModified: Date;
    }>>> =>
      ipcRenderer.invoke(IPC.RECOVERY_SCAN_REPO, repoPath),

    scanAll: (): Promise<IpcResult<Array<{
      sessionId: string;
      repoPath: string;
      sessionData: { task?: string; branchName?: string; agentType?: string };
      lastModified: Date;
    }>>> =>
      ipcRenderer.invoke(IPC.RECOVERY_SCAN_ALL),

    recoverSession: (sessionId: string, repoPath: string): Promise<IpcResult<AgentInstance>> =>
      ipcRenderer.invoke(IPC.RECOVERY_RECOVER_SESSION, sessionId, repoPath),

    recoverMultiple: (sessions: Array<{ sessionId: string; repoPath: string }>): Promise<IpcResult<{
      recovered: AgentInstance[];
      failed: Array<{ sessionId: string; error: string }>;
    }>> =>
      ipcRenderer.invoke(IPC.RECOVERY_RECOVER_MULTIPLE, sessions),

    deleteOrphaned: (sessionId: string, repoPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.RECOVERY_DELETE_ORPHANED, sessionId, repoPath),

    onRecovered: (callback: (instance: AgentInstance) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, instance: AgentInstance) => callback(instance);
      ipcRenderer.on(IPC.INSTANCE_RECOVERED, handler);
      return () => ipcRenderer.removeListener(IPC.INSTANCE_RECOVERED, handler);
    },

    onOrphanedSessionsFound: (callback: (sessions: Array<{
      sessionId: string;
      repoPath: string;
      sessionData: { task?: string; branchName?: string; agentType?: string };
      lastModified: Date;
    }>) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessions: Array<{
        sessionId: string;
        repoPath: string;
        sessionData: { task?: string; branchName?: string; agentType?: string };
        lastModified: Date;
      }>) => callback(sessions);
      ipcRenderer.on(IPC.ORPHANED_SESSIONS_FOUND, handler);
      return () => ipcRenderer.removeListener(IPC.ORPHANED_SESSIONS_FOUND, handler);
    },
  },

  // ==========================================================================
  // CLEANUP API
  // Repository cleanup for worktrees, branches, and Kanvas files
  // ==========================================================================
  cleanup: {
    analyze: (repoPath: string, targetBranch?: string): Promise<IpcResult<{
      repoPath: string;
      worktreesToRemove: Array<{ path: string; branch: string; isOrphaned?: boolean }>;
      branchesToDelete: Array<{ name: string; isMerged: boolean; hasAssociatedSession?: boolean }>;
      branchesToMerge: Array<{ branch: string; targetBranch: string; order: number }>;
      estimatedActions: number;
    }>> =>
      ipcRenderer.invoke(IPC.CLEANUP_ANALYZE, repoPath, targetBranch),

    execute: (plan: {
      repoPath: string;
      worktreesToRemove: Array<{ path: string; branch: string }>;
      branchesToDelete: Array<{ name: string; isMerged: boolean }>;
      branchesToMerge: Array<{ branch: string; targetBranch: string; order: number }>;
    }, options?: {
      removeWorktrees?: boolean;
      deleteMergedBranches?: boolean;
      mergeCompletedBranches?: boolean;
      deleteRemoteBranches?: boolean;
    }): Promise<IpcResult<{
      success: boolean;
      worktreesRemoved: number;
      branchesDeleted: number;
      branchesMerged: number;
      errors: string[];
    }>> =>
      ipcRenderer.invoke(IPC.CLEANUP_EXECUTE, plan, options),

    quick: (repoPath: string): Promise<IpcResult<{
      worktreesPruned: boolean;
      kanvasCleanup: {
        removedSessionFiles: number;
        removedAgentFiles: number;
        removedActivityFiles: number;
      };
    }>> =>
      ipcRenderer.invoke(IPC.CLEANUP_QUICK, repoPath),

    kanvas: (repoPath: string): Promise<IpcResult<{
      removedSessionFiles: number;
      removedAgentFiles: number;
      removedActivityFiles: number;
    }>> =>
      ipcRenderer.invoke(IPC.CLEANUP_KANVAS, repoPath),

    onProgress: (callback: (data: { message: string; result: unknown }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { message: string; result: unknown }) => callback(data);
      ipcRenderer.on(IPC.CLEANUP_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.CLEANUP_PROGRESS, handler);
    },
  },

  // ==========================================================================
  // CONTRACT DETECTION API
  // Detect contract changes in commits (API specs, schemas, interfaces)
  // ==========================================================================
  contract: {
    analyzeCommit: (repoPath: string, commitHash?: string): Promise<IpcResult<{
      commitHash: string;
      commitMessage: string;
      timestamp: string;
      hasContractChanges: boolean;
      changes: Array<{
        file: string;
        type: string;
        changeType: 'added' | 'modified' | 'deleted';
        additions: number;
        deletions: number;
        impactLevel: 'breaking' | 'non-breaking' | 'unknown';
      }>;
      breakingChanges: Array<{
        file: string;
        type: string;
        changeType: 'added' | 'modified' | 'deleted';
        impactLevel: 'breaking';
      }>;
      summary: string;
      recommendations: string[];
    }>> =>
      ipcRenderer.invoke(IPC.CONTRACT_ANALYZE_COMMIT, repoPath, commitHash),

    analyzeRange: (repoPath: string, fromRef?: string, toRef?: string): Promise<IpcResult<Array<{
      commitHash: string;
      commitMessage: string;
      timestamp: string;
      hasContractChanges: boolean;
      changes: Array<{
        file: string;
        type: string;
        changeType: 'added' | 'modified' | 'deleted';
        additions: number;
        deletions: number;
        impactLevel: 'breaking' | 'non-breaking' | 'unknown';
      }>;
      breakingChanges: Array<{
        file: string;
        type: string;
        impactLevel: 'breaking';
      }>;
      summary: string;
      recommendations: string[];
    }>>> =>
      ipcRenderer.invoke(IPC.CONTRACT_ANALYZE_RANGE, repoPath, fromRef, toRef),

    analyzeStaged: (repoPath: string): Promise<IpcResult<Array<{
      file: string;
      type: string;
      changeType: 'added' | 'modified' | 'deleted';
      additions: number;
      deletions: number;
      impactLevel: 'breaking' | 'non-breaking' | 'unknown';
    }>>> =>
      ipcRenderer.invoke(IPC.CONTRACT_ANALYZE_STAGED, repoPath),

    getPatterns: (): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke(IPC.CONTRACT_GET_PATTERNS),

    onChangesDetected: (callback: (data: {
      repoPath: string;
      commitHash: string;
      hasBreakingChanges: boolean;
      changes: Array<{ file: string; type: string; impactLevel: string }>;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        repoPath: string;
        commitHash: string;
        hasBreakingChanges: boolean;
        changes: Array<{ file: string; type: string; impactLevel: string }>;
      }) => callback(data);
      ipcRenderer.on(IPC.CONTRACT_CHANGES_DETECTED, handler);
      return () => ipcRenderer.removeListener(IPC.CONTRACT_CHANGES_DETECTED, handler);
    },
  },

  // ==========================================================================
  // CONTRACT REGISTRY API
  // JSON-based contract tracking at repo and feature levels
  // ==========================================================================
  contractRegistry: {
    initialize: (repoPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REGISTRY_INIT, repoPath),

    getRepoSummary: (repoPath: string): Promise<IpcResult<{
      version: string;
      lastUpdated: string;
      summary: {
        totalFeatures: number;
        totalTests: number;
        totalApiContracts: number;
        coverageScore: number;
        breakingChangesLast7Days: number;
        breakingChangesLast30Days: number;
      };
      features: Record<string, { ref: string; testCount: number; coverageScore: number }>;
      recentBreakingChanges: Array<{
        id: string;
        file: string;
        type: string;
        description: string;
        timestamp: string;
        commitHash: string;
      }>;
    }>> =>
      ipcRenderer.invoke(IPC.REGISTRY_GET_REPO, repoPath),

    getFeatureContracts: (repoPath: string, feature: string): Promise<IpcResult<{
      feature: string;
      version: string;
      lastUpdated: string;
      contracts: {
        api: Array<{ file: string; type: string; endpoints?: string[]; lastModified: string }>;
        e2e: Array<{ file: string; type: string; testCount: number; testNames: string[]; lastModified: string }>;
        unit: Array<{ file: string; type: string; testCount: number; testNames: string[]; lastModified: string }>;
        integration: Array<{ file: string; type: string; testCount: number; testNames: string[]; lastModified: string }>;
        fixtures: Array<{ file: string; type: string; usedBy: string[]; lastModified: string }>;
      };
      dependencies: string[];
      coverageScore: number;
      breakingChanges: Array<{
        id: string;
        file: string;
        type: string;
        description: string;
        timestamp: string;
        commitHash: string;
      }>;
    } | null>> =>
      ipcRenderer.invoke(IPC.REGISTRY_GET_FEATURE, repoPath, feature),

    updateFeature: (repoPath: string, feature: string, contracts: {
      api?: Array<{ file: string; type: string; endpoints?: string[]; lastModified: string }>;
      e2e?: Array<{ file: string; type: string; testCount: number; testNames: string[]; lastModified: string }>;
      unit?: Array<{ file: string; type: string; testCount: number; testNames: string[]; lastModified: string }>;
    }): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REGISTRY_UPDATE_FEATURE, repoPath, feature, contracts),

    listFeatures: (repoPath: string): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke(IPC.REGISTRY_LIST_FEATURES, repoPath),

    recordBreakingChange: (repoPath: string, feature: string, change: {
      file: string;
      type: string;
      description: string;
      timestamp: string;
      commitHash: string;
    }): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REGISTRY_RECORD_BREAKING, repoPath, feature, change),

    // Feature organization config
    getOrganizationConfig: (repoPath: string): Promise<IpcResult<{
      enabled: boolean;
      structure: 'feature-folders' | 'flat' | 'custom';
      setupCompleted: boolean;
      setupCompletedAt?: string;
    }>> =>
      ipcRenderer.invoke(IPC.REGISTRY_GET_ORG_CONFIG, repoPath),

    setOrganizationConfig: (repoPath: string, config: {
      enabled: boolean;
      structure: 'feature-folders' | 'flat' | 'custom';
      setupCompleted: boolean;
      setupCompletedAt?: string;
    }): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REGISTRY_SET_ORG_CONFIG, repoPath, config),

    needsFirstRunSetup: (repoPath: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.REGISTRY_NEEDS_SETUP, repoPath),

    // Events
    onRegistryUpdated: (callback: (data: { repoPath: string; feature?: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { repoPath: string; feature?: string }) => callback(data);
      ipcRenderer.on(IPC.CONTRACT_REGISTRY_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC.CONTRACT_REGISTRY_UPDATED, handler);
    },

    onBreakingChangeDetected: (callback: (data: {
      repoPath: string;
      feature: string;
      change: { file: string; type: string; description: string };
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        repoPath: string;
        feature: string;
        change: { file: string; type: string; description: string };
      }) => callback(data);
      ipcRenderer.on(IPC.BREAKING_CHANGE_DETECTED, handler);
      return () => ipcRenderer.removeListener(IPC.BREAKING_CHANGE_DETECTED, handler);
    },
  },

  // ==========================================================================
  // CONTRACT GENERATION API
  // Scan codebase and generate contract documentation
  // ==========================================================================
  contractGeneration: {
    discoverFeatures: (repoPath: string, useAI?: boolean): Promise<IpcResult<Array<{
      name: string;
      description?: string;
      basePath: string;
      files: {
        api: string[];
        schema: string[];
        tests: { e2e: string[]; unit: string[]; integration: string[] };
        fixtures: string[];
        config: string[];
        other: string[];
      };
      contractPatternMatches: number;
    }>>> =>
      ipcRenderer.invoke(IPC.CONTRACT_DISCOVER_FEATURES, repoPath, useAI),

    saveDiscoveredFeatures: (repoPath: string, features: unknown[]): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONTRACT_SAVE_DISCOVERED_FEATURES, repoPath, features),

    loadDiscoveredFeatures: (repoPath: string): Promise<IpcResult<unknown[]>> =>
      ipcRenderer.invoke(IPC.CONTRACT_LOAD_DISCOVERED_FEATURES, repoPath),

    generateFeature: (repoPath: string, feature: {
      name: string;
      basePath: string;
      files: {
        api: string[];
        schema: string[];
        tests: { e2e: string[]; unit: string[]; integration: string[] };
        fixtures: string[];
        config: string[];
        other: string[];
      };
      contractPatternMatches: number;
    }, options?: {
      includeCodeSamples?: boolean;
      maxFilesPerFeature?: number;
    }): Promise<IpcResult<{
      feature: string;
      success: boolean;
      markdownPath?: string;
      jsonPath?: string;
      error?: string;
    }>> =>
      ipcRenderer.invoke(IPC.CONTRACT_GENERATE_FEATURE, repoPath, feature, options),

    generateAll: (repoPath: string, options?: {
      includeCodeSamples?: boolean;
      maxFilesPerFeature?: number;
      skipExisting?: boolean;
      features?: string[];
    }): Promise<IpcResult<{
      totalFeatures: number;
      generated: number;
      skipped: number;
      failed: number;
      results: Array<{
        feature: string;
        success: boolean;
        markdownPath?: string;
        jsonPath?: string;
        error?: string;
      }>;
      duration: number;
    }>> =>
      ipcRenderer.invoke(IPC.CONTRACT_GENERATE_ALL, repoPath, options),

    generateSingle: (repoPath: string, contractType: string): Promise<IpcResult<{
      file: string;
      success: boolean;
      error?: string;
    }>> =>
      ipcRenderer.invoke(IPC.CONTRACT_GENERATE_SINGLE, repoPath, contractType),

    cancel: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONTRACT_CANCEL_GENERATION),

    onProgress: (callback: (progress: {
      total: number;
      completed: number;
      currentFeature: string;
      currentStep: 'discovering' | 'analyzing' | 'generating' | 'saving';
      errors: string[];
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: {
        total: number;
        completed: number;
        currentFeature: string;
        currentStep: 'discovering' | 'analyzing' | 'generating' | 'saving';
        errors: string[];
      }) => callback(progress);
      ipcRenderer.on(IPC.CONTRACT_GENERATION_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.CONTRACT_GENERATION_PROGRESS, handler);
    },

    onComplete: (callback: (result: {
      totalFeatures: number;
      generated: number;
      skipped: number;
      failed: number;
      results: Array<{
        feature: string;
        success: boolean;
        markdownPath?: string;
        jsonPath?: string;
        error?: string;
      }>;
      duration: number;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, result: {
        totalFeatures: number;
        generated: number;
        skipped: number;
        failed: number;
        results: Array<{
          feature: string;
          success: boolean;
          markdownPath?: string;
          jsonPath?: string;
          error?: string;
        }>;
        duration: number;
      }) => callback(result);
      ipcRenderer.on(IPC.CONTRACT_GENERATION_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC.CONTRACT_GENERATION_COMPLETE, handler);
    },
  },

  // ==========================================================================
  // REPOSITORY ANALYSIS API
  // AST parsing, code analysis, and intelligent contract generation
  // ==========================================================================
  analysis: {
    scanRepo: (repoPath: string): Promise<IpcResult<{
      features: Array<{
        name: string;
        basePath: string;
        files: {
          api: string[];
          schema: string[];
          tests: { e2e: string[]; unit: string[]; integration: string[] };
          fixtures: string[];
          config: string[];
          other: string[];
        };
        contractPatternMatches: number;
      }>;
      languages: Array<{
        language: string;
        files: number;
        lines: number;
        percentage: number;
      }>;
      totalFiles: number;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_SCAN_REPO, repoPath),

    parseFile: (filePath: string, options?: { useCache?: boolean }): Promise<IpcResult<{
      language: string;
      filePath: string;
      contentHash: string;
      exports: Array<{
        name: string;
        type: string;
        line: number;
        column: number;
        signature?: string;
        isDefault: boolean;
      }>;
      imports: Array<{
        name: string;
        alias?: string;
        source: string;
        isDefault: boolean;
        isNamespace: boolean;
        line: number;
      }>;
      functions: Array<{
        name: string;
        line: number;
        column: number;
        endLine: number;
        params: Array<{ name: string; type?: string; optional: boolean }>;
        returnType?: string;
        isAsync: boolean;
        isExported: boolean;
        isArrow: boolean;
      }>;
      classes: Array<{
        name: string;
        line: number;
        column: number;
        endLine: number;
        extends?: string;
        implements?: string[];
        methods: Array<{ name: string; line: number; visibility: string; isStatic: boolean; isAsync: boolean }>;
        properties: Array<{ name: string; line: number; type?: string; visibility: string; isStatic: boolean }>;
        isExported: boolean;
        isAbstract: boolean;
      }>;
      types: Array<{
        name: string;
        kind: string;
        line: number;
        column: number;
        isExported: boolean;
      }>;
      parseTime: number;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_PARSE_FILE, filePath, options),

    analyzeRepo: (repoPath: string, options?: {
      useCache?: boolean;
      forceRefresh?: boolean;
      useLLM?: boolean;
      generateContracts?: boolean;
      features?: string[];
    }): Promise<IpcResult<{
      success: boolean;
      analysis?: {
        repoPath: string;
        repoName: string;
        analyzedAt: string;
        features: Array<{
          name: string;
          basePath: string;
          language: string;
          frameworks: string[];
          exports: Array<{ name: string; type: string; line: number }>;
          dependencies: string[];
          internalDependencies: string[];
          externalDependencies: string[];
          fileCount: number;
          lineCount: number;
          lastAnalyzed: string;
        }>;
        dependencyGraph: {
          nodes: Array<{ id: string; name: string; type: string; path?: string; exports: string[] }>;
          edges: Array<{ source: string; target: string; type: string; symbols: string[] }>;
          circularDependencies: string[][];
          externalDependencies: Array<{ name: string; usedBy: string[]; importCount: number }>;
        };
        languages: Array<{ language: string; files: number; lines: number; percentage: number }>;
        totalFiles: number;
        totalLines: number;
        analysisDuration: number;
      };
      progress: {
        phase: string;
        totalFiles: number;
        processedFiles: number;
        currentFile?: string;
        currentFeature?: string;
        errors: Array<{ file: string; line?: number; message: string; severity: string; recoverable: boolean }>;
        startedAt: string;
      };
      errors: Array<{ file: string; message: string; severity: string; recoverable: boolean }>;
      duration: number;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_ANALYZE_REPO, repoPath, options),

    getCacheStats: (): Promise<IpcResult<{
      totalEntries: number;
      totalSize: number;
      hitCount: number;
      missCount: number;
      hitRate: number;
      oldestEntry: string;
      newestEntry: string;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_GET_CACHE_STATS),

    clearCache: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_CLEAR_CACHE),

    // Phase 2: Schema Extraction
    extractSchemaFile: (filePath: string): Promise<IpcResult<Array<{
      name: string;
      source: string;
      sourceType: string;
      file: string;
      line: number;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
        primaryKey: boolean;
        unique: boolean;
        defaultValue?: string;
        references?: { table: string; column: string };
      }>;
      relations: Array<{
        type: string;
        target: string;
        foreignKey?: string;
        references?: string;
      }>;
      indexes: Array<{
        columns: string[];
        unique: boolean;
        name?: string;
      }>;
    }>>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXTRACT_SCHEMA_FILE, filePath),

    extractSchemas: (files: Array<{ path: string }>): Promise<IpcResult<Array<{
      name: string;
      source: string;
      sourceType: string;
      file: string;
      line: number;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
        primaryKey: boolean;
        unique: boolean;
      }>;
      relations: Array<{
        type: string;
        target: string;
        foreignKey?: string;
      }>;
      indexes: Array<{
        columns: string[];
        unique: boolean;
      }>;
    }>>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXTRACT_SCHEMAS, files),

    // Phase 2: Event Tracking
    extractEventsFile: (filePath: string): Promise<IpcResult<Array<{
      name: string;
      file: string;
      line: number;
      type: 'producer' | 'consumer';
      pattern: string;
      handler?: string;
      payloadHint?: string;
    }>>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXTRACT_EVENTS_FILE, filePath),

    extractEvents: (files: Array<{ path: string }>): Promise<IpcResult<Array<{
      name: string;
      file: string;
      line: number;
      type: 'producer' | 'consumer';
      pattern: string;
      handler?: string;
      payloadHint?: string;
    }>>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXTRACT_EVENTS, files),

    getEventFlow: (events: Array<{
      name: string;
      type: 'producer' | 'consumer';
      file: string;
    }>): Promise<IpcResult<{
      events: Map<string, {
        name: string;
        producers: Array<{ file: string; line: number }>;
        consumers: Array<{ file: string; line: number; handler?: string }>;
      }>;
      orphanedProducers: string[];
      orphanedConsumers: string[];
      eventChains: Array<string[]>;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_GET_EVENT_FLOW, events),

    // Phase 2: Dependency Graph
    buildFileGraph: (repoPath: string): Promise<IpcResult<{
      nodes: Array<{ id: string; name: string; type: string; path?: string; exports: string[] }>;
      edges: Array<{ source: string; target: string; type: string; symbols: string[] }>;
      circularDependencies: string[][];
      externalDependencies: Array<{ name: string; usedBy: string[]; importCount: number }>;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_BUILD_FILE_GRAPH, repoPath),

    buildFeatureGraph: (features: Array<{
      name: string;
      basePath: string;
      exports: Array<{ name: string }>;
      internalDependencies: string[];
      externalDependencies: string[];
    }>): Promise<IpcResult<{
      nodes: Array<{ id: string; name: string; type: string; path?: string; exports: string[] }>;
      edges: Array<{ source: string; target: string; type: string; symbols: string[] }>;
      circularDependencies: string[][];
      externalDependencies: Array<{ name: string; usedBy: string[]; importCount: number }>;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_BUILD_FEATURE_GRAPH, features),

    getGraphStats: (graph: {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
      circularDependencies: string[][];
      externalDependencies: Array<{ name: string; usedBy: string[]; importCount: number }>;
    }): Promise<IpcResult<{
      totalNodes: number;
      totalEdges: number;
      avgDependencies: number;
      maxDependencies: { node: string; count: number };
      circularCount: number;
      externalPackages: number;
      mostUsedExternal: { name: string; usedBy: string[]; importCount: number } | null;
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_GET_GRAPH_STATS, graph),

    exportGraphDot: (graph: {
      nodes: Array<{ id: string; name: string }>;
      edges: Array<{ source: string; target: string }>;
      circularDependencies: string[][];
    }, options?: { title?: string; highlightCircular?: boolean }): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXPORT_GRAPH_DOT, graph, options),

    exportGraphJson: (graph: {
      nodes: Array<{ id: string; name: string; type: string }>;
      edges: Array<{ source: string; target: string; type: string }>;
    }): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_EXPORT_GRAPH_JSON, graph),

    // Phase 3: Infrastructure Parsing
    parseInfrastructure: (repoPath: string): Promise<IpcResult<{
      terraform: {
        resources: Array<{
          type: string;
          name: string;
          provider: string;
          file: string;
          line: number;
          dependencies: string[];
        }>;
        providers: Array<{ name: string; version?: string; file: string; line: number }>;
        variables: Array<{ name: string; type?: string; description?: string; file: string; line: number }>;
        outputs: Array<{ name: string; value: string; description?: string; file: string; line: number }>;
        modules: string[];
      };
      kubernetes: {
        resources: Array<{
          apiVersion: string;
          kind: string;
          name: string;
          namespace?: string;
          file: string;
        }>;
        namespaces: string[];
        deployments: string[];
        services: string[];
        configMaps: string[];
        secrets: string[];
        ingresses: string[];
      };
      docker: {
        composeFiles: Array<{
          version?: string;
          services: Array<{ name: string; image?: string; file: string }>;
          networks: string[];
          volumes: string[];
          file: string;
        }>;
        services: Array<{ name: string; image?: string; depends_on?: string[]; file: string }>;
        networks: string[];
        volumes: string[];
      };
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_PARSE_INFRA, repoPath),

    parseTerraformFile: (filePath: string): Promise<IpcResult<{
      resources: Array<{ type: string; name: string; provider: string; file: string; line: number }>;
      providers: Array<{ name: string; version?: string; file: string; line: number }>;
      variables: Array<{ name: string; type?: string; file: string; line: number }>;
      outputs: Array<{ name: string; value: string; file: string; line: number }>;
      modules: string[];
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_PARSE_TERRAFORM, filePath),

    parseKubernetesFile: (filePath: string): Promise<IpcResult<Array<{
      apiVersion: string;
      kind: string;
      name: string;
      namespace?: string;
      file: string;
    }>>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_PARSE_KUBERNETES, filePath),

    parseDockerComposeFile: (filePath: string): Promise<IpcResult<{
      version?: string;
      services: Array<{ name: string; image?: string; depends_on?: string[]; file: string }>;
      networks: string[];
      volumes: string[];
      file: string;
    } | null>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_PARSE_DOCKER_COMPOSE, filePath),

    getInfraSummary: (analysis: unknown): Promise<IpcResult<{
      terraform: { resourceCount: number; providerCount: number; moduleCount: number };
      kubernetes: { resourceCount: number; namespaceCount: number };
      docker: { serviceCount: number; networkCount: number };
    }>> =>
      ipcRenderer.invoke(IPC.ANALYSIS_GET_INFRA_SUMMARY, analysis),

    // Events
    onProgress: (callback: (progress: {
      phase: string;
      totalFiles: number;
      processedFiles: number;
      currentFile?: string;
      currentFeature?: string;
      errors: Array<{ file: string; message: string; severity: string }>;
      startedAt: string;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: {
        phase: string;
        totalFiles: number;
        processedFiles: number;
        currentFile?: string;
        currentFeature?: string;
        errors: Array<{ file: string; message: string; severity: string }>;
        startedAt: string;
      }) => callback(progress);
      ipcRenderer.on(IPC.ANALYSIS_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.ANALYSIS_PROGRESS, handler);
    },

    onComplete: (callback: (result: {
      success: boolean;
      duration: number;
      analysis?: { repoName: string; totalFiles: number; totalLines: number };
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, result: {
        success: boolean;
        duration: number;
        analysis?: { repoName: string; totalFiles: number; totalLines: number };
      }) => callback(result);
      ipcRenderer.on(IPC.ANALYSIS_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC.ANALYSIS_COMPLETE, handler);
    },

    onError: (callback: (error: {
      file: string;
      message: string;
      severity: string;
      recoverable: boolean;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, error: {
        file: string;
        message: string;
        severity: string;
        recoverable: boolean;
      }) => callback(error);
      ipcRenderer.on(IPC.ANALYSIS_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC.ANALYSIS_ERROR, handler);
    },
  },

  // ==========================================================================
  // REBASE WATCHER API
  // Auto-rebase on remote changes (on-demand mode)
  // ==========================================================================
  rebaseWatcher: {
    start: (config: {
      sessionId: string;
      repoPath: string;
      baseBranch: string;
      currentBranch: string;
      rebaseFrequency: 'never' | 'daily' | 'weekly' | 'on-demand';
      pollIntervalMs?: number;
    }): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_START, config),

    stop: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_STOP, sessionId),

    pause: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_PAUSE, sessionId),

    resume: (sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_RESUME, sessionId),

    getStatus: (sessionId: string): Promise<IpcResult<{
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
    } | null>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_GET_STATUS, sessionId),

    forceCheck: (sessionId: string): Promise<IpcResult<{ hasChanges: boolean; behindCount: number }>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_FORCE_CHECK, sessionId),

    triggerRebase: (sessionId: string): Promise<IpcResult<{ success: boolean; message: string }>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_TRIGGER, sessionId),

    list: (): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke(IPC.REBASE_WATCHER_LIST),

    // Events
    onStatusChanged: (callback: (status: {
      sessionId: string;
      isWatching: boolean;
      isPaused: boolean;
      isRebasing: boolean;
      behindCount: number;
      aheadCount: number;
      lastChecked: string | null;
      lastRebaseResult: { success: boolean; message: string; timestamp: string } | null;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: {
        sessionId: string;
        isWatching: boolean;
        isPaused: boolean;
        isRebasing: boolean;
        behindCount: number;
        aheadCount: number;
        lastChecked: string | null;
        lastRebaseResult: { success: boolean; message: string; timestamp: string } | null;
      }) => callback(status);
      ipcRenderer.on(IPC.REBASE_WATCHER_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC.REBASE_WATCHER_STATUS, handler);
    },

    onStopped: (callback: (data: { sessionId: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(IPC.REBASE_WATCHER_STOPPED, handler);
      return () => ipcRenderer.removeListener(IPC.REBASE_WATCHER_STOPPED, handler);
    },

    onRemoteChangesDetected: (callback: (data: {
      sessionId: string;
      repoPath: string;
      baseBranch: string;
      behindCount: number;
      newCommits: number;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        sessionId: string;
        repoPath: string;
        baseBranch: string;
        behindCount: number;
        newCommits: number;
      }) => callback(data);
      ipcRenderer.on(IPC.REBASE_REMOTE_CHANGES_DETECTED, handler);
      return () => ipcRenderer.removeListener(IPC.REBASE_REMOTE_CHANGES_DETECTED, handler);
    },

    onAutoRebaseCompleted: (callback: (data: {
      sessionId: string;
      success: boolean;
      message: string;
      hadUncommittedChanges: boolean;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        sessionId: string;
        success: boolean;
        message: string;
        hadUncommittedChanges: boolean;
      }) => callback(data);
      ipcRenderer.on(IPC.REBASE_AUTO_COMPLETED, handler);
      return () => ipcRenderer.removeListener(IPC.REBASE_AUTO_COMPLETED, handler);
    },
  },

  // ==========================================================================
  // FILE SYSTEM API
  // ==========================================================================
  file: {
    readContent: (filePath: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.FILE_READ_CONTENT, filePath),
  },

  // ==========================================================================
  // SHELL/QUICK ACTION API
  // ==========================================================================
  shell: {
    openTerminal: (dirPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_TERMINAL, dirPath),

    openVSCode: (dirPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_VSCODE, dirPath),

    openFinder: (dirPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_FINDER, dirPath),

    copyPath: (pathToCopy: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.SHELL_COPY_PATH, pathToCopy),
  },

  // ==========================================================================
  // TERMINAL LOG API
  // ==========================================================================
  terminal: {
    getLogs: (sessionId?: string, limit?: number): Promise<IpcResult<Array<{
      id: string;
      timestamp: string;
      level: string;
      message: string;
      sessionId?: string;
      source?: string;
      command?: string;
      output?: string;
      exitCode?: number;
      duration?: number;
    }>>> =>
      ipcRenderer.invoke(IPC.TERMINAL_GET_LOGS, sessionId, limit),

    clearLogs: (sessionId?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.TERMINAL_CLEAR, sessionId),

    onLog: (callback: (entry: {
      id: string;
      timestamp: string;
      level: string;
      message: string;
      sessionId?: string;
      source?: string;
      command?: string;
      output?: string;
      exitCode?: number;
      duration?: number;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, entry: {
        id: string;
        timestamp: string;
        level: string;
        message: string;
        sessionId?: string;
        source?: string;
        command?: string;
        output?: string;
        exitCode?: number;
        duration?: number;
      }) => callback(entry);
      ipcRenderer.on(IPC.TERMINAL_LOG, handler);
      return () => ipcRenderer.removeListener(IPC.TERMINAL_LOG, handler);
    },
  },

  // ==========================================================================
  // MERGE WORKFLOW API
  // ==========================================================================
  merge: {
    preview: (repoPath: string, sourceBranch: string, targetBranch: string): Promise<IpcResult<{
      sourceBranch: string;
      targetBranch: string;
      canMerge: boolean;
      hasConflicts: boolean;
      conflictingFiles: string[];
      filesChanged: Array<{
        path: string;
        additions: number;
        deletions: number;
        status: string;
      }>;
      commitCount: number;
      aheadBy: number;
      behindBy: number;
    }>> =>
      ipcRenderer.invoke(IPC.MERGE_PREVIEW, repoPath, sourceBranch, targetBranch),

    execute: (
      repoPath: string,
      sourceBranch: string,
      targetBranch: string,
      options?: {
        deleteWorktree?: boolean;
        deleteLocalBranch?: boolean;
        deleteRemoteBranch?: boolean;
        worktreePath?: string;
      }
    ): Promise<IpcResult<{
      success: boolean;
      message: string;
      mergeCommitHash?: string;
      filesChanged?: number;
      conflictingFiles?: string[];
    }>> =>
      ipcRenderer.invoke(IPC.MERGE_EXECUTE, repoPath, sourceBranch, targetBranch, options),

    abort: (repoPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.MERGE_ABORT, repoPath),
  },

  // ==========================================================================
  // COMMIT ANALYSIS API
  // AI-powered commit message generation from file diffs
  // ==========================================================================
  commitAnalysis: {
    analyzeStaged: (repoPath: string, options?: {
      includeBody?: boolean;
      maxFilesToAnalyze?: number;
      contextTask?: string;
      contextBranch?: string;
      useAI?: boolean;
    }): Promise<IpcResult<{
      overallType: 'feat' | 'fix' | 'refactor' | 'docs' | 'style' | 'test' | 'build' | 'ci' | 'chore' | 'perf';
      scope: string | null;
      subject: string;
      body: string;
      breakingChange: boolean;
      filesAnalyzed: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        additions: number;
        deletions: number;
        diff: string;
        language: string;
        changeType: 'feature' | 'fix' | 'refactor' | 'style' | 'docs' | 'test' | 'config' | 'other';
        summary: string;
      }>;
      suggestedMessage: string;
      alternativeMessages: string[];
    }>> =>
      ipcRenderer.invoke(IPC.COMMIT_ANALYZE_STAGED, repoPath, options),

    analyzeCommit: (repoPath: string, commitHash: string, options?: {
      includeBody?: boolean;
      maxFilesToAnalyze?: number;
      contextTask?: string;
      contextBranch?: string;
      useAI?: boolean;
    }): Promise<IpcResult<{
      overallType: 'feat' | 'fix' | 'refactor' | 'docs' | 'style' | 'test' | 'build' | 'ci' | 'chore' | 'perf';
      scope: string | null;
      subject: string;
      body: string;
      breakingChange: boolean;
      filesAnalyzed: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        additions: number;
        deletions: number;
        diff: string;
        language: string;
        changeType: 'feature' | 'fix' | 'refactor' | 'style' | 'docs' | 'test' | 'config' | 'other';
        summary: string;
      }>;
      suggestedMessage: string;
      alternativeMessages: string[];
    }>> =>
      ipcRenderer.invoke(IPC.COMMIT_ANALYZE_COMMIT, repoPath, commitHash, options),

    /**
     * Enable/disable automatic AI-enhanced commit messages
     * When enabled, commits will analyze actual file diffs to generate detailed messages
     */
    setEnhancedEnabled: (enabled: boolean): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.COMMIT_SET_ENHANCED_ENABLED, enabled),

    /**
     * Get whether enhanced commit messages are enabled
     */
    getEnhancedEnabled: (): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.COMMIT_GET_ENHANCED_ENABLED),
  },

  // ==========================================================================
  // DEBUG LOG API
  // Error tracking and diagnostics
  // ==========================================================================
  debugLog: {
    /**
     * Get recent logs from memory buffer
     */
    getRecent: (count?: number, level?: string): Promise<IpcResult<Array<{
      timestamp: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      source: string;
      message: string;
      details?: unknown;
    }>>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_GET_RECENT, count, level),

    /**
     * Export all logs for sharing
     */
    export: (): Promise<IpcResult<{
      exportedAt: string;
      appVersion: string;
      platform: string;
      entries: Array<{
        timestamp: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        source: string;
        message: string;
        details?: unknown;
      }>;
    }>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_EXPORT),

    /**
     * Clear all logs
     */
    clear: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_CLEAR),

    /**
     * Get log statistics
     */
    getStats: (): Promise<IpcResult<{
      memoryEntries: number;
      fileSize: number;
      rotatedFiles: number;
    }>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_GET_STATS),

    /**
     * Get log file path
     */
    getPath: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_GET_PATH),

    /**
     * Open log folder in system file explorer
     */
    openFolder: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.DEBUG_LOG_OPEN_FOLDER),
  },

  // ==========================================================================
  // CONFLICT RESOLUTION API
  // AI-powered conflict analysis and resolution with user approval
  // ==========================================================================
  conflict: {
    /**
     * Generate AI resolution previews for conflicted files
     */
    generatePreviews: (repoPath: string, targetBranch: string): Promise<IpcResult<Array<{
      filePath: string;
      oursContent: string;
      theirsContent: string;
      resolvedContent: string;
      resolution: 'ours' | 'theirs' | 'merged';
    }>>> =>
      ipcRenderer.invoke(IPC.CONFLICT_GENERATE_PREVIEWS, repoPath, targetBranch),

    /**
     * Apply user-approved conflict resolutions
     */
    applyApproved: (repoPath: string, previews: Array<{
      filePath: string;
      resolvedContent: string;
      approved: boolean;
    }>): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONFLICT_APPLY_APPROVED, repoPath, previews),

    /**
     * Abort rebase and restore previous state
     */
    abortRebase: (repoPath: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONFLICT_ABORT_REBASE, repoPath),

    /**
     * Check if a rebase is currently in progress
     */
    isRebaseInProgress: (repoPath: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke(IPC.CONFLICT_IS_REBASE_IN_PROGRESS, repoPath),

    /**
     * Create a backup branch before applying AI changes
     * Branch name: backup_kit/<sessionId>
     */
    createBackup: (repoPath: string, sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONFLICT_CREATE_BACKUP, repoPath, sessionId),

    /**
     * Delete backup branch after successful resolution
     */
    deleteBackup: (repoPath: string, sessionId: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.CONFLICT_DELETE_BACKUP, repoPath, sessionId),

    // Events
    onPreviewsReady: (callback: (data: {
      repoPath: string;
      previews: Array<{ filePath: string; resolution: string }>;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        repoPath: string;
        previews: Array<{ filePath: string; resolution: string }>;
      }) => callback(data);
      ipcRenderer.on(IPC.CONFLICT_PREVIEWS_READY, handler);
      return () => ipcRenderer.removeListener(IPC.CONFLICT_PREVIEWS_READY, handler);
    },

    onRebaseErrorDetected: (callback: (data: {
      sessionId: string;
      repoPath: string;
      baseBranch: string;
      currentBranch: string;
      conflictedFiles: string[];
      errorMessage: string;
    }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: {
        sessionId: string;
        repoPath: string;
        baseBranch: string;
        currentBranch: string;
        conflictedFiles: string[];
        errorMessage: string;
      }) => callback(data);
      ipcRenderer.on(IPC.REBASE_ERROR_DETECTED, handler);
      return () => ipcRenderer.removeListener(IPC.REBASE_ERROR_DETECTED, handler);
    },
  },

  // ==========================================================================
  // AUTO-UPDATE API
  // ==========================================================================
  update: {
    check: (): Promise<IpcResult<AppUpdateInfo>> =>
      ipcRenderer.invoke(IPC.UPDATE_CHECK),

    download: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),

    install: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(IPC.UPDATE_INSTALL),

    getStatus: (): Promise<IpcResult<AppUpdateInfo>> =>
      ipcRenderer.invoke(IPC.UPDATE_GET_STATUS),

    onAvailable: (callback: (info: AppUpdateInfo) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, info: AppUpdateInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, handler);
    },

    onNotAvailable: (callback: (info: AppUpdateInfo) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, info: AppUpdateInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_NOT_AVAILABLE, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_NOT_AVAILABLE, handler);
    },

    onProgress: (callback: (info: AppUpdateInfo) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, info: AppUpdateInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, handler);
    },

    onDownloaded: (callback: (info: AppUpdateInfo) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, info: AppUpdateInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler);
    },

    onError: (callback: (info: AppUpdateInfo) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, info: AppUpdateInfo) => callback(info);
      ipcRenderer.on(IPC.UPDATE_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_ERROR, handler);
    },
  },

  };

// Expose to renderer
contextBridge.exposeInMainWorld('api', api);

// Export type for renderer usage
export type ElectronAPI = typeof api;
