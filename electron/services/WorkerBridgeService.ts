/**
 * WorkerBridgeService
 *
 * Spawns the monitor-worker utility process and bridges events between
 * the worker and the existing main-process services.
 *
 * Responsibilities:
 * - Spawn / kill the utility process
 * - Auto-restart on crash with exponential backoff
 * - Ping/pong health check (detects unresponsive worker)
 * - Route events from worker to service callbacks
 * - Buffer and replay active monitor configs after restart
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'path';
import { BaseService } from './BaseService';
import type { WorkerCommand, WorkerEvent } from '../worker/worker-protocol';

const MAX_RESTARTS = 10;
const PING_INTERVAL_MS = 15_000;   // 15 seconds
const PONG_TIMEOUT_MS = 10_000;    // 10 seconds
const MIN_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;

export class WorkerBridgeService extends BaseService {
  private worker: UtilityProcess | null = null;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPongTs: number = Date.now();
  private isDisposed = false;
  private workerReady = false;

  // Active monitor configs — replayed on restart
  private activeCommands: Map<string, WorkerCommand> = new Map();

  // Queued commands waiting for worker to be ready
  private pendingCommands: WorkerCommand[] = [];

  // ─── Event callbacks (wired by services/index.ts) ─────────────

  onFileChanged?: (sessionId: string, filePath: string, changeType: string) => void;
  onCommitMsgDetected?: (sessionId: string, commitMsgFilePath: string) => void;
  onRebaseRemoteStatus?: (sessionId: string, behind: number, ahead: number, remoteBranch: string, localBranch: string) => void;
  onHeartbeatUpdate?: (sessionId: string, data: { sessionId: string; agentId?: string; timestamp: string; status?: string }) => void;
  onHeartbeatTimeout?: (sessionId: string) => void;
  onAgentFileEvent?: (subtype: string, action: string, filePath: string) => void;
  onWorkerReady?: (pid: number) => void;
  onWorkerError?: (source: string, message: string) => void;

  // ─── Lifecycle ────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.spawn();
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    this.stopHealthCheck();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killWorker();
    this.activeCommands.clear();
    this.pendingCommands = [];
  }

  // ─── Worker management ────────────────────────────────────────

  private spawn(): void {
    if (this.isDisposed) return;

    // Resolve worker path relative to this file's compiled location
    // In production: dist/electron/index.js → dist/electron/monitor-worker.js
    // In dev: same structure after electron-vite build
    const workerPath = join(__dirname, 'monitor-worker.js');

    console.log(`[WorkerBridge] Spawning utility process: ${workerPath}`);

    try {
      this.worker = utilityProcess.fork(workerPath);
      this.workerReady = false;

      this.worker.on('message', (event: WorkerEvent) => {
        this.handleWorkerEvent(event);
      });

      this.worker.on('exit', (code: number) => {
        this.handleWorkerExit(code);
      });

      this.startHealthCheck();
    } catch (err) {
      console.error('[WorkerBridge] Failed to spawn utility process:', err);
      // Will not retry automatically — this is a fatal setup error
    }
  }

  private killWorker(): void {
    if (this.worker) {
      try {
        this.worker.kill();
      } catch {
        // Already dead
      }
      this.worker = null;
      this.workerReady = false;
    }
  }

  restart(): void {
    console.log('[WorkerBridge] Manual restart requested');
    this.restartCount = 0; // Reset counter on manual restart
    this.killWorker();
    this.spawn();
  }

  // ─── Health check ─────────────────────────────────────────────

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.lastPongTs = Date.now();

    this.pingInterval = setInterval(() => {
      if (!this.worker || !this.workerReady) return;

      // Check if last pong is too old
      if (Date.now() - this.lastPongTs > PONG_TIMEOUT_MS + PING_INTERVAL_MS) {
        console.warn('[WorkerBridge] Worker unresponsive — killing and restarting');
        this.killWorker();
        // handleWorkerExit will trigger restart
        return;
      }

      this.sendCommand({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ─── Event routing ────────────────────────────────────────────

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case 'ready':
        console.log(`[WorkerBridge] Worker ready (pid: ${event.pid})`);
        this.workerReady = true;
        this.restartCount = 0;
        this.lastPongTs = Date.now();

        // Replay active monitor configs
        this.replayActiveCommands();

        // Flush pending commands
        for (const cmd of this.pendingCommands) {
          this.sendCommand(cmd);
        }
        this.pendingCommands = [];

        this.onWorkerReady?.(event.pid);
        break;

      case 'file-changed':
        this.onFileChanged?.(event.sessionId, event.filePath, event.changeType);
        break;

      case 'commit-msg-detected':
        this.onCommitMsgDetected?.(event.sessionId, event.commitMsgFilePath);
        break;

      case 'rebase-remote-status':
        this.onRebaseRemoteStatus?.(event.sessionId, event.behind, event.ahead, event.remoteBranch, event.localBranch);
        break;

      case 'heartbeat-update':
        this.onHeartbeatUpdate?.(event.sessionId, event.data);
        break;

      case 'heartbeat-timeout':
        this.onHeartbeatTimeout?.(event.sessionId);
        break;

      case 'agent-file-event':
        this.onAgentFileEvent?.(event.subtype, event.action, event.filePath);
        break;

      case 'pong':
        this.lastPongTs = Date.now();
        break;

      case 'error':
        console.error(`[WorkerBridge] Worker error (${event.source}): ${event.message}`);
        this.onWorkerError?.(event.source, event.message);
        break;
    }
  }

  private handleWorkerExit(code: number): void {
    console.warn(`[WorkerBridge] Worker exited with code ${code}`);
    this.worker = null;
    this.workerReady = false;
    this.stopHealthCheck();

    if (this.isDisposed) return;

    if (this.restartCount >= MAX_RESTARTS) {
      console.error(`[WorkerBridge] Max restarts (${MAX_RESTARTS}) reached — giving up`);
      return;
    }

    const delay = Math.min(
      MIN_RESTART_DELAY_MS * Math.pow(2, this.restartCount),
      MAX_RESTART_DELAY_MS
    );

    console.log(`[WorkerBridge] Restarting in ${delay}ms (attempt ${this.restartCount + 1}/${MAX_RESTARTS})`);
    this.restartCount++;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }

  // ─── Command sending ─────────────────────────────────────────

  private sendCommand(command: WorkerCommand): void {
    if (this.worker && this.workerReady) {
      this.worker.postMessage(command);
    } else if (command.type !== 'ping') {
      // Queue non-ping commands for when worker is ready
      this.pendingCommands.push(command);
    }
  }

  /**
   * Track a start command so it can be replayed on restart.
   * Key format: "type:id" e.g. "file:sess_abc123"
   */
  private trackCommand(key: string, command: WorkerCommand): void {
    this.activeCommands.set(key, command);
    this.sendCommand(command);
  }

  /**
   * Remove a tracked command and send the stop command.
   */
  private untrackCommand(key: string, command: WorkerCommand): void {
    this.activeCommands.delete(key);
    this.sendCommand(command);
  }

  /**
   * Replay all active start commands to a freshly restarted worker.
   */
  private replayActiveCommands(): void {
    const count = this.activeCommands.size;
    if (count > 0) {
      console.log(`[WorkerBridge] Replaying ${count} active monitor command(s)`);
      for (const command of this.activeCommands.values()) {
        this.sendCommand(command);
      }
    }
  }

  // ─── Public API (called by services) ──────────────────────────

  startFileMonitor(
    sessionId: string,
    worktreePath: string,
    commitMsgFile: string,
    claudeCommitMsgFile: string
  ): void {
    this.trackCommand(`file:${sessionId}`, {
      type: 'start-file-monitor',
      sessionId,
      worktreePath,
      commitMsgFile,
      claudeCommitMsgFile,
    });
  }

  stopFileMonitor(sessionId: string): void {
    this.untrackCommand(`file:${sessionId}`, {
      type: 'stop-file-monitor',
      sessionId,
    });
  }

  startRebaseMonitor(
    sessionId: string,
    repoPath: string,
    baseBranch: string,
    remoteName: string,
    pollIntervalMs: number
  ): void {
    this.trackCommand(`rebase:${sessionId}`, {
      type: 'start-rebase-monitor',
      sessionId,
      repoPath,
      baseBranch,
      remoteName,
      pollIntervalMs,
    });
  }

  stopRebaseMonitor(sessionId: string): void {
    this.untrackCommand(`rebase:${sessionId}`, {
      type: 'stop-rebase-monitor',
      sessionId,
    });
  }

  startHeartbeatMonitor(sessionId: string, heartbeatFile: string): void {
    this.trackCommand(`heartbeat:${sessionId}`, {
      type: 'start-heartbeat-monitor',
      sessionId,
      heartbeatFile,
    });
  }

  stopHeartbeatMonitor(sessionId: string): void {
    this.untrackCommand(`heartbeat:${sessionId}`, {
      type: 'stop-heartbeat-monitor',
      sessionId,
    });
  }

  startAgentMonitor(baseDir: string): void {
    this.trackCommand('agent:global', {
      type: 'start-agent-monitor',
      baseDir,
    });
  }

  stopAgentMonitor(): void {
    this.untrackCommand('agent:global', {
      type: 'stop-agent-monitor',
    });
  }

  startKanvasHeartbeat(heartbeatDir: string, appVersion: string): void {
    this.trackCommand('kanvas-heartbeat:global', {
      type: 'start-kanvas-heartbeat',
      heartbeatDir,
      appVersion,
    });
  }

  stopKanvasHeartbeat(): void {
    this.untrackCommand('kanvas-heartbeat:global', {
      type: 'stop-kanvas-heartbeat',
    });
  }

  // ─── Status ───────────────────────────────────────────────────

  getStatus(): {
    workerAlive: boolean;
    workerReady: boolean;
    workerPid: number | null;
    restartCount: number;
    activeMonitors: number;
    uptimeMs: number;
  } {
    return {
      workerAlive: this.worker !== null,
      workerReady: this.workerReady,
      workerPid: this.worker?.pid ?? null,
      restartCount: this.restartCount,
      activeMonitors: this.activeCommands.size,
      uptimeMs: this.lastPongTs ? Date.now() - this.lastPongTs : 0,
    };
  }
}
