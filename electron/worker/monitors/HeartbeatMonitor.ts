/**
 * HeartbeatMonitor
 * Watches agent heartbeat JSON files in the utility process.
 * Emits parsed heartbeat data and timeout events to main process.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import type { WorkerEvent } from '../worker-protocol';

const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

interface HeartbeatSession {
  sessionId: string;
  heartbeatFile: string;
  watcher: FSWatcher;
  lastHeartbeatTs: number | null;
}

export class HeartbeatMonitor {
  private sessions: Map<string, HeartbeatSession> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(private emit: (event: WorkerEvent) => void) {}

  start(sessionId: string, heartbeatFile: string): void {
    // Stop existing monitor for this session
    this.stop(sessionId);

    const watcher = chokidar.watch(heartbeatFile, {
      persistent: true,
      ignoreInitial: false,
    });

    const session: HeartbeatSession = {
      sessionId,
      heartbeatFile,
      watcher,
      lastHeartbeatTs: null,
    };

    watcher.on('add', () => this.processHeartbeatFile(session));
    watcher.on('change', () => this.processHeartbeatFile(session));

    this.sessions.set(sessionId, session);

    // Start periodic timeout checker if not running
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => this.checkTimeouts(), CHECK_INTERVAL_MS);
    }

    console.log(`[HeartbeatMonitor] Started monitoring ${sessionId}`);
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.watcher.close().catch((err) => {
        console.error(`[HeartbeatMonitor] Error closing watcher for ${sessionId}:`, err);
      });
      this.sessions.delete(sessionId);
      console.log(`[HeartbeatMonitor] Stopped monitoring ${sessionId}`);
    }

    // Stop check interval if no more sessions
    if (this.sessions.size === 0 && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stop(sessionId);
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async processHeartbeatFile(session: HeartbeatSession): Promise<void> {
    try {
      const content = await fs.readFile(session.heartbeatFile, 'utf8');
      const data = JSON.parse(content);

      session.lastHeartbeatTs = Date.now();

      this.emit({
        type: 'heartbeat-update',
        sessionId: session.sessionId,
        data: {
          sessionId: data.sessionId || session.sessionId,
          agentId: data.agentId,
          timestamp: data.timestamp,
          status: data.status,
        },
      });
    } catch (err) {
      // File might be partially written; ignore parse errors
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.lastHeartbeatTs && now - session.lastHeartbeatTs > HEARTBEAT_TIMEOUT_MS) {
        this.emit({
          type: 'heartbeat-timeout',
          sessionId,
        });
      }
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}
