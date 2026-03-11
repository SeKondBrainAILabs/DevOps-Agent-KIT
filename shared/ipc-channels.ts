/**
 * IPC Channel Constants
 * Naming convention: {domain}:{action}
 */

export const IPC = {
  // ==========================================================================
  // SESSION CHANNELS
  // ==========================================================================
  SESSION_CREATE: 'session:create',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_CLOSE: 'session:close',
  SESSION_CLAIM: 'session:claim',
  SESSION_UPDATE: 'session:update',
  // Events (main → renderer)
  SESSION_CREATED: 'session:created',
  SESSION_UPDATED: 'session:updated',
  SESSION_CLOSED: 'session:closed',
  CROSS_SESSION_OVERLAP_DETECTED: 'session:cross-overlap-detected',

  // ==========================================================================
  // GIT CHANNELS
  // ==========================================================================
  GIT_STATUS: 'git:status',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_MERGE: 'git:merge',
  GIT_BRANCHES: 'git:branches',
  GIT_CREATE_WORKTREE: 'git:createWorktree',
  GIT_REMOVE_WORKTREE: 'git:removeWorktree',
  GIT_DETECT_SUBMODULES: 'git:detect-submodules',
  // Events (main → renderer)
  GIT_STATUS_CHANGED: 'git:statusChanged',

  // ==========================================================================
  // WATCHER CHANNELS
  // ==========================================================================
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_STATUS: 'watcher:status',
  // Events (main → renderer)
  FILE_CHANGED: 'file:changed',
  COMMIT_TRIGGERED: 'commit:triggered',
  COMMIT_COMPLETED: 'commit:completed',

  // ==========================================================================
  // LOCK/COORDINATION CHANNELS
  // ==========================================================================
  LOCK_DECLARE: 'lock:declare',
  LOCK_RELEASE: 'lock:release',
  LOCK_CHECK: 'lock:check',
  LOCK_LIST: 'lock:list',
  // Events (main → renderer)
  CONFLICT_DETECTED: 'conflict:detected',

  // ==========================================================================
  // CONFIG CHANNELS
  // ==========================================================================
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_ALL: 'config:getAll',
  CREDENTIAL_GET: 'credential:get',
  CREDENTIAL_SET: 'credential:set',
  CREDENTIAL_HAS: 'credential:has',

  // ==========================================================================
  // AI/CHAT CHANNELS
  // ==========================================================================
  AI_CHAT: 'ai:chat',
  AI_STREAM_START: 'ai:stream:start',
  AI_STREAM_STOP: 'ai:stream:stop',
  AI_GET_MODEL: 'ai:get-model',
  AI_SET_MODEL: 'ai:set-model',
  AI_LIST_MODELS: 'ai:list-models',
  // Mode-based prompts
  AI_CHAT_WITH_MODE: 'ai:chat-with-mode',
  AI_STREAM_WITH_MODE: 'ai:stream-with-mode',
  AI_LIST_MODES: 'ai:list-modes',
  AI_GET_MODE: 'ai:get-mode',
  AI_RELOAD_CONFIG: 'ai:reload-config',
  AI_GET_CONFIG_SOURCES: 'ai:get-config-sources',
  // Events (main → renderer)
  AI_STREAM_CHUNK: 'ai:stream:chunk',
  AI_STREAM_END: 'ai:stream:end',
  AI_STREAM_ERROR: 'ai:stream:error',

  // ==========================================================================
  // ACTIVITY LOG CHANNELS
  // ==========================================================================
  LOG_GET: 'log:get',
  LOG_CLEAR: 'log:clear',
  LOG_GET_COMMITS: 'log:get-commits',  // Get commits for a session from database
  LOG_GET_TIMELINE: 'log:get-timeline',  // Get combined activity + commits timeline
  // Events (main → renderer)
  LOG_ENTRY: 'log:entry',

  // ==========================================================================
  // DIALOG CHANNELS
  // ==========================================================================
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  DIALOG_SHOW_MESSAGE: 'dialog:showMessage',

  // ==========================================================================
  // AGENT LISTENER CHANNELS
  // Kanvas monitors agents that report into it
  // ==========================================================================
  AGENT_LIST: 'agent:list',
  AGENT_GET: 'agent:get',
  AGENT_SESSIONS: 'agent:sessions',
  AGENT_INITIALIZE: 'agent:initialize',
  // Events (main → renderer) - Agent reports to Kanvas
  AGENT_REGISTERED: 'agent:registered',
  AGENT_UNREGISTERED: 'agent:unregistered',
  AGENT_HEARTBEAT: 'agent:heartbeat',
  AGENT_STATUS_CHANGED: 'agent:status-changed',
  SESSION_REPORTED: 'session:reported',
  ACTIVITY_REPORTED: 'activity:reported',

  // ==========================================================================
  // AGENT INSTANCE CHANNELS
  // Create and manage agent instances from Kanvas dashboard
  // ==========================================================================
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_VALIDATE_REPO: 'instance:validate-repo',
  INSTANCE_INITIALIZE_KANVAS: 'instance:initialize-kanvas',
  INSTANCE_GET_INSTRUCTIONS: 'instance:get-instructions',
  INSTANCE_LAUNCH: 'instance:launch',
  INSTANCE_LIST: 'instance:list',
  INSTANCE_GET: 'instance:get',
  INSTANCE_DELETE: 'instance:delete',
  INSTANCE_DELETE_SESSION: 'instance:delete-session', // Delete by sessionId
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_CLEAR_ALL: 'instance:clear-all',
  INSTANCE_UPDATE_BASE_BRANCH: 'instance:update-base-branch',
  RECENT_REPOS_LIST: 'recent-repos:list',
  RECENT_REPOS_ADD: 'recent-repos:add',
  RECENT_REPOS_REMOVE: 'recent-repos:remove',
  // Events (main → renderer)
  INSTANCE_STATUS_CHANGED: 'instance:status-changed',
  INSTANCE_DELETED: 'instance:deleted',
  INSTANCES_CLEARED: 'instances:cleared',

  // ==========================================================================
  // SESSION RECOVERY CHANNELS
  // ==========================================================================
  RECOVERY_SCAN_REPO: 'recovery:scan-repo',
  RECOVERY_SCAN_ALL: 'recovery:scan-all',
  RECOVERY_RECOVER_SESSION: 'recovery:recover-session',
  RECOVERY_RECOVER_MULTIPLE: 'recovery:recover-multiple',
  RECOVERY_DELETE_ORPHANED: 'recovery:delete-orphaned',
  // Events
  INSTANCE_RECOVERED: 'instance:recovered',
  ORPHANED_SESSIONS_FOUND: 'recovery:orphaned-found',

  // ==========================================================================
  // REPO CLEANUP CHANNELS
  // ==========================================================================
  CLEANUP_ANALYZE: 'cleanup:analyze',
  CLEANUP_EXECUTE: 'cleanup:execute',
  CLEANUP_QUICK: 'cleanup:quick',
  CLEANUP_KANVAS: 'cleanup:kanvas',
  // Events
  CLEANUP_PROGRESS: 'cleanup:progress',

  // ==========================================================================
  // GIT REBASE CHANNELS
  // ==========================================================================
  GIT_FETCH: 'git:fetch',
  GIT_CHECK_REMOTE: 'git:check-remote',
  GIT_REBASE: 'git:rebase',
  GIT_PERFORM_REBASE: 'git:perform-rebase',
  GIT_LIST_WORKTREES: 'git:list-worktrees',
  GIT_PRUNE_WORKTREES: 'git:prune-worktrees',
  GIT_DELETE_BRANCH: 'git:delete-branch',
  GIT_MERGED_BRANCHES: 'git:merged-branches',
  GIT_GET_CHANGED_FILES: 'git:get-changed-files',
  GIT_GET_FILES_WITH_STATUS: 'git:get-files-with-status',
  GIT_GET_DIFF_SUMMARY: 'git:get-diff-summary',

  // ==========================================================================
  // COMMIT HISTORY CHANNELS
  // Get commit history and detailed diffs for session tracking
  // ==========================================================================
  GIT_GET_COMMIT_HISTORY: 'git:get-commit-history',
  GIT_GET_COMMIT_DIFF: 'git:get-commit-diff',

  // ==========================================================================
  // REBASE WATCHER CHANNELS
  // Auto-rebase on remote changes (on-demand mode)
  // ==========================================================================
  REBASE_WATCHER_START: 'rebase-watcher:start',
  REBASE_WATCHER_STOP: 'rebase-watcher:stop',
  REBASE_WATCHER_PAUSE: 'rebase-watcher:pause',
  REBASE_WATCHER_RESUME: 'rebase-watcher:resume',
  REBASE_WATCHER_GET_STATUS: 'rebase-watcher:get-status',
  REBASE_WATCHER_FORCE_CHECK: 'rebase-watcher:force-check',
  REBASE_WATCHER_TRIGGER: 'rebase-watcher:trigger',
  REBASE_WATCHER_LIST: 'rebase-watcher:list',
  // Events (main → renderer)
  REBASE_WATCHER_STATUS: 'rebase-watcher:status',
  REBASE_WATCHER_STOPPED: 'rebase-watcher:stopped',
  REBASE_REMOTE_CHANGES_DETECTED: 'rebase:remote-changes-detected',
  REBASE_AUTO_COMPLETED: 'rebase:auto-completed',
  REBASE_ERROR_DETECTED: 'rebase:error-detected',

  // ==========================================================================
  // CONTRACT DETECTION CHANNELS
  // ==========================================================================
  CONTRACT_ANALYZE_COMMIT: 'contract:analyze-commit',
  CONTRACT_ANALYZE_RANGE: 'contract:analyze-range',
  CONTRACT_ANALYZE_STAGED: 'contract:analyze-staged',
  CONTRACT_GET_PATTERNS: 'contract:get-patterns',
  // Events
  CONTRACT_CHANGES_DETECTED: 'contract:changes-detected',

  // ==========================================================================
  // CONTRACT REGISTRY CHANNELS
  // JSON-based contract tracking at repo and feature levels
  // ==========================================================================
  REGISTRY_INIT: 'registry:init',
  REGISTRY_GET_REPO: 'registry:get-repo',
  REGISTRY_GET_FEATURE: 'registry:get-feature',
  REGISTRY_UPDATE_FEATURE: 'registry:update-feature',
  REGISTRY_LIST_FEATURES: 'registry:list-features',
  REGISTRY_RECORD_BREAKING: 'registry:record-breaking',
  // Feature organization config
  REGISTRY_GET_ORG_CONFIG: 'registry:get-org-config',
  REGISTRY_SET_ORG_CONFIG: 'registry:set-org-config',
  REGISTRY_NEEDS_SETUP: 'registry:needs-setup',
  // Events
  CONTRACT_REGISTRY_UPDATED: 'contract:registry-updated',
  BREAKING_CHANGE_DETECTED: 'contract:breaking-change',

  // ==========================================================================
  // CONTRACT GENERATION CHANNELS
  // Scan codebase and generate contract documentation
  // ==========================================================================
  CONTRACT_DISCOVER_FEATURES: 'contract:discover-features',
  CONTRACT_SAVE_DISCOVERED_FEATURES: 'contract:save-discovered-features',
  CONTRACT_LOAD_DISCOVERED_FEATURES: 'contract:load-discovered-features',
  CONTRACT_GENERATE_FEATURE: 'contract:generate-feature',
  CONTRACT_GENERATE_ALL: 'contract:generate-all',
  CONTRACT_GENERATE_SINGLE: 'contract:generate-single',
  CONTRACT_CANCEL_GENERATION: 'contract:cancel-generation',
  // New: Repo structure analysis and README generation
  CONTRACT_ANALYZE_REPO_STRUCTURE: 'contract:analyze-repo-structure',
  CONTRACT_GENERATE_README: 'contract:generate-readme',
  CONTRACT_ANALYZE_FEATURE_DEEP: 'contract:analyze-feature-deep',
  // Events
  CONTRACT_GENERATION_PROGRESS: 'contract:generation-progress',
  CONTRACT_GENERATION_COMPLETE: 'contract:generation-complete',
  CONTRACT_GENERATION_ERROR: 'contract:generation-error',

  // ==========================================================================
  // REPOSITORY ANALYSIS CHANNELS
  // AST parsing, code analysis, and intelligent contract generation
  // ==========================================================================
  ANALYSIS_SCAN_REPO: 'analysis:scan-repo',
  ANALYSIS_PARSE_FILE: 'analysis:parse-file',
  ANALYSIS_PARSE_FEATURE: 'analysis:parse-feature',
  ANALYSIS_ANALYZE_FEATURE: 'analysis:analyze-feature',
  ANALYSIS_ANALYZE_REPO: 'analysis:analyze-repo',
  ANALYSIS_BUILD_GRAPH: 'analysis:build-graph',
  ANALYSIS_GENERATE_CONTRACTS: 'analysis:generate-contracts',
  ANALYSIS_INCREMENTAL: 'analysis:incremental',
  ANALYSIS_GET_CACHE_STATS: 'analysis:get-cache-stats',
  ANALYSIS_CLEAR_CACHE: 'analysis:clear-cache',
  // Phase 2: Schema extraction
  ANALYSIS_EXTRACT_SCHEMAS: 'analysis:extract-schemas',
  ANALYSIS_EXTRACT_SCHEMA_FILE: 'analysis:extract-schema-file',
  // Phase 2: Event tracking
  ANALYSIS_EXTRACT_EVENTS: 'analysis:extract-events',
  ANALYSIS_EXTRACT_EVENTS_FILE: 'analysis:extract-events-file',
  ANALYSIS_GET_EVENT_FLOW: 'analysis:get-event-flow',
  // Phase 2: Dependency graph
  ANALYSIS_BUILD_FILE_GRAPH: 'analysis:build-file-graph',
  ANALYSIS_BUILD_FEATURE_GRAPH: 'analysis:build-feature-graph',
  ANALYSIS_GET_GRAPH_STATS: 'analysis:get-graph-stats',
  ANALYSIS_EXPORT_GRAPH_DOT: 'analysis:export-graph-dot',
  ANALYSIS_EXPORT_GRAPH_JSON: 'analysis:export-graph-json',
  // Phase 3: Infrastructure parsing
  ANALYSIS_PARSE_INFRA: 'analysis:parse-infra',
  ANALYSIS_PARSE_TERRAFORM: 'analysis:parse-terraform',
  ANALYSIS_PARSE_KUBERNETES: 'analysis:parse-kubernetes',
  ANALYSIS_PARSE_DOCKER_COMPOSE: 'analysis:parse-docker-compose',
  ANALYSIS_GET_INFRA_SUMMARY: 'analysis:get-infra-summary',
  // Events
  ANALYSIS_PROGRESS: 'analysis:progress',
  ANALYSIS_COMPLETE: 'analysis:complete',
  ANALYSIS_ERROR: 'analysis:error',

  // ==========================================================================
  // FILE SYSTEM CHANNELS
  // Read file content for in-app viewing
  // ==========================================================================
  FILE_READ_CONTENT: 'file:read-content',

  // ==========================================================================
  // SHELL/QUICK ACTION CHANNELS
  // ==========================================================================
  SHELL_OPEN_TERMINAL: 'shell:open-terminal',
  SHELL_OPEN_VSCODE: 'shell:open-vscode',
  SHELL_OPEN_FINDER: 'shell:open-finder',
  SHELL_COPY_PATH: 'shell:copy-path',

  // ==========================================================================
  // TERMINAL LOG CHANNELS
  // System-level logging for terminal view
  // ==========================================================================
  TERMINAL_LOG: 'terminal:log',
  TERMINAL_CLEAR: 'terminal:clear',
  TERMINAL_GET_LOGS: 'terminal:get-logs',

  // ==========================================================================
  // LOCK CHANGE EVENTS
  // Real-time file lock updates
  // ==========================================================================
  LOCK_CHANGED: 'lock:changed',
  LOCK_FORCE_RELEASE: 'lock:force-release',

  // ==========================================================================
  // MERGE WORKFLOW CHANNELS
  // ==========================================================================
  MERGE_PREVIEW: 'merge:preview',
  MERGE_EXECUTE: 'merge:execute',
  MERGE_ABORT: 'merge:abort',
  MERGE_CLEAN_UNTRACKED: 'merge:clean-untracked',     // Remove untracked files blocking merge
  MERGE_RESOLVE_BRANCH: 'merge:resolve-branch',       // Get actual active branch from worktree path

  // ==========================================================================
  // COMMIT ANALYSIS CHANNELS
  // AI-powered commit message generation from file diffs
  // ==========================================================================
  COMMIT_ANALYZE_STAGED: 'commit:analyze-staged',
  COMMIT_ANALYZE_COMMIT: 'commit:analyze-commit',
  COMMIT_GENERATE_MESSAGE: 'commit:generate-message',
  COMMIT_ENHANCE_MESSAGE: 'commit:enhance-message',
  COMMIT_SET_ENHANCED_ENABLED: 'commit:set-enhanced-enabled',
  COMMIT_GET_ENHANCED_ENABLED: 'commit:get-enhanced-enabled',

  // ==========================================================================
  // MERGE CONFLICT RESOLUTION CHANNELS
  // AI-powered conflict analysis and resolution with user approval
  // ==========================================================================
  CONFLICT_GET_FILES: 'conflict:get-files',
  CONFLICT_READ_FILE: 'conflict:read-file',
  CONFLICT_ANALYZE: 'conflict:analyze',
  CONFLICT_RESOLVE_FILE: 'conflict:resolve-file',
  CONFLICT_APPLY_RESOLUTION: 'conflict:apply-resolution',
  // Interactive workflow with user approval
  CONFLICT_GENERATE_PREVIEWS: 'conflict:generate-previews',    // Start rebase, return previews
  CONFLICT_APPLY_APPROVED: 'conflict:apply-approved',          // Apply user-approved resolutions
  CONFLICT_ABORT_REBASE: 'conflict:abort-rebase',              // Abort and revert
  CONFLICT_IS_REBASE_IN_PROGRESS: 'conflict:is-rebase-in-progress',
  // Backup branch management for safe auto-fix
  CONFLICT_CREATE_BACKUP: 'conflict:create-backup',            // Create backup_kit/<sessionId> branch
  CONFLICT_DELETE_BACKUP: 'conflict:delete-backup',            // Delete backup branch after success
  // Legacy auto-apply (use with caution)
  CONFLICT_REBASE_WITH_AI: 'conflict:rebase-with-ai',
  // Events
  CONFLICT_RESOLUTION_PROGRESS: 'conflict:resolution-progress',
  CONFLICT_RESOLUTION_COMPLETE: 'conflict:resolution-complete',
  CONFLICT_PREVIEWS_READY: 'conflict:previews-ready',          // Previews generated, awaiting approval
  CONFLICT_APPROVAL_REQUIRED: 'conflict:approval-required',    // User must review before applying

  // ==========================================================================
  // DEBUG LOG CHANNELS
  // ==========================================================================
  DEBUG_LOG_WRITE: 'debug-log:write',
  DEBUG_LOG_GET_RECENT: 'debug-log:get-recent',
  DEBUG_LOG_EXPORT: 'debug-log:export',
  DEBUG_LOG_CLEAR: 'debug-log:clear',
  DEBUG_LOG_GET_STATS: 'debug-log:get-stats',
  DEBUG_LOG_GET_PATH: 'debug-log:get-path',
  DEBUG_LOG_OPEN_FOLDER: 'debug-log:open-folder',

  // ==========================================================================
  // VERSION MANAGEMENT CHANNELS
  // ==========================================================================
  VERSION_GET: 'version:get',
  VERSION_BUMP: 'version:bump',
  VERSION_GET_SETTINGS: 'version:get-settings',
  VERSION_SET_SETTINGS: 'version:set-settings',

  // ==========================================================================
  // AUTO-UPDATE CHANNELS
  // ==========================================================================
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_GET_STATUS: 'update:get-status',
  // Events (main → renderer)
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_NOT_AVAILABLE: 'update:not-available',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',

  // ==========================================================================
  // WORKER PROCESS CHANNELS
  // Monitor utility process status and control
  // ==========================================================================
  WORKER_STATUS: 'worker:status',
  WORKER_RESTART: 'worker:restart',
  // Events (main → renderer)
  WORKER_STATUS_CHANGED: 'worker:status-changed',

  // ==========================================================================
  // MCP SERVER CHANNELS
  // ==========================================================================
  MCP_SERVER_STATUS: 'mcp:server-status',
  MCP_GET_CALL_LOG: 'mcp:get-call-log',
  // Events (main → renderer)
  MCP_SERVER_STARTED: 'mcp:server-started',
  MCP_TOOL_CALLED: 'mcp:tool-called',

  // ==========================================================================
  // SEED DATA CHANNELS
  // Generate seed contracts, merge into execution plan, and execute
  // ==========================================================================
  SEED_GENERATE_FEATURE: 'seed:generate-feature',
  SEED_GENERATE_ALL: 'seed:generate-all',
  SEED_MERGE_PLAN: 'seed:merge-plan',
  SEED_EXECUTE: 'seed:execute',
  SEED_GET_STATUS: 'seed:get-status',
  SEED_GET_PLAN: 'seed:get-plan',
  // Events
  SEED_PROGRESS: 'seed:progress',

  // ==========================================================================
  // STARTUP CHANNELS
  // Port discovery and startup orchestration
  // ==========================================================================
  STARTUP_DISCOVER_PORTS: 'startup:discover-ports',
  STARTUP_GET_PORTS: 'startup:get-ports',
  STARTUP_GET_STATUS: 'startup:get-status',
  // Events
  STARTUP_STATUS_CHANGED: 'startup:status-changed',

  // ==========================================================================
  // APP CHANNELS
  // ==========================================================================
  APP_GET_VERSION: 'app:getVersion',
  APP_RELOAD: 'app:reload',
  APP_QUIT: 'app:quit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// Channel groups for type-safe handler registration
export const REQUEST_CHANNELS = [
  IPC.SESSION_CREATE,
  IPC.SESSION_LIST,
  IPC.SESSION_GET,
  IPC.SESSION_CLOSE,
  IPC.SESSION_CLAIM,
  IPC.GIT_STATUS,
  IPC.GIT_COMMIT,
  IPC.GIT_PUSH,
  IPC.GIT_MERGE,
  IPC.GIT_BRANCHES,
  IPC.GIT_CREATE_WORKTREE,
  IPC.GIT_REMOVE_WORKTREE,
  IPC.GIT_DETECT_SUBMODULES,
  IPC.WATCHER_START,
  IPC.WATCHER_STOP,
  IPC.WATCHER_STATUS,
  IPC.LOCK_DECLARE,
  IPC.LOCK_RELEASE,
  IPC.LOCK_CHECK,
  IPC.LOCK_LIST,
  IPC.LOCK_FORCE_RELEASE,
  IPC.CONFIG_GET,
  IPC.CONFIG_SET,
  IPC.CONFIG_GET_ALL,
  IPC.CREDENTIAL_GET,
  IPC.CREDENTIAL_SET,
  IPC.CREDENTIAL_HAS,
  IPC.AI_CHAT,
  IPC.AI_CHAT_WITH_MODE,
  IPC.AI_LIST_MODES,
  IPC.AI_GET_MODE,
  IPC.AI_RELOAD_CONFIG,
  IPC.AI_GET_CONFIG_SOURCES,
  IPC.LOG_GET,
  IPC.LOG_CLEAR,
  IPC.DIALOG_OPEN_DIRECTORY,
  IPC.DIALOG_SHOW_MESSAGE,
  IPC.AGENT_LIST,
  IPC.AGENT_GET,
  IPC.AGENT_SESSIONS,
  IPC.AGENT_INITIALIZE,
  IPC.INSTANCE_CREATE,
  IPC.INSTANCE_VALIDATE_REPO,
  IPC.INSTANCE_INITIALIZE_KANVAS,
  IPC.INSTANCE_GET_INSTRUCTIONS,
  IPC.INSTANCE_LAUNCH,
  IPC.INSTANCE_LIST,
  IPC.INSTANCE_GET,
  IPC.INSTANCE_DELETE,
  IPC.INSTANCE_RESTART,
  IPC.RECENT_REPOS_LIST,
  IPC.RECENT_REPOS_ADD,
  IPC.RECENT_REPOS_REMOVE,
  IPC.INSTANCE_UPDATE_BASE_BRANCH,
  IPC.APP_GET_VERSION,
  IPC.APP_RELOAD,
  // Version management channels
  IPC.VERSION_GET,
  IPC.VERSION_BUMP,
  IPC.VERSION_GET_SETTINGS,
  IPC.VERSION_SET_SETTINGS,
  // Analysis channels
  IPC.ANALYSIS_SCAN_REPO,
  IPC.ANALYSIS_PARSE_FILE,
  IPC.ANALYSIS_PARSE_FEATURE,
  IPC.ANALYSIS_ANALYZE_FEATURE,
  IPC.ANALYSIS_ANALYZE_REPO,
  IPC.ANALYSIS_BUILD_GRAPH,
  IPC.ANALYSIS_GENERATE_CONTRACTS,
  IPC.ANALYSIS_INCREMENTAL,
  IPC.ANALYSIS_GET_CACHE_STATS,
  IPC.ANALYSIS_CLEAR_CACHE,
  // Phase 2: Schema extraction
  IPC.ANALYSIS_EXTRACT_SCHEMAS,
  IPC.ANALYSIS_EXTRACT_SCHEMA_FILE,
  // Phase 2: Event tracking
  IPC.ANALYSIS_EXTRACT_EVENTS,
  IPC.ANALYSIS_EXTRACT_EVENTS_FILE,
  IPC.ANALYSIS_GET_EVENT_FLOW,
  // Phase 2: Dependency graph
  IPC.ANALYSIS_BUILD_FILE_GRAPH,
  IPC.ANALYSIS_BUILD_FEATURE_GRAPH,
  IPC.ANALYSIS_GET_GRAPH_STATS,
  IPC.ANALYSIS_EXPORT_GRAPH_DOT,
  IPC.ANALYSIS_EXPORT_GRAPH_JSON,
  // Phase 3: Infrastructure parsing
  IPC.ANALYSIS_PARSE_INFRA,
  IPC.ANALYSIS_PARSE_TERRAFORM,
  IPC.ANALYSIS_PARSE_KUBERNETES,
  IPC.ANALYSIS_PARSE_DOCKER_COMPOSE,
  IPC.ANALYSIS_GET_INFRA_SUMMARY,
  // Merge workflow
  IPC.MERGE_PREVIEW,
  IPC.MERGE_EXECUTE,
  IPC.MERGE_ABORT,
  IPC.MERGE_CLEAN_UNTRACKED,
  IPC.MERGE_RESOLVE_BRANCH,
  // Merge conflict resolution
  IPC.CONFLICT_GET_FILES,
  IPC.CONFLICT_READ_FILE,
  IPC.CONFLICT_ANALYZE,
  IPC.CONFLICT_RESOLVE_FILE,
  IPC.CONFLICT_APPLY_RESOLUTION,
  IPC.CONFLICT_GENERATE_PREVIEWS,
  IPC.CONFLICT_APPLY_APPROVED,
  IPC.CONFLICT_ABORT_REBASE,
  IPC.CONFLICT_IS_REBASE_IN_PROGRESS,
  IPC.CONFLICT_REBASE_WITH_AI,
  IPC.CONFLICT_CREATE_BACKUP,
  IPC.CONFLICT_DELETE_BACKUP,
  // Auto-update channels
  IPC.UPDATE_CHECK,
  IPC.UPDATE_DOWNLOAD,
  IPC.UPDATE_INSTALL,
  IPC.UPDATE_GET_STATUS,
  // Worker process channels
  IPC.WORKER_STATUS,
  IPC.WORKER_RESTART,
  // MCP server channels
  IPC.MCP_SERVER_STATUS,
  IPC.MCP_GET_CALL_LOG,
  // Seed data channels
  IPC.SEED_GENERATE_FEATURE,
  IPC.SEED_GENERATE_ALL,
  IPC.SEED_MERGE_PLAN,
  IPC.SEED_EXECUTE,
  IPC.SEED_GET_STATUS,
  IPC.SEED_GET_PLAN,
  // Startup channels
  IPC.STARTUP_DISCOVER_PORTS,
  IPC.STARTUP_GET_PORTS,
  IPC.STARTUP_GET_STATUS,
] as const;

export const EVENT_CHANNELS = [
  IPC.SESSION_CREATED,
  IPC.SESSION_UPDATED,
  IPC.SESSION_CLOSED,
  IPC.CROSS_SESSION_OVERLAP_DETECTED,
  IPC.GIT_STATUS_CHANGED,
  IPC.FILE_CHANGED,
  IPC.COMMIT_TRIGGERED,
  IPC.COMMIT_COMPLETED,
  IPC.CONFLICT_DETECTED,
  IPC.LOCK_CHANGED,
  IPC.AI_STREAM_CHUNK,
  IPC.AI_STREAM_END,
  IPC.AI_STREAM_ERROR,
  IPC.LOG_ENTRY,
  IPC.AGENT_REGISTERED,
  IPC.AGENT_UNREGISTERED,
  IPC.AGENT_HEARTBEAT,
  IPC.AGENT_STATUS_CHANGED,
  IPC.SESSION_REPORTED,
  IPC.ACTIVITY_REPORTED,
  IPC.INSTANCE_STATUS_CHANGED,
  // Analysis events
  IPC.ANALYSIS_PROGRESS,
  IPC.ANALYSIS_COMPLETE,
  IPC.ANALYSIS_ERROR,
  // Conflict resolution events
  IPC.CONFLICT_RESOLUTION_PROGRESS,
  IPC.CONFLICT_RESOLUTION_COMPLETE,
  IPC.CONFLICT_PREVIEWS_READY,
  IPC.CONFLICT_APPROVAL_REQUIRED,
  // Auto-update events
  IPC.UPDATE_AVAILABLE,
  IPC.UPDATE_NOT_AVAILABLE,
  IPC.UPDATE_PROGRESS,
  IPC.UPDATE_DOWNLOADED,
  IPC.UPDATE_ERROR,
  // Worker process events
  IPC.WORKER_STATUS_CHANGED,
  // MCP server events
  IPC.MCP_SERVER_STARTED,
  IPC.MCP_TOOL_CALLED,
  // Seed data events
  IPC.SEED_PROGRESS,
  // Startup events
  IPC.STARTUP_STATUS_CHANGED,
] as const;
