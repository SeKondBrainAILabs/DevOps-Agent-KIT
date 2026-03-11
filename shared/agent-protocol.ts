/**
 * Agent-to-Kanvas Communication Protocol
 *
 * SeKondBrain Kanvas is a DASHBOARD that agents report into.
 * Agents (DevOps Agent, AI Agents, etc.) are separate processes that:
 * 1. Register with Kanvas when they start
 * 2. Send status updates and activity logs
 * 3. Receive commands from Kanvas (optional)
 *
 * Communication happens via:
 * - File-based messaging (session lock files, activity logs)
 * - IPC for local agents
 * - WebSocket for remote agents (future)
 */

import type { AgentType, LogType, SessionStatus } from './types';

// =============================================================================
// AGENT REGISTRATION
// =============================================================================

export interface AgentInfo {
  agentId: string;
  agentType: AgentType;
  agentName: string;
  version: string;
  pid: number;
  startedAt: string;
  capabilities: AgentCapability[];
}

export type AgentCapability =
  | 'file-watching'
  | 'auto-commit'
  | 'code-generation'
  | 'code-review'
  | 'chat'
  | 'test-execution'
  | 'deployment';

// =============================================================================
// AGENT STATUS UPDATES
// =============================================================================

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';

export interface AgentStatusUpdate {
  agentId: string;
  sessionId: string;
  status: AgentStatus;
  currentTask?: string;
  progress?: number; // 0-100
  timestamp: string;
}

// =============================================================================
// ACTIVITY REPORTS
// =============================================================================

export interface AgentActivityReport {
  agentId: string;
  sessionId: string;
  type: LogType;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

// =============================================================================
// FILE CHANGE REPORTS
// =============================================================================

export interface FileChangeReport {
  agentId: string;
  sessionId: string;
  filePath: string;
  changeType: 'add' | 'modify' | 'delete';
  timestamp: string;
}

// =============================================================================
// COMMIT REPORTS
// =============================================================================

export interface CommitReport {
  agentId: string;
  sessionId: string;
  commitHash: string;
  shortHash: string;
  message: string;
  filesChanged: string[];
  timestamp: string;
}

// =============================================================================
// SESSION REPORTS
// =============================================================================

export interface SessionReport {
  sessionId: string;
  agentId: string;
  agentType: AgentType;
  task: string;
  branchName: string;
  baseBranch: string; // The branch this session was created from (merge target)
  worktreePath: string;
  repoPath: string;
  status: SessionStatus;
  created: string;
  updated: string;
  commitCount: number;
  lastCommit?: string;
  // Multi-repo session support
  repos?: Array<{
    repoName: string;
    repoPath: string;
    worktreePath: string;
    branchName: string;
    role: 'primary' | 'secondary';
  }>;
}

// =============================================================================
// KANVAS COMMANDS (sent to agents)
// =============================================================================

export type KanvasCommand =
  | { type: 'start-watching' }
  | { type: 'stop-watching' }
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export interface KanvasCommandMessage {
  commandId: string;
  sessionId: string;
  agentId: string;
  command: KanvasCommand;
  timestamp: string;
}

// =============================================================================
// FILE-BASED MESSAGING PATHS
// Per-repo installation directory: .S9N_KIT_DevOpsAgent
// =============================================================================

/**
 * DevOps Agent Kit directory structure (per-repo)
 *
 * .S9N_KIT_DevOpsAgent/
 * ├── agents/           # Agent registration files
 * ├── sessions/         # Session status files
 * ├── activity/         # Activity logs
 * ├── commands/         # Kanvas -> Agent commands
 * ├── heartbeats/       # Agent heartbeat files
 * ├── coordination/     # File locking/coordination
 * │   ├── active-edits/
 * │   └── completed-edits/
 * ├── config.json       # Repo-specific config
 * └── houserules.md     # Optional: team-shared rules (can be committed)
 */
export const DEVOPS_KIT_DIR = '.S9N_KIT_DevOpsAgent';

export const KANVAS_PATHS = {
  // Base directory for all DevOps Agent data
  baseDir: DEVOPS_KIT_DIR,

  // Agent registration files
  agents: `${DEVOPS_KIT_DIR}/agents`,

  // Session status files
  sessions: `${DEVOPS_KIT_DIR}/sessions`,

  // Activity log files
  activity: `${DEVOPS_KIT_DIR}/activity`,

  // Command files (Kanvas -> Agent)
  commands: `${DEVOPS_KIT_DIR}/commands`,

  // Heartbeat files
  heartbeats: `${DEVOPS_KIT_DIR}/heartbeats`,

  // Config file
  config: `${DEVOPS_KIT_DIR}/config.json`,

  // House rules (optional, can be committed)
  houserules: `${DEVOPS_KIT_DIR}/houserules.md`,
} as const;

// File coordination paths (for multi-agent file locking)
// Now nested under the main DevOps Kit directory
export const FILE_COORDINATION_PATHS = {
  // Base directory for file coordination
  baseDir: `${DEVOPS_KIT_DIR}/coordination`,

  // Active file edit declarations
  activeEdits: `${DEVOPS_KIT_DIR}/coordination/active-edits`,

  // Completed edit records (moved here when session ends)
  completedEdits: `${DEVOPS_KIT_DIR}/coordination/completed-edits`,
} as const;

// House Rules Contracts paths
export const CONTRACTS_PATHS = {
  // Base directory for contracts
  baseDir: 'House_Rules_Contracts',

  // Individual contract files (matches UI contract type tabs)
  api: 'House_Rules_Contracts/API_CONTRACT.md',
  schema: 'House_Rules_Contracts/DATABASE_SCHEMA_CONTRACT.md',
  events: 'House_Rules_Contracts/EVENTS_CONTRACT.md',
  features: 'House_Rules_Contracts/FEATURES_CONTRACT.md',
  infra: 'House_Rules_Contracts/INFRA_CONTRACT.md',
  integrations: 'House_Rules_Contracts/THIRD_PARTY_INTEGRATIONS.md',
  admin: 'House_Rules_Contracts/ADMIN_CONTRACT.md',
  sql: 'House_Rules_Contracts/SQL_CONTRACT.md',
  css: 'House_Rules_Contracts/CSS_CONTRACT.md',
  prompts: 'House_Rules_Contracts/PROMPTS_CONTRACT.md',
  // Test contracts (populated dynamically from feature analysis, not generated files)
  e2e: 'House_Rules_Contracts/E2E_TESTS_CONTRACT.md',
  unit: 'House_Rules_Contracts/UNIT_TESTS_CONTRACT.md',
  integration: 'House_Rules_Contracts/INTEGRATION_TESTS_CONTRACT.md',
  fixtures: 'House_Rules_Contracts/FIXTURES_CONTRACT.md',
  seed: 'House_Rules_Contracts/SEED_DATA_CONTRACT.md',
} as const;

// MCP config file (auto-generated per session for MCP-capable agents)
export const MCP_CONFIG_FILE = '.mcp.json';

// Folder structure file (separate from houserules — lives at repo root)
export const FOLDER_STRUCTURE_FILE = 'FOLDER_STRUCTURE.md';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getAgentFilePath(baseDir: string, agentId: string): string {
  return `${baseDir}/${KANVAS_PATHS.agents}/${agentId}.json`;
}

export function getSessionFilePath(baseDir: string, sessionId: string): string {
  return `${baseDir}/${KANVAS_PATHS.sessions}/${sessionId}.json`;
}

export function getActivityFilePath(baseDir: string, sessionId: string): string {
  return `${baseDir}/${KANVAS_PATHS.activity}/${sessionId}.log`;
}

export function getCommandFilePath(baseDir: string, sessionId: string): string {
  return `${baseDir}/${KANVAS_PATHS.commands}/${sessionId}.cmd`;
}

export function getHeartbeatFilePath(baseDir: string, agentId: string): string {
  return `${baseDir}/${KANVAS_PATHS.heartbeats}/${agentId}.beat`;
}

// File coordination helpers
export function getFileCoordinationDir(baseDir: string): string {
  return `${baseDir}/${FILE_COORDINATION_PATHS.baseDir}`;
}

export function getActiveEditsDir(baseDir: string): string {
  return `${baseDir}/${FILE_COORDINATION_PATHS.activeEdits}`;
}

export function getActiveEditFilePath(baseDir: string, agentType: string, sessionId: string): string {
  const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
  return `${baseDir}/${FILE_COORDINATION_PATHS.activeEdits}/${agentType}-${shortSessionId}.json`;
}

export function getCompletedEditsDir(baseDir: string): string {
  return `${baseDir}/${FILE_COORDINATION_PATHS.completedEdits}`;
}

// Commit message file helper
export function getCommitMessageFilePath(baseDir: string, sessionId: string): string {
  const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
  return `${baseDir}/.devops-commit-${shortSessionId}.msg`;
}

// House rules file path
export function getHouseRulesFilePath(baseDir: string): string {
  return `${baseDir}/houserules.md`;
}
