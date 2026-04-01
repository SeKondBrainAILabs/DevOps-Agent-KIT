/**
 * IPC Handler Registration
 * Connects main process services to renderer via IPC
 */

import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { Services } from '../services';
import { databaseService } from '../services/DatabaseService';

/**
 * Register all IPC handlers
 * Removes existing handlers first to support HMR during development
 */
export function registerIpcHandlers(services: Services, mainWindow: BrowserWindow): void {
  console.log('[IPC] Registering IPC handlers...');
  // Remove existing handlers first (for HMR support)
  removeIpcHandlers();
  // ==========================================================================
  // SESSION HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.SESSION_CREATE, async (_, request) => {
    return services.session.create(request);
  });

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    return services.session.list();
  });

  ipcMain.handle(IPC.SESSION_GET, async (_, id: string) => {
    return services.session.get(id);
  });

  ipcMain.handle(IPC.SESSION_CLOSE, async (_, request) => {
    return services.session.close(request);
  });

  ipcMain.handle(IPC.SESSION_CLAIM, async (_, sessionId: string) => {
    return services.session.claim(sessionId);
  });

  // ==========================================================================
  // GIT HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.GIT_STATUS, async (_, sessionId: string) => {
    return services.git.getStatus(sessionId);
  });

  ipcMain.handle(IPC.GIT_COMMIT, async (_, sessionId: string, message: string) => {
    return services.git.commit(sessionId, message);
  });

  ipcMain.handle(IPC.GIT_PUSH, async (_, sessionId: string) => {
    return services.git.push(sessionId);
  });

  ipcMain.handle(IPC.GIT_MERGE, async (_, sessionId: string, targetBranch: string) => {
    return services.git.merge(sessionId, targetBranch);
  });

  ipcMain.handle(IPC.GIT_BRANCHES, async (_, sessionId: string) => {
    return services.git.listBranches(sessionId);
  });

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE, async (_, sessionId: string, branchName: string, path: string) => {
    return services.git.createWorktree(sessionId, branchName, path);
  });

  ipcMain.handle(IPC.GIT_REMOVE_WORKTREE, async (_, sessionId: string) => {
    return services.git.removeWorktree(sessionId);
  });

  ipcMain.handle(IPC.GIT_DETECT_SUBMODULES, async (_, repoPath: string) => {
    return services.git.detectSubmodules(repoPath);
  });

  // ==========================================================================
  // WATCHER HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.WATCHER_START, async (_, sessionId: string) => {
    return services.watcher.start(sessionId);
  });

  ipcMain.handle(IPC.WATCHER_STOP, async (_, sessionId: string) => {
    return services.watcher.stop(sessionId);
  });

  ipcMain.handle(IPC.WATCHER_STATUS, async (_, sessionId: string) => {
    return services.watcher.isWatching(sessionId);
  });

  // ==========================================================================
  // LOCK HANDLERS
  // ==========================================================================
  // Legacy lock API (session-based)
  ipcMain.handle(IPC.LOCK_DECLARE, async (_, sessionId: string, files: string[], operation: string) => {
    return services.lock.declareFiles(sessionId, files, operation as 'edit' | 'read' | 'delete');
  });

  ipcMain.handle(IPC.LOCK_RELEASE, async (_, sessionId: string) => {
    return services.lock.releaseFiles(sessionId);
  });

  // New auto-lock API (repo/file-based)
  ipcMain.handle(IPC.LOCK_CHECK, async (_, repoPath: string, files: string[], excludeSessionId?: string) => {
    return services.lock.checkConflicts(repoPath, files, excludeSessionId);
  });

  ipcMain.handle(IPC.LOCK_LIST, async (_, repoPath?: string) => {
    if (repoPath) {
      return services.lock.getRepoLocks(repoPath);
    }
    return services.lock.listDeclarations();
  });

  ipcMain.handle(IPC.LOCK_FORCE_RELEASE, async (_, repoPath: string, filePath: string) => {
    return services.lock.forceReleaseLock(repoPath, filePath);
  });

  // ==========================================================================
  // CONFIG HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.CONFIG_GET, async (_, key: string) => {
    return services.config.get(key);
  });

  ipcMain.handle(IPC.CONFIG_SET, async (_, key: string, value: unknown) => {
    return services.config.set(key, value);
  });

  ipcMain.handle(IPC.CONFIG_GET_ALL, async () => {
    return services.config.getAll();
  });

  ipcMain.handle(IPC.CREDENTIAL_GET, async (_, key: string) => {
    return services.config.getCredential(key);
  });

  ipcMain.handle(IPC.CREDENTIAL_SET, async (_, key: string, value: string) => {
    return services.config.setCredential(key, value);
  });

  ipcMain.handle(IPC.CREDENTIAL_HAS, async (_, key: string) => {
    return services.config.hasCredential(key);
  });

  // ==========================================================================
  // AI HANDLERS (streaming uses on/send pattern)
  // ==========================================================================
  ipcMain.handle(IPC.AI_CHAT, async (_, messages, modelOverride?: string) => {
    return services.ai.sendMessage(messages, modelOverride as any);
  });

  ipcMain.handle(IPC.AI_GET_MODEL, async () => {
    return { success: true, data: services.ai.getModel() };
  });

  ipcMain.handle(IPC.AI_SET_MODEL, async (_, modelKey: string) => {
    try {
      services.ai.setModel(modelKey as any);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INVALID_MODEL', message: error instanceof Error ? error.message : 'Invalid model' },
      };
    }
  });

  ipcMain.handle(IPC.AI_LIST_MODELS, async () => {
    return { success: true, data: services.ai.getAvailableModels() };
  });

  ipcMain.on(IPC.AI_STREAM_START, async (_, messages, modelOverride?: string) => {
    try {
      for await (const chunk of services.ai.streamChat(messages, modelOverride as any)) {
        mainWindow.webContents.send(IPC.AI_STREAM_CHUNK, chunk);
      }
      mainWindow.webContents.send(IPC.AI_STREAM_END);
    } catch (error) {
      mainWindow.webContents.send(
        IPC.AI_STREAM_ERROR,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  });

  ipcMain.on(IPC.AI_STREAM_STOP, () => {
    services.ai.stopStream();
  });

  // Mode-based AI handlers
  ipcMain.handle(IPC.AI_CHAT_WITH_MODE, async (_, options) => {
    return services.ai.sendWithMode(options);
  });

  ipcMain.on(IPC.AI_STREAM_WITH_MODE, async (_, options) => {
    try {
      for await (const chunk of services.ai.streamWithMode(options)) {
        mainWindow.webContents.send(IPC.AI_STREAM_CHUNK, chunk);
      }
      mainWindow.webContents.send(IPC.AI_STREAM_END);
    } catch (error) {
      mainWindow.webContents.send(
        IPC.AI_STREAM_ERROR,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  });

  ipcMain.handle(IPC.AI_LIST_MODES, async () => {
    return { success: true, data: services.ai.getAvailableModes() };
  });

  ipcMain.handle(IPC.AI_GET_MODE, async (_, modeId: string) => {
    return { success: true, data: services.ai.getMode(modeId) };
  });

  ipcMain.handle(IPC.AI_RELOAD_CONFIG, async () => {
    const { getAIConfigRegistry } = await import('../services/AIConfigRegistry');
    const registry = getAIConfigRegistry();
    return registry.reload();
  });

  ipcMain.handle(IPC.AI_GET_CONFIG_SOURCES, async () => {
    const { getAIConfigRegistry } = await import('../services/AIConfigRegistry');
    const registry = getAIConfigRegistry();
    return { success: true, data: registry.getConfigSources() };
  });

  // ==========================================================================
  // ACTIVITY LOG HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.LOG_GET, async (_, sessionId: string, limit?: number, offset?: number) => {
    return services.activity.getLogs(sessionId, limit, offset);
  });

  ipcMain.handle(IPC.LOG_CLEAR, async (_, sessionId: string) => {
    return services.activity.clearLogs(sessionId);
  });

  ipcMain.handle(IPC.LOG_GET_COMMITS, async (_, sessionId: string, limit?: number) => {
    return services.activity.getCommitsForSession(sessionId, limit);
  });

  ipcMain.handle(IPC.LOG_GET_TIMELINE, async (_, sessionId: string, limit?: number) => {
    return services.activity.getTimelineForSession(sessionId, limit);
  });

  // ==========================================================================
  // AGENT LISTENER HANDLERS
  // Kanvas monitors agents that report into it
  // ==========================================================================
  ipcMain.handle(IPC.AGENT_INITIALIZE, async (_, baseDir: string) => {
    try {
      await services.agentListener.initialize(baseDir);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INIT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to initialize agent listener',
        },
      };
    }
  });

  ipcMain.handle(IPC.AGENT_LIST, async () => {
    return {
      success: true,
      data: services.agentListener.getAgents(),
    };
  });

  ipcMain.handle(IPC.AGENT_GET, async (_, agentId: string) => {
    return {
      success: true,
      data: services.agentListener.getAgent(agentId) || null,
    };
  });

  ipcMain.handle(IPC.AGENT_SESSIONS, async (_, agentId: string) => {
    return {
      success: true,
      data: services.agentListener.getAgentSessions(agentId),
    };
  });

  // ==========================================================================
  // AGENT INSTANCE HANDLERS
  // Create and manage agent instances from Kanvas dashboard
  // ==========================================================================
  ipcMain.handle(IPC.INSTANCE_CREATE, async (_, config) => {
    const result = await services.agentInstance.createInstance(config);

    // Auto-start file watcher for the new session (use worktree if available)
    if (result.success && result.data?.sessionId) {
      const watchPath = result.data.worktreePath || config.repoPath;
      services.watcher.startWithPath(result.data.sessionId, watchPath).catch((err) => {
        console.warn('[IPC] Failed to start watcher for new session:', err);
      });
    }

    return result;
  });

  ipcMain.handle(IPC.INSTANCE_VALIDATE_REPO, async (_, path: string) => {
    return services.agentInstance.validateRepository(path);
  });

  ipcMain.handle(IPC.INSTANCE_INITIALIZE_KANVAS, async (_, path: string) => {
    return services.agentInstance.initializeKanvasDirectory(path);
  });

  ipcMain.handle(IPC.INSTANCE_GET_INSTRUCTIONS, async (_, agentType, config) => {
    return services.agentInstance.getInstructions(agentType, config);
  });

  ipcMain.handle(IPC.INSTANCE_LAUNCH, async (_, instanceId: string) => {
    return services.agentInstance.launchAgent(instanceId);
  });

  ipcMain.handle(IPC.INSTANCE_LIST, async () => {
    return services.agentInstance.listInstances();
  });

  ipcMain.handle(IPC.INSTANCE_GET, async (_, instanceId: string) => {
    return services.agentInstance.getInstance(instanceId);
  });

  ipcMain.handle(IPC.INSTANCE_DELETE, async (_, instanceId: string) => {
    // Stop watcher before deleting
    await services.watcher.stop(instanceId).catch(() => {});
    return await services.agentInstance.deleteInstance(instanceId);
  });

  ipcMain.handle(IPC.INSTANCE_DELETE_SESSION, async (_, sessionId: string, repoPath?: string) => {
    // Stop watcher before deleting
    await services.watcher.stop(sessionId).catch(() => {});
    return await services.agentInstance.deleteSessionById(sessionId, repoPath);
  });

  ipcMain.handle(IPC.INSTANCE_RESTART, async (_, sessionId: string, sessionData?: {
    repoPath: string;
    branchName: string;
    baseBranch?: string;
    worktreePath?: string;
    agentType?: string;
    task?: string;
  }, commitChanges?: boolean) => {
    // Stop old watcher
    await services.watcher.stop(sessionId).catch(() => {});

    const result = await services.agentInstance.restartInstance(sessionId, sessionData, commitChanges);

    // Start watcher for new session (use worktree path if available)
    if (result.success && result.data?.sessionId) {
      const watchPath = result.data.worktreePath || result.data.config?.repoPath;
      if (watchPath) {
        services.watcher.startWithPath(result.data.sessionId, watchPath).catch((err) => {
          console.warn('[IPC] Failed to start watcher for restarted session:', err);
        });
      }
    }

    return result;
  });

  ipcMain.handle(IPC.INSTANCE_CLEAR_ALL, async () => {
    return services.agentInstance.clearAllInstances();
  });

  ipcMain.handle(IPC.INSTANCE_UPDATE_BASE_BRANCH, async (_, sessionId: string, newBaseBranch: string) => {
    return services.agentInstance.updateBaseBranch(sessionId, newBaseBranch);
  });

  ipcMain.handle(IPC.RECENT_REPOS_LIST, async () => {
    return services.agentInstance.getRecentRepos();
  });

  ipcMain.handle(IPC.RECENT_REPOS_ADD, async (_, repo) => {
    return services.agentInstance.addRecentRepo(repo);
  });

  ipcMain.handle(IPC.RECENT_REPOS_REMOVE, async (_, path: string) => {
    return services.agentInstance.removeRecentRepo(path);
  });

  // ==========================================================================
  // DIALOG HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return {
      success: true,
      data: result.canceled ? null : result.filePaths[0],
    };
  });

  ipcMain.handle(IPC.DIALOG_SHOW_MESSAGE, async (_, options) => {
    await dialog.showMessageBox(mainWindow, {
      type: options.type,
      title: options.title,
      message: options.message,
    });
    return { success: true };
  });

  // ==========================================================================
  // SESSION RECOVERY HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.RECOVERY_SCAN_REPO, async (_, repoPath: string) => {
    return services.sessionRecovery.scanRepoForSessions(repoPath);
  });

  ipcMain.handle(IPC.RECOVERY_SCAN_ALL, async () => {
    return services.sessionRecovery.scanAllReposForSessions();
  });

  ipcMain.handle(IPC.RECOVERY_RECOVER_SESSION, async (_, sessionId: string, repoPath: string) => {
    return services.sessionRecovery.recoverSession(sessionId, repoPath);
  });

  ipcMain.handle(IPC.RECOVERY_RECOVER_MULTIPLE, async (_, sessions: Array<{ sessionId: string; repoPath: string }>) => {
    return services.sessionRecovery.recoverMultipleSessions(sessions);
  });

  ipcMain.handle(IPC.RECOVERY_DELETE_ORPHANED, async (_, sessionId: string, repoPath: string) => {
    return services.sessionRecovery.deleteOrphanedSession(sessionId, repoPath);
  });

  // ==========================================================================
  // REPO CLEANUP HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.CLEANUP_ANALYZE, async (_, repoPath: string, targetBranch?: string) => {
    return services.repoCleanup.analyzeRepo(repoPath, targetBranch);
  });

  ipcMain.handle(IPC.CLEANUP_EXECUTE, async (_, plan, options) => {
    return services.repoCleanup.executeCleanup(plan, options);
  });

  ipcMain.handle(IPC.CLEANUP_QUICK, async (_, repoPath: string) => {
    return services.repoCleanup.quickCleanup(repoPath);
  });

  ipcMain.handle(IPC.CLEANUP_KANVAS, async (_, repoPath: string) => {
    return services.repoCleanup.cleanupKanvasDirectory(repoPath);
  });

  // ==========================================================================
  // GIT REBASE HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.GIT_FETCH, async (_, repoPath: string, remote?: string) => {
    return services.git.fetchRemote(repoPath, remote);
  });

  ipcMain.handle(IPC.GIT_CHECK_REMOTE, async (_, repoPath: string, branch: string) => {
    return services.git.checkRemoteChanges(repoPath, branch);
  });

  ipcMain.handle(IPC.GIT_REBASE, async (_, repoPath: string, targetBranch: string) => {
    return services.git.rebase(repoPath, targetBranch);
  });

  ipcMain.handle(IPC.GIT_PERFORM_REBASE, async (_, repoPath: string, baseBranch: string) => {
    // Always use AI-powered rebase so conflicts are resolved automatically
    const result = await services.git.performRebaseWithAI(repoPath, baseBranch, services.mergeConflict);

    // Log activity for rebase operations
    try {
      // Find session by matching repoPath or worktreePath
      const sessionsResult = await services.session.list();
      if (sessionsResult.success && sessionsResult.data) {
        const session = sessionsResult.data.find(
          (s) => s.worktreePath === repoPath || s.repoPath === repoPath
        );

        if (session) {
          const logType = result.success && result.data?.success ? 'git' : 'error';
          const message = result.data?.message || (result.success ? 'Rebase completed' : 'Rebase failed');
          const details: Record<string, unknown> = {
            operation: 'rebase',
            baseBranch,
            repoPath,
          };

          if (result.data?.commitsAdded !== undefined) {
            details.commitsAdded = result.data.commitsAdded;
          }
          if (result.data?.beforeHead) {
            details.beforeHead = result.data.beforeHead.substring(0, 8);
          }
          if (result.data?.afterHead) {
            details.afterHead = result.data.afterHead.substring(0, 8);
          }

          services.activity.log(session.id, logType, message, details);
          console.log(`[IPC] Logged rebase activity for session ${session.id}: ${message}`);
        } else {
          console.log(`[IPC] Could not find session for repoPath: ${repoPath} - activity not logged`);
        }
      }
    } catch (logError) {
      console.warn('[IPC] Failed to log rebase activity:', logError);
    }

    return result;
  });

  ipcMain.handle(IPC.GIT_LIST_WORKTREES, async (_, repoPath: string) => {
    return services.git.listWorktrees(repoPath);
  });

  ipcMain.handle(IPC.GIT_PRUNE_WORKTREES, async (_, repoPath: string) => {
    return services.git.pruneWorktrees(repoPath);
  });

  ipcMain.handle(IPC.GIT_DELETE_BRANCH, async (_, repoPath: string, branchName: string, deleteRemote?: boolean) => {
    return services.git.deleteBranch(repoPath, branchName, deleteRemote);
  });

  ipcMain.handle(IPC.GIT_MERGED_BRANCHES, async (_, repoPath: string, baseBranch?: string) => {
    return services.git.getMergedBranches(repoPath, baseBranch);
  });

  ipcMain.handle(IPC.GIT_GET_CHANGED_FILES, async (_, repoPath: string, baseBranch?: string) => {
    return services.git.getChangedFiles(repoPath, baseBranch);
  });

  ipcMain.handle(IPC.GIT_GET_FILES_WITH_STATUS, async (_, repoPath: string, baseBranch?: string) => {
    return services.git.getFilesWithStatus(repoPath, baseBranch);
  });

  ipcMain.handle(IPC.GIT_GET_DIFF_SUMMARY, async (_, repoPath: string) => {
    return services.git.getDiffSummaryForCommit(repoPath);
  });

  // ==========================================================================
  // COMMIT HISTORY HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.GIT_GET_COMMIT_HISTORY, async (_, repoPath: string, baseBranch?: string, limit?: number, branchName?: string) => {
    return services.git.getCommitHistory(repoPath, baseBranch, limit, branchName);
  });

  ipcMain.handle(IPC.GIT_GET_COMMIT_DIFF, async (_, repoPath: string, commitHash: string) => {
    return services.git.getCommitDiff(repoPath, commitHash);
  });

  // ==========================================================================
  // CONTRACT DETECTION HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.CONTRACT_ANALYZE_COMMIT, async (_, repoPath: string, commitHash?: string) => {
    return services.contractDetection.analyzeCommit(repoPath, commitHash);
  });

  ipcMain.handle(IPC.CONTRACT_ANALYZE_RANGE, async (_, repoPath: string, fromRef?: string, toRef?: string) => {
    return services.contractDetection.analyzeCommitRange(repoPath, fromRef, toRef);
  });

  ipcMain.handle(IPC.CONTRACT_ANALYZE_STAGED, async (_, repoPath: string) => {
    return services.contractDetection.analyzeStagedChanges(repoPath);
  });

  ipcMain.handle(IPC.CONTRACT_GET_PATTERNS, async () => {
    return {
      success: true,
      data: services.contractDetection.getContractFilePatterns(),
    };
  });

  // ==========================================================================
  // CONTRACT REGISTRY HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.REGISTRY_INIT, async (_, repoPath: string) => {
    return services.contractRegistry.initializeRegistry(repoPath);
  });

  ipcMain.handle(IPC.REGISTRY_GET_REPO, async (_, repoPath: string) => {
    return services.contractRegistry.getRepoSummary(repoPath);
  });

  ipcMain.handle(IPC.REGISTRY_GET_FEATURE, async (_, repoPath: string, feature: string) => {
    return services.contractRegistry.getFeatureContracts(repoPath, feature);
  });

  ipcMain.handle(IPC.REGISTRY_UPDATE_FEATURE, async (_, repoPath: string, feature: string, contracts: unknown) => {
    return services.contractRegistry.updateFeatureContracts(repoPath, feature, contracts as any);
  });

  ipcMain.handle(IPC.REGISTRY_LIST_FEATURES, async (_, repoPath: string) => {
    return services.contractRegistry.listFeatures(repoPath);
  });

  ipcMain.handle(IPC.REGISTRY_RECORD_BREAKING, async (_, repoPath: string, feature: string, change: unknown) => {
    return services.contractRegistry.recordBreakingChange(repoPath, feature, change as any);
  });

  ipcMain.handle(IPC.REGISTRY_GET_ORG_CONFIG, async (_, repoPath: string) => {
    return services.contractRegistry.getFeatureOrganizationConfig(repoPath);
  });

  ipcMain.handle(IPC.REGISTRY_SET_ORG_CONFIG, async (_, repoPath: string, config: unknown) => {
    return services.contractRegistry.setFeatureOrganizationConfig(repoPath, config as any);
  });

  ipcMain.handle(IPC.REGISTRY_NEEDS_SETUP, async (_, repoPath: string) => {
    return services.contractRegistry.needsFirstRunSetup(repoPath);
  });

  // ==========================================================================
  // CONTRACT GENERATION HANDLERS
  // Scan codebase and generate contract documentation
  // ==========================================================================
  ipcMain.handle(IPC.CONTRACT_DISCOVER_FEATURES, async (_, repoPath: string, useAI?: boolean) => {
    return services.contractGeneration.discoverFeatures(repoPath, useAI);
  });

  ipcMain.handle(IPC.CONTRACT_SAVE_DISCOVERED_FEATURES, async (_, repoPath: string, features: unknown[]) => {
    const key = `discovered_features:${repoPath}`;
    console.log('[IPC] Saving discovered features with key:', key, 'count:', features?.length);
    databaseService.setSetting(key, features);
    return { success: true };
  });

  ipcMain.handle(IPC.CONTRACT_LOAD_DISCOVERED_FEATURES, async (_, repoPath: string) => {
    const key = `discovered_features:${repoPath}`;
    console.log('[IPC] Loading discovered features with key:', key);
    const features = databaseService.getSetting<unknown[]>(key, []);
    console.log('[IPC] Found features:', features?.length || 0);
    return { success: true, data: features };
  });

  ipcMain.handle(IPC.CONTRACT_GENERATE_FEATURE, async (_, repoPath: string, feature: unknown) => {
    return services.contractGeneration.generateFeatureContract(repoPath, feature as any);
  });

  ipcMain.handle(IPC.CONTRACT_GENERATE_ALL, async (_, repoPath: string, options?: unknown) => {
    return services.contractGeneration.generateAllContracts(repoPath, options as any);
  });

  ipcMain.handle(IPC.CONTRACT_GENERATE_SINGLE, async (_, repoPath: string, contractType: string) => {
    return services.contractGeneration.generateSingleContract(repoPath, contractType);
  });

  ipcMain.handle(IPC.CONTRACT_CANCEL_GENERATION, async () => {
    services.contractGeneration.cancelGeneration();
    return { success: true };
  });

  // New: Repo structure analysis and README generation
  ipcMain.handle(IPC.CONTRACT_ANALYZE_REPO_STRUCTURE, async (_, repoPath: string) => {
    return services.contractGeneration.analyzeRepoStructure(repoPath);
  });

  ipcMain.handle(IPC.CONTRACT_GENERATE_README, async (_, repoPath: string, structureAnalysis: unknown) => {
    return services.contractGeneration.generateRepoReadme(repoPath, structureAnalysis as any);
  });

  ipcMain.handle(IPC.CONTRACT_ANALYZE_FEATURE_DEEP, async (_, repoPath: string, feature: unknown) => {
    return services.contractGeneration.analyzeFeatureDeep(repoPath, feature as any);
  });

  // ==========================================================================
  // REPOSITORY ANALYSIS HANDLERS
  // AST parsing, code analysis, and intelligent contract generation
  // ==========================================================================
  ipcMain.handle(IPC.ANALYSIS_SCAN_REPO, async (_, repoPath: string) => {
    try {
      const result = await services.repositoryAnalysis.scanRepository(repoPath);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SCAN_FAILED',
          message: error instanceof Error ? error.message : 'Failed to scan repository',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_PARSE_FILE, async (_, filePath: string, options?: { useCache?: boolean }) => {
    try {
      const ast = await services.astParser.parseFile(filePath, options);
      return { success: true, data: ast };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to parse file',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_ANALYZE_REPO, async (_, repoPath: string, options?: unknown) => {
    try {
      const result = await services.repositoryAnalysis.analyzeRepository(repoPath, options as any);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'ANALYSIS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to analyze repository',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_GET_CACHE_STATS, async () => {
    return { success: true, data: services.astParser.getCacheStats() };
  });

  ipcMain.handle(IPC.ANALYSIS_CLEAR_CACHE, async () => {
    services.astParser.clearCache();
    return { success: true };
  });

  // ==========================================================================
  // PHASE 2: SCHEMA EXTRACTION HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.ANALYSIS_EXTRACT_SCHEMA_FILE, async (_, filePath: string) => {
    try {
      const schemas = await services.schemaExtractor.extractFromFile(filePath);
      return { success: true, data: schemas };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SCHEMA_EXTRACTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to extract schemas',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_EXTRACT_SCHEMAS, async (_, files: Array<{ path: string }>) => {
    try {
      const schemas = await services.schemaExtractor.extractFromFiles(files);
      return { success: true, data: schemas };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SCHEMA_EXTRACTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to extract schemas',
        },
      };
    }
  });

  // ==========================================================================
  // PHASE 2: EVENT TRACKING HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.ANALYSIS_EXTRACT_EVENTS_FILE, async (_, filePath: string) => {
    try {
      const events = await services.eventTracker.extractFromFile(filePath);
      return { success: true, data: events };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EVENT_EXTRACTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to extract events',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_EXTRACT_EVENTS, async (_, files: Array<{ path: string }>) => {
    try {
      const events = await services.eventTracker.extractFromFiles(files);
      return { success: true, data: events };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EVENT_EXTRACTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to extract events',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_GET_EVENT_FLOW, async (_, events: unknown[]) => {
    try {
      const flow = services.eventTracker.buildEventFlowGraph(events as any);
      return { success: true, data: flow };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EVENT_FLOW_FAILED',
          message: error instanceof Error ? error.message : 'Failed to build event flow',
        },
      };
    }
  });

  // ==========================================================================
  // PHASE 2: DEPENDENCY GRAPH HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.ANALYSIS_BUILD_FILE_GRAPH, async (_, repoPath: string) => {
    try {
      // First analyze the repository to get parsed files
      const result = await services.repositoryAnalysis.analyzeRepository(repoPath);
      if (!result.success || !result.analysis) {
        return {
          success: false,
          error: { code: 'ANALYSIS_FAILED', message: 'Failed to analyze repository' },
        };
      }
      // The graph is already built as part of the analysis
      return { success: true, data: result.analysis.dependencyGraph };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GRAPH_BUILD_FAILED',
          message: error instanceof Error ? error.message : 'Failed to build dependency graph',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_BUILD_FEATURE_GRAPH, async (_, features: unknown[]) => {
    try {
      const graph = services.dependencyGraph.buildFeatureGraph(features as any);
      return { success: true, data: graph };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GRAPH_BUILD_FAILED',
          message: error instanceof Error ? error.message : 'Failed to build feature graph',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_GET_GRAPH_STATS, async (_, graph: unknown) => {
    try {
      const stats = services.dependencyGraph.getStats(graph as any);
      return { success: true, data: stats };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STATS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get graph stats',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_EXPORT_GRAPH_DOT, async (_, graph: unknown, options?: { title?: string; highlightCircular?: boolean }) => {
    try {
      const dot = services.dependencyGraph.toDOT(graph as any, options);
      return { success: true, data: dot };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EXPORT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to export graph to DOT',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_EXPORT_GRAPH_JSON, async (_, graph: unknown) => {
    try {
      const json = services.dependencyGraph.toJSON(graph as any);
      return { success: true, data: json };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EXPORT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to export graph to JSON',
        },
      };
    }
  });

  // ==========================================================================
  // PHASE 3: INFRASTRUCTURE PARSING HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.ANALYSIS_PARSE_INFRA, async (_, repoPath: string) => {
    try {
      const analysis = await services.infraParser.analyzeInfrastructure(repoPath);
      return { success: true, data: analysis };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INFRA_PARSE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to parse infrastructure',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_PARSE_TERRAFORM, async (_, filePath: string) => {
    try {
      const analysis = await services.infraParser.parseTerraformFile(filePath);
      return { success: true, data: analysis };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'TERRAFORM_PARSE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to parse Terraform file',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_PARSE_KUBERNETES, async (_, filePath: string) => {
    try {
      const resources = await services.infraParser.parseKubernetesFile(filePath);
      return { success: true, data: resources };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'KUBERNETES_PARSE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to parse Kubernetes file',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_PARSE_DOCKER_COMPOSE, async (_, filePath: string) => {
    try {
      const config = await services.infraParser.parseDockerComposeFile(filePath);
      return { success: true, data: config };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DOCKER_COMPOSE_PARSE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to parse Docker Compose file',
        },
      };
    }
  });

  ipcMain.handle(IPC.ANALYSIS_GET_INFRA_SUMMARY, async (_, analysis: unknown) => {
    try {
      const summary = services.infraParser.getSummary(analysis as any);
      return { success: true, data: summary };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SUMMARY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get infrastructure summary',
        },
      };
    }
  });

  // ==========================================================================
  // REBASE WATCHER HANDLERS
  // Auto-rebase on remote changes (on-demand mode)
  // ==========================================================================
  ipcMain.handle(IPC.REBASE_WATCHER_START, async (_, config) => {
    return services.rebaseWatcher.startWatching(config);
  });

  ipcMain.handle(IPC.REBASE_WATCHER_STOP, async (_, sessionId: string) => {
    return services.rebaseWatcher.stopWatching(sessionId);
  });

  ipcMain.handle(IPC.REBASE_WATCHER_PAUSE, async (_, sessionId: string) => {
    services.rebaseWatcher.pauseWatching(sessionId);
    return { success: true };
  });

  ipcMain.handle(IPC.REBASE_WATCHER_RESUME, async (_, sessionId: string) => {
    services.rebaseWatcher.resumeWatching(sessionId);
    return { success: true };
  });

  ipcMain.handle(IPC.REBASE_WATCHER_GET_STATUS, async (_, sessionId: string) => {
    return {
      success: true,
      data: services.rebaseWatcher.getWatchStatus(sessionId),
    };
  });

  ipcMain.handle(IPC.REBASE_WATCHER_FORCE_CHECK, async (_, sessionId: string) => {
    return services.rebaseWatcher.forceCheck(sessionId);
  });

  ipcMain.handle(IPC.REBASE_WATCHER_TRIGGER, async (_, sessionId: string) => {
    return services.rebaseWatcher.triggerRebase(sessionId);
  });

  ipcMain.handle(IPC.REBASE_WATCHER_LIST, async () => {
    return {
      success: true,
      data: services.rebaseWatcher.getWatchedSessions(),
    };
  });

  // ==========================================================================
  // FILE SYSTEM HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.FILE_READ_CONTENT, async (_, filePath: string) => {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, data: content };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FILE_READ_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read file',
        },
      };
    }
  });

  // ==========================================================================
  // SHELL/QUICK ACTION HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.SHELL_OPEN_TERMINAL, async (_, dirPath: string) => {
    return services.quickAction.openTerminal(dirPath);
  });

  ipcMain.handle(IPC.SHELL_OPEN_VSCODE, async (_, dirPath: string) => {
    return services.quickAction.openVSCode(dirPath);
  });

  ipcMain.handle(IPC.SHELL_OPEN_FINDER, async (_, dirPath: string) => {
    return services.quickAction.openFinder(dirPath);
  });

  ipcMain.handle(IPC.SHELL_COPY_PATH, async (_, pathToCopy: string) => {
    return services.quickAction.copyPath(pathToCopy);
  });

  // ==========================================================================
  // TERMINAL LOG HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.TERMINAL_GET_LOGS, async (_, sessionId?: string, limit?: number) => {
    return services.terminalLog.getLogs(sessionId, limit);
  });

  ipcMain.handle(IPC.TERMINAL_CLEAR, async (_, sessionId?: string) => {
    return services.terminalLog.clearLogs(sessionId);
  });

  // ==========================================================================
  // MERGE WORKFLOW HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.MERGE_PREVIEW, async (_, repoPath: string, sourceBranch: string, targetBranch: string) => {
    return services.merge.previewMerge(repoPath, sourceBranch, targetBranch);
  });

  ipcMain.handle(IPC.MERGE_EXECUTE, async (_, repoPath: string, sourceBranch: string, targetBranch: string, options?: {
    deleteWorktree?: boolean;
    deleteLocalBranch?: boolean;
    deleteRemoteBranch?: boolean;
    worktreePath?: string;
  }) => {
    return services.merge.executeMerge(repoPath, sourceBranch, targetBranch, options);
  });

  ipcMain.handle(IPC.MERGE_ABORT, async (_, repoPath: string) => {
    return services.merge.abortMerge(repoPath);
  });

  ipcMain.handle(IPC.MERGE_CLEAN_UNTRACKED, async (_, repoPath: string, blockingFiles: string[]) => {
    return services.merge.cleanUntrackedBlockingFiles(repoPath, blockingFiles);
  });

  ipcMain.handle(IPC.MERGE_RESOLVE_BRANCH, async (_, dirPath: string) => {
    return services.merge.resolveActiveBranch(dirPath);
  });

  // ==========================================================================
  // MERGE CONFLICT RESOLUTION HANDLERS
  // AI-powered conflict analysis and resolution with user approval
  // ==========================================================================
  ipcMain.handle(IPC.CONFLICT_GET_FILES, async (_, repoPath: string) => {
    return services.mergeConflict.getConflictedFiles(repoPath);
  });

  ipcMain.handle(IPC.CONFLICT_READ_FILE, async (_, repoPath: string, filePath: string) => {
    return services.mergeConflict.readConflictedFile(repoPath, filePath);
  });

  ipcMain.handle(IPC.CONFLICT_ANALYZE, async (_, repoPath: string, filePath: string) => {
    return services.mergeConflict.analyzeConflict(repoPath, filePath);
  });

  ipcMain.handle(IPC.CONFLICT_RESOLVE_FILE, async (_, repoPath: string, filePath: string, currentBranch: string, incomingBranch: string) => {
    return services.mergeConflict.resolveFileConflict(repoPath, filePath, currentBranch, incomingBranch);
  });

  ipcMain.handle(IPC.CONFLICT_APPLY_RESOLUTION, async (_, repoPath: string, filePath: string, content: string) => {
    return services.mergeConflict.applyResolution(repoPath, filePath, content);
  });

  ipcMain.handle(IPC.CONFLICT_GENERATE_PREVIEWS, async (_, repoPath: string, targetBranch: string) => {
    return services.mergeConflict.generateResolutionPreviews(repoPath, targetBranch);
  });

  ipcMain.handle(IPC.CONFLICT_APPLY_APPROVED, async (_, repoPath: string, approvedPreviews: unknown) => {
    return services.mergeConflict.applyApprovedResolutions(repoPath, approvedPreviews as any);
  });

  ipcMain.handle(IPC.CONFLICT_ABORT_REBASE, async (_, repoPath: string) => {
    return services.mergeConflict.abortRebase(repoPath);
  });

  ipcMain.handle(IPC.CONFLICT_IS_REBASE_IN_PROGRESS, async (_, repoPath: string) => {
    return services.mergeConflict.isRebaseInProgress(repoPath);
  });

  ipcMain.handle(IPC.CONFLICT_REBASE_WITH_AI, async (_, repoPath: string, targetBranch: string) => {
    return services.mergeConflict.rebaseWithResolution(repoPath, targetBranch);
  });

  ipcMain.handle(IPC.CONFLICT_CREATE_BACKUP, async (_, repoPath: string, sessionId: string) => {
    try {
      const execa = (await import('execa')).execa || (await import('execa')).default;
      const branchName = `backup_kit/${sessionId}`;
      await (execa as any)('git', ['branch', branchName], { cwd: repoPath });
      return { success: true, data: branchName };
    } catch (error) {
      return { success: false, error: { code: 'CREATE_BACKUP_FAILED', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  ipcMain.handle(IPC.CONFLICT_DELETE_BACKUP, async (_, repoPath: string, sessionId: string) => {
    try {
      const execa = (await import('execa')).execa || (await import('execa')).default;
      const branchName = `backup_kit/${sessionId}`;
      await (execa as any)('git', ['branch', '-D', branchName], { cwd: repoPath });
      return { success: true };
    } catch (error) {
      return { success: false, error: { code: 'DELETE_BACKUP_FAILED', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ==========================================================================
  // COMMIT ANALYSIS HANDLERS
  // AI-powered commit message generation from file diffs
  // ==========================================================================
  ipcMain.handle(IPC.COMMIT_ANALYZE_STAGED, async (_, repoPath: string, options?: unknown) => {
    return services.commitAnalysis.analyzeStaged(repoPath, options as any);
  });

  ipcMain.handle(IPC.COMMIT_ANALYZE_COMMIT, async (_, repoPath: string, commitHash: string, options?: unknown) => {
    return services.commitAnalysis.analyzeCommit(repoPath, commitHash, options as any);
  });

  ipcMain.handle(IPC.COMMIT_SET_ENHANCED_ENABLED, async (_, enabled: boolean) => {
    services.watcher.setEnhancedCommitsEnabled(enabled);
    return { success: true };
  });

  ipcMain.handle(IPC.COMMIT_GET_ENHANCED_ENABLED, async () => {
    // Note: This returns the current state. Could be stored in config for persistence.
    return { success: true, data: false }; // Default to false, would need state tracking
  });

  // ==========================================================================
  // DEBUG LOG HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.DEBUG_LOG_WRITE, async (_, level: string, source: string, message: string, details?: unknown) => {
    const logLevel = level as 'debug' | 'info' | 'warn' | 'error';
    services.debugLog[logLevel](source, message, details);
    return { success: true };
  });

  ipcMain.handle(IPC.DEBUG_LOG_GET_RECENT, async (_, count?: number, level?: string) => {
    return services.debugLog.getRecentLogs(count, level as any);
  });

  ipcMain.handle(IPC.DEBUG_LOG_EXPORT, async () => {
    return services.debugLog.exportLogs();
  });

  ipcMain.handle(IPC.DEBUG_LOG_CLEAR, async () => {
    return services.debugLog.clearLogs();
  });

  ipcMain.handle(IPC.DEBUG_LOG_GET_STATS, async () => {
    return services.debugLog.getLogStats();
  });

  ipcMain.handle(IPC.DEBUG_LOG_GET_PATH, async () => {
    return services.debugLog.getLogFilePath();
  });

  ipcMain.handle(IPC.DEBUG_LOG_OPEN_FOLDER, async () => {
    const pathResult = services.debugLog.getLogDirectory();
    if (pathResult.success && pathResult.data) {
      const { shell } = await import('electron');
      shell.openPath(pathResult.data);
      return { success: true };
    }
    return { success: false, error: { code: 'PATH_NOT_FOUND', message: 'Log directory not found' } };
  });

  // ==========================================================================
  // VERSION MANAGEMENT HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.VERSION_GET, (_, repoPath: string) => {
    return services.version.getRepoVersion(repoPath);
  });

  ipcMain.handle(IPC.VERSION_BUMP, (_, repoPath: string, component: 'major' | 'minor' | 'patch') => {
    return services.version.bumpVersion(repoPath, component);
  });

  ipcMain.handle(IPC.VERSION_GET_SETTINGS, (_, repoPath: string) => {
    return services.version.getSettings(repoPath);
  });

  ipcMain.handle(IPC.VERSION_SET_SETTINGS, (_, repoPath: string, settings: { autoVersionBump: boolean }) => {
    return services.version.setSettings(repoPath, settings);
  });

  // ==========================================================================
  // AUTO-UPDATE HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    return { success: true, data: await services.autoUpdate.checkForUpdates() };
  });

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => {
    try {
      await services.autoUpdate.downloadUpdate();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DOWNLOAD_FAILED',
          message: error instanceof Error ? error.message : 'Download failed',
        },
      };
    }
  });

  ipcMain.handle(IPC.UPDATE_INSTALL, () => {
    services.autoUpdate.installUpdate();
    return { success: true };
  });

  ipcMain.handle(IPC.UPDATE_GET_STATUS, () => {
    return { success: true, data: services.autoUpdate.getStatus() };
  });

  // ==========================================================================
  // WORKER PROCESS HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.WORKER_STATUS, () => {
    return { success: true, data: services.workerBridge.getStatus() };
  });

  ipcMain.handle(IPC.WORKER_RESTART, () => {
    services.workerBridge.restart();
    return { success: true };
  });

  // ==========================================================================
  // MCP SERVER HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.MCP_SERVER_STATUS, () => {
    return { success: true, data: services.mcpServer.getStatus() };
  });

  ipcMain.handle(IPC.MCP_GET_CALL_LOG, async (_, limit?: number) => {
    return { success: true, data: services.mcpServer.getMcpCallLog(limit) };
  });

  ipcMain.handle(IPC.MCP_INSTALL_CLAUDE_CODE, async () => {
    const result = await services.mcpServer.installForClaudeCode();
    return result.success
      ? { success: true, data: { path: result.path } }
      : { success: false, error: { code: 'MCP_INSTALL_FAILED', message: result.error } };
  });

  ipcMain.handle(IPC.MCP_UNINSTALL_CLAUDE_CODE, async () => {
    const result = await services.mcpServer.uninstallFromClaudeCode();
    return result.success
      ? { success: true }
      : { success: false, error: { code: 'MCP_UNINSTALL_FAILED', message: result.error } };
  });

  ipcMain.handle(IPC.MCP_CHECK_CLAUDE_CODE_CONFIG, async () => {
    const data = await services.mcpServer.checkClaudeCodeConfig();
    return { success: true, data };
  });

  // ==========================================================================
  // APP HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.APP_GET_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.APP_RELOAD, () => {
    mainWindow.reload();
    return { success: true };
  });

  ipcMain.on(IPC.APP_QUIT, () => {
    app.quit();
  });

  // Start watchers for existing sessions
  startWatchersForExistingSessions(services);
}

/**
 * Start file watchers for all existing sessions and auto-restart active ones
 */
async function startWatchersForExistingSessions(services: Services): Promise<void> {
  const result = services.agentInstance.listInstances();
  if (result.success && result.data) {
    console.log(`[IPC] Starting watchers for ${result.data.length} existing sessions`);
    const activeSessions: string[] = [];

    for (const instance of result.data) {
      // Use worktree path if available, otherwise fallback to repo path
      const watchPath = instance.worktreePath || instance.config?.repoPath;
      if (watchPath) {
        // Start file watcher
        services.watcher.startWithPath(instance.sessionId, watchPath).catch((err) => {
          console.warn(`[IPC] Failed to start file watcher for session ${instance.sessionId}:`, err);
        });

        // Start rebase watcher for all non-never frequencies
        const rebaseFrequency = instance.config?.rebaseFrequency || 'never';
        if (rebaseFrequency !== 'never' && instance.config?.baseBranch) {
          services.rebaseWatcher.startWatching({
            sessionId: instance.sessionId,
            repoPath: watchPath,
            baseBranch: instance.config.baseBranch,
            currentBranch: instance.config.branchName,
            rebaseFrequency: rebaseFrequency as 'on-demand' | 'daily' | 'weekly',
            pollIntervalMs: 60000,
          }).catch((err) => {
            console.warn(`[IPC] Failed to start rebase watcher for session ${instance.sessionId}:`, err);
          });
        }

        // Track sessions that were active — will auto-restart after watchers settle
        if (instance.status === 'active') {
          activeSessions.push(instance.sessionId);
        }
      }
    }

    // Auto-restart sessions that were active when the app was last closed
    if (activeSessions.length > 0) {
      console.log(`[IPC] Auto-restarting ${activeSessions.length} previously active session(s)`);
      setTimeout(async () => {
        for (const sessionId of activeSessions) {
          try {
            const restart = await services.agentInstance.restartInstance(sessionId, undefined, true);
            if (restart.success && restart.data?.sessionId) {
              const watchPath = restart.data.worktreePath || restart.data.config?.repoPath;
              if (watchPath) {
                services.watcher.startWithPath(restart.data.sessionId, watchPath).catch(() => {});
              }
              console.log(`[IPC] Auto-restarted session ${sessionId} -> ${restart.data.sessionId}`);
              services.terminalLog.logSystem(`Auto-restarted session on app launch`, restart.data.sessionId);
            }
          } catch (err) {
            console.warn(`[IPC] Auto-restart failed for session ${sessionId}:`, err);
          }
        }
      }, 2000); // Wait 2s for watchers to initialise before restarting
    }

    // Run crash recovery - process any unprocessed commits from while app was closed
    setTimeout(async () => {
      try {
        const recovery = await services.agentInstance.processUnprocessedCommitsOnStartup({
          analyzeCommit: async (sessionId: string, commitHash: string, worktreePath: string) => {
            const result = await services.contractDetection.analyzeCommit(worktreePath, commitHash);
            if (result.success && result.data) {
              return {
                contractChanges: result.data.changes?.length || 0,
                breakingChanges: result.data.breakingChanges?.length || 0,
              };
            }
            return { contractChanges: 0, breakingChanges: 0 };
          },
        });

        if (recovery.commitsProcessed > 0) {
          console.log(`[IPC] Crash recovery: processed ${recovery.commitsProcessed} commits from ${recovery.sessionsProcessed} sessions`);
          services.terminalLog.logSystem(`Crash recovery: processed ${recovery.commitsProcessed} commits from ${recovery.sessionsProcessed} sessions`);
        }
      } catch (error) {
        console.warn('[IPC] Crash recovery failed:', error);
      }
    }, 2000); // Delay to let watchers start first
  }
  // ==========================================================================
  // SEED DATA HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.SEED_GENERATE_FEATURE, async (_, repoPath: string, feature: unknown) => {
    return services.seedDataExecution.generateFeatureSeedContract(repoPath, feature as any);
  });

  ipcMain.handle(IPC.SEED_GENERATE_ALL, async (_, repoPath: string, features: unknown[]) => {
    return services.seedDataExecution.generateAllSeedContracts(repoPath, features as any);
  });

  ipcMain.handle(IPC.SEED_MERGE_PLAN, async (_, repoPath: string) => {
    return services.seedDataExecution.mergeSeedContracts(repoPath);
  });

  ipcMain.handle(IPC.SEED_EXECUTE, async (_, repoPath: string) => {
    return services.seedDataExecution.executeSeedPlan(repoPath);
  });

  ipcMain.handle(IPC.SEED_GET_STATUS, async () => {
    return services.seedDataExecution.getSeedStatus();
  });

  ipcMain.handle(IPC.SEED_GET_PLAN, async (_, repoPath: string) => {
    return services.seedDataExecution.getSeedPlan(repoPath);
  });

  // ==========================================================================
  // STARTUP / PORT DISCOVERY HANDLERS
  // ==========================================================================
  ipcMain.handle(IPC.STARTUP_DISCOVER_PORTS, async (_, servicesConfig: unknown[]) => {
    return services.seedDataExecution.discoverPorts(servicesConfig as any);
  });

  ipcMain.handle(IPC.STARTUP_GET_PORTS, async () => {
    return services.seedDataExecution.getPorts();
  });

  ipcMain.handle(IPC.STARTUP_GET_STATUS, async () => {
    return services.seedDataExecution.getStartupStatus();
  });

  console.log('[IPC] All IPC handlers registered successfully');
}

/**
 * Remove all IPC handlers (for cleanup/testing)
 */
export function removeIpcHandlers(): void {
  Object.values(IPC).forEach((channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  });
}
