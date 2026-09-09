/**
 * MCP Tools — v2.5 additions
 *
 * kit_workspace_list / kit_workspace_add / kit_workspace_scan
 * kit_project_group_list / kit_project_group_add
 * kit_get_repo_status / kit_list_branches / kit_list_worktrees
 * kit_get_repo_worktree_mode / kit_set_repo_worktree_mode
 * kit_get_active_session_count
 * kit_check_autocommit_guard
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// Same zod / MCP mocking pattern as McpTools.test.ts
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

// GitRewriteGuardIO reads real files; mock it to a controllable output.
const mockGuardResult = jest.fn();
jest.mock('../../../electron/services/GitRewriteGuardIO', () => ({
  evaluateAutoCommitGuardForWorktree: (path: string) => mockGuardResult(path),
}));

const registeredTools: Map<string, { schema: any; handler: Function }> = new Map();
const mockMcpServer = {
  tool: jest.fn((name: string, _desc: string, schema: any, handler: Function) => {
    registeredTools.set(name, { schema, handler });
  }),
  resource: jest.fn(),
};

const { registerTools } = require('../../../electron/services/mcp/tools');

describe('MCP v2.5 tools', () => {
  let binder: McpSessionBinder;
  let deps: any;

  beforeEach(() => {
    registeredTools.clear();
    jest.clearAllMocks();
    binder = new McpSessionBinder();
    binder.registerSession('sess_test_123', '/tmp/worktree-test');

    (mockGuardResult as any).mockReturnValue({ allowed: true, kind: 'allowed' });

    deps = {
      gitService: {
        getRepoStatus: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: {
            repoPath: '/repo',
            currentBranch: 'main',
            ahead: 0,
            behind: 0,
            modifiedCount: 0,
            stagedCount: 0,
            untrackedCount: 0,
            unmergedCount: 0,
            stashCount: 0,
            worktreeCount: 1,
          },
        }),
        listBranchesForRepo: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: [
            { name: 'main', isCurrent: true, lastCommitMs: Date.now(), mergedIntoDefault: false, deletedOnRemote: false, hasWorktree: true },
          ],
        }),
        listWorktrees: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: [{ path: '/repo', branch: 'main', head: 'abc', bare: false }],
        }),
        // Not needed for these tools but required by the deps shape.
        commit: jest.fn(),
        push: jest.fn(),
        getStatus: jest.fn(),
        getCommitHistory: jest.fn(),
      },
      activityService: { log: jest.fn() },
      lockService: {
        checkConflicts: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
        declareFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        releaseFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        forceReleaseLock: (jest.fn() as any).mockResolvedValue({ success: true }),
      },
      agentInstanceService: {
        listInstances: (jest.fn() as any).mockReturnValue({ success: true, data: [] }),
        getActiveSessionCountForRepo: (jest.fn() as any).mockReturnValue({ success: true, data: 3 }),
      },
      configService: {
        getRepoWorktreeMode: (jest.fn() as any).mockReturnValue('in-place'),
        setRepoWorktreeMode: jest.fn(),
      },
      workspaceService: {
        list: (jest.fn() as any).mockReturnValue({ success: true, data: [{ id: 'ws_1', name: 'work' }] }),
        get: jest.fn(),
        add: (jest.fn() as any).mockReturnValue({ success: true, data: { id: 'ws_new' } }),
        remove: jest.fn(),
        getActive: jest.fn(),
        scan: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: { workspaceId: 'ws_1', scannedAt: '', durationMs: 5, repoCount: 2, repos: [] },
        }),
      },
      projectGroupService: {
        list: (jest.fn() as any).mockReturnValue({ success: true, data: [] }),
        add: (jest.fn() as any).mockReturnValue({ success: true, data: { id: 'pg_x', name: 'Core' } }),
      },
    };

    registerTools(mockMcpServer as any, binder, deps);
  });

  function callTool(name: string, args: Record<string, any> = {}) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    return tool.handler(args);
  }
  function parseResult(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  describe('registration', () => {
    it('registers all 12 v2.5 tools', () => {
      for (const t of [
        'kit_workspace_list', 'kit_workspace_add', 'kit_workspace_scan',
        'kit_project_group_list', 'kit_project_group_add',
        'kit_get_repo_status', 'kit_list_branches', 'kit_list_worktrees',
        'kit_get_repo_worktree_mode', 'kit_set_repo_worktree_mode',
        'kit_get_active_session_count', 'kit_check_autocommit_guard',
      ]) {
        expect(registeredTools.has(t)).toBe(true);
      }
    });
  });

  describe('kit_workspace_*', () => {
    it('kit_workspace_list forwards to service', async () => {
      const r = parseResult(await callTool('kit_workspace_list'));
      expect(r.data[0].id).toBe('ws_1');
      expect(deps.workspaceService.list).toHaveBeenCalled();
    });

    it('kit_workspace_add maps snake_case → camelCase', async () => {
      await callTool('kit_workspace_add', {
        path: '/x',
        name: 'X',
        scan_depth: 3,
        ignore_globs: ['tmp'],
      });
      expect(deps.workspaceService.add).toHaveBeenCalledWith({
        path: '/x',
        name: 'X',
        scanDepth: 3,
        ignoreGlobs: ['tmp'],
      });
    });

    it('kit_workspace_scan awaits async scan', async () => {
      const r = parseResult(await callTool('kit_workspace_scan', { workspace_id: 'ws_1' }));
      expect(r.data.workspaceId).toBe('ws_1');
      expect(deps.workspaceService.scan).toHaveBeenCalledWith('ws_1');
    });

    it('returns not-available when workspaceService is missing', async () => {
      registeredTools.clear();
      registerTools(mockMcpServer as any, binder, { ...deps, workspaceService: undefined });
      const r = parseResult(await callTool('kit_workspace_list'));
      expect(r.error).toMatch(/workspaceService/);
    });
  });

  describe('kit_project_group_*', () => {
    it('list returns registered groups', async () => {
      const r = parseResult(await callTool('kit_project_group_list'));
      expect(r.success).toBe(true);
    });

    it('add maps snake_case → camelCase', async () => {
      await callTool('kit_project_group_add', { name: 'Core', repo_paths: ['/a', '/b'], color: '#abc' });
      expect(deps.projectGroupService.add).toHaveBeenCalledWith({
        name: 'Core',
        repoPaths: ['/a', '/b'],
        color: '#abc',
      });
    });
  });

  describe('kit_get_repo_status / kit_list_branches / kit_list_worktrees', () => {
    it('get_repo_status calls gitService.getRepoStatus', async () => {
      const r = parseResult(await callTool('kit_get_repo_status', { repo_path: '/repo' }));
      expect(r.data.currentBranch).toBe('main');
      expect(deps.gitService.getRepoStatus).toHaveBeenCalledWith('/repo');
    });

    it('list_branches returns C7 hygiene metadata', async () => {
      const r = parseResult(await callTool('kit_list_branches', { repo_path: '/repo' }));
      expect(r.data[0]).toMatchObject({ name: 'main', isCurrent: true, hasWorktree: true });
    });

    it('list_worktrees returns worktree list', async () => {
      const r = parseResult(await callTool('kit_list_worktrees', { repo_path: '/repo' }));
      expect(r.data).toHaveLength(1);
    });

    it('returns not-available when gitService methods are missing', async () => {
      registeredTools.clear();
      registerTools(mockMcpServer as any, binder, {
        ...deps,
        gitService: { commit: jest.fn(), push: jest.fn(), getStatus: jest.fn(), getCommitHistory: jest.fn() },
      });
      const r = parseResult(await callTool('kit_get_repo_status', { repo_path: '/x' }));
      expect(r.error).toMatch(/gitService.getRepoStatus/);
    });
  });

  describe('kit_get_repo_worktree_mode / kit_set_repo_worktree_mode (C5)', () => {
    it('get returns the current mode', async () => {
      const r = parseResult(await callTool('kit_get_repo_worktree_mode', { repo_path: '/x' }));
      expect(r.data).toBe('in-place');
    });

    it('set forwards to configService', async () => {
      await callTool('kit_set_repo_worktree_mode', { repo_path: '/x', mode: 'in-place' });
      expect(deps.configService.setRepoWorktreeMode).toHaveBeenCalledWith('/x', 'in-place');
    });
  });

  describe('kit_get_active_session_count (R1)', () => {
    it('returns count from agentInstanceService', async () => {
      const r = parseResult(await callTool('kit_get_active_session_count', { repo_path: '/x' }));
      expect(r.data).toBe(3);
    });

    it('returns not-available when method missing', async () => {
      registeredTools.clear();
      registerTools(mockMcpServer as any, binder, {
        ...deps,
        agentInstanceService: { listInstances: deps.agentInstanceService.listInstances },
      });
      const r = parseResult(await callTool('kit_get_active_session_count', { repo_path: '/x' }));
      expect(r.error).toMatch(/getActiveSessionCountForRepo/);
    });
  });

  describe('kit_check_autocommit_guard (rebase-race fix)', () => {
    it('returns allowed when guard permits', async () => {
      (mockGuardResult as any).mockReturnValueOnce({ allowed: true, kind: 'allowed' });
      const r = parseResult(await callTool('kit_check_autocommit_guard', { worktree_path: '/wt' }));
      expect(r.allowed).toBe(true);
    });

    it('returns blocked-mid-rebase when a rebase is in progress', async () => {
      (mockGuardResult as any).mockReturnValueOnce({
        allowed: false,
        kind: 'blocked-mid-rebase',
        message: 'rebase in progress',
      });
      const r = parseResult(await callTool('kit_check_autocommit_guard', { worktree_path: '/wt' }));
      expect(r.allowed).toBe(false);
      expect(r.kind).toBe('blocked-mid-rebase');
    });

    it('returns blocked-detached-head when HEAD is detached', async () => {
      (mockGuardResult as any).mockReturnValueOnce({
        allowed: false,
        kind: 'blocked-detached-head',
        message: 'detached',
      });
      const r = parseResult(await callTool('kit_check_autocommit_guard', { worktree_path: '/wt' }));
      expect(r.kind).toBe('blocked-detached-head');
    });

    it('passes the worktree_path through to the guard', async () => {
      await callTool('kit_check_autocommit_guard', { worktree_path: '/my/wt' });
      expect(mockGuardResult).toHaveBeenCalledWith('/my/wt');
    });
  });

  // ===========================================================================
  // Regression: git tools (kit_merge / kit_rebase) must resolve a session's
  // branch/repo the SAME way the worktree tools do — including predecessor
  // session ids. After a KIT restart the agent keeps calling with its original
  // (now-predecessor) id; the binder resolves it, but kit_merge/kit_rebase used
  // an exact `sessionId` match on listInstances() and returned "Could not
  // resolve source branch or repo path" for a session every other tool
  // resolved fine.
  // ===========================================================================
  describe('predecessor-aware session resolution (git tools must not drift)', () => {
    const CURRENT = 'sess_current_999';
    const PRED = 'sess_pred_111';        // the id the restarted agent still holds
    const WT = '/tmp/worktree-multi';
    const REPO = '/tmp/repo-main';
    const SRC = 'claude-session-xyz';
    const BASE = 'integration/all-work-v3';

    let mergeService: any;
    let rebaseWatcherService: any;

    beforeEach(() => {
      registeredTools.clear();
      binder = new McpSessionBinder();
      // Multi-repo session registered under BOTH ids (binder aliases predecessors).
      binder.registerMultiRepoSession(CURRENT, [
        { repoName: 'primary', worktreePath: WT, role: 'primary' },
      ]);
      binder.registerMultiRepoSession(PRED, [
        { repoName: 'primary', worktreePath: WT, role: 'primary' },
      ]);

      mergeService = {
        executeMerge: (jest.fn() as any).mockResolvedValue({
          success: true,
          data: { success: true, message: 'merged', mergeCommitHash: 'deadbeef', filesChanged: 3 },
        }),
      };
      rebaseWatcherService = {
        performRebaseForPath: (jest.fn() as any).mockResolvedValue({
          success: true, message: 'rebased', incomingCommits: 8, commitsAdded: 9,
        }),
      };

      // The instance is keyed by the CURRENT id; PRED is only a predecessor.
      const instance = {
        sessionId: CURRENT,
        predecessorSessionIds: [PRED],
        config: { branchName: SRC, repoPath: REPO, baseBranch: BASE },
      };
      const gitDeps = {
        ...deps,
        agentInstanceService: {
          listInstances: (jest.fn() as any).mockReturnValue({ success: true, data: [instance] }),
        },
        mergeService,
        rebaseWatcherService,
      };
      registerTools(mockMcpServer as any, binder, gitDeps);
    });

    it('kit_merge resolves branch+repo from a PREDECESSOR id (was: could not resolve)', async () => {
      const r = parseResult(await callTool('kit_merge', { session_id: PRED, cwd: WT }));
      expect(r.error).toBeUndefined();
      expect(mergeService.executeMerge).toHaveBeenCalledWith(
        REPO, SRC, BASE, expect.objectContaining({ worktreePath: WT, skipCiGate: false }),
      );
      expect(r.source).toBe(SRC);
      expect(r.target).toBe(BASE);
    });

    it('kit_rebase resolves repo+base from a PREDECESSOR id', async () => {
      const r = parseResult(await callTool('kit_rebase', { session_id: PRED, cwd: WT }));
      expect(r.error).toBeUndefined();
      expect(rebaseWatcherService.performRebaseForPath).toHaveBeenCalledWith(PRED, REPO, BASE);
      expect(r.baseBranch).toBe(BASE);
    });

    it('resolves the CURRENT id identically (no drift between the two)', async () => {
      const merged = parseResult(await callTool('kit_merge', { session_id: CURRENT, cwd: WT }));
      expect(merged.source).toBe(SRC);
      expect(mergeService.executeMerge).toHaveBeenCalledWith(
        REPO, SRC, BASE, expect.objectContaining({ worktreePath: WT }),
      );
    });

    it('kit_get_session_info returns branchName for a predecessor id too', async () => {
      const r = parseResult(await callTool('kit_get_session_info', { session_id: PRED }));
      expect(r.branchName).toBe(SRC);
      expect(r.baseBranch).toBe(BASE);
    });
  });
});
