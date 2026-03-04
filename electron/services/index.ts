/**
 * Service Initialization and Export
 * Creates and manages all main process services
 */

import { BrowserWindow } from 'electron';
import { SessionService } from './SessionService';
import { GitService } from './GitService';
import { WatcherService } from './WatcherService';
import { LockService } from './LockService';
import { ConfigService } from './ConfigService';
import { AIService } from './AIService';
import { ActivityService } from './ActivityService';
import { AgentListenerService } from './AgentListenerService';
import { AgentInstanceService } from './AgentInstanceService';
import { SessionRecoveryService } from './SessionRecoveryService';
import { RepoCleanupService } from './RepoCleanupService';
import { ContractDetectionService } from './ContractDetectionService';
import { ContractRegistryService } from './ContractRegistryService';
import { ContractGenerationService } from './ContractGenerationService';
import { RebaseWatcherService } from './RebaseWatcherService';
import { TerminalLogService } from './TerminalLogService';
import { QuickActionService } from './QuickActionService';
import { MergeService } from './MergeService';
import { MergeConflictService } from './MergeConflictService';
import { HeartbeatService } from './HeartbeatService';
import { CommitAnalysisService } from './CommitAnalysisService';
import { DebugLogService } from './DebugLogService';
import { VersionService } from './VersionService';
import { AutoUpdateService } from './AutoUpdateService';
import { WorkerBridgeService } from './WorkerBridgeService';
import { McpServerService } from './McpServerService';
import { databaseService } from './DatabaseService';
import {
  initializeAnalysisServices,
  disposeAnalysisServices,
  ASTParserService,
  RepositoryAnalysisService,
  APIExtractorService,
  SchemaExtractorService,
  EventTrackerService,
  DependencyGraphService,
  InfraParserService,
} from './analysis';

export interface Services {
  session: SessionService;
  git: GitService;
  watcher: WatcherService;
  lock: LockService;
  config: ConfigService;
  ai: AIService;
  activity: ActivityService;
  agentListener: AgentListenerService;
  agentInstance: AgentInstanceService;
  sessionRecovery: SessionRecoveryService;
  repoCleanup: RepoCleanupService;
  contractDetection: ContractDetectionService;
  contractRegistry: ContractRegistryService;
  contractGeneration: ContractGenerationService;
  rebaseWatcher: RebaseWatcherService;
  terminalLog: TerminalLogService;
  quickAction: QuickActionService;
  merge: MergeService;
  mergeConflict: MergeConflictService;
  heartbeat: HeartbeatService;
  commitAnalysis: CommitAnalysisService;
  debugLog: DebugLogService;
  version: VersionService;
  autoUpdate: AutoUpdateService;
  workerBridge: WorkerBridgeService;
  mcpServer: McpServerService;
  // Analysis services (Phase 1)
  astParser: ASTParserService;
  repositoryAnalysis: RepositoryAnalysisService;
  apiExtractor: APIExtractorService;
  // Analysis services (Phase 2)
  schemaExtractor: SchemaExtractorService;
  eventTracker: EventTrackerService;
  dependencyGraph: DependencyGraphService;
  // Analysis services (Phase 3)
  infraParser: InfraParserService;
}

let services: Services | null = null;

/**
 * Initialize all services with the main window reference
 */
export async function initializeServices(mainWindow: BrowserWindow): Promise<Services> {
  // Initialize database service first (stores activities, settings, logs)
  await databaseService.initialize();
  console.log('[Services] Database initialized');

  // Initialize Debug Log service early (for logging during initialization)
  const debugLog = new DebugLogService();
  await debugLog.initialize();

  // Initialize config service (other services may depend on it)
  const config = new ConfigService();
  await config.initialize();

  // Initialize activity service (used by other services for logging)
  const activity = new ActivityService();
  activity.setMainWindow(mainWindow);

  // Initialize core services
  const git = new GitService();
  git.setMainWindow(mainWindow);

  const lock = new LockService();
  lock.setMainWindow(mainWindow);

  // Initialize Terminal Log service early (other services may use it)
  const terminalLog = new TerminalLogService();
  terminalLog.setMainWindow(mainWindow);

  const watcher = new WatcherService(git, activity);
  watcher.setMainWindow(mainWindow);

  const session = new SessionService(git, watcher, lock, activity);
  session.setMainWindow(mainWindow);

  // Initialize AI service with credentials from config
  const ai = new AIService(config);
  ai.setMainWindow(mainWindow);

  // Initialize Agent Listener service
  // Kanvas monitors agents that report into it (dashboard pattern)
  const agentListener = new AgentListenerService();

  // Initialize Agent Instance service
  // For creating new agent instances from Kanvas dashboard
  const agentInstance = new AgentInstanceService();

  // Initialize Session Recovery service
  // For recovering orphaned sessions from repository .kanvas directories
  const sessionRecovery = new SessionRecoveryService();

  // Initialize Repo Cleanup service
  // For cleaning up worktrees, branches, and Kanvas files
  const repoCleanup = new RepoCleanupService();

  // Initialize Contract Detection service
  // For detecting contract changes in commits (API specs, schemas, interfaces, tests)
  const contractDetection = new ContractDetectionService();
  contractDetection.setMainWindow(mainWindow);

  // Initialize Contract Registry service
  // For JSON-based contract tracking at repo and feature levels
  const contractRegistry = new ContractRegistryService();
  contractRegistry.setMainWindow(mainWindow);

  // Initialize Contract Generation service
  // For scanning codebases and generating contract documentation using AI
  const contractGeneration = new ContractGenerationService(ai, contractRegistry);
  contractGeneration.setMainWindow(mainWindow);

  // Initialize Rebase Watcher service
  // For auto-rebasing when remote changes are detected (on-demand mode)
  const rebaseWatcher = new RebaseWatcherService(git);
  rebaseWatcher.setMainWindow(mainWindow);
  rebaseWatcher.setDebugLog(debugLog);

  // Connect rebaseWatcher to watcher for post-commit rebase
  watcher.setRebaseWatcher(rebaseWatcher);

  // Connect terminalLog to watcher for terminal view logging
  watcher.setTerminalLogService(terminalLog);

  // Connect lockService to watcher for auto-locking files on change
  watcher.setLockService(lock);

  // Connect terminalLog to agentInstance for restart logging
  agentInstance.setTerminalLogService(terminalLog);

  // Connect agentInstance to watcher for commit tracking (crash recovery)
  watcher.setAgentInstanceService(agentInstance);

  // Initialize Quick Action service
  // For opening terminal, VS Code, Finder, clipboard
  const quickAction = new QuickActionService();

  // Initialize Merge service
  // For merge preview and execution workflow
  const merge = new MergeService();

  // Initialize Merge Conflict service
  // For AI-powered conflict resolution using LLM (llama, qwen, etc.)
  const mergeConflict = new MergeConflictService(ai);
  mergeConflict.setDebugLog(debugLog);

  // Wire merge service dependencies
  merge.setMergeConflictService(mergeConflict);
  merge.setRebaseWatcher(rebaseWatcher);
  merge.setAgentInstanceService(agentInstance);
  merge.setLockService(lock);

  // Wire mergeConflict into rebaseWatcher so AI resolution is actually used
  rebaseWatcher.setMergeConflictService(mergeConflict);

  // Initialize Heartbeat service
  // For monitoring agent connection status
  const heartbeat = new HeartbeatService();
  heartbeat.setMainWindow(mainWindow);

  // Initialize Commit Analysis service
  // For AI-powered commit message generation from file diffs
  const commitAnalysis = new CommitAnalysisService();
  commitAnalysis.setAIService(ai);

  // Initialize Version service
  // For repo-level version management (read, bump, settings)
  const version = new VersionService();

  // Initialize AutoUpdate service
  // For checking/downloading/installing app updates via GitHub Releases
  const autoUpdate = new AutoUpdateService();
  autoUpdate.setMainWindow(mainWindow);
  autoUpdate.initialize();

  // Initialize Worker Bridge service
  // Spawns a utility process for file monitoring, rebase polling, heartbeat tracking
  const workerBridge = new WorkerBridgeService();

  // Wire worker bridge events to existing services
  workerBridge.onFileChanged = (sessionId, filePath, changeType) => {
    watcher.handleExternalFileChange(sessionId, filePath, changeType as 'add' | 'change' | 'unlink');
  };
  workerBridge.onCommitMsgDetected = (sessionId, commitMsgFilePath) => {
    watcher.handleExternalCommitMsg(sessionId, commitMsgFilePath);
  };
  workerBridge.onRebaseRemoteStatus = (sessionId, behind, ahead, remoteBranch, localBranch) => {
    rebaseWatcher.handleExternalRemoteStatus(sessionId, behind, ahead, remoteBranch, localBranch);
  };
  workerBridge.onHeartbeatUpdate = (sessionId, data) => {
    heartbeat.handleExternalHeartbeat(sessionId, data);
  };
  workerBridge.onHeartbeatTimeout = (sessionId) => {
    heartbeat.handleExternalHeartbeatTimeout(sessionId);
  };
  workerBridge.onAgentFileEvent = (subtype, action, filePath) => {
    agentListener.handleExternalFileEvent(subtype, action, filePath);
  };
  workerBridge.onWorkerReady = (pid) => {
    terminalLog.logSystem(`Worker process ready (pid: ${pid})`);
  };
  workerBridge.onWorkerError = (source, message) => {
    terminalLog.warn(`Worker error (${source}): ${message}`, undefined, 'Worker');
  };
  workerBridge.onWorkerLog = (level, source, message) => {
    terminalLog.log(level === 'debug' ? 'debug' : level, message, { source: `Worker:${source}` });
  };

  // Connect worker bridge to monitoring services
  watcher.setWorkerBridge(workerBridge);
  rebaseWatcher.setWorkerBridge(workerBridge);
  heartbeat.setWorkerBridge(workerBridge);
  agentListener.setWorkerBridge(workerBridge);

  // Spawn the utility process
  await workerBridge.initialize();
  console.log('[Services] Worker bridge initialized');

  // Initialize MCP Server service
  // Provides MCP protocol interface for coding agents (Claude Code, Cursor, etc.)
  const mcpServer = new McpServerService();
  mcpServer.setGitService(git);
  mcpServer.setActivityService(activity);
  mcpServer.setLockService(lock);
  mcpServer.setAgentInstanceService(agentInstance);
  mcpServer.setDatabaseService(databaseService);
  await mcpServer.initialize();
  console.log('[Services] MCP server initialized on port', mcpServer.getPort());

  // Pass MCP URL to AgentInstanceService for .mcp.json generation
  agentInstance.setMcpServerUrl(mcpServer.getUrl());

  // Wire multi-repo callback: register all repos with MCP session binder
  agentInstance.onMultiRepoSessionCreated = (sessionId, repos) => {
    mcpServer.sessionBinder.registerMultiRepoSession(sessionId, repos);
    console.log(`[Services] Multi-repo session ${sessionId} registered with MCP binder (${repos.length} repos)`);
  };

  // Initialize Analysis services
  // For AST parsing, repository analysis, and API extraction
  const analysisServices = await initializeAnalysisServices();
  analysisServices.repositoryAnalysis.setMainWindow(mainWindow);

  // Connect analysis services to contract generation for enhanced contracts (Phase 3)
  contractGeneration.setAnalysisServices(
    analysisServices.astParser,
    analysisServices.apiExtractor,
    analysisServices.schemaExtractor,
    analysisServices.dependencyGraph
  );

  // Connect analysis services to watcher for incremental analysis (Phase 4)
  watcher.setAnalysisServices(
    analysisServices.astParser,
    analysisServices.repositoryAnalysis
  );

  // Connect commit analysis service to watcher for enhanced commit messages
  watcher.setCommitAnalysisService(commitAnalysis);

  // Connect contract services to watcher for post-commit contract auto-checks
  watcher.setContractServices(contractDetection, contractGeneration);

  services = {
    session,
    git,
    watcher,
    lock,
    config,
    ai,
    activity,
    agentListener,
    agentInstance,
    sessionRecovery,
    repoCleanup,
    contractDetection,
    contractRegistry,
    contractGeneration,
    rebaseWatcher,
    terminalLog,
    quickAction,
    merge,
    mergeConflict,
    heartbeat,
    commitAnalysis,
    debugLog,
    version,
    autoUpdate,
    workerBridge,
    mcpServer,
    // Analysis services (Phase 1)
    astParser: analysisServices.astParser,
    repositoryAnalysis: analysisServices.repositoryAnalysis,
    apiExtractor: analysisServices.apiExtractor,
    // Analysis services (Phase 2)
    schemaExtractor: analysisServices.schemaExtractor,
    eventTracker: analysisServices.eventTracker,
    dependencyGraph: analysisServices.dependencyGraph,
    // Analysis services (Phase 3)
    infraParser: analysisServices.infraParser,
  };

  // Log initial startup message to terminal
  terminalLog.logSystem('Kanvas services initialized');
  terminalLog.info('Ready to monitor agent sessions', undefined, 'Kanvas');

  return services;
}

/**
 * Dispose all services (cleanup on app quit)
 */
export async function disposeServices(): Promise<void> {
  if (!services) return;

  // Stop MCP server (close HTTP server and transports)
  await services.mcpServer.dispose();

  // Stop worker bridge (stops utility process and all monitors)
  await services.workerBridge.dispose();

  // Stop all watchers
  await services.watcher.dispose();

  // Release all locks
  await services.lock.dispose();

  // Cleanup AI streams
  services.ai.dispose();

  // Cleanup agent listener
  await services.agentListener.destroy();

  // Cleanup rebase watcher
  await services.rebaseWatcher.dispose();

  // Cleanup heartbeat service
  await services.heartbeat.dispose();

  // Cleanup analysis services
  await disposeAnalysisServices();

  // Close database connection (last, so other services can flush)
  await databaseService.dispose();

  services = null;
}

// Re-export service classes
export { SessionService } from './SessionService';
export { GitService } from './GitService';
export { WatcherService } from './WatcherService';
export { LockService } from './LockService';
export { ConfigService } from './ConfigService';
export { AIService } from './AIService';
export { ActivityService } from './ActivityService';
export { AgentListenerService } from './AgentListenerService';
export { AgentInstanceService } from './AgentInstanceService';
export { SessionRecoveryService } from './SessionRecoveryService';
export { RepoCleanupService } from './RepoCleanupService';
export { ContractDetectionService } from './ContractDetectionService';
export { ContractRegistryService } from './ContractRegistryService';
export { ContractGenerationService } from './ContractGenerationService';
export { RebaseWatcherService } from './RebaseWatcherService';
export { TerminalLogService } from './TerminalLogService';
export { QuickActionService } from './QuickActionService';
export { MergeService } from './MergeService';
export { MergeConflictService } from './MergeConflictService';
export { HeartbeatService } from './HeartbeatService';
export { CommitAnalysisService } from './CommitAnalysisService';
export { DebugLogService } from './DebugLogService';
export { VersionService } from './VersionService';
export { AutoUpdateService } from './AutoUpdateService';
export { WorkerBridgeService } from './WorkerBridgeService';
export { McpServerService } from './McpServerService';
export { databaseService } from './DatabaseService';
// Analysis services (Phase 1 + Phase 2 + Phase 3)
export {
  ASTParserService,
  RepositoryAnalysisService,
  APIExtractorService,
  SchemaExtractorService,
  EventTrackerService,
  DependencyGraphService,
  InfraParserService,
} from './analysis';
