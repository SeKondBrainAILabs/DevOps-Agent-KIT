/**
 * KC-S3.1.5 — MCP surface for scaffold exclusions.
 *
 * `kit_commit` stages everything with `git add -A`, so a commit made in a
 * scaffolded worktree also carries the files the DevOps Agent and the worktree
 * setup wrote. Two MCP changes fix the visibility of that:
 *
 *   1. `kit_commit` accepts an optional `exclude` list and forwards it to
 *      `gitService.commit` so those paths are unstaged before the commit.
 *   2. `kit_start_session` reports the scaffolding it found in the new worktree
 *      as `setup_changes`, so the agent knows what it did not write.
 *
 * Drives the real `registerTools` against a capturing stub, the way
 * McpTools.test.ts and McpSessionTools.test.ts do, and invokes the captured
 * handlers directly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Proxy stub: every schema method chains (the enumerated-list approach rots as
// schemas grow). The raw schema object is still captured verbatim, so a test can
// assert which keys a tool declares.
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

// Capture tool registrations, keeping the raw schema object.
interface Registered {
  schema: any;
  handler: (args: any) => Promise<any>;
}
const registeredTools = new Map<string, Registered>();
const mockMcpServer = {
  tool: jest.fn((name: string, _desc: string, schema: any, handler: (args: any) => Promise<any>) => {
    registeredTools.set(name, { schema, handler });
  }),
  resource: jest.fn(),
};

const { registerTools } = require('../../../electron/services/mcp/tools');

const parse = (result: any) => JSON.parse(result.content[0].text);

// ---------------------------------------------------------------------------
// kit_commit harness
// ---------------------------------------------------------------------------

interface CommitHarness {
  commit: jest.Mock<any>;
}

function buildCommitHarness(): CommitHarness {
  registeredTools.clear();

  const binder: any = {
    registerSession: () => undefined,
    getWorktreePathForRepo: () => '/wt/KIT-DevOps-repo/feat-test',
    getWorktreePath: () => '/wt/KIT-DevOps-repo/feat-test',
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    getSession: () => undefined,
    listSessions: () => [],
  };

  const commit = jest.fn(async () => ({
    success: true,
    data: { hash: 'abc123def456', shortHash: 'abc123d', filesChanged: 1 },
  })) as any;

  const deps: any = {
    gitService: {
      commit,
      // Worktree-divergence guard: report the expected session branch.
      getCurrentBranchName: jest.fn(async () => 'feat/test'),
      listBranchesForRepo: jest.fn(async () => ({
        success: true,
        data: { currentBranch: 'feat/test', branches: ['main', 'feat/test'] },
      })),
    },
    activityService: { log: jest.fn() },
    databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
    // No lockService: findProtectedChanges returns { hits: [] }.
  };

  registerTools(mockMcpServer as any, binder, deps, undefined);
  return { commit };
}

function callCommit(args: Record<string, any>) {
  const tool = registeredTools.get('kit_commit');
  if (!tool) throw new Error('kit_commit not registered');
  // The divergence guard compares cwd to the worktree; default it so the test
  // models a well-behaved agent in the right place.
  if (args.cwd === undefined) args = { ...args, cwd: '/wt/KIT-DevOps-repo/feat-test' };
  return tool.handler(args);
}

beforeEach(() => {
  registeredTools.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ===========================================================================
// kit_commit — exclude
// ===========================================================================

describe('kit_commit — exclude (KC-S3.1.5)', () => {
  it('declares an optional exclude parameter in its schema', () => {
    buildCommitHarness();
    const schema = registeredTools.get('kit_commit')!.schema;
    expect(Object.keys(schema)).toContain('exclude');
  });

  it('forwards exclude to gitService.commit so those paths stay unstaged', async () => {
    const h = buildCommitHarness();

    await callCommit({
      session_id: 'sess_test_123',
      message: 'feat: only the story',
      push: false,
      exclude: ['houserules.md', 'uv.lock'],
    });

    expect(h.commit).toHaveBeenCalledTimes(1);
    const args = h.commit.mock.calls[0];
    // commit(sessionId, message, repoName, exclude)
    expect(args[0]).toBe('sess_test_123');
    expect(args[1]).toBe('feat: only the story');
    expect(args[3]).toEqual(['houserules.md', 'uv.lock']);
  });

  it('passes no exclude when the caller omits it (unchanged behaviour)', async () => {
    const h = buildCommitHarness();

    await callCommit({ session_id: 'sess_test_123', message: 'feat: no exclusions', push: false });

    expect(h.commit).toHaveBeenCalledTimes(1);
    const args = h.commit.mock.calls[0];
    // Fourth argument must be undefined, not a stray [] that would behave the same
    // but muddy the contract.
    expect(args[3] ?? undefined).toBeUndefined();
  });

  it('surfaces "nothing to commit" from gitService as the tool error', async () => {
    const h = buildCommitHarness();
    h.commit.mockResolvedValueOnce({
      success: false,
      error: { code: 'GIT_COMMIT_FAILED', message: 'nothing to commit' },
    });

    const out = parse(
      await callCommit({
        session_id: 'sess_test_123',
        message: 'feat: nothing left',
        push: false,
        exclude: ['houserules.md'],
      })
    );

    expect(out.error).toBe('nothing to commit');
  });
});

// ===========================================================================
// kit_start_session — setup_changes
// ===========================================================================

interface SessionHarness {
  handlers: Map<string, (args: any) => Promise<any>>;
  startSession: jest.Mock<any>;
  getPendingChanges: jest.Mock<any>;
}

function buildSessionHarness(over: {
  startSession?: (config: any) => Promise<any>;
  pendingChanges?: () => Promise<any>;
} = {}): SessionHarness {
  registeredTools.clear();

  const startSession = jest.fn(
    over.startSession ??
      (async (config: any) => ({
        success: true,
        data: {
          id: 'inst_1',
          sessionId: 'sess_1',
          status: 'waiting',
          createdAt: '2026-08-29T00:00:00.000Z',
          worktreePath: '/wt/KIT-DevOps-repo/' + config.branchName,
          prompt: 'PROMPT BODY',
          config,
        },
      }))
  ) as any;

  const getPendingChanges = jest.fn(
    over.pendingChanges ??
      (async () => ({ success: true, data: ['houserules.md', 'uv.lock'] }))
  ) as any;

  const binder: any = {
    getSession: () => undefined,
    getWorktreePath: () => undefined,
    getWorktreePathForRepo: () => undefined,
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    listSessions: () => [],
  };

  registerTools(
    mockMcpServer as any,
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
        listBranchesForRepo: jest.fn(async () => ({
          success: true,
          data: { currentBranch: 'development', branches: ['main', 'development'] },
        })),
        getPendingChanges,
      },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    },
    undefined
  );

  const handlers = new Map<string, (args: any) => Promise<any>>();
  for (const [name, reg] of registeredTools) handlers.set(name, reg.handler);
  return { handlers, startSession, getPendingChanges };
}

let repoDir: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kit-scaffold-'));
  repoDir = join(tmpRoot, 'MyApp');
  mkdirSync(repoDir, { recursive: true });
});

// Re-mock console.warn after the global beforeEach above (order-independent).
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('kit_start_session — setup_changes (KC-S3.1.5)', () => {
  it('reports the scaffolding found in the new worktree as setup_changes', async () => {
    const h = buildSessionHarness();

    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 'do a thing' })
    );

    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual(['houserules.md', 'uv.lock']);
    // The paths come from the new worktree, not the source repo.
    const wt = h.startSession.mock.calls[0][0];
    expect(h.getPendingChanges).toHaveBeenCalledTimes(1);
    expect(h.getPendingChanges.mock.calls[0][0]).toContain('KIT-DevOps-repo');
    expect(h.getPendingChanges.mock.calls[0][0]).toBe(out.worktree_path);
    expect(wt.useWorktree).toBe(true);
  });

  it('reports an empty setup_changes when the worktree is clean', async () => {
    const h = buildSessionHarness({ pendingChanges: async () => ({ success: true, data: [] }) });

    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );

    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
  });

  it('reports an empty setup_changes when the pending-changes lookup fails', async () => {
    const h = buildSessionHarness({
      pendingChanges: async () => ({ success: false, error: { code: 'X', message: 'git exploded' } }),
    });

    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );

    // A failed lookup must not fail the session; setup_changes degrades to [].
    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
  });

  it('reports an empty setup_changes for an observer session (no worktree)', async () => {
    const h = buildSessionHarness({
      startSession: async (config: any) => ({
        success: true,
        data: {
          id: 'inst_obs',
          sessionId: 'sess_obs',
          status: 'waiting',
          createdAt: '2026-08-29T00:00:00.000Z',
          worktreePath: null,
          prompt: 'P',
          config,
        },
      }),
    });

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'review',
        isolation: 'observer',
      })
    );

    expect(out.ok).toBe(true);
    expect(out.isolation).toBe('observer');
    expect(out.setup_changes).toEqual([]);
    // An observer has no worktree, so nothing is looked up.
    expect(h.getPendingChanges).not.toHaveBeenCalled();
  });
});
