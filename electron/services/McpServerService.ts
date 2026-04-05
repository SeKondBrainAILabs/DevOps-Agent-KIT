/**
 * MCP Server Service
 *
 * Extends BaseService. Runs an HTTP-based MCP server on localhost
 * so coding agents (Claude Code, Cursor, etc.) can interact with Kanvas
 * via a proper tool interface.
 *
 * Transport: Streamable HTTP (POST /mcp, GET /mcp for SSE, DELETE /mcp)
 *
 * Uses stateful mode: each client connection gets its own transport + server
 * instance to avoid SDK restriction on reusing stateless transports across requests.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Server } from 'http';
import { BaseService } from './BaseService';
import { McpSessionBinder } from './mcp/session-binder';
import { MCP_DEFAULT_PORT_START, MCP_SERVER_HOST } from '../../shared/mcp-types';
import type { McpServerStatus, McpInstallConfigStatus, McpInstallTarget } from '../../shared/mcp-types';

// Lazy imports for MCP SDK (ESM modules)
let _McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer | null = null;
let _StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport | null = null;
let _SSEServerTransport: typeof import('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport | null = null;

async function getMcpServer() {
  if (!_McpServer) {
    const mod = await import('@modelcontextprotocol/sdk/server/mcp.js');
    _McpServer = mod.McpServer;
  }
  return _McpServer;
}

async function getTransport() {
  if (!_StreamableHTTPServerTransport) {
    const mod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    _StreamableHTTPServerTransport = mod.StreamableHTTPServerTransport;
  }
  return _StreamableHTTPServerTransport;
}

async function getSseTransport() {
  if (!_SSEServerTransport) {
    const mod = await import('@modelcontextprotocol/sdk/server/sse.js');
    _SSEServerTransport = mod.SSEServerTransport;
  }
  return _SSEServerTransport;
}

// Service interface types (set via setters, not constructor)
export interface McpServiceDeps {
  gitService?: {
    commit: (sessionId: string, message: string, repoName?: string) => Promise<any>;
    push: (sessionId: string, repoName?: string) => Promise<any>;
    getStatus: (sessionId: string) => Promise<any>;
    getCommitHistory: (repoPath: string, baseBranch?: string, limit?: number) => Promise<any>;
  };
  activityService?: {
    log: (sessionId: string, type: string, message: string, details?: Record<string, unknown>) => void;
  };
  lockService?: {
    checkConflicts: (repoPath: string, files: string[], excludeSessionId?: string) => Promise<any>;
    declareFiles: (sessionId: string, files: string[], operation: 'edit' | 'read' | 'delete') => Promise<any>;
    releaseFiles: (sessionId: string) => Promise<any>;
    forceReleaseLock: (repoPath: string, filePath: string) => Promise<any>;
  };
  agentInstanceService?: {
    listInstances: () => { success: boolean; data?: any[] };
  };
  databaseService?: {
    recordCommit: (sessionId: string, hash: string, message: string, filesChanged: number) => void;
    recordSessionEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
    getSetting: (key: string, defaultValue?: any) => any;
  };
  contractDetectionService?: {
    analyzeCommit: (worktreePath: string, commitHash: string) => Promise<any>;
  };
  contractGenerationService?: {
    generateFeatureContract: (worktreePath: string, feature: any) => Promise<any>;
  };
}

export interface McpCallLogEntry {
  timestamp: string;
  toolName: string;
  sessionId: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class McpServerService extends BaseService {
  private httpServer: Server | null = null;
  private port: number | null = null;
  private startedAt: string | null = null;

  // Per-connection transports (stateful mode) — keyed by mcp-session-id
  private transports = new Map<
    string,
    InstanceType<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport>
  >();

  // SSE transports — keyed by session-id for legacy SSE clients (Claude Desktop)
  private sseTransports = new Map<
    string,
    InstanceType<typeof import('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport>
  >();

  readonly sessionBinder = new McpSessionBinder();
  private deps: McpServiceDeps = {};

  // Track last activity per transport for stale session cleanup
  private lastActivity = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // MCP call log — in-memory cache backed by persistent database
  private mcpCallLog: McpCallLogEntry[] = [];
  private _dbService: { recordMcpCall: (entry: any) => void; getMcpCalls: (limit?: number, sessionId?: string) => any[] } | null = null;

  /** Inject DatabaseService reference for persistent MCP call logging */
  setMcpCallDb(db: { recordMcpCall: (entry: any) => void; getMcpCalls: (limit?: number, sessionId?: string) => any[] }): void {
    this._dbService = db;
  }

  getMcpCallLog(limit = 200): McpCallLogEntry[] {
    // Load from database if available and in-memory cache is empty
    if (this.mcpCallLog.length === 0 && this._dbService) {
      try {
        const rows = this._dbService.getMcpCalls(limit);
        this.mcpCallLog = rows;
      } catch {
        // Fall back to empty
      }
    }
    return this.mcpCallLog.slice(-limit);
  }

  addCallLogEntry(entry: McpCallLogEntry): void {
    this.mcpCallLog.push(entry);
    if (this.mcpCallLog.length > 500) {
      this.mcpCallLog = this.mcpCallLog.slice(-200);
    }
    // Persist to database
    if (this._dbService) {
      this._dbService.recordMcpCall(entry);
    }
    // Emit real-time event to renderer
    this.emitToRenderer('mcp:tool-called', entry);
  }

  // ==========================================================================
  // DEPENDENCY SETTERS
  // ==========================================================================

  setGitService(svc: McpServiceDeps['gitService']): void {
    this.deps.gitService = svc;
  }

  setActivityService(svc: McpServiceDeps['activityService']): void {
    this.deps.activityService = svc;
  }

  setLockService(svc: McpServiceDeps['lockService']): void {
    this.deps.lockService = svc;
  }

  setAgentInstanceService(svc: McpServiceDeps['agentInstanceService']): void {
    this.deps.agentInstanceService = svc;
  }

  setDatabaseService(svc: McpServiceDeps['databaseService']): void {
    this.deps.databaseService = svc;
  }

  setContractDetectionService(svc: McpServiceDeps['contractDetectionService']): void {
    this.deps.contractDetectionService = svc;
  }

  setContractGenerationService(svc: McpServiceDeps['contractGenerationService']): void {
    this.deps.contractGenerationService = svc;
  }

  getDeps(): McpServiceDeps {
    return this.deps;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async initialize(): Promise<void> {
    try {
      // Detect free port
      const detectPort = (await import('detect-port')).default;
      this.port = await detectPort(MCP_DEFAULT_PORT_START);

      // Pre-load SDK classes so handleRequest doesn't need to await them
      await getMcpServer();
      await getTransport();
      await getSseTransport();

      // Create HTTP server
      this.httpServer = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[McpServerService] Unhandled request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
      });

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.listen(this.port!, MCP_SERVER_HOST, () => {
          this.startedAt = new Date().toISOString();
          console.log(`[McpServerService] MCP server listening on http://${MCP_SERVER_HOST}:${this.port}/mcp`);
          resolve();
        });
        this.httpServer!.on('error', reject);
      });

      // Start stale session cleanup timer
      this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 60_000);

      // Emit to renderer
      this.emitToRenderer('mcp:server-started', {
        port: this.port,
        url: this.getUrl(),
      });
    } catch (error) {
      console.error('[McpServerService] Failed to initialize:', error);
      this.port = null;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.lastActivity.clear();

    // Close all active transports (streamable HTTP)
    for (const [sessionId, transport] of this.transports) {
      try {
        await transport.close();
      } catch {
        // Ignore
      }
      this.transports.delete(sessionId);
    }

    // Close SSE transports
    for (const [sessionId, transport] of this.sseTransports) {
      try {
        await transport.close?.();
      } catch {
        // Ignore
      }
      this.sseTransports.delete(sessionId);
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.port = null;
    this.startedAt = null;
    this.sessionBinder.clear();
    console.log('[McpServerService] Disposed');
  }

  // ==========================================================================
  // HTTP REQUEST HANDLER
  // ==========================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- SSE transport routes (for Claude Desktop) ----
    if (url.pathname === '/sse' && req.method === 'GET') {
      await this.handleSseConnect(req, res);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sseSessionId = url.searchParams.get('sessionId');
      if (sseSessionId && this.sseTransports.has(sseSessionId)) {
        this.lastActivity.set(sseSessionId, Date.now());
        await this.sseTransports.get(sseSessionId)!.handlePostMessage(req, res);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown SSE session' }));
      return;
    }

    // ---- Streamable HTTP transport route (for Claude Code) ----
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session transport
    if (sessionId && this.transports.has(sessionId)) {
      this.lastActivity.set(sessionId, Date.now());
      await this.transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    // New connection — only POST (initialize) can create a new session
    if (req.method === 'POST' && !sessionId) {
      await this.createSessionAndHandle(req, res);
      return;
    }

    // Unknown session or invalid request
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request: No valid session' }));
  }

  private async createSessionAndHandle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const McpServerClass = _McpServer!;
    const TransportClass = _StreamableHTTPServerTransport!;

    // Create per-connection MCP server + transport (stateful mode)
    const mcpServer = new McpServerClass({
      name: 'kit',
      version: '1.0.0',
    });

    const transport = new TransportClass({
      sessionIdGenerator: () => randomUUID(),
    });

    // Register tools and resources on this server instance
    const { registerTools } = await import('./mcp/tools');
    const { registerResources } = await import('./mcp/resources');
    registerTools(mcpServer, this.sessionBinder, this.deps, this);
    registerResources(mcpServer, this.sessionBinder, this.deps);

    // Connect server to transport
    await mcpServer.connect(transport);

    // Track transport; clean up when session closes
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.transports.delete(sid);
        this.lastActivity.delete(sid);
        console.log(`[McpServerService] Session closed: ${sid} (${this.transports.size} active)`);
      }
    };

    // Handle the initial request — session ID header will be set in the response
    await transport.handleRequest(req, res);

    // After handling, store by the session ID the transport assigned
    const sid = transport.sessionId;
    if (sid) {
      this.transports.set(sid, transport);
      this.lastActivity.set(sid, Date.now());
      console.log(`[McpServerService] New session: ${sid} (${this.transports.size} active)`);
    }
  }

  // ==========================================================================
  // SSE TRANSPORT (Claude Desktop compatibility)
  // ==========================================================================

  private async handleSseConnect(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const McpServerClass = _McpServer!;
    const SseTransportClass = _SSEServerTransport!;

    const mcpServer = new McpServerClass({
      name: 'kit',
      version: '1.0.0',
    });

    // SSE transport: client GETs /sse, POSTs to /messages?sessionId=xxx
    const transport = new SseTransportClass('/messages', res);

    // Register tools and resources
    const { registerTools } = await import('./mcp/tools');
    const { registerResources } = await import('./mcp/resources');
    registerTools(mcpServer, this.sessionBinder, this.deps, this);
    registerResources(mcpServer, this.sessionBinder, this.deps);

    await mcpServer.connect(transport);

    // Track by the transport's session ID
    const sid = (transport as any)._sessionId as string;
    if (sid) {
      this.sseTransports.set(sid, transport);
      this.lastActivity.set(sid, Date.now());
      console.log(`[McpServerService] SSE session opened: ${sid} (${this.sseTransports.size} active)`);
    }

    transport.onclose = () => {
      if (sid) {
        this.sseTransports.delete(sid);
        this.lastActivity.delete(sid);
        console.log(`[McpServerService] SSE session closed: ${sid} (${this.sseTransports.size} active)`);
      }
    };
  }

  /** Remove transports that haven't seen any activity within the timeout window */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    const timeout = McpServerService.SESSION_TIMEOUT_MS;
    let cleaned = 0;

    for (const [sid, lastTime] of this.lastActivity) {
      if (now - lastTime > timeout) {
        if (this.transports.has(sid)) {
          try { this.transports.get(sid)!.close?.(); } catch { /* ignore */ }
          this.transports.delete(sid);
        }
        if (this.sseTransports.has(sid)) {
          try { this.sseTransports.get(sid)!.close?.(); } catch { /* ignore */ }
          this.sseTransports.delete(sid);
        }
        this.lastActivity.delete(sid);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[McpServerService] Cleaned ${cleaned} stale session(s) (${this.transports.size + this.sseTransports.size} active)`);
    }
  }

  // ==========================================================================
  // STATUS
  // ==========================================================================

  getPort(): number | null {
    return this.port;
  }

  getUrl(): string | null {
    if (!this.port) return null;
    return `http://${MCP_SERVER_HOST}:${this.port}/mcp`;
  }

  getStatus(): McpServerStatus {
    return {
      port: this.port,
      url: this.getUrl(),
      isRunning: this.httpServer !== null && this.httpServer.listening,
      connectionCount: this.transports.size + this.sseTransports.size,
      startedAt: this.startedAt,
    };
  }

  // ==========================================================================
  // MCP CONFIG INSTALL/UNINSTALL (Claude Code CLI + Claude Desktop)
  // ==========================================================================

  private getConfigPath(target: McpInstallTarget): string {
    if (target === 'claude-desktop') {
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    // Claude Code CLI reads MCP config from ~/.claude.json (per-project structure)
    return join(homedir(), '.claude.json');
  }

  private async readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(filePath, JSON.stringify(data, null, 2));
  }

  private getSseUrl(): string | null {
    if (!this.port) return null;
    return `http://${MCP_SERVER_HOST}:${this.port}/sse`;
  }

  /**
   * Resolve the full path to npx, ensuring Node 18+ is used.
   * Claude Desktop may pick an old nvm version (e.g. Node 16) from PATH,
   * which crashes mcp-remote due to missing ReadableStream global.
   */
  private resolveNpxPath(): string {
    try {
      // Use the current process's node to find npx in the same bin dir
      const binDir = require('path').dirname(process.execPath);
      const npxCandidate = join(binDir, 'npx');
      if (existsSync(npxCandidate)) {
        return npxCandidate;
      }
      // Fallback: resolve from shell
      const { execSync } = require('child_process');
      const resolved = execSync('which npx', { encoding: 'utf-8' }).trim();
      if (resolved) return resolved;
    } catch {
      // ignore
    }
    return 'npx';
  }

  async installMcpConfig(target: McpInstallTarget): Promise<{ success: boolean; path: string; error?: string }> {
    const url = target === 'claude-desktop' ? this.getSseUrl() : this.getUrl();
    if (!url) {
      return { success: false, path: '', error: 'MCP server is not running' };
    }

    const configPath = this.getConfigPath(target);
    try {
      const settings = await this.readJsonFile(configPath);

      if (target === 'claude-desktop') {
        // Claude Desktop: top-level mcpServers with stdio bridge
        const mcpServers = (settings.mcpServers as Record<string, unknown>) || {};
        const npxPath = this.resolveNpxPath();
        const nodeBinDir = require('path').dirname(npxPath);
        mcpServers.kit = {
          command: npxPath,
          args: ['-y', 'mcp-remote', url],
          env: {
            PATH: `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`,
          },
        };
        settings.mcpServers = mcpServers;
      } else {
        // Claude Code CLI: per-project mcpServers in ~/.claude.json
        // Also install globally so it works for any project opened in this repo
        const projects = (settings.projects as Record<string, any>) || {};
        // Install for all registered sessions' repo paths
        const allSessions = this.sessionBinder.listSessions();
        const repoPaths = new Set<string>();
        for (const session of allSessions) {
          repoPaths.add(session.worktreePath);
        }
        // Also install a global-level entry (some Claude Code versions support this)
        if (!settings.mcpServers) settings.mcpServers = {};
        (settings.mcpServers as Record<string, unknown>).kit = { type: 'http', url };

        for (const repoPath of repoPaths) {
          if (!projects[repoPath]) projects[repoPath] = {};
          if (!projects[repoPath].mcpServers) projects[repoPath].mcpServers = {};
          projects[repoPath].mcpServers.kit = { type: 'http', url };
        }
        settings.projects = projects;
      }

      await this.writeJsonFile(configPath, settings);

      console.log(`[McpServerService] Installed KIT MCP config to ${configPath} (${target})`);
      return { success: true, path: configPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[McpServerService] Failed to install ${target} config: ${message}`);
      return { success: false, path: configPath, error: message };
    }
  }

  async uninstallMcpConfig(target: McpInstallTarget): Promise<{ success: boolean; error?: string }> {
    const configPath = this.getConfigPath(target);
    try {
      const settings = await this.readJsonFile(configPath);

      if (target === 'claude-desktop') {
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && 'kit' in mcpServers) {
          delete mcpServers.kit;
          settings.mcpServers = mcpServers;
        }
      } else {
        // Claude Code: remove from top-level and all project entries
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && 'kit' in mcpServers) delete mcpServers.kit;
        const projects = settings.projects as Record<string, any> | undefined;
        if (projects) {
          for (const proj of Object.values(projects)) {
            if (proj?.mcpServers?.kit) delete proj.mcpServers.kit;
          }
        }
      }

      await this.writeJsonFile(configPath, settings);
      console.log(`[McpServerService] Removed KIT from ${target} config`);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async checkMcpConfig(target: McpInstallTarget): Promise<McpInstallConfigStatus> {
    const configPath = this.getConfigPath(target);
    try {
      const settings = await this.readJsonFile(configPath);
      let kit: { url?: string; args?: string[]; type?: string } | undefined;

      if (target === 'claude-desktop') {
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        kit = mcpServers?.kit as typeof kit;
      } else {
        // Claude Code: check top-level mcpServers first, then any project entry
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        kit = mcpServers?.kit as typeof kit;
        if (!kit) {
          const projects = settings.projects as Record<string, any> | undefined;
          if (projects) {
            for (const proj of Object.values(projects)) {
              if (proj?.mcpServers?.kit) {
                kit = proj.mcpServers.kit;
                break;
              }
            }
          }
        }
      }

      if (!kit) {
        return { installed: false, path: configPath, currentUrl: null, portMismatch: false };
      }

      const currentUrl = kit.url || kit.args?.find(a => a.startsWith('http')) || null;
      const liveUrl = target === 'claude-desktop' ? this.getSseUrl() : this.getUrl();
      const portMismatch = !!liveUrl && !!currentUrl && currentUrl !== liveUrl;

      return { installed: true, path: configPath, currentUrl, portMismatch };
    } catch {
      return { installed: false, path: configPath, currentUrl: null, portMismatch: false };
    }
  }

  // Convenience wrappers for backward compat with existing IPC handlers
  async installForClaudeCode(): Promise<{ success: boolean; path: string; error?: string }> {
    return this.installMcpConfig('claude-code');
  }
  async uninstallFromClaudeCode(): Promise<{ success: boolean; error?: string }> {
    return this.uninstallMcpConfig('claude-code');
  }
  async checkClaudeCodeConfig(): Promise<McpInstallConfigStatus> {
    return this.checkMcpConfig('claude-code');
  }
}
