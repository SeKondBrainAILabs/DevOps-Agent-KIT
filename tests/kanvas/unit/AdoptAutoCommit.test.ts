/**
 * Adopted sessions are auto-commit OFF unless the caller asks.
 *
 * KIT Harness revises its own PR by adopting the kept PR branch. kit_adopt_session
 * used to hard-code autoCommit: true, so KIT could commit to that branch on its
 * own (the watcher's commit-message file, the idle-end checkpoint, the commit
 * before a restart) while the harness starts its own sessions with auto_commit
 * false. kit_adopt_session now takes auto_commit, default false, and
 * kit_start_session is unchanged.
 *
 * Adoption also starts the file watcher (as kit_start_session does): it is what
 * registers the worktree with GitService, so kit_commit works straight after
 * kit_adopt_session. The watcher makes no commit of its own unless
 * auto_commit is true.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  adoptedAutoCommit,
  commitOnRestart,
  mayAutoCommit,
} from '../../../shared/auto-commit-policy';
import { SessionOrchestrator } from '../../../electron/services/SessionOrchestrator';

function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('auto-commit policy', () => {
  it('adopts with auto-commit only when it is explicitly true', () => {
    expect(adoptedAutoCommit(undefined)).toBe(false);
    expect(adoptedAutoCommit(false)).toBe(false);
    expect(adoptedAutoCommit('true')).toBe(false);
    expect(adoptedAutoCommit(1)).toBe(false);
    expect(adoptedAutoCommit(true)).toBe(true);
  });

  it.each([
    // Unset (app-launch restart, kit_restart_session without commit_changes):
    // the auto-commit rule.
    [undefined, { createdBy: 'adopted', autoCommit: false }, false],
    [undefined, { createdBy: 'adopted', autoCommit: true }, true],
    [undefined, { createdBy: 'mcp', autoCommit: false }, true],
    [undefined, undefined, true],
    // Explicit: honoured as given, adopted or not.
    [true, { createdBy: 'adopted', autoCommit: false }, true],
    [false, { createdBy: 'adopted', autoCommit: true }, false],
    [false, { createdBy: 'mcp' }, false],
  ])('commitOnRestart(%s, %j) is %s', (requested, config, expected) => {
    expect(commitOnRestart(requested as any, config as any)).toBe(expected);
  });

  it.each([
    [{ createdBy: 'adopted', autoCommit: false }, false],
    [{ createdBy: 'adopted' }, false],
    [{ createdBy: 'adopted', autoCommit: true }, true],
    // Every other session keeps what it had, whatever autoCommit says.
    [{ createdBy: 'mcp', autoCommit: false }, true],
    [{ createdBy: 'mcp', autoCommit: true }, true],
    [{ createdBy: 'ui', autoCommit: false }, true],
    [{}, true],
    [undefined, true],
    [null, true],
  ])('mayAutoCommit(%j) is %s', (config, expected) => {
    expect(mayAutoCommit(config as any)).toBe(expected);
  });
});

// ─── SessionOrchestrator ─────────────────────────────────────────────────────

function orchestrator(instances: any[] = []) {
  const deps: any = {
    agentInstance: {
      createInstance: jest.fn(async (config: any) => {
        const created = { id: 'inst_new', sessionId: 'sess_new', status: 'waiting', worktreePath: '/wt/new', config };
        instances.push(created);
        return { success: true, data: created };
      }),
      listInstances: () => ({ success: true, data: instances }),
      markSessionClosed: jest.fn(() => ({ success: true, data: undefined })),
      restartInstance: jest.fn(async () => ({
        success: true,
        data: { id: 'inst_2', sessionId: 'sess_2', worktreePath: '/wt/sess_2', config: {} },
      })),
    },
    watcher: {
      startWithPath: jest.fn(async () => ({ success: true })),
      stopAll: jest.fn(async () => ({ success: true })),
    },
    rebaseWatcher: { stopWatching: jest.fn(async () => ({ success: true })) },
    binder: { unregisterSession: jest.fn() },
  };
  return { orch: new SessionOrchestrator(deps), deps };
}

describe('SessionOrchestrator.adoptSession', () => {
  it('adopts with autoCommit false by default', async () => {
    const h = orchestrator();
    await h.orch.adoptSession({ repoPath: '/repo', branchName: 'kit/pr-branch' });
    expect(h.deps.agentInstance.createInstance.mock.calls[0][0].autoCommit).toBe(false);
  });

  it('adopts with autoCommit true only when asked', async () => {
    const h = orchestrator();
    await h.orch.adoptSession({ repoPath: '/repo', branchName: 'kit/pr-branch', autoCommit: true });
    expect(h.deps.agentInstance.createInstance.mock.calls[0][0].autoCommit).toBe(true);
  });

  it('starts the file watcher on the adopted worktree, so kit_commit has a registered worktree', async () => {
    // WatcherService.startWithPath is the only place a session's worktree is
    // registered with GitService; without it kit_commit fails with
    // "No worktree registered for session" until a restart.
    const h = orchestrator();
    await h.orch.adoptSession({ repoPath: '/repo', branchName: 'kit/pr-branch', worktreePath: '/wt/new' });
    expect(h.deps.watcher.startWithPath).toHaveBeenCalledWith('sess_new', '/wt/new');
    expect(h.deps.agentInstance.createInstance.mock.calls[0][0].autoCommit).toBe(false);
  });

  it('does not fail the adoption when the watcher will not start', async () => {
    const h = orchestrator();
    h.deps.watcher.startWithPath.mockRejectedValueOnce(new Error('ENOENT'));
    const r = await h.orch.adoptSession({ repoPath: '/repo', branchName: 'kit/pr-branch' });
    expect(r.success).toBe(true);
  });

  it('starts no watcher when the adoption failed', async () => {
    const h = orchestrator([
      { sessionId: 'sess_x', status: 'idle', config: { repoPath: '/repo', branchName: 'kit/pr-branch', createdBy: 'ui' } },
    ]);
    const r = await h.orch.adoptSession({ repoPath: '/repo', branchName: 'kit/pr-branch' });
    expect(r.success).toBe(false);
    expect(h.deps.watcher.startWithPath).not.toHaveBeenCalled();
  });
});

describe('SessionOrchestrator.restartSession commitChanges', () => {
  it.each([undefined, true, false])('passes commitChanges=%s through unchanged', async (commitChanges) => {
    const h = orchestrator([{ sessionId: 'sess_1', status: 'idle', config: { createdBy: 'adopted' } }]);
    await h.orch.restartSession('sess_1', undefined, commitChanges);
    expect(h.deps.agentInstance.restartInstance.mock.calls[0][2]).toBe(commitChanges);
  });
});

// ─── MCP tools ───────────────────────────────────────────────────────────────

type Handler = (args: any) => Promise<any>;
const parse = (result: any) => JSON.parse(result.content[0].text);

function tools() {
  const handlers = new Map<string, Handler>();
  const server: any = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => handlers.set(name, handler),
  };
  const created = (config: any) => ({
    success: true,
    data: { id: 'inst_1', sessionId: 'sess_1', status: 'waiting', worktreePath: '/wt/x', prompt: 'P', config },
  });
  const adoptSession = jest.fn(async (input: any) =>
    created({ branchName: input.branchName, createdBy: 'adopted', autoCommit: input.autoCommit })
  );
  const startSession = jest.fn(async (config: any) => created(config));
  const restartSession = jest.fn(async () => created({ branchName: 'kit/pr' }));
  const binder: any = {
    getSession: () => undefined,
    getWorktreePath: () => undefined,
    getWorktreePathForRepo: () => undefined,
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
        adoptSession,
        startSession,
        restartSession,
        listSessions: () => [],
        expandSessionAliases: (id: string) => [id],
        teardownSession: async () => ({}),
        resolveSessionId: (id: string) => id,
      },
      gitService: {
        listBranchesForRepo: async () => ({ success: true, data: { currentBranch: 'main', branches: ['main'] } }),
      },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    },
    undefined
  );
  return { handlers, adoptSession, startSession, restartSession };
}

describe('kit_adopt_session auto_commit', () => {
  it('adopts with auto-commit off when auto_commit is omitted', async () => {
    const t = tools();
    const out = parse(await t.handlers.get('kit_adopt_session')!({ repo_path: '/repo', branch_name: 'kit/pr' }));
    expect(t.adoptSession.mock.calls[0][0].autoCommit).toBe(false);
    expect(out).toMatchObject({ ok: true, auto_commit: false });
  });

  it('adopts with auto-commit on when auto_commit is true', async () => {
    const t = tools();
    const out = parse(
      await t.handlers.get('kit_adopt_session')!({ repo_path: '/repo', branch_name: 'kit/pr', auto_commit: true })
    );
    expect(t.adoptSession.mock.calls[0][0].autoCommit).toBe(true);
    expect(out).toMatchObject({ ok: true, auto_commit: true });
  });
});

describe('kit_restart_session commit_changes', () => {
  it.each([
    [undefined, undefined],
    [true, true],
    [false, false],
  ])('passes commit_changes=%s through as %s (unset is the default; an explicit true still commits)', async (given, passed) => {
    const t = tools();
    const args: any = { target_session_id: 'sess_1' };
    if (given !== undefined) args.commit_changes = given;
    await t.handlers.get('kit_restart_session')!(args);
    expect((t.restartSession.mock.calls[0] as any[])[2]).toBe(passed);
  });
});

describe('kit_start_session is unchanged', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'kit-adopt-ac-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('still defaults auto_commit to true', async () => {
    const t = tools();
    await t.handlers.get('kit_start_session')!({ repo_path: tmpRoot, task: 't' });
    expect(t.startSession.mock.calls[0][0].autoCommit).toBe(true);
  });

  it('still honours auto_commit false', async () => {
    const t = tools();
    await t.handlers.get('kit_start_session')!({ repo_path: tmpRoot, task: 't', auto_commit: false });
    expect(t.startSession.mock.calls[0][0].autoCommit).toBe(false);
  });
});
