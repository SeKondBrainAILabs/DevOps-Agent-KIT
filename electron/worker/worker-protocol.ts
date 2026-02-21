/**
 * Worker Protocol
 * Shared message types for Main Process ↔ Utility Process communication.
 * Used by both the monitor-worker (utility process) and WorkerBridgeService (main process).
 */

// ─── Main → Worker Commands ───────────────────────────────────────

export type WorkerCommand =
  | StartFileMonitorCommand
  | StopFileMonitorCommand
  | StartRebaseMonitorCommand
  | StopRebaseMonitorCommand
  | StartHeartbeatMonitorCommand
  | StopHeartbeatMonitorCommand
  | StartAgentMonitorCommand
  | StopAgentMonitorCommand
  | StartKanvasHeartbeatCommand
  | StopKanvasHeartbeatCommand
  | PingCommand;

export interface StartFileMonitorCommand {
  type: 'start-file-monitor';
  sessionId: string;
  worktreePath: string;
  commitMsgFile: string;
  claudeCommitMsgFile: string;
}

export interface StopFileMonitorCommand {
  type: 'stop-file-monitor';
  sessionId: string;
}

export interface StartRebaseMonitorCommand {
  type: 'start-rebase-monitor';
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  remoteName: string;
  pollIntervalMs: number;
}

export interface StopRebaseMonitorCommand {
  type: 'stop-rebase-monitor';
  sessionId: string;
}

export interface StartHeartbeatMonitorCommand {
  type: 'start-heartbeat-monitor';
  sessionId: string;
  heartbeatFile: string;
}

export interface StopHeartbeatMonitorCommand {
  type: 'stop-heartbeat-monitor';
  sessionId: string;
}

export interface StartAgentMonitorCommand {
  type: 'start-agent-monitor';
  baseDir: string;
}

export interface StopAgentMonitorCommand {
  type: 'stop-agent-monitor';
}

export interface StartKanvasHeartbeatCommand {
  type: 'start-kanvas-heartbeat';
  heartbeatDir: string;
  appVersion: string;
}

export interface StopKanvasHeartbeatCommand {
  type: 'stop-kanvas-heartbeat';
}

export interface PingCommand {
  type: 'ping';
  ts: number;
}

// ─── Worker → Main Events ─────────────────────────────────────────

export type WorkerEvent =
  | FileChangedEvent
  | CommitMsgDetectedEvent
  | RebaseRemoteStatusEvent
  | HeartbeatUpdateEvent
  | HeartbeatTimeoutEvent
  | AgentFileEvent
  | PongEvent
  | WorkerErrorEvent
  | WorkerReadyEvent
  | WorkerLogEvent;

export interface FileChangedEvent {
  type: 'file-changed';
  sessionId: string;
  filePath: string;
  changeType: 'add' | 'change' | 'unlink';
}

export interface CommitMsgDetectedEvent {
  type: 'commit-msg-detected';
  sessionId: string;
  commitMsgFilePath: string;
}

export interface RebaseRemoteStatusEvent {
  type: 'rebase-remote-status';
  sessionId: string;
  behind: number;
  ahead: number;
  remoteBranch: string;
  localBranch: string;
}

export interface HeartbeatUpdateEvent {
  type: 'heartbeat-update';
  sessionId: string;
  data: {
    sessionId: string;
    agentId?: string;
    timestamp: string;
    status?: string;
  };
}

export interface HeartbeatTimeoutEvent {
  type: 'heartbeat-timeout';
  sessionId: string;
}

export interface AgentFileEvent {
  type: 'agent-file-event';
  subtype: 'agent' | 'session' | 'heartbeat' | 'activity';
  action: 'add' | 'change' | 'unlink';
  filePath: string;
}

export interface PongEvent {
  type: 'pong';
  ts: number;
  workerUptime: number;
  monitorsActive: number;
}

export interface WorkerErrorEvent {
  type: 'error';
  source: string;
  message: string;
}

export interface WorkerReadyEvent {
  type: 'ready';
  pid: number;
}

export interface WorkerLogEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
}
