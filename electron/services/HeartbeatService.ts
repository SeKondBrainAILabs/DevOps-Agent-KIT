/**
 * Heartbeat Service
 * Monitors agent heartbeats and connection status
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type { IpcResult, HeartbeatStatus } from '../../shared/types';
import type { WorkerBridgeService } from './WorkerBridgeService';
import chokidar, { type FSWatcher } from 'chokidar';
const { watch } = chokidar;
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';

const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

interface HeartbeatData {
  sessionId: string;
  agentId?: string;
  timestamp: string;
  status?: string;
}

export class HeartbeatService extends BaseService {
  private heartbeats: Map<string, HeartbeatStatus> = new Map();
  private watchers: Map<string, FSWatcher> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private firstHeartbeat: Map<string, string> = new Map();
  private workerBridge: WorkerBridgeService | null = null;
  private workerMonitoredSessions: Set<string> = new Set();

  /**
   * Set worker bridge for utility process monitoring.
   */
  setWorkerBridge(bridge: WorkerBridgeService): void {
    this.workerBridge = bridge;
    console.log('[HeartbeatService] Worker bridge configured');
  }

  /**
   * Handle heartbeat data from the utility process worker.
   */
  handleExternalHeartbeat(
    sessionId: string,
    data: { sessionId: string; agentId?: string; timestamp: string; status?: string }
  ): void {
    // Track first heartbeat time
    if (!this.firstHeartbeat.has(sessionId)) {
      this.firstHeartbeat.set(sessionId, data.timestamp);
    }

    const firstHeartbeatTime = new Date(this.firstHeartbeat.get(sessionId)!).getTime();
    const now = Date.now();
    const connectionDuration = Math.round((now - firstHeartbeatTime) / 1000);

    const status: HeartbeatStatus = {
      sessionId,
      agentId: data.agentId,
      lastHeartbeat: data.timestamp,
      isConnected: true,
      connectionDuration,
      missedHeartbeats: 0,
    };

    this.heartbeats.set(sessionId, status);

    this.emitToRenderer(IPC.AGENT_HEARTBEAT, {
      sessionId,
      agentId: data.agentId,
      timestamp: data.timestamp,
      isConnected: true,
    });
  }

  /**
   * Handle heartbeat timeout from the utility process worker.
   */
  handleExternalHeartbeatTimeout(sessionId: string): void {
    const status = this.heartbeats.get(sessionId);
    if (!status || !status.isConnected) return;

    const updatedStatus: HeartbeatStatus = {
      ...status,
      isConnected: false,
      missedHeartbeats: (status.missedHeartbeats || 0) + 1,
    };

    this.heartbeats.set(sessionId, updatedStatus);

    this.emitToRenderer(IPC.AGENT_STATUS_CHANGED, {
      sessionId,
      agentId: status.agentId,
      isConnected: false,
      lastHeartbeat: status.lastHeartbeat,
      missedHeartbeats: updatedStatus.missedHeartbeats,
    });
  }

  /**
   * Start monitoring heartbeats for a session
   */
  async startMonitoring(
    sessionId: string,
    kanvasDir: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const heartbeatsDir = path.join(kanvasDir, 'heartbeats');
      await fs.mkdir(heartbeatsDir, { recursive: true });

      // Initialize heartbeat status
      this.heartbeats.set(sessionId, {
        sessionId,
        lastHeartbeat: null,
        isConnected: false,
        missedHeartbeats: 0,
      });

      const heartbeatFile = path.join(heartbeatsDir, `${sessionId}.json`);

      // When worker bridge is available, delegate to utility process
      if (this.workerBridge) {
        this.workerMonitoredSessions.add(sessionId);
        this.workerBridge.startHeartbeatMonitor(sessionId, heartbeatFile);
        console.log(`[HeartbeatService] Delegated monitoring to worker for ${sessionId}`);
        return;
      }

      // Fallback: in-process monitoring
      if (existsSync(heartbeatFile)) {
        await this.processHeartbeatFile(sessionId, heartbeatFile);
      }

      const watcher = watch(heartbeatFile, {
        persistent: true,
        ignoreInitial: false,
      });

      watcher.on('add', () => this.processHeartbeatFile(sessionId, heartbeatFile));
      watcher.on('change', () => this.processHeartbeatFile(sessionId, heartbeatFile));

      this.watchers.set(sessionId, watcher);

      if (!this.checkInterval) {
        this.checkInterval = setInterval(() => this.checkAllHeartbeats(), CHECK_INTERVAL_MS);
      }
    }, 'HEARTBEAT_START_FAILED');
  }

  /**
   * Stop monitoring heartbeats for a session
   */
  async stopMonitoring(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const watcher = this.watchers.get(sessionId);
      if (watcher) {
        await watcher.close();
        this.watchers.delete(sessionId);
      } else if (this.workerBridge && this.workerMonitoredSessions.has(sessionId)) {
        this.workerBridge.stopHeartbeatMonitor(sessionId);
        this.workerMonitoredSessions.delete(sessionId);
      }

      this.heartbeats.delete(sessionId);
      this.firstHeartbeat.delete(sessionId);

      if (this.watchers.size === 0 && this.workerMonitoredSessions.size === 0 && this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
    }, 'HEARTBEAT_STOP_FAILED');
  }

  /**
   * Process a heartbeat file (in-process fallback)
   */
  private async processHeartbeatFile(sessionId: string, filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data: HeartbeatData = JSON.parse(content);

      if (!this.firstHeartbeat.has(sessionId)) {
        this.firstHeartbeat.set(sessionId, data.timestamp);
      }

      const firstHeartbeatTime = new Date(this.firstHeartbeat.get(sessionId)!).getTime();
      const now = Date.now();
      const connectionDuration = Math.round((now - firstHeartbeatTime) / 1000);

      const status: HeartbeatStatus = {
        sessionId,
        agentId: data.agentId,
        lastHeartbeat: data.timestamp,
        isConnected: true,
        connectionDuration,
        missedHeartbeats: 0,
      };

      this.heartbeats.set(sessionId, status);

      this.emitToRenderer(IPC.AGENT_HEARTBEAT, {
        sessionId,
        agentId: data.agentId,
        timestamp: data.timestamp,
        isConnected: true,
      });
    } catch (error) {
      console.error(`[HeartbeatService] Error processing heartbeat for ${sessionId}:`, error);
    }
  }

  /**
   * Check all heartbeats for timeouts (in-process fallback)
   */
  private checkAllHeartbeats(): void {
    const now = Date.now();

    for (const [sessionId, status] of this.heartbeats) {
      if (status.lastHeartbeat) {
        const lastHeartbeatTime = new Date(status.lastHeartbeat).getTime();
        const timeSinceLastHeartbeat = now - lastHeartbeatTime;

        if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          if (status.isConnected) {
            const missedHeartbeats = Math.floor(timeSinceLastHeartbeat / HEARTBEAT_TIMEOUT_MS);
            const updatedStatus: HeartbeatStatus = {
              ...status,
              isConnected: false,
              missedHeartbeats,
            };

            this.heartbeats.set(sessionId, updatedStatus);

            this.emitToRenderer(IPC.AGENT_STATUS_CHANGED, {
              sessionId,
              agentId: status.agentId,
              isConnected: false,
              lastHeartbeat: status.lastHeartbeat,
              missedHeartbeats,
            });
          }
        }
      }
    }
  }

  getStatus(sessionId: string): IpcResult<HeartbeatStatus | null> {
    const status = this.heartbeats.get(sessionId);
    return this.success(status || null);
  }

  getAllStatuses(): IpcResult<HeartbeatStatus[]> {
    return this.success(Array.from(this.heartbeats.values()));
  }

  async writeHeartbeat(sessionId: string, kanvasDir: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const heartbeatsDir = path.join(kanvasDir, 'heartbeats');
      await fs.mkdir(heartbeatsDir, { recursive: true });

      const heartbeatFile = path.join(heartbeatsDir, `${sessionId}.json`);
      const data: HeartbeatData = {
        sessionId,
        timestamp: new Date().toISOString(),
        status: 'active',
      };

      await fs.writeFile(heartbeatFile, JSON.stringify(data, null, 2));
    }, 'HEARTBEAT_WRITE_FAILED');
  }

  async dispose(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
    this.heartbeats.clear();
    this.firstHeartbeat.clear();
    this.workerMonitoredSessions.clear();
  }
}
