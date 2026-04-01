/**
 * MCP Tools Unit Tests
 *
 * Tests tool handlers by calling registerTools with mock services
 * and verifying the tool callbacks.
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// Mock ALL dependencies of tools.ts to avoid heavy module resolution
function zodChain(): any {
  const c: any = {};
  ['string', 'number', 'boolean', 'array', 'object', 'enum', 'record',
    'optional', 'default', 'describe', 'unknown'].forEach(m => { c[m] = (..._a: any[]) => zodChain(); });
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

describe('MCP Tools', () => {
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
        data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 3 },
      }),
      push: (jest.fn() as any).mockResolvedValue({ success: true }),
      getStatus: (jest.fn() as any).mockResolvedValue({ success: true, data: {} }),
      getCommitHistory: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: [
          { hash: 'abc123', shortHash: 'abc123', message: 'feat: add feature', author: 'test', date: '2026-01-01', filesChanged: 2 },
        ],
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
    return tool.handler(args);
  }

  function parseResult(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  // ==========================================================================
  // kit_commit
  // ==========================================================================
  describe('kit_commit', () => {
    it('should register the tool', () => {
      expect(registeredTools.has('kit_commit')).toBe(true);
    });

    it('should commit successfully', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: add new feature',
        push: false,
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(data.shortHash).toBe('abc123d');
      expect(data.filesChanged).toBe(3);
      expect(data.pushed).toBe(false);
      expect(mockGitService.commit).toHaveBeenCalledWith('sess_test_123', 'feat: add new feature', undefined);
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'unknown_sess',
        message: 'test',
      });

      const data = parseResult(result);
      expect(data.error).toContain('Unknown session');
    });

    it('should record commit in database', async () => {
      await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: test commit',
      });

      expect(mockDatabaseService.recordCommit).toHaveBeenCalledWith(
        'sess_test_123',
        'abc123def456',
        'feat: test commit',
        3
      );
    });

    it('should push when requested', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: push test',
        push: true,
      });

      const data = parseResult(result);
      expect(data.pushed).toBe(true);
      expect(mockGitService.push).toHaveBeenCalledWith('sess_test_123', undefined);
    });

    it('should not push by default', async () => {
      await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: no push',
      });

      expect(mockGitService.push).not.toHaveBeenCalled();
    });

    it('should log activity for commit', async () => {
      await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: activity test',
      });

      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'git',
        expect.stringContaining('Committed'),
        expect.objectContaining({ source: 'mcp' })
      );
    });
  });

  // ==========================================================================
  // kit_get_session_info
  // ==========================================================================
  describe('kit_get_session_info', () => {
    it('should return session info with agent details', async () => {
      const result = await callTool('kit_get_session_info', {
        session_id: 'sess_test_123',
      });

      const data = parseResult(result);
      expect(data.sessionId).toBe('sess_test_123');
      expect(data.worktreePath).toBe('/tmp/worktree-test');
      expect(data.agentType).toBe('claude');
      expect(data.branchName).toBe('feat/test');
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_get_session_info', {
        session_id: 'unknown_sess',
      });

      const data = parseResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });

  // ==========================================================================
  // kit_log_activity
  // ==========================================================================
  describe('kit_log_activity', () => {
    it('should log info activity', async () => {
      const result = await callTool('kit_log_activity', {
        session_id: 'sess_test_123',
        type: 'info',
        message: 'Started working on feature',
      });

      const data = parseResult(result);
      expect(data.logged).toBe(true);
      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'info',
        'Started working on feature',
        expect.objectContaining({ source: 'mcp' })
      );
    });

    it('should log warning activity', async () => {
      await callTool('kit_log_activity', {
        session_id: 'sess_test_123',
        type: 'warning',
        message: 'Potential issue detected',
      });

      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'warning',
        'Potential issue detected',
        expect.any(Object)
      );
    });

    it('should log error activity', async () => {
      await callTool('kit_log_activity', {
        session_id: 'sess_test_123',
        type: 'error',
        message: 'Build failed',
      });

      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'error',
        'Build failed',
        expect.any(Object)
      );
    });

    it('should log git activity', async () => {
      await callTool('kit_log_activity', {
        session_id: 'sess_test_123',
        type: 'git',
        message: 'Rebased on main',
      });

      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'git',
        'Rebased on main',
        expect.any(Object)
      );
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_log_activity', {
        session_id: 'unknown_sess',
        type: 'info',
        message: 'test',
      });

      const data = parseResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });

  // ==========================================================================
  // kit_lock_file
  // ==========================================================================
  describe('kit_lock_file', () => {
    it('should lock files successfully', async () => {
      const result = await callTool('kit_lock_file', {
        session_id: 'sess_test_123',
        files: ['src/index.ts', 'src/utils.ts'],
        reason: 'Implementing feature',
      });

      const data = parseResult(result);
      expect(data.locked).toBe(true);
      expect(data.files).toEqual(['src/index.ts', 'src/utils.ts']);
      expect(data.conflicts).toEqual([]);
    });

    it('should detect conflicts', async () => {
      mockLockService.checkConflicts.mockResolvedValueOnce({
        success: true,
        data: [{
          file: 'src/index.ts',
          heldBy: 'claude',
          sessionId: 'sess_other',
        }],
      });

      const result = await callTool('kit_lock_file', {
        session_id: 'sess_test_123',
        files: ['src/index.ts'],
      });

      const data = parseResult(result);
      expect(data.locked).toBe(false);
      expect(data.conflicts).toHaveLength(1);
      expect(data.conflicts[0].file).toBe('src/index.ts');
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_lock_file', {
        session_id: 'unknown_sess',
        files: ['test.ts'],
      });

      const data = parseResult(result);
      expect(data.error).toContain('Unknown session');
    });
  });

  // ==========================================================================
  // kit_unlock_file
  // ==========================================================================
  describe('kit_unlock_file', () => {
    it('should unlock specific files', async () => {
      const result = await callTool('kit_unlock_file', {
        session_id: 'sess_test_123',
        files: ['src/index.ts'],
      });

      const data = parseResult(result);
      expect(data.unlocked).toBe(true);
      expect(mockLockService.forceReleaseLock).toHaveBeenCalledWith('/tmp/worktree-test', 'src/index.ts');
    });

    it('should release all locks when no files specified', async () => {
      const result = await callTool('kit_unlock_file', {
        session_id: 'sess_test_123',
      });

      const data = parseResult(result);
      expect(data.unlocked).toBe(true);
      expect(data.files).toBe('all');
      expect(mockLockService.releaseFiles).toHaveBeenCalledWith('sess_test_123');
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_unlock_file', {
        session_id: 'unknown_sess',
      });

      const data = parseResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });

  // ==========================================================================
  // kit_get_commit_history
  // ==========================================================================
  describe('kit_get_commit_history', () => {
    it('should return commit history', async () => {
      const result = await callTool('kit_get_commit_history', {
        session_id: 'sess_test_123',
      });

      const data = parseResult(result);
      expect(data.commits).toHaveLength(1);
      expect(data.commits[0].message).toBe('feat: add feature');
    });

    it('should respect limit parameter', async () => {
      await callTool('kit_get_commit_history', {
        session_id: 'sess_test_123',
        limit: 5,
      });

      expect(mockGitService.getCommitHistory).toHaveBeenCalledWith('/tmp/worktree-test', undefined, 5);
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_get_commit_history', {
        session_id: 'unknown_sess',
      });

      const data = parseResult(result);
      expect(data.error).toContain('Unknown session');
    });
  });

  // ==========================================================================
  // kit_request_review
  // ==========================================================================
  describe('kit_request_review', () => {
    it('should log review request activity', async () => {
      const result = await callTool('kit_request_review', {
        session_id: 'sess_test_123',
        summary: 'Implemented user auth with JWT tokens',
      });

      const data = parseResult(result);
      expect(data.logged).toBe(true);
      expect(data.summary).toBe('Implemented user auth with JWT tokens');
      expect(data.sessionId).toBe('sess_test_123');
    });

    it('should log activity with review details', async () => {
      await callTool('kit_request_review', {
        session_id: 'sess_test_123',
        summary: 'Added tests for auth',
      });

      expect(mockActivityService.log).toHaveBeenCalledWith(
        'sess_test_123',
        'info',
        expect.stringContaining('Review requested'),
        expect.objectContaining({ reviewRequested: true, source: 'mcp' })
      );
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_request_review', {
        session_id: 'unknown_sess',
        summary: 'test',
      });

      const data = parseResult(result);
      expect(data.error).toBe('Unknown session');
    });
  });

  // ==========================================================================
  // Multi-Repo: repo parameter
  // ==========================================================================
  describe('multi-repo support', () => {
    beforeEach(() => {
      // Register a multi-repo session
      binder.registerMultiRepoSession('sess_multi_001', [
        { repoName: 'primary', worktreePath: '/tmp/primary-worktree', role: 'primary' },
        { repoName: 'shared-lib', worktreePath: '/tmp/primary-worktree/libs/shared-lib', role: 'secondary' },
      ]);
    });

    it('should commit to specific repo when repo param is provided', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_multi_001',
        message: 'feat: update shared lib',
        repo: 'shared-lib',
      });

      const data = parseResult(result);
      expect(data.commitHash).toBeDefined();
      expect(data.repo).toBe('shared-lib');
      expect(mockGitService.commit).toHaveBeenCalledWith('sess_multi_001', 'feat: update shared lib', 'shared-lib');
    });

    it('should default to primary repo when no repo param', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_multi_001',
        message: 'feat: primary change',
      });

      const data = parseResult(result);
      expect(data.commitHash).toBeDefined();
      expect(data.repo).toBeUndefined();
    });

    it('should return error for unknown repo name', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_multi_001',
        message: 'test',
        repo: 'nonexistent-repo',
      });

      const data = parseResult(result);
      expect(data.error).toContain('Unknown session or repo');
    });

    it('should get commit history for specific repo', async () => {
      await callTool('kit_get_commit_history', {
        session_id: 'sess_multi_001',
        repo: 'shared-lib',
        limit: 5,
      });

      expect(mockGitService.getCommitHistory).toHaveBeenCalledWith(
        '/tmp/primary-worktree/libs/shared-lib',
        undefined,
        5
      );
    });

    it('should return repos in session info for multi-repo session', async () => {
      const result = await callTool('kit_get_session_info', {
        session_id: 'sess_multi_001',
      });

      const data = parseResult(result);
      expect(data.repos).toBeDefined();
      expect(data.repos).toHaveLength(2);
      expect(data.repos[0].repoName).toBe('primary');
      expect(data.repos[1].repoName).toBe('shared-lib');
    });

    it('should lock files in specific repo', async () => {
      const result = await callTool('kit_lock_file', {
        session_id: 'sess_multi_001',
        files: ['src/utils.ts'],
        repo: 'shared-lib',
      });

      const data = parseResult(result);
      expect(data.locked).toBe(true);
      expect(mockLockService.checkConflicts).toHaveBeenCalledWith(
        '/tmp/primary-worktree/libs/shared-lib',
        ['src/utils.ts'],
        'sess_multi_001'
      );
    });
  });

  // ==========================================================================
  // kit_commit_all
  // ==========================================================================
  describe('kit_commit_all', () => {
    it('should register the tool', () => {
      expect(registeredTools.has('kit_commit_all')).toBe(true);
    });

    it('should commit across all repos in session', async () => {
      binder.registerMultiRepoSession('sess_multi_002', [
        { repoName: 'primary', worktreePath: '/tmp/wt-primary', role: 'primary' },
        { repoName: 'lib-a', worktreePath: '/tmp/wt-primary/libs/lib-a', role: 'secondary' },
      ]);

      const result = await callTool('kit_commit_all', {
        session_id: 'sess_multi_002',
        message: 'feat: cross-repo update',
        push: false,
      });

      const data = parseResult(result);
      expect(data.commits).toBeDefined();
      expect(data.commits).toHaveLength(2);
      expect(data.commits[0].repoName).toBe('primary');
      expect(data.commits[1].repoName).toBe('lib-a');
    });

    it('should return error for unknown session', async () => {
      const result = await callTool('kit_commit_all', {
        session_id: 'unknown_sess',
        message: 'test',
      });

      const data = parseResult(result);
      expect(data.error).toContain('Unknown session');
    });

    it('should push when requested', async () => {
      binder.registerMultiRepoSession('sess_multi_003', [
        { repoName: 'primary', worktreePath: '/tmp/wt-push', role: 'primary' },
      ]);

      const result = await callTool('kit_commit_all', {
        session_id: 'sess_multi_003',
        message: 'feat: push all',
        push: true,
      });

      const data = parseResult(result);
      expect(data.commits[0].pushed).toBe(true);
      expect(mockGitService.push).toHaveBeenCalled();
    });
  });
});
