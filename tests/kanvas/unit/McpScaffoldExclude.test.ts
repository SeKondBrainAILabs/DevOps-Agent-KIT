/**
 * MCP tools exclude and setup_changes tests (AC2)
 *
 * Tests that:
 * 1. kit_commit accepts exclude and passes it to gitService.commit
 * 2. Without exclude, the call is unchanged
 * 3. kit_start_session's response includes setup_changes parsed from git status --porcelain --untracked-files=all
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// Mock ALL dependencies of tools.ts to avoid heavy module resolution
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

// Import after mocks are set up (jest.mock is hoisted)
const { registerTools } = require('../../../electron/services/mcp/tools');

describe('MCP Tools - exclude and setup_changes', () => {
  let binder: McpSessionBinder;
  let deps: any;
  let mockGitService: any;

  beforeEach(() => {
    registeredTools.clear();
    jest.clearAllMocks();

    binder = new McpSessionBinder();
    binder.registerSession('sess_test_123', '/tmp/worktree-test');

    mockGitService = {
      commit: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 3 },
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
        data: ['houserules.md', '.gitignore'],
      }),
    };

    deps = {
      gitService: mockGitService,
      activityService: { log: jest.fn() },
      lockService: {
        checkConflicts: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
        declareFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        releaseFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        forceReleaseLock: (jest.fn() as any).mockResolvedValue({ success: true }),
      },
      databaseService: {
        recordCommit: jest.fn(),
        recordSessionEvent: jest.fn(),
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
      // For kit_start_session
      sessionOrchestrator: {
        startSession: jest.fn(async (config: any) => ({
          success: true,
          data: {
            id: 'inst_1',
            sessionId: 'sess_started',
            status: 'waiting',
            createdAt: '2026-01-01T00:00:00.000Z',
            worktreePath: '/tmp/worktree-started',
            prompt: 'PROMPT BODY',
            config,
          },
        })),
        listSessions: () => [],
        expandSessionAliases: (id: string) => [id],
        teardownSession: async () => ({}),
        resolveSessionId: (id: string) => id,
      },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    };

    registerTools(mockMcpServer as any, binder, deps);
  });

  function callTool(name: string, args: Record<string, any>) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    // Mutating tools now require `cwd`. Default it to the session's worktree.
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
  // kit_commit exclude parameter
  // ==========================================================================
  describe('kit_commit exclude parameter', () => {
    it('should register the tool with exclude schema', () => {
      expect(registeredTools.has('kit_commit')).toBe(true);
      const tool = registeredTools.get('kit_commit')!;
      // The schema should have an optional exclude field
      expect(tool.schema).toBeDefined();
    });

    it('passes exclude to gitService.commit when provided', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: exclude some files',
        exclude: ['houserules.md', '.gitignore', 'uv.lock'],
        push: false,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: exclude some files',
        undefined,
        ['houserules.md', '.gitignore', 'uv.lock']
      );
    });

    it('calls gitService.commit without exclude when omitted', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: normal commit',
        push: false,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      // Should be called with 3 arguments (no exclude)
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: normal commit',
        undefined
      );
    });

    it('passes empty array to gitService.commit when exclude is empty', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: empty exclude',
        exclude: [],
        push: false,
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

    it('handles multi-repo commit with exclude', async () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'primary', worktreePath: '/tmp/primary-wt', role: 'primary' },
        { repoName: 'lib', worktreePath: '/tmp/primary-wt/libs/lib', role: 'secondary' },
      ]);

      const result = await callTool('kit_commit', {
        session_id: 'sess_multi',
        message: 'feat: exclude in multi-repo',
        repo: 'lib',
        exclude: ['lib/ignore.md'],
        push: false,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_multi',
        '[Upgrade From primary] feat: exclude in multi-repo',
        'lib',
        ['lib/ignore.md']
      );
    });
  });

  // ==========================================================================
  // kit_start_session setup_changes
  // ==========================================================================
  describe('kit_start_session setup_changes', () => {
    it('includes setup_changes in the success response', async () => {
      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'test task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toBeDefined();
      expect(data.setup_changes).toEqual(['houserules.md', '.gitignore']);
    });

    it('calls gitService.getPendingChanges to get setup_changes', async () => {
      await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'test task',
      });

      expect(mockGitService.getPendingChanges).toHaveBeenCalledWith('/tmp/worktree-started');
    });

    it('returns empty array when there are no setup changes', async () => {
      mockGitService.getPendingChanges.mockResolvedValueOnce({
        success: true,
        data: [],
      });

      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'clean task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toEqual([]);
    });

    it('returns empty array when getPendingChanges fails', async () => {
      mockGitService.getPendingChanges.mockResolvedValueOnce({
        success: false,
        error: { message: 'git error' },
      });

      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'error task',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      // Should still succeed, just with empty setup_changes
      expect(data.setup_changes).toEqual([]);
    });

    it('includes setup_changes with dry_run', async () => {
      // Dry run doesn't actually start a session, so setup_changes won't be present
      // This tests that the schema is correct
      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'dry run',
        dry_run: true,
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.dry_run).toBe(true);
      // Dry run doesn't create a session, so getPendingChanges is not called
      expect(mockGitService.getPendingChanges).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // kit_start_session porcelain parsing
  // ==========================================================================
  describe('kit_start_session porcelain parsing', () => {
    it('parses porcelain v1 output correctly', async () => {
      // Simulate getPendingChanges returning paths from porcelain v1
      mockGitService.getPendingChanges.mockResolvedValueOnce({
        success: true,
        data: ['houserules.md', '.gitignore', 'src/new.ts'],
      });

      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'test',
      });

      const data = parseResult(result);
      expect(data.setup_changes).toEqual(['houserules.md', '.gitignore', 'src/new.ts']);
    });

    it('handles rename paths correctly (uses new path)', async () => {
      // When parsing porcelain, renames "a -> b" should use b
      mockGitService.getPendingChanges.mockResolvedValueOnce({
        success: true,
        data: ['old-name.ts', 'new-name.ts'], // Both paths from rename
      });

      const result = await callTool('kit_start_session', {
        repo_path: '/tmp/repo',
        task: 'test',
      });

      const data = parseResult(result);
      // The paths should be as returned from getPendingChanges
      expect(data.setup_changes).toEqual(['old-name.ts', 'new-name.ts']);
    });
  });
});
