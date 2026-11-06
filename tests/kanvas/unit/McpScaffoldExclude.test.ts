/**
 * KC-S3.1.5 — kit_commit accepts `exclude`; kit_start_session reports
 * `setup_changes`.
 *
 * Two things are asserted here:
 *   1. kit_commit passes an optional `exclude` array through to
 *      gitService.commit as its 4th argument, and calls it unchanged when
 *      exclude is omitted.
 *   2. kit_start_session's success JSON carries `setup_changes` (exact
 *      snake_case key), parsed from `git status --porcelain
 *      --untracked-files=all`, and is [] for an observer session or when the
 *      status command fails.
 *
 * The porcelain parsing itself lives in GitService.getSetupChanges; the
 * parsing tests drive that method directly with a mocked execa (the
 * GitService.commits.test.ts pattern). The MCP tests drive the real
 * registerTools against a capturing stub.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── execa mock (used by the GitService.getSetupChanges parsing tests) ──────
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));
const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

// ── zod + MCP SDK mock (used by the registerTools tests) ───────────────────
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

import { GitService } from '../../../electron/services/GitService';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// ==========================================================================
// GitService.getSetupChanges — porcelain parsing (AC5, AC6)
// ==========================================================================
describe('GitService.getSetupChanges (KC-S3.1.5)', () => {
  let gitService: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
  });

  it('runs git status --porcelain --untracked-files=all in the given worktree', async () => {
    mockedExeca.mockResolvedValueOnce({ stdout: '?? houserules.md\n', stderr: '' } as never);

    await gitService.getSetupChanges('/tmp/wt');

    expect(mockedExeca).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      expect.objectContaining({ cwd: '/tmp/wt' }),
    );
  });

  it('returns one path per porcelain line, untracked and modified alike', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: '?? houserules.md\n M .gitignore\n?? FOLDER_STRUCTURE.md\n',
      stderr: '',
    } as never);

    const result = await gitService.getSetupChanges('/tmp/wt');

    expect(result).toEqual(['houserules.md', '.gitignore', 'FOLDER_STRUCTURE.md']);
  });

  it('takes the destination of a rename, ignoring the source', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: 'R  a.txt -> b.txt\n?? houserules.md\n',
      stderr: '',
    } as never);

    const result = await gitService.getSetupChanges('/tmp/wt');

    expect(result).toEqual(['b.txt', 'houserules.md']);
    expect(result).not.toContain('a.txt');
  });

  it('returns [] when git status fails', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('not a git repository') as never);

    const result = await gitService.getSetupChanges('/tmp/wt');

    expect(result).toEqual([]);
  });

  it('returns [] for an empty status', async () => {
    mockedExeca.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);

    const result = await gitService.getSetupChanges('/tmp/wt');

    expect(result).toEqual([]);
  });
});

// ==========================================================================
// MCP tools — kit_commit exclude passthrough (AC2, AC7)
// ==========================================================================
const registeredTools: Map<string, { schema: any; handler: Function }> = new Map();

const mockMcpServer = {
  tool: jest.fn((name: string, _desc: string, schema: any, handler: Function) => {
    registeredTools.set(name, { schema, handler });
  }),
  resource: jest.fn(),
};

describe('MCP kit_commit exclude + kit_start_session setup_changes (KC-S3.1.5)', () => {
  let binder: McpSessionBinder;
  let deps: any;
  let mockGitService: any;
  let mockStartSession: any;

  const worktree = '/tmp/worktree-scaffold';
  let repoDir: string;
  let tmpRoot: string;

  beforeEach(() => {
    registeredTools.clear();
    jest.clearAllMocks();

    tmpRoot = mkdtempSync(join(tmpdir(), 'kit-scaffold-'));
    repoDir = join(tmpRoot, 'MyApp');
    mkdirSync(repoDir, { recursive: true });

    binder = new McpSessionBinder();
    binder.registerSession('sess_test_123', worktree);

    mockGitService = {
      commit: (jest.fn() as any).mockResolvedValue({
        success: true,
        data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 1, files: [{ path: 'src/app.ts', status: 'modified' }] },
      }),
      push: (jest.fn() as any).mockResolvedValue({ success: true }),
      getStatus: (jest.fn() as any).mockResolvedValue({ success: true, data: {} }),
      getCurrentBranchName: (jest.fn() as any).mockResolvedValue('feat/test'),
      getPendingChanges: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
      getSetupChanges: (jest.fn() as any).mockResolvedValue(['houserules.md', '.vscode/settings.json']),
    };

    mockStartSession = jest.fn(async (config: any) => ({
      success: true,
      data: {
        id: 'inst_1',
        sessionId: 'sess_1',
        status: 'waiting',
        createdAt: '2026-08-29T00:00:00.000Z',
        worktreePath: config.isolation === 'observer' ? undefined : worktree,
        prompt: 'PROMPT BODY',
        config,
      },
    }));

    deps = {
      gitService: mockGitService,
      activityService: { log: jest.fn() },
      lockService: {
        checkConflicts: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
        declareFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        releaseFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        forceReleaseLock: (jest.fn() as any).mockResolvedValue({ success: true }),
      },
      databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
      agentInstanceService: {
        listInstances: (jest.fn() as any).mockReturnValue({ success: true, data: [] }),
      },
      sessionOrchestrator: {
        startSession: mockStartSession,
        listSessions: () => [],
        expandSessionAliases: (id: string) => [id],
        teardownSession: async () => ({}),
        resolveSessionId: (id: string) => id,
      },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    };

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(mockMcpServer as any, binder, deps);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function callTool(name: string, args: Record<string, any>) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    if (args.cwd === undefined && args.session_id) {
      args = { ...args, cwd: worktree };
    }
    return tool.handler(args);
  }

  const parseResult = (result: any) => JSON.parse(result.content[0].text);

  // ── kit_commit ──────────────────────────────────────────────────────────
  describe('kit_commit', () => {
    it('passes exclude through to gitService.commit as the 4th argument', async () => {
      const result = await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: add feature',
        push: false,
        exclude: ['houserules.md', '.vscode/settings.json'],
      });

      const data = parseResult(result);
      expect(data.commitHash).toBe('abc123def456');
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: add feature',
        undefined,
        ['houserules.md', '.vscode/settings.json'],
      );
    });

    it('calls gitService.commit with no exclude (no fourth argument) when exclude is omitted', async () => {
      await callTool('kit_commit', {
        session_id: 'sess_test_123',
        message: 'feat: add feature',
        push: false,
      });

      // Unchanged behaviour: exactly the same three arguments as before, and
      // no fourth argument at all (Jest's toHaveBeenCalledWith is arity-exact).
      expect(mockGitService.commit).toHaveBeenCalledWith(
        'sess_test_123',
        'feat: add feature',
        undefined,
      );
    });
  });

  // ── kit_start_session ───────────────────────────────────────────────────
  describe('kit_start_session', () => {
    it('reports setup_changes from gitService.getSetupChanges in the new worktree', async () => {
      const result = await callTool('kit_start_session', {
        repo_path: repoDir,
        task: 'do a thing',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toEqual(['houserules.md', '.vscode/settings.json']);
      expect(mockGitService.getSetupChanges).toHaveBeenCalledWith(worktree);
    });

    it('uses the exact snake_case key setup_changes, not setupChanges', async () => {
      const result = await callTool('kit_start_session', {
        repo_path: repoDir,
        task: 'do a thing',
      });

      const data = parseResult(result);
      expect(Object.prototype.hasOwnProperty.call(data, 'setup_changes')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(data, 'setupChanges')).toBe(false);
    });

    it('is [] for an observer session (no worktree) and does not call getSetupChanges', async () => {
      const result = await callTool('kit_start_session', {
        repo_path: repoDir,
        task: 'review',
        isolation: 'observer',
      });

      const data = parseResult(result);
      expect(data.isolation).toBe('observer');
      expect(data.worktree_path).toBeNull();
      expect(data.setup_changes).toEqual([]);
      expect(mockGitService.getSetupChanges).not.toHaveBeenCalled();
    });

    it('is [] when the status command fails (getSetupChanges rejects)', async () => {
      mockGitService.getSetupChanges.mockRejectedValueOnce(new Error('git status failed'));

      const result = await callTool('kit_start_session', {
        repo_path: repoDir,
        task: 'do a thing',
      });

      const data = parseResult(result);
      expect(data.ok).toBe(true);
      expect(data.setup_changes).toEqual([]);
    });
  });
});
