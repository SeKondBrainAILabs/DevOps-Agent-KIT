/**
 * KC-S3.1.5 (AC2): kit_commit can exclude scaffolding paths, and
 * kit_start_session reports the scaffolding it created via `setup_changes`.
 *
 * Drives the real registerTools against a capturing stub (the McpTools /
 * McpSessionTools pattern) and invokes the captured handlers directly.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── execa mock: gitInWorktree in tools.ts resolves execa dynamically ────────
const execaCalls: Array<{ args: string[]; cwd?: string }> = [];
let statusStdout = '';
let statusFails = false;
const mockExecaFn = jest.fn((cmd: string, args: string[], opts: { cwd?: string } = {}) => {
  execaCalls.push({ args, cwd: opts.cwd });
  if (args[0] === 'status' && args.includes('--porcelain')) {
    if (statusFails) return Promise.reject(new Error('fatal: not a git repository'));
    return Promise.resolve({ stdout: statusStdout, stderr: '' });
  }
  return Promise.resolve({ stdout: '', stderr: '' });
});
jest.mock('execa', () => ({ __esModule: true, default: mockExecaFn, execa: mockExecaFn }));

// Proxy stub: every schema method chains.
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

type Handler = (args: any) => Promise<any>;

interface Harness {
  handlers: Map<string, Handler>;
  commit: jest.Mock<any>;
  startSession: jest.Mock<any>;
}

function buildHarness(over: { startSession?: (config: any) => Promise<any> } = {}): Harness {
  const handlers = new Map<string, Handler>();
  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };

  const commit = jest.fn(async () => ({
    success: true,
    data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 1, files: [{ path: 'kept.txt', status: 'added' }] },
  })) as any;

  const startSession = jest.fn(
    over.startSession ??
      (async (config: any) => ({
        success: true,
        data: {
          id: 'inst_1',
          sessionId: 'sess_new',
          status: 'waiting',
          createdAt: '2026-08-29T00:00:00.000Z',
          worktreePath: '/wt/KIT-DevOps-repo/' + config.branchName,
          prompt: 'PROMPT BODY',
          config,
        },
      }))
  ) as any;

  const binder: any = {
    getSession: () => ({ worktreePath: '/wt/primary' }),
    getWorktreePath: () => '/wt/primary',
    getWorktreePathForRepo: () => '/wt/primary',
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    listSessions: () => [],
  };

  const { registerTools } = require('../../../electron/services/mcp/tools');
  registerTools(
    server,
    binder,
    {
      sessionOrchestrator: {
        startSession,
        listSessions: () => [],
        expandSessionAliases: (id: string) => [id],
        teardownSession: async () => ({}),
        resolveSessionId: (id: string) => id,
      },
      gitService: {
        commit,
        listBranchesForRepo: async () => ({ success: true, data: { currentBranch: 'development', branches: ['main', 'development'] } }),
        getCurrentBranchName: async () => 'feat/test',
      },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    },
    undefined
  );

  return { handlers, commit, startSession };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  execaCalls.length = 0;
  statusStdout = '';
  statusFails = false;
  tmpRoot = mkdtempSync(join(tmpdir(), 'kit-s315-'));
  repoDir = join(tmpRoot, 'MyApp');
  mkdirSync(repoDir, { recursive: true });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── kit_commit exclude pass-through ─────────────────────────────────────────
describe('kit_commit exclude (KC-S3.1.5 AC2)', () => {
  it('registers the exclude input', () => {
    expect(buildHarness().handlers.has('kit_commit')).toBe(true);
  });

  it('passes the exclude list as the 4th argument to gitService.commit', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_commit')!({
      session_id: 'sess_test',
      message: 'feat: commit without scaffolding',
      cwd: '/wt/primary',
      push: false,
      exclude: ['houserules.md', 'FOLDER_STRUCTURE.md'],
    });

    expect(h.commit).toHaveBeenCalledWith(
      'sess_test',
      'feat: commit without scaffolding',
      undefined,
      ['houserules.md', 'FOLDER_STRUCTURE.md']
    );
  });

  it('omits the 4th argument when exclude is not supplied (behaviour unchanged)', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_commit')!({
      session_id: 'sess_test',
      message: 'feat: normal commit',
      cwd: '/wt/primary',
      push: false,
    });

    expect(h.commit).toHaveBeenCalledWith('sess_test', 'feat: normal commit', undefined);
    expect((h.commit as any).mock.calls[0]).toHaveLength(3);
  });
});

// ── kit_start_session setup_changes ─────────────────────────────────────────
describe('kit_start_session setup_changes (KC-S3.1.5 AC2)', () => {
  it('reports the scaffolding paths as setup_changes, parsed from porcelain v1', async () => {
    const h = buildHarness();
    statusStdout =
      '?? houserules.md\n' +
      '?? FOLDER_STRUCTURE.md\n' +
      ' M .vscode/settings.json\n' +
      ' M .gitignore\n' +
      '?? uv.lock\n';

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'Do the thing',
        include_prompt: false,
      })
    );

    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([
      'houserules.md',
      'FOLDER_STRUCTURE.md',
      '.vscode/settings.json',
      '.gitignore',
      'uv.lock',
    ]);
    // The status command ran in the NEW worktree, untracked files included.
    const statusCall = execaCalls.find((c) => c.args[0] === 'status');
    expect(statusCall?.args).toEqual(['status', '--porcelain', '--untracked-files=all']);
    expect(statusCall?.cwd).toBe(out.worktree_path);
  });

  it('uses the destination path for a rename in porcelain output', async () => {
    const h = buildHarness();
    statusStdout = 'R  old-name.md -> houserules.md\n';

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'Do the thing',
        include_prompt: false,
      })
    );

    expect(out.setup_changes).toEqual(['houserules.md']);
  });

  it('returns an empty setup_changes when there is no scaffolding', async () => {
    const h = buildHarness();
    statusStdout = '';

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'Do the thing',
        include_prompt: false,
      })
    );

    expect(out.setup_changes).toEqual([]);
  });

  it('returns an empty setup_changes when the status command fails', async () => {
    const h = buildHarness();
    statusFails = true;

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'Do the thing',
        include_prompt: false,
      })
    );

    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
  });

  it('returns an empty setup_changes for an observer (no worktree)', async () => {
    const h = buildHarness({
      startSession: async (config: any) => ({
        success: true,
        data: {
          id: 'inst_obs',
          sessionId: 'sess_obs',
          status: 'waiting',
          createdAt: '2026-08-29T00:00:00.000Z',
          worktreePath: undefined,
          prompt: 'PROMPT BODY',
          config,
        },
      }),
    });

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'Review the thing',
        isolation: 'observer',
        include_prompt: false,
      })
    );

    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
    // No git status should have been run for an observer.
    expect(execaCalls.filter((c) => c.args[0] === 'status')).toHaveLength(0);
  });
});
