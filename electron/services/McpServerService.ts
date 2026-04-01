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
import type { McpServerStatus, ClaudeCodeConfigStatus } from '../../shared/mcp-types';

// Lazy imports for MCP SDK (ESM modules)
let _McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer | null = null;
let _StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport | null = null;

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

  readonly sessionBinder = new McpSessionBinder();
  private deps: McpServiceDeps = {};

  // MCP call log for debug observability
  private mcpCallLog: McpCallLogEntry[] = [];

  getMcpCallLog(limit = 50): McpCallLogEntry[] {
    return this.mcpCallLog.slice(-limit);
  }

  addCallLogEntry(entry: McpCallLogEntry): void {
    this.mcpCallLog.push(entry);
    if (this.mcpCallLog.length > 200) {
      this.mcpCallLog.shift();
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
    // Close all active transports
    for (const [sessionId, transport] of this.transports) {
      try {
        await transport.close();
      } catch {
        // Ignore
      }
      this.transports.delete(sessionId);
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
    // Only handle /mcp path
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session transport
    if (sessionId && this.transports.has(sessionId)) {
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
      name: 'kanvas',
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
        console.log(`[McpServerService] Session closed: ${sid} (${this.transports.size} active)`);
      }
    };

    // Handle the initial request — session ID header will be set in the response
    await transport.handleRequest(req, res);

    // After handling, store by the session ID the transport assigned
    const sid = transport.sessionId;
    if (sid) {
      this.transports.set(sid, transport);
      console.log(`[McpServerService] New session: ${sid} (${this.transports.size} active)`);
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
      connectionCount: this.transports.size,
      startedAt: this.startedAt,
    };
  }

  // ==========================================================================
  // CLAUDE CODE CONFIG MANAGEMENT
  // ==========================================================================

  private getClaudeSettingsPath(): string {
    return join(homedir(), '.claude', 'settings.json');
  }

  private async readClaudeSettings(): Promise<Record<string, unknown>> {
    const settingsPath = this.getClaudeSettingsPath();
    try {
      const content = await readFile(settingsPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async writeClaudeSettings(settings: Record<string, unknown>): Promise<void> {
    const settingsPath = this.getClaudeSettingsPath();
    const claudeDir = join(homedir(), '.claude');
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  async installForClaudeCode(): Promise<{ success: boolean; path: string; error?: string }> {
    const url = this.getUrl();
    if (!url) {
      return { success: false, path: '', error: 'MCP server is not running' };
    }

    try {
      const settings = await this.readClaudeSettings();
      const mcpServers = (settings.mcpServers as Record<string, unknown>) || {};
      mcpServers.kanvas = {
        type: 'streamable-http',
        url,
      };
      settings.mcpServers = mcpServers;
      await this.writeClaudeSettings(settings);

      const path = this.getClaudeSettingsPath();
      console.log(`[McpServerService] Installed Kanvas MCP config to ${path}`);
      return { success: true, path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[McpServerService] Failed to install Claude Code config: ${message}`);
      return { success: false, path: this.getClaudeSettingsPath(), error: message };
    }
  }

  async uninstallFromClaudeCode(): Promise<{ success: boolean; error?: string }> {
    try {
      const settings = await this.readClaudeSettings();
      const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
      if (mcpServers && 'kanvas' in mcpServers) {
        delete mcpServers.kanvas;
        settings.mcpServers = mcpServers;
        await this.writeClaudeSettings(settings);
        console.log('[McpServerService] Removed Kanvas MCP config from Claude Code settings');
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async checkClaudeCodeConfig(): Promise<ClaudeCodeConfigStatus> {
    const path = this.getClaudeSettingsPath();
    try {
      const settings = await this.readClaudeSettings();
      const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
      const kanvas = mcpServers?.kanvas as { url?: string } | undefined;

      if (!kanvas) {
        return { installed: false, path, currentUrl: null, portMismatch: false };
      }

      const currentUrl = kanvas.url || null;
      const liveUrl = this.getUrl();
      const portMismatch = !!liveUrl && !!currentUrl && currentUrl !== liveUrl;

      return { installed: true, path, currentUrl, portMismatch };
    } catch {
      return { installed: false, path, currentUrl: null, portMismatch: false };
    }
  }
}
