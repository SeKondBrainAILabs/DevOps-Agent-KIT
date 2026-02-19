/**
 * Monitor Worker — Utility Process Entry Point
 *
 * Runs in an Electron utilityProcess, separate from main and renderer.
 * Manages all I/O monitoring (file watchers, git polling, heartbeats).
 * Communicates with the main process via parentPort (MessagePort).
 *
 * If this process crashes, the main process auto-restarts it.
 */

import type { WorkerCommand, WorkerEvent } from './worker-protocol';
import { FileMonitor } from './monitors/FileMonitor';
import { RebaseMonitor } from './monitors/RebaseMonitor';
import { HeartbeatMonitor } from './monitors/HeartbeatMonitor';
import { AgentMonitor } from './monitors/AgentMonitor';
import { KanvasHeartbeatWriter } from './monitors/KanvasHeartbeatWriter';

const startTime = Date.now();

// ─── Emit helper ──────────────────────────────────────────────────

function emit(event: WorkerEvent): void {
  process.parentPort.postMessage(event);
}

// ─── Instantiate monitors ─────────────────────────────────────────

const fileMonitor = new FileMonitor(emit);
const rebaseMonitor = new RebaseMonitor(emit);
const heartbeatMonitor = new HeartbeatMonitor(emit);
const agentMonitor = new AgentMonitor(emit);
const kanvasHeartbeat = new KanvasHeartbeatWriter();

// ─── Command dispatcher ──────────────────────────────────────────

function handleCommand(command: WorkerCommand): void {
  try {
    switch (command.type) {
      // File monitoring
      case 'start-file-monitor':
        fileMonitor.start(
          command.sessionId,
          command.worktreePath,
          command.commitMsgFile,
          command.claudeCommitMsgFile
        );
        break;
      case 'stop-file-monitor':
        fileMonitor.stop(command.sessionId);
        break;

      // Rebase polling
      case 'start-rebase-monitor':
        rebaseMonitor.start(
          command.sessionId,
          command.repoPath,
          command.baseBranch,
          command.remoteName,
          command.pollIntervalMs
        );
        break;
      case 'stop-rebase-monitor':
        rebaseMonitor.stop(command.sessionId);
        break;

      // Heartbeat monitoring
      case 'start-heartbeat-monitor':
        heartbeatMonitor.start(command.sessionId, command.heartbeatFile);
        break;
      case 'stop-heartbeat-monitor':
        heartbeatMonitor.stop(command.sessionId);
        break;

      // Agent directory monitoring
      case 'start-agent-monitor':
        agentMonitor.start(command.baseDir);
        break;
      case 'stop-agent-monitor':
        agentMonitor.stop();
        break;

      // Kanvas heartbeat writer
      case 'start-kanvas-heartbeat':
        kanvasHeartbeat.start(command.heartbeatDir, command.appVersion);
        break;
      case 'stop-kanvas-heartbeat':
        kanvasHeartbeat.stop();
        break;

      // Health check
      case 'ping':
        emit({
          type: 'pong',
          ts: command.ts,
          workerUptime: Math.round((Date.now() - startTime) / 1000),
          monitorsActive:
            fileMonitor.activeCount +
            rebaseMonitor.activeCount +
            heartbeatMonitor.activeCount +
            agentMonitor.activeCount +
            (kanvasHeartbeat.isActive ? 1 : 0),
        });
        break;

      default:
        console.warn('[MonitorWorker] Unknown command type:', (command as { type: string }).type);
    }
  } catch (err) {
    emit({
      type: 'error',
      source: 'MonitorWorker',
      message: `Error handling command ${command.type}: ${(err as Error).message}`,
    });
  }
}

// ─── Message listener ─────────────────────────────────────────────

process.parentPort.on('message', (messageEvent) => {
  const command = messageEvent.data as WorkerCommand;
  handleCommand(command);
});

// ─── Error handlers ───────────────────────────────────────────────

process.on('uncaughtException', (error) => {
  console.error('[MonitorWorker] Uncaught exception:', error);
  emit({
    type: 'error',
    source: 'MonitorWorker:uncaughtException',
    message: error.message,
  });
  // Don't exit — try to keep running
});

process.on('unhandledRejection', (reason) => {
  console.error('[MonitorWorker] Unhandled rejection:', reason);
  emit({
    type: 'error',
    source: 'MonitorWorker:unhandledRejection',
    message: String(reason),
  });
});

// ─── Cleanup on exit ──────────────────────────────────────────────

process.on('exit', () => {
  fileMonitor.stopAll();
  rebaseMonitor.stopAll();
  heartbeatMonitor.stopAll();
  agentMonitor.stop();
  kanvasHeartbeat.stop();
});

// ─── Signal ready ─────────────────────────────────────────────────

emit({
  type: 'ready',
  pid: process.pid,
});

console.log(`[MonitorWorker] Ready (pid: ${process.pid})`);
