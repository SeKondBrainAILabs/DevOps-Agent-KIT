/**
 * MCP Resources Unit Tests
 *
 * Tests resource handlers by calling registerResources with mock services.
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';
import type { McpServiceDeps } from '../../../electron/services/McpServerService';

// Mock fs functions
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}));

import { existsSync, readFileSync, readdirSync } from 'fs';

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;

// Capture resource registrations
const registeredResources: Map<string, { handler: Function }> = new Map();

const mockMcpServer = {
  tool: jest.fn(),
  resource: jest.fn((name: string, _uriTemplate: string, _meta: any, handler: Function) => {
    registeredResources.set(name, { handler });
  }),
};

let registerResources: typeof import('../../../electron/services/mcp/resources').registerResources;

beforeAll(async () => {
  const mod = await import('../../../electron/services/mcp/resources');
  registerResources = mod.registerResources;
});

describe('MCP Resources', () => {
  let binder: McpSessionBinder;
  let deps: any;

  beforeEach(() => {
    registeredResources.clear();
    jest.clearAllMocks();

    binder = new McpSessionBinder();
    binder.registerSession('sess_test_123', '/tmp/worktree-test');

    deps = {
      gitService: {
        commit: jest.fn() as any,
        push: jest.fn() as any,
        getStatus: jest.fn() as any,
        getCommitHistory: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: [
            { hash: 'abc123', shortHash: 'abc123', message: 'test commit', author: 'dev', date: '2026-01-01', filesChanged: 1 },
          ],
        }),
      },
      agentInstanceService: {
        listInstances: (jest.fn() as any).mockReturnValue({
          success: true,
          data: [{
            sessionId: 'sess_test_123',
            config: {
              agentType: 'claude',
              branchName: 'feat/test',
              baseBranch: 'main',
              taskDescription: 'Test task',
              repoPath: '/repo',
            },
            createdAt: '2026-01-01T00:00:00Z',
          }],
        }),
      },
    };

    registerResources(mockMcpServer as any, binder, deps);
  });

  function callResource(name: string, uriHref: string) {
    const resource = registeredResources.get(name);
    if (!resource) throw new Error(`Resource ${name} not registered`);
    return resource.handler(new URL(uriHref));
  }

  function parseJsonResult(result: any): any {
    return JSON.parse(result.contents[0].text);
  }

  // ==========================================================================
  // session-info
  // ==========================================================================
  describe('session-info', () => {
    it('should register the resource', () => {
      expect(registeredResources.has('session-info')).toBe(true);
    });

    it('should return correct session shape', async () => {
      const result = await callResource('session-info', 'kanvas://session/sess_test_123/info');
      const data = parseJsonResult(result);

      expect(data.sessionId).toBe('sess_test_123');
      expect(data.worktreePath).toBe('/tmp/worktree-test');
      expect(data.agentType).toBe('claude');
      expect(data.branchName).toBe('feat/test');
    });

    it('should return error for unknown session', async () => {
      const result = await callResource('session-info', 'kanvas://session/unknown_sess/info');
      const data = parseJsonResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });

  // ==========================================================================
  // houserules
  // ==========================================================================
  describe('houserules', () => {
    it('should register the resource', () => {
      expect(registeredResources.has('houserules')).toBe(true);
    });

    it('should read from worktree root first', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        return String(p) === '/tmp/worktree-test/houserules.md';
      });
      mockReadFileSync.mockReturnValue('# Team Rules\n- Use TypeScript');

      const result = await callResource('houserules', 'kanvas://session/sess_test_123/houserules');
      expect(result.contents[0].text).toBe('# Team Rules\n- Use TypeScript');
      expect(result.contents[0].mimeType).toBe('text/markdown');
    });

    it('should fallback to .S9N_KIT_DevOpsAgent/houserules.md', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        return String(p) === '/tmp/worktree-test/.S9N_KIT_DevOpsAgent/houserules.md';
      });
      mockReadFileSync.mockReturnValue('# Fallback Rules');

      const result = await callResource('houserules', 'kanvas://session/sess_test_123/houserules');
      expect(result.contents[0].text).toBe('# Fallback Rules');
    });

    it('should return no-rules message when neither exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await callResource('houserules', 'kanvas://session/sess_test_123/houserules');
      expect(result.contents[0].text).toContain('No House Rules');
    });
  });

  // ==========================================================================
  // contracts
  // ==========================================================================
  describe('contracts', () => {
    it('should register the resource', () => {
      expect(registeredResources.has('contracts')).toBe(true);
    });

    it('should list contract files', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        'API_CONTRACT.md',
        'DATABASE_SCHEMA_CONTRACT.md',
        'somefile.txt',
        'SQL_CONTRACT.json',
      ] as any);

      const result = await callResource('contracts', 'kanvas://session/sess_test_123/contracts');
      const data = parseJsonResult(result);

      expect(data.files).toHaveLength(3); // Only .md and .json
      expect(data.files).toContain('API_CONTRACT.md');
      expect(data.files).toContain('SQL_CONTRACT.json');
      expect(data.files).not.toContain('somefile.txt');
    });

    it('should return empty list when directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await callResource('contracts', 'kanvas://session/sess_test_123/contracts');
      const data = parseJsonResult(result);
      expect(data.files).toEqual([]);
    });
  });

  // ==========================================================================
  // commits
  // ==========================================================================
  describe('commits', () => {
    it('should register the resource', () => {
      expect(registeredResources.has('commits')).toBe(true);
    });

    it('should return commit history', async () => {
      const result = await callResource('commits', 'kanvas://session/sess_test_123/commits');
      const data = parseJsonResult(result);

      expect(data.commits).toHaveLength(1);
      expect(data.commits[0].message).toBe('test commit');
    });

    it('should return empty commits for unknown session', async () => {
      const result = await callResource('commits', 'kanvas://session/unknown_sess/commits');
      const data = parseJsonResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });
});
