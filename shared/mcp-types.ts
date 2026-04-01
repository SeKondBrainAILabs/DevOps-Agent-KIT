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
  COMMIT: 'kanvas_commit',
  GET_SESSION_INFO: 'kanvas_get_session_info',
  LOG_ACTIVITY: 'kanvas_log_activity',
  LOCK_FILE: 'kanvas_lock_file',
  UNLOCK_FILE: 'kanvas_unlock_file',
  GET_COMMIT_HISTORY: 'kanvas_get_commit_history',
  REQUEST_REVIEW: 'kanvas_request_review',
} as const;

// =============================================================================
// MCP RESOURCE URIS
// =============================================================================

export const MCP_RESOURCES = {
  SESSION_INFO: 'kanvas://session/{session_id}/info',
  HOUSERULES: 'kanvas://session/{session_id}/houserules',
  CONTRACTS: 'kanvas://session/{session_id}/contracts',
  COMMITS: 'kanvas://session/{session_id}/commits',
} as const;

// =============================================================================
// CLAUDE CODE CONFIG STATUS
// =============================================================================

export interface ClaudeCodeConfigStatus {
  installed: boolean;
  path: string;
  currentUrl: string | null;
  portMismatch: boolean;
}

// =============================================================================
// MCP CONFIG
// =============================================================================

export const MCP_DEFAULT_PORT_START = 39100;
export const MCP_SERVER_HOST = '127.0.0.1';
