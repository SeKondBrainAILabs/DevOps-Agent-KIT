/**
 * Shared type definitions for SeKondBrain Kanvas
 * Used by both main (Electron) and renderer (React) processes
 */

// =============================================================================
// SESSION TYPES
// =============================================================================

export type SessionStatus = 'idle' | 'active' | 'watching' | 'paused' | 'error' | 'closed';

export type AgentType = 'claude' | 'codex' | 'cursor' | 'copilot' | 'cline' | 'aider' | 'warp' | 'custom';

export interface Session {
  id: string;
  name: string;
  task: string;
  agentType: AgentType;
  status: SessionStatus;
  branchName: string;
  baseBranch: string; // The branch this session was created from (merge target)
  worktreePath: string;
  repoPath: string;
  created: string;
  updated: string;
  commitCount: number;
  lastCommit?: string;
  error?: string;
  repos?: RepoEntry[]; // Populated in multi-repo mode
}

export interface CreateSessionRequest {
  repoPath: string;
  task: string;
  agentType: AgentType;
  description?: string;
}

export interface CloseSessionRequest {
  sessionId: string;
  merge?: boolean;
  mergeTarget?: string;
  deleteRemote?: boolean;
}

// =============================================================================
// GIT TYPES
// =============================================================================

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitFileChange {
  path: string;
  status: FileStatus;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  changes: GitFileChange[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  lastCommit?: string;
}

/**
 * Extended commit info with file statistics
 * Used by CommitsTab for commit history display
 */
export interface GitCommitWithFiles extends GitCommit {
  filesChanged: number;
  additions: number;
  deletions: number;
  files?: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
  }>;
}

/**
 * Detailed diff information for a single commit
 * Used when expanding a commit to see file diffs
 */
export interface CommitDiffDetail {
  commit: GitCommitWithFiles;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    diff: string;
    language?: string;
  }>;
}

// =============================================================================
// FILE LOCK TYPES
// =============================================================================

export interface FileLock {
  sessionId: string;
  agentType: AgentType;
  files: string[];
  operation: 'edit' | 'read' | 'delete';
  declaredAt: string;
  estimatedDuration: number; // minutes
  reason?: string;
}

/** Per-file lock for auto-locking when agents modify files */
export interface AutoFileLock {
  filePath: string;           // Relative path from repo root
  sessionId: string;
  agentType: AgentType;
  repoPath: string;           // Repo this lock belongs to
  lockedAt: string;
  lastModified: string;       // Last time file was modified
  autoLocked: boolean;        // True if auto-locked by watcher
  branchName?: string;        // Branch where file is being modified
}

/** Summary of locks for a repository */
export interface RepoLockSummary {
  repoPath: string;
  totalLocks: number;
  locksBySession: Record<string, string[]>;  // sessionId -> file paths
  conflicts: FileConflict[];
}

/** Lock change event for real-time updates */
export interface LockChangeEvent {
  type: 'acquired' | 'released' | 'conflict' | 'force-released';
  lock: AutoFileLock;
  conflictWith?: AutoFileLock;  // Set if type is 'conflict'
}

export interface FileConflict {
  file: string;
  conflictsWith: string;
  session: string;
  reason: string;
  declaredAt: string;
}

// =============================================================================
// ACTIVITY LOG TYPES
// =============================================================================

export type LogType = 'success' | 'error' | 'warning' | 'info' | 'commit' | 'file' | 'git';

export interface ActivityLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  type: LogType;
  message: string;
  details?: Record<string, unknown>;
  commitHash?: string; // Linked when commit completes - identifies which commit included this activity
  filePath?: string; // If activity relates to a specific file
}

// =============================================================================
// WATCHER TYPES
// =============================================================================

export type FileChangeType = 'add' | 'change' | 'unlink';

export interface FileChangeEvent {
  sessionId: string;
  filePath: string;
  type: FileChangeType;
  timestamp: string;
  repoName?: string; // Which repo this change belongs to (multi-repo mode)
}

export interface CommitTriggerEvent {
  sessionId: string;
  message: string;
  timestamp: string;
}

export interface CommitCompleteEvent {
  sessionId: string;
  commitHash: string;
  message: string;
  filesChanged: number;
  timestamp: string;
  repoName?: string; // Which repo this commit belongs to (multi-repo mode)
}

// =============================================================================
// AI/CHAT TYPES
// =============================================================================

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  streaming?: boolean;
}

export interface ChatStreamChunk {
  sessionId: string;
  content: string;
  done: boolean;
}

// =============================================================================
// CONFIG TYPES
// =============================================================================

export interface AppConfig {
  theme: 'light' | 'dark' | 'system';
  defaultAgentType: AgentType;
  recentProjects: string[];
  autoWatch: boolean;
  autoPush: boolean;
  onboardingCompleted: boolean;
  /**
   * Telemetry opt-in (Epic O / story O5). Default `false` — the user must
   * explicitly opt-in. When `false`, no analytics or usage pings are sent.
   */
  telemetryOptIn: boolean;
  /**
   * Default landing view shown on app launch (Epic L / story L4).
   * One of 'morning-check' | 'workspace-browser' | 'last-visited'.
   */
  defaultLandingView: 'morning-check' | 'workspace-browser' | 'last-visited';
}

// =============================================================================
// WORKSPACE (Epic A — multi-workspace, multi-repo discovery)
// =============================================================================

/**
 * A user-defined root folder containing one or more repositories
 * (e.g. `/Users/x/work`). Workspaces can be added, renamed, removed.
 */
export interface Workspace {
  /** Stable ID (UUID-ish). Persisted across renames. */
  id: string;
  /** Human-friendly name; defaults to the basename of `path`. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Recursive scan depth (default 2). */
  scanDepth: number;
  /** Glob patterns to skip during scans (in addition to defaults). */
  ignoreGlobs: string[];
  /** ISO timestamp of when the workspace was added. */
  createdAt: string;
  /** ISO timestamp of the most-recent successful scan. */
  lastScannedAt?: string;
}

export interface WorkspaceCreateInput {
  path: string;
  name?: string;
  scanDepth?: number;
  ignoreGlobs?: string[];
}

export interface WorkspaceUpdateInput {
  name?: string;
  scanDepth?: number;
  ignoreGlobs?: string[];
}

/**
 * A repository discovered by `WorkspaceService.scanWorkspace` (story A2).
 * Each row maps to one Git repo found under a workspace folder.
 */
export interface DiscoveredRepo {
  /** Workspace this repo belongs to. */
  workspaceId: string;
  /** Absolute path to the repo root (the directory containing `.git`). */
  path: string;
  /** Basename of the repo path. */
  name: string;
  /** Depth at which this repo was discovered, relative to workspace root. */
  depth: number;
  /** ISO timestamp of discovery. */
  discoveredAt: string;
}

/**
 * Event fired by the WorkspaceService filesystem watcher (story A3).
 * Renderer subscribes via `window.api.workspace.onRepoChange(...)`.
 */
export interface WorkspaceRepoChangeEvent {
  workspaceId: string;
  kind: 'repo-added' | 'repo-removed';
  repoPath: string;
  depth: number;
  at: string;
}

/**
 * Project Group (Epic F / story F1).
 *
 * A user-defined logical grouping of repos (e.g. "Core Stack"). Persistent —
 * lives outside any individual session — so it can power cross-repo views,
 * branch-sync visualizers, and bulk actions.
 */
export interface ProjectGroup {
  id: string;
  name: string;
  /** Member repo paths (absolute). */
  repoPaths: string[];
  /** Optional UI accent color (hex string). */
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectGroupCreateInput {
  name: string;
  repoPaths: string[];
  color?: string;
}

export interface ProjectGroupUpdateInput {
  name?: string;
  repoPaths?: string[];
  color?: string;
}

/**
 * Branch row enriched with C7 hygiene metadata, surfaced by
 * `GitService.listBranchesForRepo(repoPath)` and consumed by the
 * BranchManagerPanel.
 */
export interface RepoBranchRow {
  name: string;
  /** True iff this is the currently checked-out branch. */
  isCurrent: boolean;
  /** Most recent commit timestamp on the branch (ms since epoch). */
  lastCommitMs: number;
  /** True iff the branch is fully merged into the default branch. */
  mergedIntoDefault: boolean;
  /** True iff the local branch's remote tracking ref is gone. */
  deletedOnRemote: boolean;
  /** True iff a worktree references this branch. */
  hasWorktree: boolean;
}

/**
 * Status block surfaced by `GitService.getRepoStatus(repoPath)` and
 * consumed by the RepoStatusCard renderer atom (Day 1.5).
 */
export interface RepoStatus {
  repoPath: string;
  currentBranch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  modifiedCount: number;
  stagedCount: number;
  untrackedCount: number;
  unmergedCount: number;
  stashCount: number;
  worktreeCount: number;
  /** Most recent commit info, if a log exists. */
  lastCommit?: {
    sha: string;
    shortSha: string;
    subject: string;
    authoredAt: string;
  };
  /** ISO timestamp when the snapshot was produced. */
  fetchedAt: string;
}

// =============================================================================
// STORAGE METRICS (Workspace Disk & Docker panel)
// =============================================================================

export interface DockerUsageBucket {
  sizeBytes: number;
  reclaimableBytes: number;
  /** Percentage (0-100) when available from Docker output, otherwise null. */
  reclaimablePercent: number | null;
}

export interface DockerUsageMetrics {
  available: boolean;
  error?: string;
  images: DockerUsageBucket;
  localVolumes: DockerUsageBucket;
  buildCache: DockerUsageBucket;
}

export interface LocalStorageRepoUsage {
  repoPath: string;
  bytes: number;
  /** Concrete directories included in this measurement. */
  paths: string[];
}
export interface AbandonedWorktreeUsage {
  repoPath: string;
  worktreePath: string;
  branch: string;
  bytes: number;
  exists: boolean;
  lastTouchedAt: string | null;
  daysSinceLastTouched: number | null;
  reason: 'missing-path' | 'stale-no-session';
}

export interface ReclaimableRepoUsage {
  repoPath: string;
  totalReclaimableBytes: number;
  nodeModulesBytes: number;
  pythonEnvsBytes: number;
  abandonedWorktreeBytes: number;
  abandonedWorktreeCount: number;
}

export interface LocalStorageUsageMetrics {
  scannedRepoCount: number;
  nodeModulesTotalBytes: number;
  pythonEnvsTotalBytes: number;
  nodeModulesByRepo: LocalStorageRepoUsage[];
  pythonEnvsByRepo: LocalStorageRepoUsage[];
  abandonedWorktrees: AbandonedWorktreeUsage[];
  reclaimableByRepo: ReclaimableRepoUsage[];
}

export interface StorageMetricsOverview {
  fetchedAt: string;
  docker: DockerUsageMetrics;
  local: LocalStorageUsageMetrics;
}

export interface WorkspaceScanResult {
  workspaceId: string;
  scannedAt: string;
  durationMs: number;
  repoCount: number;
  repos: DiscoveredRepo[];
}

// =============================================================================
// PER-REPO WORKSPACE SETTINGS
// =============================================================================

/**
 * Worktree mode for a repo.
 * - 'worktree' (default): each session gets an isolated git worktree;
 *   parallel sessions are allowed.
 * - 'in-place': agent works on a branch in the main repo (Docker hot-reload friendly);
 *   only ONE active session is permitted per repo (Single-Session Mode).
 */
export type WorktreeMode = 'in-place' | 'worktree';

export interface RepoWorkspaceConfig {
  repoPath: string;
  worktreeMode: WorktreeMode;
  lastUpdated: string;
}

export interface BranchManagementSettings {
  defaultMergeTarget: string;
  enableDualMerge: boolean;
  enableWeeklyConsolidation: boolean;
  orphanSessionThresholdDays: number;
  mergeStrategy: 'hierarchical-first' | 'target-first' | 'parallel';
  conflictResolution: 'prompt' | 'auto';
}

export interface Credentials {
  groqApiKey?: string;
  openaiApiKey?: string;
  updatedAt?: string;
}

// =============================================================================
// VERSION MANAGEMENT TYPES
// =============================================================================

export interface RepoVersionInfo {
  version: string;
  major: number;
  minor: number;
  patch: number;
}

export interface RepoVersionSettings {
  autoVersionBump: boolean;
}

// =============================================================================
// APP UPDATE TYPES
// =============================================================================

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress?: { percent: number; transferred: number; total: number };
  error?: string;
  releaseNotes?: string;
  releaseDate?: string;
}

// =============================================================================
// WORKTREE SAFETY INFO
// =============================================================================

export interface WorktreeSafetyInfo {
  worktreePath: string;
  hasUncommittedChanges: boolean;
  uncommittedFiles: Array<{ path: string; status: string }>;
  unmergedCommitCount: number;   // commits in worktree HEAD not in main or development
  mergedIntoBranches: string[];  // which of ['main','development'] contain the HEAD
}

/**
 * A session flagged as stale by the startup scan. A session is stale when its
 * worktree has been idle >= STALE_WORKTREE_DAYS and is fully committed (no
 * uncommitted/unstaged changes — those keep it active and visible in the
 * workspace view instead). `safeToDelete` is true when there are also no
 * unmerged commits, meaning removal cannot lose work; those are auto-removed.
 * Sessions with unmerged commits are surfaced to the user for confirmation.
 */
export interface StaleSessionInfo {
  sessionId: string;
  repoPath: string;
  repoName: string;
  branchName: string;
  worktreePath: string;
  daysIdle: number;
  unmergedCommitCount: number;   // committed-but-unmerged work that removal would orphan
  mergedIntoBranches: string[];  // which of ['main','development'] already contain HEAD
  safeToDelete: boolean;         // !hasUncommittedChanges && unmergedCommitCount === 0
}

// =============================================================================
// IPC RESULT TYPES
// =============================================================================

export interface IpcResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Helper type for extracting data from IpcResult
export type ExtractData<T> = T extends IpcResult<infer U> ? U : never;

// =============================================================================
// AGENT INSTANCE TYPES
// For creating new agent instances from Kanvas dashboard
// =============================================================================

export type InstanceStatus = 'pending' | 'initializing' | 'waiting' | 'active' | 'error';

export type RebaseFrequency = 'never' | 'daily' | 'weekly' | 'on-demand';

export interface AgentInstanceConfig {
  repoPath: string;
  agentType: AgentType;
  taskDescription: string;
  branchName: string;
  baseBranch: string;
  /**
   * @deprecated Derived from `isolation` as of the MCP session-lifecycle epic.
   * Still required and still written for one release: it is non-optional
   * today, constructed by the wizard and by restartInstance, and
   * `migrateUseWorktreeFlag` rewrites drifted rows on every launch. Removing
   * it in the same change as the isolation work would have meant touching all
   * of those at once.
   */
  useWorktree: boolean;
  autoCommit: boolean;
  commitInterval: number;
  // Extended configuration
  rebaseFrequency: RebaseFrequency;
  systemPrompt: string;
  contextPreservation: string;
  // Multi-repo mode (optional, advanced)
  multiRepo?: MultiRepoConfig;
  // Custom agent: whether the agent supports MCP
  customMcpEnabled?: boolean;
  // Optional: fire a GitHub Action when this session is merged (see MergeActionConfig).
  mergeAction?: MergeActionConfig;
  /**
   * Who created this session. Absent means a record written before the field
   * existed, i.e. a human's — so it is treated as 'ui' everywhere, which keeps
   * legacy sessions out of the agent concurrency budget and out of reach of an
   * agent's close permissions.
   *
   * (A1 adds the rest of the lineage/isolation fields; this one lands with G1
   * because the admission guard is its first consumer.)
   */
  createdBy?: 'ui' | 'mcp' | 'adopted';
  /** The session that asked for this one, when an agent spawned it. */
  parentSessionId?: string;
  /**
   * 'observer' sessions own NO worktree — they borrow `observedPath` and every
   * write tool refuses for them. Absent means 'worktree' (a normal session).
   */
  isolation?: 'worktree' | 'observer';
  /** Observer only: the directory being borrowed. Never a worktree it owns. */
  observedPath?: string;
  /** Observer only: the session whose worktree is borrowed, if any. */
  observerOfSessionId?: string;
  /**
   * Requested lifetime in minutes, from `kit_start_session(ttl_minutes)`.
   * Materialised onto the instance as `expiresAt` at creation. The reaper
   * treats it as a HARD ceiling; the idle TTL applies independently and is
   * usually what fires first.
   */
  ttlMinutes?: number;
}

/**
 * Configures a GitHub Action to fire when a session is merged. Currently the
 * "tag-push" mechanism: KIT creates and pushes a version tag (e.g.
 * "SDDMini-KH/v3.23.41") whose push triggers the workflow. The version is
 * auto-incremented (patch) from the latest existing tag with the same prefix.
 */
export interface MergeActionConfig {
  enabled: boolean;
  type: 'tag-push';
  /** Tag prefix up to and including the leading "v", e.g. "SDDMini-KH/v". */
  tagPrefix: string;
  /** How to bump the version from the latest tag. Patch only for now. */
  versionBump: 'patch';
}

export interface AgentInstance {
  id: string;
  config: AgentInstanceConfig;
  status: InstanceStatus;
  createdAt: string;
  instructions?: string;
  prompt?: string; // The comprehensive prompt to copy to the coding agent
  sessionId?: string;
  worktreePath?: string; // Path to isolated worktree (local_deploy/{branchName})
  error?: string;
  multiRepoEntries?: RepoEntry[]; // Populated repos with worktree paths (multi-repo mode)
  /**
   * Ordered chain of sessionIds this instance has replaced via restart. The
   * most recent predecessor is the last element; the oldest is first. Used by
   * `backfillMcpCallsByLineage` to repatriate orphaned `mcp_calls` rows that
   * would otherwise be invisible after the predecessor records are purged by
   * `purgeInstancesOnBranch`. Empty/missing for instances created before
   * v2.6.59 — no recovery is possible for those without lineage data.
   */
  predecessorSessionIds?: string[];
  /**
   * How this session's worktree was obtained. 'failed' means worktree creation
   * did not succeed and the session is running directly in the source repo —
   * previously indistinguishable from a normal session.
   */
  worktreeStatus?: 'created' | 'reused' | 'legacy' | 'observer' | 'failed';
  /**
   * Non-fatal problems hit while provisioning the worktree (env symlink,
   * pre-commit hook, KIT directory). Previously swallowed to console.warn and
   * invisible to any headless caller.
   */
  worktreeWarnings?: string[];
  /**
   * Set by `detectStaleRebases` startup scan when the worktree's gitdir has a
   * `rebase-merge` or `rebase-apply` directory older than the stale threshold
   * (default 6h). Cleared automatically when the gitdir no longer has rebase
   * state. Renderer surfaces this as a banner with an "Abort + back up" button
   * wired to the `INSTANCE_REPAIR_STALE_REBASE` IPC handler.
   */
  staleRebase?: {
    detectedAt: string;     // when the scan flagged it
    startedAt: string;      // mtime of rebase-merge/apply dir
    kind: 'merge' | 'apply';
    ageMinutes: number;     // age at detection time
    gitDir: string;         // absolute path to the rebase-* dir, for repair
  };
  /**
   * When `markSessionClosed` ran. Set for both a safe close (worktree and
   * branch retained) and the destructive path.
   *
   * These two fields were assigned by `markSessionClosed` before they were
   * declared here, which type-checked as an error the build never surfaced —
   * electron-vite compiles with esbuild and does not check types. See
   * `scripts/typecheck-gate.sh`.
   */
  closedAt?: string;
  /** Free text: 'task complete', 'reaped: idle 4h', 'app_quit', ... */
  closeReason?: string;
  /**
   * Hard deadline for the reaper (R1), ISO-8601. Set at creation from
   * `config.ttlMinutes`. Absent means the idle TTL alone applies.
   */
  expiresAt?: string;
  /**
   * User has pinned this session: the reaper skips it entirely, whatever its
   * age or idleness. Set from the session row menu (R2).
   */
  pinned?: boolean;
  /**
   * Set when the reaper acted on this session, so the expiry dialog can show
   * what happened and the pass is not repeated. Absent means never reaped.
   */
  reapedAt?: string;
}

/**
 * One line in the agent-session expiry dialog (R2): what the reaper did to a
 * session whose TTL ran out, and what is still recoverable.
 */
export interface ExpiredAgentSessionInfo {
  sessionId: string;
  branchName?: string;
  repoPath?: string;
  worktreePath?: string;
  taskDescription?: string;
  /** Why it expired: idle TTL, hard ceiling, or an explicit expiresAt. */
  reasonCode: string;
  /** What was actually done. Only 'delete-clean' removed anything. */
  action: 'delete-observer' | 'delete-clean' | 'snapshot-and-close' | 'teardown-only';
  detail: string;
  idleMinutes: number;
  /** Set when uncommitted work was pinned to a ref before closing. */
  snapshotRef?: string;
  worktreeDeleted: boolean;
  localBranchDeleted: boolean;
}

// =============================================================================
// MULTI-REPO SESSION TYPES
// =============================================================================

export type RepoRole = 'primary' | 'secondary';

export interface RepoEntry {
  repoPath: string;           // Absolute path to repo root
  repoName: string;           // basename (e.g., "DevOpsAgent")
  branchName: string;         // primary: user-specified, secondary: From_{PrimaryRepoName}_{DDMMYY}
  baseBranch: string;         // Branch to merge back to
  worktreePath: string;       // Primary: set after worktree creation. Secondary: submodule path within primary worktree
  role: RepoRole;
  isSubmodule: boolean;
}

export interface MultiRepoConfig {
  primaryRepo: RepoEntry;
  secondaryRepos: RepoEntry[];
  commitScope: 'all' | 'per-repo'; // User preference from wizard
}

/** Generate secondary repo branch name: Upgrade_From_{PrimaryRepoName} */
export function generateSecondaryBranchName(primaryRepoName: string): string {
  return `Upgrade_From_${primaryRepoName}`;
}

export interface RepoValidation {
  isValid: boolean;
  isGitRepo: boolean;
  repoName: string;
  currentBranch: string;
  remoteUrl?: string;
  hasKanvasDir: boolean;
  branches: string[];
  error?: string;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastUsed: string;
  agentCount: number;
}

export interface KanvasConfig {
  version: string;
  repoPath: string;
  initialized: string;
  settings: {
    autoCommit: boolean;
    commitInterval: number;
    watchPatterns: string[];
    ignorePatterns: string[];
  };
}

// =============================================================================
// CONTRACT TYPES
// Matches House_Rules_Contracts/ structure
// Categories: API, Schema, Events (Feature Bus), CSS, Features
// =============================================================================

/**
 * Contract categories matching House_Rules_Contracts/ structure
 * - api: API endpoints (openapi, graphql, protobuf, REST routes)
 * - schema: Database schemas, TypeScript types, JSON schemas
 * - events: Event bus / pub-sub events (Feature Bus)
 * - css: Styles, themes, design tokens
 * - features: Feature flags and toggles
 * - infra: Infrastructure contracts
 * - integrations: Third-party service integrations
 * - admin: Admin capabilities - what can be administered for this feature
 * - sql: Reusable SQL queries, stored procedures, performance hints
 */
export type ContractType = 'api' | 'schema' | 'events' | 'css' | 'features' | 'infra' | 'integrations' | 'e2e' | 'unit' | 'integration' | 'fixtures' | 'admin' | 'sql' | 'prompts' | 'seed';

export type ContractStatus = 'active' | 'modified' | 'deprecated' | 'breaking' | 'beta';

/**
 * Base contract interface matching House_Rules_Contracts format
 */
export interface Contract {
  id: string;
  type: ContractType;
  name: string;
  description?: string;
  filePath: string;
  status: ContractStatus;
  version: string;
  lastUpdated: string;
  modifiedBy?: string; // agent or session that modified it
  breaking?: boolean; // true if changes break compatibility
  changeLog?: ContractChangeLogEntry[];
}

export interface ContractChangeLogEntry {
  date: string;
  version: string;
  agent: string;
  changes: string;
  impact: 'breaking' | 'non-breaking' | 'documentation';
}

/**
 * API Contract - matches API_CONTRACT.md structure
 * Covers: OpenAPI, GraphQL, Protobuf, REST endpoints
 */
export interface APIContract extends Contract {
  type: 'api';
  baseUrl?: string;
  apiVersion?: string;
  endpoints?: APIEndpoint[];
}

export interface APIEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description?: string;
  authRequired: boolean;
  roles?: string[];
  rateLimit?: string;
}

/**
 * Schema Contract - matches DATABASE_SCHEMA_CONTRACT.md structure
 * Covers: Database migrations, TypeScript types, JSON Schema, Prisma, Drizzle
 */
export interface SchemaContract extends Contract {
  type: 'schema';
  schemaType: 'database' | 'graphql' | 'json' | 'typescript' | 'prisma' | 'protobuf';
  tables?: string[];
  types?: string[];
}

/**
 * Events Contract - matches EVENTS_CONTRACT.md structure
 * Feature Bus / pub-sub event definitions
 */
export interface EventsContract extends Contract {
  type: 'events';
  events?: EventDefinition[];
}

export interface EventDefinition {
  name: string;
  producer: string;
  consumers?: string[];
  schemaRef?: string; // reference to schema file
  deliverySemantics?: 'at-least-once' | 'exactly-once' | 'at-most-once';
}

/**
 * CSS Contract - for design tokens, themes, styles
 */
export interface CSSContract extends Contract {
  type: 'css';
  scope: 'global' | 'component' | 'theme';
  variables?: string[];
  breakpoints?: Record<string, string>;
  colorTokens?: string[];
}

/**
 * Features Contract - matches FEATURES_CONTRACT.md structure
 * Feature flags and toggles
 */
export interface FeaturesContract extends Contract {
  type: 'features';
  flags?: FeatureFlag[];
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  conditions?: string[];
  rolloutPercentage?: number;
}

/**
 * Infrastructure Contract - matches INFRA_CONTRACT.md
 */
export interface InfraContract extends Contract {
  type: 'infra';
  services?: string[];
  environment?: string;
}

/**
 * Third-party Integrations Contract - matches THIRD_PARTY_INTEGRATIONS.md
 */
export interface IntegrationsContract extends Contract {
  type: 'integrations';
  provider?: string;
  apiVersion?: string;
  sdkVersion?: string;
}

/**
 * Admin Contract - defines what can be administered for this feature
 * Used for building admin panels and management interfaces
 */
export interface AdminContract extends Contract {
  type: 'admin';
  adminCapabilities?: AdminCapability[];
  requiredPermissions?: string[];
  adminRoutes?: APIEndpoint[];
}

export interface AdminCapability {
  name: string;
  description?: string;
  entityType: string; // e.g., 'user', 'post', 'organization'
  operations: ('create' | 'read' | 'update' | 'delete' | 'list' | 'search' | 'export' | 'import' | 'bulk_update' | 'archive')[];
  permissions?: string[];
  fields?: AdminField[];
}

export interface AdminField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'json';
  editable: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  required?: boolean;
  validation?: string;
}

/**
 * Seed Data Contract - defines seed/fixture data for a feature
 * Used for database seeding, test data generation, and startup initialization
 */
export interface SeedDataContract extends Contract {
  type: 'seed';
  tables: string[];
  records: SeedRecord[];
  order: number;
  idempotent: boolean;
  environment: SeedEnvironment[];
}

export type SeedEnvironment = 'dev' | 'staging' | 'test' | 'production';

export interface SeedRecord {
  table: string;
  data: Record<string, unknown>[];
  dependencies: string[]; // Table names this record depends on
  idempotencyKey?: string; // Column(s) used for upsert
}

/**
 * Merged seed execution plan — output of merging all per-feature seed contracts
 */
export interface SeedExecutionPlan {
  metadata: {
    generatedAt: string;
    totalOperations: number;
    totalTables: number;
    totalFeatures: number;
    checksum: string;
    schemaValidation?: {
      valid: boolean;
      warnings: string[];
      errors: string[];
    };
  };
  operations: SeedOperation[];
  rollback: SeedRollbackStep[];
}

export interface SeedOperation {
  table: string;
  data: Record<string, unknown>[];
  featureSource: string;
  dependencies: string[];
  checksum: string;
  idempotencyKey?: string;
  environment: SeedEnvironment[];
}

export interface SeedRollbackStep {
  table: string;
  action: 'truncate' | 'delete-where';
  featureSource: string;
}

/**
 * Startup port binding — discovered free ports for services
 */
export interface PortBinding {
  serviceName: string;
  port: number;
  preferredPort?: number;
}

export interface StartupStatus {
  status: 'pending' | 'discovering-ports' | 'seeding' | 'ready' | 'failed';
  ports: PortBinding[];
  seedProgress?: {
    total: number;
    completed: number;
    currentTable: string;
    currentFeature: string;
    errors: string[];
  };
  error?: string;
}

export type AnyContract =
  | APIContract
  | SchemaContract
  | EventsContract
  | CSSContract
  | FeaturesContract
  | InfraContract
  | IntegrationsContract
  | AdminContract
  | SeedDataContract;

/**
 * Contract file change detection result
 * From ContractDetectionService
 */
export interface ContractFileChange {
  file: string;
  type: 'openapi' | 'graphql' | 'protobuf' | 'database' | 'typescript' | 'jsonSchema' | 'apiRoutes' | 'config';
  changeType: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  impactLevel: 'breaking' | 'non-breaking' | 'unknown';
  details?: string;
}

// =============================================================================
// TERMINAL LOG TYPES
// System-level logging for terminal view
// =============================================================================

export type TerminalLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'git' | 'system';

export interface TerminalLogEntry {
  id: string;
  timestamp: string;
  level: TerminalLogLevel;
  message: string;
  sessionId?: string;
  source?: string; // e.g., 'GitService', 'WatcherService', 'LockService'
  command?: string; // For git commands
  output?: string; // Command output
  exitCode?: number; // For commands
  duration?: number; // ms
}

// =============================================================================
// MERGE PREVIEW TYPES
// =============================================================================

export interface MergePreview {
  sourceBranch: string;
  targetBranch: string;
  canMerge: boolean;
  hasConflicts: boolean;
  conflictingFiles: string[];
  filesChanged: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted';
  }>;
  commitCount: number;
  aheadBy: number;
  behindBy: number;
  /** Untracked files blocking the merge (can be auto-cleaned) */
  untrackedBlockingFiles?: string[];
  /** Human-readable description of the blocking error */
  blockingError?: string;
  /** Files being merged that are also locked by other active sessions */
  crossSessionOverlaps?: Array<{ file: string; sessionId: string }>;
}

export interface MergeResult {
  success: boolean;
  message: string;
  mergeCommitHash?: string;
  filesChanged?: number;
  conflictingFiles?: string[];
  /** Whether stashed files were successfully recovered after merge */
  stashRecovered?: boolean;
  /** Files that could not be recovered from stash due to unresolvable conflicts */
  stashConflictFiles?: string[];
  /** S9N-6394: reason the merge gate blocked the operation, when it did. */
  gateReason?: 'CI_RED' | 'CI_PENDING' | 'WIP_COMMITS' | 'GH_UNAVAILABLE' | 'CI_UNKNOWN';
  /** S9N-6394: raw payload from the gate (failing checks, WIP shas, etc.). */
  gateDetails?: unknown;
}

// =============================================================================
// HEARTBEAT TYPES
// =============================================================================

export interface HeartbeatStatus {
  sessionId: string;
  agentId?: string;
  lastHeartbeat: string | null;
  isConnected: boolean;
  connectionDuration?: number; // seconds since first heartbeat
  missedHeartbeats: number;
}

// =============================================================================
// CONTRACT GENERATION TYPES
// For scanning codebases and generating contract documentation
// =============================================================================

/**
 * A feature discovered during codebase scan
 */
export interface DiscoveredFeature {
  name: string;
  description?: string; // AI-generated description of the feature
  basePath: string;
  specificFiles?: string[]; // AI-identified specific files for this feature (filters what gets scanned)
  files: {
    api: string[];      // API routes, OpenAPI, GraphQL, etc.
    schema: string[];   // Types, interfaces, database schemas
    tests: {
      e2e: string[];
      unit: string[];
      integration: string[];
    };
    fixtures: string[];
    config: string[];
    css: string[];      // CSS, SCSS, style files
    prompts: string[];  // Prompt templates, skill configs, mode YAML files
    other: string[];
  };
  contractPatternMatches: number; // How many contract patterns matched
}

/**
 * Options for contract generation
 */
export interface ContractGenerationOptions {
  includeCodeSamples?: boolean;
  maxFilesPerFeature?: number;
  skipExisting?: boolean;
  features?: string[]; // Generate only specific features by name (empty = all)
  useAI?: boolean; // Use LLM to intelligently identify actual features (not just folders)
  preDiscoveredFeatures?: DiscoveredFeature[]; // Use pre-discovered features instead of re-discovering
  forceRefresh?: boolean; // If true, regenerate all contracts ignoring diffs (default: false = incremental)
}

/**
 * Progress during batch contract generation
 */
export interface ContractGenerationProgress {
  total: number;
  completed: number;
  currentFeature: string;
  currentStep: 'discovering' | 'analyzing' | 'generating' | 'saving';
  contractType?: 'markdown' | 'json' | 'admin'; // Which contract type is being generated
  errors: string[];
}

/**
 * Result of generating a single feature's contract
 */
export interface GeneratedContractResult {
  feature: string;
  success: boolean;
  markdownPath?: string;
  jsonPath?: string;
  error?: string;
}

/**
 * Result of batch contract generation
 */
export interface BatchContractGenerationResult {
  totalFeatures: number;
  generated: number;
  skipped: number;
  failed: number;
  results: GeneratedContractResult[];
  duration: number; // ms
}

/**
 * Generated contract JSON structure (saved to registry)
 */
export interface GeneratedContractJSON {
  feature: string;
  version: string;
  lastGenerated: string;
  generatorVersion: string;
  overview: string;
  apis: {
    endpoints: Array<{
      method: string;
      path: string;
      description: string;
      authRequired?: boolean;
    }>;
    exports: Array<{
      name: string;
      type: 'function' | 'type' | 'interface' | 'class' | 'const';
      file: string;
    }>;
  };
  schemas: Array<{
    name: string;
    type: 'interface' | 'type' | 'enum' | 'database';
    file: string;
  }>;
  dependencies: string[];
  testCoverage: {
    e2e: { count: number; files: string[] };
    unit: { count: number; files: string[] };
    integration: { count: number; files: string[] };
  };
  breakingChangeFiles: string[];
  sourceFiles: string[];
}
