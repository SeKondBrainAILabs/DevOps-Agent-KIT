/**
 * McpServerService Unit Tests
 *
 * Tests service lifecycle, port detection, status, disposal, and the
 * per-connection transport pattern that prevents the SDK "stateless transport
 * cannot be reused" error on second requests.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock detect-port
jest.mock('detect-port', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// Mock MCP SDK server
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn(),
}));

// Mock transport — each call to constructor produces a fresh instance
// so we can verify per-connection behaviour
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(),
}));

// Mock tools and resources registration
jest.mock('../../../electron/services/mcp/tools', () => ({
  registerTools: jest.fn(),
}));

jest.mock('../../../electron/services/mcp/resources', () => ({
  registerResources: jest.fn(),
}));

// Mock http
jest.mock('http', () => ({
  createServer: jest.fn(),
}));

import { McpServerService } from '../../../electron/services/McpServerService';

/** Build a fresh transport mock and return it plus a jest-controlled sessionId */
function makeTransportMock(sessionId: string) {
  return {
    sessionId,
    // Call res.end() to simulate a real HTTP response so simulateRequest resolves
    handleRequest: jest.fn().mockImplementation((_req: any, res: any) => {
      res.end('{}');
      return Promise.resolve(undefined);
    }),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onclose: null as (() => void) | null,
  };
}

describe('McpServerService', () => {
  let service: McpServerService;

  let mockDetectPort: any;
  let mockHttpServerInstance: any;
  let transportCtorMock: any;
  let mcpServerCtorMock: any;

  // Queue of transport instances returned by the constructor
  let transportQueue: ReturnType<typeof makeTransportMock>[];

  beforeEach(() => {
    jest.clearAllMocks();
    transportQueue = [];

    mockDetectPort = require('detect-port').default;
    mockDetectPort.mockResolvedValue(39100);

    // Each new transport comes from the queue
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    transportCtorMock = StreamableHTTPServerTransport;
    transportCtorMock.mockImplementation(() => {
      const t = transportQueue.shift() ?? makeTransportMock(`auto-${Math.random()}`);
      return t;
    });

    // McpServer mock
    const mcpServerInstance = {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      tool: jest.fn(),
      resource: jest.fn(),
    };
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    mcpServerCtorMock = McpServer;
    mcpServerCtorMock.mockImplementation(() => mcpServerInstance);

    // HTTP server mock — captures the request handler
    mockHttpServerInstance = {
      listen: jest.fn((_port: number, _host: string, cb: () => void) => cb()),
      close: jest.fn((cb: () => void) => cb()),
      on: jest.fn(),
      listening: true,
      _handler: null as ((req: any, res: any) => void) | null,
    };
    const http = require('http');
    http.createServer.mockImplementation((handler: any) => {
      mockHttpServerInstance._handler = handler;
      return mockHttpServerInstance;
    });

    service = new McpServerService();
  });

  /** Simulate an HTTP request through the server's handler */
  async function simulateRequest(
    method: string,
    sessionId?: string,
    path = '/mcp'
  ): Promise<{ status: number; body: string }> {
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      let status = 200;
      let body = '';
      const res = {
        headersSent: false,
        setHeader: jest.fn(),
        writeHead: (s: number) => { status = s; },
        end: (b?: string) => { body = b || ''; resolve({ status, body }); },
      };
      const headers: Record<string, string> = {};
      if (sessionId) headers['mcp-session-id'] = sessionId;

      const req = { url: path, method, headers };
      mockHttpServerInstance._handler!(req, res);
    });

    // Flush pending microtasks so post-response async work (e.g. storing session in map) completes
    await Promise.resolve();
    await Promise.resolve();
    return result;
  }

  describe('before initialization', () => {
    it('should return null port', () => {
      expect(service.getPort()).toBeNull();
    });

    it('should return null URL', () => {
      expect(service.getUrl()).toBeNull();
    });

    it('should report not running', () => {
      const status = service.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.port).toBeNull();
      expect(status.startedAt).toBeNull();
    });
  });

  describe('initialization', () => {
    it('should detect a free port and start', async () => {
      await service.initialize();
      expect(service.getPort()).toBe(39100);
    });

    it('should build the correct URL', async () => {
      await service.initialize();
      expect(service.getUrl()).toBe('http://127.0.0.1:39100/mcp');
    });

    it('should bind to 127.0.0.1 only', async () => {
      await service.initialize();
      expect(mockHttpServerInstance.listen).toHaveBeenCalledWith(39100, '127.0.0.1', expect.any(Function));
    });

    it('should report running status after init', async () => {
      await service.initialize();
      const status = service.getStatus();
      expect(status.port).toBe(39100);
      expect(status.startedAt).toBeDefined();
    });

    it('should NOT register tools at init time (deferred to per-connection)', async () => {
      const { registerTools } = require('../../../electron/services/mcp/tools');
      const { registerResources } = require('../../../electron/services/mcp/resources');

      await service.initialize();

      // Tools/resources are registered per connection, not at startup
      expect(registerTools).not.toHaveBeenCalled();
      expect(registerResources).not.toHaveBeenCalled();
    });
  });

  describe('per-connection transport (regression for 500-on-second-request)', () => {
    /**
     * This is the bug that was missed by the previous test suite:
     * In stateless mode, the SDK throws "Stateless transport cannot be reused
     * across requests" on the second request. Each new client (POST without
     * mcp-session-id) must get its OWN transport + McpServer pair.
     */
    it('should create a new transport for each new connection (POST without session-id)', async () => {
      const t1 = makeTransportMock('session-aaa');
      const t2 = makeTransportMock('session-bbb');
      transportQueue.push(t1, t2);

      await service.initialize();

      // First connection
      await simulateRequest('POST');
      expect(t1.handleRequest).toHaveBeenCalledTimes(1);

      // Second connection — must get a DIFFERENT transport, not reuse t1
      await simulateRequest('POST');
      expect(t2.handleRequest).toHaveBeenCalledTimes(1);

      // t1 should NOT have been called again
      expect(t1.handleRequest).toHaveBeenCalledTimes(1);
    });

    it('should register tools+resources on every new connection', async () => {
      const { registerTools } = require('../../../electron/services/mcp/tools');
      const { registerResources } = require('../../../electron/services/mcp/resources');

      transportQueue.push(makeTransportMock('s1'), makeTransportMock('s2'));
      await service.initialize();

      await simulateRequest('POST');
      await simulateRequest('POST');

      expect(registerTools).toHaveBeenCalledTimes(2);
      expect(registerResources).toHaveBeenCalledTimes(2);
    });

    it('should create a separate McpServer per connection', async () => {
      transportQueue.push(makeTransportMock('s1'), makeTransportMock('s2'));
      await service.initialize();

      await simulateRequest('POST');
      await simulateRequest('POST');

      expect(mcpServerCtorMock).toHaveBeenCalledTimes(2);
    });

    it('should route follow-up requests to the existing transport by session-id', async () => {
      const t1 = makeTransportMock('session-xyz');
      transportQueue.push(t1);

      await service.initialize();

      // New connection
      await simulateRequest('POST');
      expect(t1.handleRequest).toHaveBeenCalledTimes(1);

      // Follow-up (GET for SSE) with same session ID — must reuse t1
      await simulateRequest('GET', 'session-xyz');
      expect(t1.handleRequest).toHaveBeenCalledTimes(2);

      // No new transport should have been created
      expect(transportCtorMock).toHaveBeenCalledTimes(1);
    });

    it('should return 400 for requests with unknown session-id', async () => {
      await service.initialize();
      const result = await simulateRequest('GET', 'nonexistent-session');
      expect(result.status).toBe(400);
    });
  });

  describe('port detection failure', () => {
    it('should set port to null on failure', async () => {
      mockDetectPort.mockRejectedValueOnce(new Error('Port detection failed'));

      await expect(service.initialize()).rejects.toThrow('Port detection failed');
      expect(service.getPort()).toBeNull();
    });
  });

  describe('dispose', () => {
    it('should close the HTTP server', async () => {
      await service.initialize();
      await service.dispose();
      expect(mockHttpServerInstance.close).toHaveBeenCalled();
    });

    it('should close all active session transports on dispose', async () => {
      const t1 = makeTransportMock('s1');
      const t2 = makeTransportMock('s2');
      transportQueue.push(t1, t2);

      await service.initialize();
      await simulateRequest('POST'); // creates t1 session
      await simulateRequest('POST'); // creates t2 session

      await service.dispose();

      expect(t1.close).toHaveBeenCalled();
      expect(t2.close).toHaveBeenCalled();
    });

    it('should reset port and status after dispose', async () => {
      await service.initialize();
      await service.dispose();

      expect(service.getPort()).toBeNull();
      expect(service.getUrl()).toBeNull();
    });

    it('should clear session binder on dispose', async () => {
      await service.initialize();
      service.sessionBinder.registerSession('sess_test', '/tmp');
      expect(service.sessionBinder.listSessions()).toHaveLength(1);

      await service.dispose();
      expect(service.sessionBinder.listSessions()).toHaveLength(0);
    });
  });

  describe('non-/mcp paths', () => {
    it('should return 404 for unknown paths', async () => {
      await service.initialize();
      const result = await simulateRequest('GET', undefined, '/other');
      expect(result.status).toBe(404);
    });

    it('should return 204 for OPTIONS (CORS preflight)', async () => {
      await service.initialize();
      const result = await simulateRequest('OPTIONS');
      expect(result.status).toBe(204);
    });
  });

  describe('dependency setters', () => {
    it('should accept service dependencies', () => {
      const mockGit = {
        commit: jest.fn() as any,
        push: jest.fn() as any,
        getStatus: jest.fn() as any,
        getCommitHistory: jest.fn() as any,
      };
      const mockActivity = { log: jest.fn() as any };

      service.setGitService(mockGit);
      service.setActivityService(mockActivity);

      const deps = service.getDeps();
      expect(deps.gitService).toBe(mockGit);
      expect(deps.activityService).toBe(mockActivity);
    });
  });

  describe('session binder', () => {
    it('should expose session binder for external registration', () => {
      expect(service.sessionBinder).toBeDefined();
      service.sessionBinder.registerSession('sess_1', '/worktree/1');
      expect(service.sessionBinder.getWorktreePath('sess_1')).toBe('/worktree/1');
    });
  });
});
