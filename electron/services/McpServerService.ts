/**
 * MCP Server Service
 *
 * Extends BaseService. Runs an HTTP-based MCP server on localhost
 * so coding agents (Claude Code, Cursor, etc.) can interact with Kanvas
 * via a proper tool interface.
 *
 * Transport: Streamable HTTP (POST /mcp, GET /mcp for SSE, DELETE /mcp)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server } from 'http';
import { BaseService } from './BaseService';
import { McpSessionBinder } from './mcp/session-binder';
import { MCP_DEFAULT_PORT_START, MCP_SERVER_HOST } from '../../shared/mcp-types';
import type { McpServerStatus } from '../../shared/mcp-types';

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
  private mcpServer: InstanceType<typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer> | null = null;
  private transport: InstanceType<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport> | null = null;
  private port: number | null = null;
  private startedAt: string | null = null;

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

      // Create MCP server instance
      const McpServerClass = await getMcpServer();
      this.mcpServer = new McpServerClass({
        name: 'kanvas',
        version: '1.0.0',
      });

      // Register tools and resources
      const { registerTools } = await import('./mcp/tools');
      const { registerResources } = await import('./mcp/resources');
      registerTools(this.mcpServer, this.sessionBinder, this.deps, this);
      registerResources(this.mcpServer, this.sessionBinder, this.deps);

      // Create transport
      const TransportClass = await getTransport();
      this.transport = new TransportClass({
        sessionIdGenerator: undefined, // Use default UUID generator
      });

      // Connect MCP server to transport
      await this.mcpServer.connect(this.transport);

      // Create HTTP server
      this.httpServer = createServer((req, res) => this.handleRequest(req, res));

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.listen(this.port, MCP_SERVER_HOST, () => {
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
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.transport = null;
    }

    if (this.mcpServer) {
      try {
        await this.mcpServer.close();
      } catch {
        // Ignore close errors
      }
      this.mcpServer = null;
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

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Delegate to transport
    if (!this.transport) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP server not ready' }));
      return;
    }

    // The StreamableHTTPServerTransport handles POST (RPC), GET (SSE), DELETE (close)
    this.transport.handleRequest(req, res);
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
      connectionCount: this.sessionBinder.getConnectionCount(),
      startedAt: this.startedAt,
    };
  }
}
