/**
 * MCP toolkit exclude and setup_changes tests (KC-S3.1.5 AC2)
 *
 * Tests that:
 * 1. kit_commit accepts `exclude` parameter and passes it to gitService.commit
 * 2. kit_start_session's response includes `setup_changes` parsed from git status --porcelain
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// Mock ALL dependencies of tools.ts
function zodChain(): any {
  const c: any = {};
  ['string', 'number', 'boolean', 'array', 'object', 'enum', 'record',
    'optional', 'default', 'describe', 'unknown', 'int', 'min', 'max'].forEach(m => { c[m] = (..._a: any[]) => zodChain(); });
  c.then = undefined;
  return c;
}
jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

// Capture tool registrations
const registeredTools: Map<string, { schema: any; handler: Function }> = new Map();

const mockMcpServer = {
  tool: jest.fn((name: string, _desc: string, schema: any, handler: Function) => {
    registeredTools.set(name, { schema, handler });
  }),
  resource: jest.fn(),
};

// Import after mocks are set up
const { registerTools } = require('../../../electron/services/mcp/tools');

describe('MCP Tools - exclude and setup_changes', () => {
  let binder: McpSessionBinder;
  let deps: any;
  let mockGitService: any;
  let mockActivityService: any;
  let mockLockService: any;
  let mockDatabaseService: any;
  let mockAgentInstanceService: any;

  beforeEach(() => {
    registeredTools.clear();
    jest.clearAllMocks();

    binder = new McpSessionBinder();
    binder.registerSession('sess_test_123', '/tmp/worktree-test');

    mockGitService = {
      commit: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 2, files: [{ path: 'src/file.ts', status: 'added' }] },
      }),
      push: (jest.fn() as any).mockResolvedValue({ success: true }),
      getStatus: (jest.fn() as any).mockResolvedValue({ success: true, data: {} }),
      getCommitHistory: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: [],
      }),
      getCurrentBranchName: (jest.fn() as any).mockResolvedValue('feat/test'),
      // For kit_start_session setup_changes
      getPendingChanges: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: ['houserules.md', 'FOLDER_STRUCTURE.md', '.vscode/settings.json'],
      }),
    };

    mockActivityService = { log: jest.fn() };

    mockLockService = {
      checkConflicts: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
      declareFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
      releaseFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
      forceReleaseLock: (jest.fn() as any).mockResolvedValue({ success: true }),
    };

    mockDatabaseService = {
      recordCommit: jest.fn(),
      recordSessionEvent: jest.fn(),
    };

    mockAgentInstanceService = {
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
    };

    deps = {
      gitService: mockGitService,
      activityService: mockActivityService,
      lockService: mockLockService,
      databaseService: mockDatabaseService,
      agentInstanceService: mockAgentInstanceService,
    };

    registerTools(mockMcpServer as any, binder, deps);
  });

  function callTool(name: string, args: Record<string, any>) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    // Default cwd to the session's worktree
    if (args.cwd === undefined && args.session_id) {
      const wt = binder.getWorktreePathForRepo(args.session_id, args.repo);
      if (wt) args = { ...args, cwd: wt };
    }
    return tool.handler(args);
  }

  function parseResult(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  // ==========================================================================
  // kit_commit - exclude parameter
  // ==========================================================================
  describe('kit_commit - exclude parameter', () => {
    it('should register the tool with exclude schema', () => {
      expect(registeredTools.has('kit_commit')).toBe(true);
      const tool = registeredTools.get('kit_commit')!;
      // The schema should have an exclude field
      expect(tool.schema).toHaveProperty('exclude');
    });

    it('should pass exclude array to gitService.commit', async () => {
      const excludePaths = ['houserules.md', 'FOLDER_STRUCTURE.md', '.vscode/settings.json'];
      
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: exclude test',
        push: false,
        exclude: excludePaths,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: exclude test',
        undefined,
        excludePaths
      );
    });

    it('should work without exclude parameter (backward compatibility)', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: no exclude',
        push: false,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      // Should be called with undefined for exclude
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: no exclude',
        undefined,
        undefined
      );
    });

    it('should work with empty exclude array', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: empty exclude',
        push: false,
        exclude: [],
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: empty exclude',
        undefined,
        []
      );
    });
  });

  // ==========================================================================
  // kit_start_session - setup_changes
  // ==========================================================================
  describe('kit_start_session - setup_changes', () => {
    let mockSessionOrchestrator: any;

    beforeEach(() => {
      // Reset mock to include session orchestrator for kit_start_session
      mockSessionOrchestrator = {
        startSession: jest.fn().mockResolvedValue({
          success: true,
          data: {
            id: 'inst_1',
            sessionId: 'sess_new_123',
            status: 'waiting',
            createdAt: '2026-01-01T00:00:00Z',
            worktreePath: '/tmp/worktree-new',
            config: {
              branchName: 'feat/new',
              baseBranch: 'main',
              repoPath: '/repo',
            },
          },
        }),
        listSessions: jest.fn().mockReturnValue([]),
        expandSessionAliases: jest.fn().mockImplementation((id: string) => [id]),
        teardownSession: jest.fn().mockResolvedValue({}),
        resolveSessionId: jest.fn().mockImplementation((id: string) => id),
      };

      // Update deps with session orchestrator
      deps = {
        ...deps,
        sessionOrchestrator: mockSessionOrchestrator,
        mcpUrl: () => 'http://127.0.0.1:39100/mcp',
      };

      // Re-register tools with updated deps
      registeredTools.clear();
      registerTools(mockMcpServer as any, binder, deps);
    });

    it('should include setup_changes in the response', async () => {
      // Mock git status to return some changes
      // Note: execa is mocked at module level, so we need to set up the mock
      const mockExeca = require('execa').default as jest.MockedFunction<any>;
      mockExeca.mockResolvedValue({ stdout: '?? houserules.md\n M FOLDER_STRUCTURE.md\nA  .vscode/settings.json' } as never);

      const result = await callTool('kit_start_session', {
        repo_path: '/repo',
        task: 'test task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toBeDefined();
      expect(Array.isArray(data.setup_changes)).toBe(true);
      // Should contain the files from git status
      expect(data.setup_changes).toContain('houserules.md');
      expect(data.setup_changes).toContain('FOLDER_STRUCTURE.md');
      expect(data.setup_changes).toContain('.vscode/settings.json');
    });

    it('should return empty array when no changes', async () => {
      const mockExeca = require('execa').default as jest.MockedFunction<any>;
      mockExeca.mockResolvedValue({ stdout: '' } as never);

      const result = await callTool('kit_start_session', {
        repo_path: '/repo',
        task: 'test task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toEqual([]);
    });

    it('should handle git status failure gracefully (return empty array)', async () => {
      const mockExeca = require('execa').default as jest.MockedFunction<any>;
      mockExeca.mockRejectedValue(new Error('git error') as never);

      const result = await callTool('kit_start_session', {
        repo_path: '/repo',
        task: 'test task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      // Should still succeed but with empty setup_changes
      expect(data.setup_changes).toEqual([]);
    });

    it('should parse porcelain v1 format correctly', async () => {
      const mockExeca = require('execa').default as jest.MockedFunction<any>;
      // Porcelain v1 format: "XY path" where X is staged, Y is worktree
      mockExeca.mockResolvedValue({
        stdout: '?? new-file.ts\n M modified-file.ts\nA  staged-file.ts\nD  deleted-file.ts\nR  old-name.ts -> new-name.ts'
      } as never);

      const result = await callTool('kit_start_session', {
        repo_path: '/repo',
        task: 'test task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toContain('new-file.ts');
      expect(data.setup_changes).toContain('modified-file.ts');
      expect(data.setup_changes).toContain('staged-file.ts');
      expect(data.setup_changes).toContain('deleted-file.ts');
      // For rename, should use the new name (after "->")
      expect(data.setup_changes).toContain('new-name.ts');
    });

    it('should return empty array for observer sessions (no worktree)', async () => {
      const mockSessionOrchestratorObs = {
        startSession: jest.fn().mockResolvedValue({
          success: true,
          data: {
            id: 'inst_obs',
            sessionId: 'sess_obs_123',
            status: 'waiting',
            createdAt: '2026-01-01T00:00:00Z',
            // Observer sessions have no worktree
            worktreePath: undefined,
            config: {
              isolation: 'observer',
              branchName: 'feat/obs',
              baseBranch: 'main',
              repoPath: '/repo',
            },
          },
        }),
        listSessions: jest.fn().mockReturnValue([]),
        expandSessionAliases: jest.fn().mockImplementation((id: string) => [id]),
        teardownSession: jest.fn().mockResolvedValue({}),
        resolveSessionId: jest.fn().mockImplementation((id: string) => id),
      };

      deps.sessionOrchestrator = mockSessionOrchestratorObs;
      registeredTools.clear();
      registerTools(mockMcpServer as any, binder, deps);

      const result = await callTool('kit_start_session', {
        repo_path: '/repo',
        task: 'test task',
        isolation: 'observer',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.isolation).toBe('observer');
      expect(data.setup_changes).toEqual([]);
    });
  });
});
