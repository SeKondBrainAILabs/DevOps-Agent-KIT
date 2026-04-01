/**
 * Shared MCP Type Definitions
 * Types used by both the MCP server and client code.
 */

// =============================================================================
// MCP SERVER STATUS
// =============================================================================

export interface McpServerStatus {
  port: number | null;
  url: string | null;
  isRunning: boolean;
  connectionCount: number;
  startedAt: string | null;
}

// =============================================================================
// MCP TOOL RESULTS
// =============================================================================

export interface McpCommitResult {
  commitHash: string;
  shortHash: string;
  message: string;
  filesChanged: number;
  pushed: boolean;
}

export interface McpSessionInfo {
  sessionId: string;
  agentType: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  repoPath: string;
  task: string;
  createdAt: string;
}

export interface McpLockResult {
  locked: boolean;
  files: string[];
  conflicts?: Array<{
    file: string;
    heldBy: string;
    sessionId: string;
  }>;
}

export interface McpCommitHistoryEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

export interface McpReviewResult {
  logged: boolean;
  summary: string;
  sessionId: string;
}

// =============================================================================
// MCP TOOL NAMES
// =============================================================================

export const MCP_TOOLS = {
  COMMIT: 'kit_commit',
  COMMIT_ALL: 'kit_commit_all',
  GET_SESSION_INFO: 'kit_get_session_info',
  LOG_ACTIVITY: 'kit_log_activity',
  LOCK_FILE: 'kit_lock_file',
  UNLOCK_FILE: 'kit_unlock_file',
  GET_COMMIT_HISTORY: 'kit_get_commit_history',
  REQUEST_REVIEW: 'kit_request_review',
} as const;

// =============================================================================
// MCP RESOURCE URIS
// =============================================================================

export const MCP_RESOURCES = {
  SESSION_INFO: 'kit://session/{session_id}/info',
  HOUSERULES: 'kit://session/{session_id}/houserules',
  CONTRACTS: 'kit://session/{session_id}/contracts',
  COMMITS: 'kit://session/{session_id}/commits',
} as const;

// =============================================================================
// CLAUDE CODE CONFIG STATUS
// =============================================================================

export type McpInstallTarget = 'claude-code' | 'claude-desktop';

export interface McpInstallConfigStatus {
  installed: boolean;
  path: string;
  currentUrl: string | null;
  portMismatch: boolean;
}

/** @deprecated Use McpInstallConfigStatus instead */
export type ClaudeCodeConfigStatus = McpInstallConfigStatus;

// =============================================================================
// MCP CONFIG
// =============================================================================

export const MCP_DEFAULT_PORT_START = 39100;
export const MCP_SERVER_HOST = '127.0.0.1';
