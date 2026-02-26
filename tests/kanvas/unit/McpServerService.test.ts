/**
 * McpServerService Unit Tests
 *
 * Tests service lifecycle, port detection, status, and disposal.
 * Note: These tests mock the MCP SDK and HTTP server to avoid actual network binding.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock detect-port
jest.mock('detect-port', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// Mock MCP SDK server — store mocks inside the factory closure
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn(),
}));

// Mock transport
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

// Now import the class under test — mocks are in place
import { McpServerService } from '../../../electron/services/McpServerService';

describe('McpServerService', () => {
  let service: McpServerService;

  // Mock handles — retrieved via require after jest.mock hoisting
  let mockDetectPort: any;
  let mockMcpServerInstance: any;
  let mockTransportInstance: any;
  let mockHttpServerInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up detect-port
    mockDetectPort = require('detect-port').default;
    mockDetectPort.mockResolvedValue(39100);

    // Set up MCP Server mock
    mockMcpServerInstance = {
      connect: jest.fn(),
      close: jest.fn(),
      tool: jest.fn(),
      resource: jest.fn(),
    };
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    McpServer.mockImplementation(() => mockMcpServerInstance);

    // Set up transport mock
    mockTransportInstance = {
      close: jest.fn(),
      handleRequest: jest.fn(),
    };
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    StreamableHTTPServerTransport.mockImplementation(() => mockTransportInstance);

    // Set up HTTP server mock
    mockHttpServerInstance = {
      listen: jest.fn((_port: number, _host: string, cb: () => void) => cb()),
      close: jest.fn((cb: () => void) => cb()),
      on: jest.fn(),
      listening: true,
    };
    const http = require('http');
    http.createServer.mockReturnValue(mockHttpServerInstance);

    service = new McpServerService();
  });

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

    it('should register tools and resources', async () => {
      const { registerTools } = require('../../../electron/services/mcp/tools');
      const { registerResources } = require('../../../electron/services/mcp/resources');

      await service.initialize();
      expect(registerTools).toHaveBeenCalledTimes(1);
      expect(registerResources).toHaveBeenCalledTimes(1);
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
    it('should close HTTP server', async () => {
      await service.initialize();
      await service.dispose();

      expect(mockHttpServerInstance.close).toHaveBeenCalled();
    });

    it('should close transport', async () => {
      await service.initialize();
      await service.dispose();

      expect(mockTransportInstance.close).toHaveBeenCalled();
    });

    it('should close MCP server', async () => {
      await service.initialize();
      await service.dispose();

      expect(mockMcpServerInstance.close).toHaveBeenCalled();
    });

    it('should reset port and status after dispose', async () => {
      await service.initialize();
      await service.dispose();

      expect(service.getPort()).toBeNull();
      expect(service.getUrl()).toBeNull();
    });

    it('should clear session binder', async () => {
      await service.initialize();
      service.sessionBinder.registerSession('sess_test', '/tmp');
      expect(service.sessionBinder.listSessions()).toHaveLength(1);

      await service.dispose();
      expect(service.sessionBinder.listSessions()).toHaveLength(0);
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
