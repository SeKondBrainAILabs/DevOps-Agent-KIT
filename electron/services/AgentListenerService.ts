/**
 * AgentListenerService
 *
 * Monitors the .S9N_KIT_DevOpsAgent directory for agent registrations, status updates,
 * and activity reports. Kanvas is a DASHBOARD - agents report INTO it.
 */

import chokidar, { type FSWatcher } from 'chokidar';
const { watch } = chokidar;
import { readFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserWindow } from 'electron';
import { BaseService } from './BaseService';
import {
  KANVAS_PATHS,
  AgentInfo,
  AgentStatusUpdate,
  AgentActivityReport,
  SessionReport,
  FileChangeReport,
  CommitReport,
} from '../../shared/agent-protocol';

interface RegisteredAgent extends AgentInfo {
  lastHeartbeat: string;
  isAlive: boolean;
  sessions: string[];
}

export class AgentListenerService extends BaseService {
  private watchers: Map<string, FSWatcher> = new Map();
  private agents: Map<string, RegisteredAgent> = new Map();
  private sessions: Map<string, SessionReport> = new Map();
  private baseDir: string = '';
  private heartbeatCheckInterval?: NodeJS.Timeout;
  private readonly HEARTBEAT_TIMEOUT_MS = 30000; // 30 seconds

  constructor() {
    super();
  }

  /**
   * Simple logging helper
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const prefix = `[AgentListenerService]`;
    if (level === 'error') {
      console.error(prefix, message, data || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }
  }

  async initialize(baseDir: string): Promise<void> {
    this.baseDir = baseDir;

    // Ensure DevOps Kit directories exist
    await this.ensureKanvasDirectories();

    // Start watching for agent files
    await this.startWatching();

    // Load existing agents and sessions
    await this.loadExistingData();

    // Start heartbeat checker
    this.startHeartbeatChecker();

    this.log('info', `AgentListenerService initialized for ${baseDir}`);
  }

  private async ensureKanvasDirectories(): Promise<void> {
    const dirs = [
      KANVAS_PATHS.baseDir,
      KANVAS_PATHS.agents,
      KANVAS_PATHS.sessions,
      KANVAS_PATHS.activity,
      KANVAS_PATHS.commands,
      KANVAS_PATHS.heartbeats,
    ];

    for (const dir of dirs) {
      const fullPath = join(this.baseDir, dir);
      if (!existsSync(fullPath)) {
        await mkdir(fullPath, { recursive: true });
      }
    }
  }

  private async startWatching(): Promise<void> {
    // Watch for agent registrations
    const agentsPath = join(this.baseDir, KANVAS_PATHS.agents);
    const agentsWatcher = watch(agentsPath, {
      persistent: true,
      ignoreInitial: false,
    });

    agentsWatcher.on('add', (path) => this.handleAgentFile(path));
    agentsWatcher.on('change', (path) => this.handleAgentFile(path));
    agentsWatcher.on('unlink', (path) => this.handleAgentRemoved(path));
    this.watchers.set('agents', agentsWatcher);

    // Watch for session reports
    const sessionsPath = join(this.baseDir, KANVAS_PATHS.sessions);
    const sessionsWatcher = watch(sessionsPath, {
      persistent: true,
      ignoreInitial: false,
    });

    sessionsWatcher.on('add', (path) => this.handleSessionFile(path));
    sessionsWatcher.on('change', (path) => this.handleSessionFile(path));
    sessionsWatcher.on('unlink', (path) => this.handleSessionRemoved(path));
    this.watchers.set('sessions', sessionsWatcher);

    // Watch for heartbeats
    const heartbeatsPath = join(this.baseDir, KANVAS_PATHS.heartbeats);
    const heartbeatWatcher = watch(heartbeatsPath, {
      persistent: true,
      ignoreInitial: false,
    });

    heartbeatWatcher.on('add', (path) => this.handleHeartbeat(path));
    heartbeatWatcher.on('change', (path) => this.handleHeartbeat(path));
    this.watchers.set('heartbeats', heartbeatWatcher);

    // Watch for activity logs
    const activityPath = join(this.baseDir, KANVAS_PATHS.activity);
    const activityWatcher = watch(activityPath, {
      persistent: true,
      ignoreInitial: false,
    });

    activityWatcher.on('add', (path) => this.handleActivityFile(path));
    activityWatcher.on('change', (path) => this.handleActivityFile(path));
    this.watchers.set('activity', activityWatcher);
  }

  private async loadExistingData(): Promise<void> {
    // Load existing agents
    const agentsPath = join(this.baseDir, KANVAS_PATHS.agents);
    if (existsSync(agentsPath)) {
      const files = await readdir(agentsPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await this.handleAgentFile(join(agentsPath, file));
        }
      }
    }

    // Load existing sessions
    const sessionsPath = join(this.baseDir, KANVAS_PATHS.sessions);
    if (existsSync(sessionsPath)) {
      const files = await readdir(sessionsPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await this.handleSessionFile(join(sessionsPath, file));
        }
      }
    }
  }

  private async handleAgentFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const agentInfo = JSON.parse(content) as AgentInfo;

      const existing = this.agents.get(agentInfo.agentId);
      const registeredAgent: RegisteredAgent = {
        ...agentInfo,
        lastHeartbeat: new Date().toISOString(),
        isAlive: true,
        sessions: existing?.sessions || [],
      };

      this.agents.set(agentInfo.agentId, registeredAgent);
      this.emitToRenderer('agent:registered', registeredAgent);
      this.log('info', `Agent registered: ${agentInfo.agentName} (${agentInfo.agentId})`);
    } catch (error) {
      this.log('error', `Failed to read agent file: ${filePath}`, { error });
    }
  }

  private handleAgentRemoved(filePath: string): void {
    const agentId = filePath.split('/').pop()?.replace('.json', '');
    if (agentId && this.agents.has(agentId)) {
      const agent = this.agents.get(agentId);
      this.agents.delete(agentId);
      this.emitToRenderer('agent:unregistered', agentId);
      this.log('info', `Agent unregistered: ${agent?.agentName} (${agentId})`);
    }
  }

  private async handleSessionFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const sessionReport = JSON.parse(content) as SessionReport;

      this.sessions.set(sessionReport.sessionId, sessionReport);

      // Link session to agent
      const agent = this.agents.get(sessionReport.agentId);
      if (agent && !agent.sessions.includes(sessionReport.sessionId)) {
        agent.sessions.push(sessionReport.sessionId);
      }

      this.emitToRenderer('session:reported', sessionReport);
      this.log('info', `Session reported: ${sessionReport.sessionId} from ${sessionReport.agentId}`);
    } catch (error) {
      this.log('error', `Failed to read session file: ${filePath}`, { error });
    }
  }

  private handleSessionRemoved(filePath: string): void {
    const sessionId = filePath.split('/').pop()?.replace('.json', '');
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);

      // Unlink from agent
      if (session?.agentId) {
        const agent = this.agents.get(session.agentId);
        if (agent) {
          agent.sessions = agent.sessions.filter(id => id !== sessionId);
        }
      }

      this.emitToRenderer('session:closed', sessionId);
    }
  }

  private async handleHeartbeat(filePath: string): Promise<void> {
    const agentId = filePath.split('/').pop()?.replace('.beat', '');
    if (agentId && this.agents.has(agentId)) {
      const agent = this.agents.get(agentId)!;
      agent.lastHeartbeat = new Date().toISOString();
      agent.isAlive = true;
      this.emitToRenderer('agent:heartbeat', { agentId, timestamp: agent.lastHeartbeat });
    }
  }

  private async handleActivityFile(filePath: string): Promise<void> {
    // Activity files are append-only logs, read last few lines
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      const lastLines = lines.slice(-10); // Last 10 entries

      for (const line of lastLines) {
        try {
          const activity = JSON.parse(line) as AgentActivityReport;
          this.emitToRenderer('activity:reported', activity);
        } catch {
          // Line might not be valid JSON, skip
        }
      }
    } catch (error) {
      this.log('error', `Failed to read activity file: ${filePath}`, { error });
    }
  }

  private startHeartbeatChecker(): void {
    this.heartbeatCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [agentId, agent] of this.agents) {
        const lastBeat = new Date(agent.lastHeartbeat).getTime();
        const isAlive = (now - lastBeat) < this.HEARTBEAT_TIMEOUT_MS;

        if (agent.isAlive !== isAlive) {
          agent.isAlive = isAlive;
          this.emitToRenderer('agent:status-changed', {
            agentId,
            isAlive,
            lastHeartbeat: agent.lastHeartbeat,
          });

          if (!isAlive) {
            this.log('warn', `Agent ${agent.agentName} (${agentId}) appears offline`);
          }
        }
      }
    }, 10000); // Check every 10 seconds
  }

  private emitToRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(channel, data);
    }
  }

  // Public API methods

  getAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getAgent(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  getSessions(): SessionReport[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): SessionReport | undefined {
    return this.sessions.get(sessionId);
  }

  getAgentSessions(agentId: string): SessionReport[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    return agent.sessions
      .map(id => this.sessions.get(id))
      .filter((s): s is SessionReport => s !== undefined);
  }

  async destroy(): Promise<void> {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }

    for (const [name, watcher] of this.watchers) {
      await watcher.close();
      this.log('info', `Closed watcher: ${name}`);
    }

    this.watchers.clear();
    this.agents.clear();
    this.sessions.clear();
  }
}

export const agentListenerService = new AgentListenerService();
