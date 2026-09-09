/**
 * MCP session-lifecycle tools — stories KIT-MCP-M1 onwards.
 *
 * Drives the real `registerTools` against a capturing stub, the way
 * McpTools.test.ts does, and invokes the captured handlers directly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Proxy stub: every schema method chains. An enumerated list rots as schemas
// grow — that is how the registry suite first broke.
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

type Handler = (args: any) => Promise<any>;

interface Harness {
  handlers: Map<string, Handler>;
  startSession: jest.Mock<any>;
  listBranchesForRepo: jest.Mock<any>;
}

function buildHarness(over: {
  startSession?: (config: any) => Promise<any>;
  branches?: { currentBranch?: string; branches?: string[] };
} = {}): Harness {
  const handlers = new Map<string, Handler>();
  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };

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

  const listBranchesForRepo = jest.fn(async () => ({
    success: true,
    data: over.branches ?? { currentBranch: 'development', branches: ['main', 'development'] },
  })) as any;

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
        startSession,
        listSessions: () => [],
        expandSessionAliases: (id: string) => [id],
        teardownSession: async () => ({}),
        resolveSessionId: (id: string) => id,
      },
      gitService: { listBranchesForRepo },
      mcpUrl: () => 'http://127.0.0.1:39100/mcp',
    },
    undefined
  );

  return { handlers, startSession, listBranchesForRepo };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

let repoDir: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kit-m1-'));
  repoDir = join(tmpRoot, 'MyApp');
  mkdirSync(repoDir, { recursive: true });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('kit_start_session — registration', () => {
  it('is registered', () => {
    expect(buildHarness().handlers.has('kit_start_session')).toBe(true);
  });
});

describe('kit_start_session — repo_path handling', () => {
  it('refuses a path that does not exist', async () => {
    const h = buildHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: join(tmpRoot, 'nope'),
        task: 't',
      })
    );
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe('INVALID_REPO');
  });

  it('normalises a trailing slash so the caps cannot be bypassed', async () => {
    // getActiveSessionsForRepo compares repo paths by EXACT STRING, so a
    // trailing slash would create a second bucket and with it a way past both
    // the per-repo cap and Single-Session Mode.
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({ repo_path: repoDir + '/', task: 't' });

    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.startSession.mock.calls[0][0].repoPath).not.toMatch(/\/$/);
  });

  it('refuses a repo_path that is itself a KIT worktree', async () => {
    // An orchestrator running inside its own worktree will naturally pass its
    // cwd. That would nest a worktree inside the parent's, and the parent's
    // watcher would commit it.
    const nested = join(tmpRoot, 'KIT-DevOps-MyApp', 'claude-session-20260829-a1b2');
    mkdirSync(nested, { recursive: true });

    const h = buildHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: nested, task: 't' })
    );

    expect(out.ok).toBe(false);
    expect(out.error_code).toBe('NESTED_WORKTREE_REFUSED');
    expect(out.message).toMatch(/SOURCE repository/i);
    expect(h.startSession).not.toHaveBeenCalled();
  });
});

describe('kit_start_session — derivation', () => {
  it('derives a branch name in the UI shape when none is given', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' });

    const branch = h.startSession.mock.calls[0][0].branchName;
    expect(branch).toMatch(/^claude-session-\d{8}-[a-z0-9]{4}$/);
  });

  it('honours an explicit branch name', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 't',
      branch_name: 'feat/explicit',
    });
    expect(h.startSession.mock.calls[0][0].branchName).toBe('feat/explicit');
  });

  it('derives the base branch from the repo rather than hard-defaulting to main', async () => {
    // The wizard shows the user its choice; an agent just gets it. Guessing
    // 'main' would cut every session off the wrong base in a repo on
    // 'development'.
    const h = buildHarness({
      branches: { currentBranch: 'development', branches: ['main', 'development'] },
    });
    await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' });

    expect(h.startSession.mock.calls[0][0].baseBranch).toBe('development');
  });

  it('never picks another session branch as the base', async () => {
    const h = buildHarness({
      branches: {
        currentBranch: 'claude-session-20260829-a1b2',
        branches: ['main', 'claude-session-20260829-a1b2'],
      },
    });
    await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' });

    expect(h.startSession.mock.calls[0][0].baseBranch).toBe('main');
  });

  it('strips an origin/ prefix from an explicit base branch', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 't',
      base_branch: 'origin/development',
    });
    expect(h.startSession.mock.calls[0][0].baseBranch).toBe('development');
  });

  it('still resolves a base branch when the branch listing fails', async () => {
    const h = buildHarness();
    h.listBranchesForRepo.mockRejectedValueOnce(new Error('git exploded'));

    await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' });

    expect(h.startSession.mock.calls[0][0].baseBranch).toBe('main');
  });
});

describe('kit_start_session — lineage and origin', () => {
  it('stamps createdBy mcp', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' });
    expect(h.startSession.mock.calls[0][0].createdBy).toBe('mcp');
  });

  it('records the caller as the parent so bulk close has an anchor', async () => {
    const h = buildHarness();
    await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 't',
      session_id: 'sess_parent',
    });
    expect(h.startSession.mock.calls[0][0].parentSessionId).toBe('sess_parent');
  });
});

describe('kit_start_session — dry run', () => {
  it('returns the resolved plan and creates nothing', async () => {
    const h = buildHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 't',
        dry_run: true,
      })
    );

    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.plan.base_branch).toBe('development');
    expect(out.plan.branch).toMatch(/^claude-session-/);
    expect(h.startSession).not.toHaveBeenCalled();
  });
});

describe('kit_start_session — response', () => {
  it('returns what a subagent needs to start working', async () => {
    const h = buildHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'do a thing',
        session_id: 'sess_parent',
      })
    );

    expect(out.ok).toBe(true);
    expect(out.session_id).toBe('sess_1');
    expect(out.worktree_path).toContain('KIT-DevOps-repo');
    expect(out.launch.must_pass_session_id).toBe('sess_1');
    expect(out.launch.cwd).toBe(out.worktree_path);
    expect(out.mcp.url).toBe('http://127.0.0.1:39100/mcp');
    expect(out.watcher_started).toBe(true);
  });

  it('includes the prompt by default and omits it on request', async () => {
    const h = buildHarness();
    const withPrompt = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );
    expect(withPrompt.prompt).toBe('PROMPT BODY');

    const without = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 't',
        include_prompt: false,
      })
    );
    expect(without.prompt).toBeUndefined();
  });

  it('surfaces provisioning warnings that used to be swallowed', async () => {
    const h = buildHarness({
      startSession: async (config: any) => ({
        success: true,
        data: {
          id: 'inst_1',
          sessionId: 'sess_1',
          status: 'waiting',
          createdAt: 'now',
          worktreePath: '/wt/x',
          config,
          worktreeWarnings: ['link .env into worktree: ENOENT'],
        },
      }),
    });
    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );
    expect(out.warnings).toEqual(['link .env into worktree: ENOENT']);
  });
});

describe('kit_start_session — refusals pass through verbatim', () => {
  it('returns the admission error code and its self-remediation payload', async () => {
    // The whole point of a machine-readable refusal: the agent must be able to
    // close its own oldest session rather than retry-looping.
    const h = buildHarness({
      startSession: async () => ({
        success: false,
        error: {
          code: 'SESSION_LIMIT_REACHED',
          message: 'Agent session limit reached (global): 8 of 8 in use.',
          details: { scope: 'global', limit: 8, current: 8, active_sessions: [{ session_id: 's1' }] },
          instruction: 'Close a session with kit_close_session(session_id=...) before creating another.',
        },
      }),
    });

    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );

    expect(out.ok).toBe(false);
    expect(out.error_code).toBe('SESSION_LIMIT_REACHED');
    expect(out.retryable).toBe(true);
    expect(out.details.active_sessions).toEqual([{ session_id: 's1' }]);
    expect(out.instruction).toMatch(/kit_close_session/);
  });

  it('marks a kill-switch refusal as not retryable', async () => {
    const h = buildHarness({
      startSession: async () => ({
        success: false,
        error: {
          code: 'AGENT_SESSION_CREATION_DISABLED',
          message: 'disabled',
          instruction: 'Ask the user.',
        },
      }),
    });
    const out = parse(
      await h.handlers.get('kit_start_session')!({ repo_path: repoDir, task: 't' })
    );
    expect(out.error_code).toBe('AGENT_SESSION_CREATION_DISABLED');
    expect(out.retryable).toBe(false);
  });
});

// ─── observer sessions (A2/A3/A4) ────────────────────────────────────────────
describe('kit_start_session — observer isolation', () => {
  function observerHarness(over: { sessions?: any[] } = {}) {
    const handlers = new Map<string, Handler>();
    const registerObserverSession = jest.fn() as any;
    const observerIds = new Set<string>();
    const bound = new Map<string, any>();

    const server: any = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h),
    };
    const binder: any = {
      getSession: (id: string) => bound.get(id),
      getWorktreePath: () => undefined,
      getWorktreePathForRepo: () => undefined,
      getReposForSession: () => [],
      getPrimaryRepoNameIfSecondary: () => undefined,
      listSessions: () => [],
      isObserver: (id: string) => observerIds.has(id),
      registerObserverSession: (id: string, path: string, o: any) => {
        registerObserverSession(id, path, o);
        observerIds.add(id);
        bound.set(id, { worktreePath: path, isolation: 'observer', ownerSessionId: o?.ownerSessionId });
      },
    };

    const startSession = jest.fn(async (config: any) => ({
      success: true,
      data: {
        id: 'inst_obs',
        sessionId: 'sess_obs',
        status: 'waiting',
        createdAt: 'now',
        // Critical: an observer gets NO worktreePath back.
        worktreePath: config.isolation === 'observer' ? undefined : '/wt/x',
        config,
      },
    })) as any;

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(
      server,
      binder,
      {
        sessionOrchestrator: {
          startSession,
          listSessions: () => over.sessions ?? [],
          expandSessionAliases: (id: string) => [id],
          teardownSession: async () => ({}),
          resolveSessionId: (id: string) => id,
          directChildSessionIds: () => [],
          descendantSessionIds: () => [],
        },
        gitService: { listBranchesForRepo: async () => ({ success: true, data: {} }) },
        mcpUrl: () => 'http://127.0.0.1:39100/mcp',
      },
      undefined
    );
    return { handlers, startSession, registerObserverSession, binder };
  }

  it('creates an observer with NO worktree and NO watcher', async () => {
    const h = observerHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 'review the diff',
        isolation: 'observer',
      })
    );

    expect(out.ok).toBe(true);
    expect(out.isolation).toBe('observer');
    expect(out.worktree_path).toBeNull();
    expect(out.watcher_started).toBe(false);
    expect(out.read_only).toBe(true);
  });

  it('never sets autoCommit for an observer', async () => {
    // The tree it watches is not its own; auto-committing would land the
    // owner's uncommitted work on the owner's branch.
    const h = observerHarness();
    await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 't',
      isolation: 'observer',
    });
    expect(h.startSession.mock.calls[0][0].autoCommit).toBe(false);
    expect(h.startSession.mock.calls[0][0].isolation).toBe('observer');
  });

  it('borrows a named session’s worktree and records the owner', async () => {
    const owner = {
      sessionId: 'sess_owner',
      worktreePath: '/Users/x/Repos/KIT-DevOps-MyApp/claude-session-20260829-a1b2',
      config: { repoPath: '/Users/x/Repos/MyApp' },
    };
    const h = observerHarness({ sessions: [owner] });

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 't',
        isolation: 'observer',
        observe_session_id: 'sess_owner',
      })
    );

    expect(out.observed_path).toBe(owner.worktreePath);
    expect(out.observer_of).toBe('sess_owner');
    // repoPath resolves to the SOURCE repo, so KIT's own bookkeeping never
    // lands inside the borrowed directory.
    expect(out.repo_path).toBe('/Users/x/Repos/MyApp');
  });

  it('registers with the binder as an observer', async () => {
    const h = observerHarness();
    await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 't',
      isolation: 'observer',
    });
    expect(h.registerObserverSession).toHaveBeenCalledWith(
      'sess_obs',
      expect.any(String),
      expect.anything()
    );
  });

  it('refuses to observe an observer', async () => {
    const other = {
      sessionId: 'sess_other_obs',
      config: { isolation: 'observer', repoPath: '/r' },
    };
    const h = observerHarness({ sessions: [other] });

    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 't',
        isolation: 'observer',
        observe_session_id: 'sess_other_obs',
      })
    );

    expect(out.ok).toBe(false);
    expect(out.error_code).toBe('OBSERVER_OF_OBSERVER_REFUSED');
  });

  it('refuses to observe a session that does not exist', async () => {
    const h = observerHarness();
    const out = parse(
      await h.handlers.get('kit_start_session')!({
        repo_path: repoDir,
        task: 't',
        isolation: 'observer',
        observe_session_id: 'sess_ghost',
      })
    );
    expect(out.error_code).toBe('NOT_FOUND');
  });
});

describe('observer read-only enforcement (A4)', () => {
  function guardHarness() {
    const handlers = new Map<string, Handler>();
    const observers = new Set<string>(['sess_obs']);
    const server: any = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h),
    };
    const binder: any = {
      getSession: (id: string) =>
        observers.has(id)
          ? { worktreePath: '/borrowed/wt', isolation: 'observer', ownerSessionId: 'sess_owner' }
          : { worktreePath: '/own/wt' },
      getWorktreePath: () => '/own/wt',
      getWorktreePathForRepo: () => '/own/wt',
      getReposForSession: () => [],
      getPrimaryRepoNameIfSecondary: () => undefined,
      listSessions: () => [],
      isObserver: (id: string) => observers.has(id),
    };
    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(server, binder, {}, undefined);
    return handlers;
  }

  const FORBIDDEN = [
    'kit_commit',
    'kit_commit_all',
    'kit_merge',
    'kit_rebase',
    'kit_request_review',
    'kit_lock_file',
    'kit_unlock_file',
    'kit_set_repo_worktree_mode',
    'kit_start_session',
  ];

  it.each(FORBIDDEN)('refuses %s for an observer', async (tool) => {
    const handlers = guardHarness();
    const result = await handlers.get(tool)!({
      session_id: 'sess_obs',
      repo_path: '/r',
      mode: 'worktree',
      message: 'x',
      task: 't',
    });

    expect(result.isError).toBe(true);
    const out = parse(result);
    expect(out.error).toBe('OBSERVER_SESSION_READ_ONLY');
    expect(out.tool).toBe(tool);
  });

  it('names the borrowed path and the owner so the agent can explain itself', async () => {
    const handlers = guardHarness();
    const out = parse(
      await handlers.get('kit_commit')!({ session_id: 'sess_obs', message: 'x' })
    );
    expect(out.observed_path).toBe('/borrowed/wt');
    expect(out.owner_session_id).toBe('sess_owner');
    expect(out.instruction).toMatch(/kit_log_activity/);
    expect(out.instruction).toMatch(/read tools/i);
  });

  it('covers kit_set_repo_worktree_mode, which had no session_id before', async () => {
    // The guard reads the caller from args. This tool took only
    // {repo_path, mode}, so it resolved to 'unknown' and a throwaway inspector
    // could have flipped a repo-wide policy for everybody.
    const handlers = guardHarness();
    const result = await handlers.get('kit_set_repo_worktree_mode')!({
      session_id: 'sess_obs',
      repo_path: '/r',
      mode: 'in-place',
    });
    expect(result.isError).toBe(true);
  });

  it('does NOT refuse those tools for a normal session', async () => {
    // The guard is what is under test, not kit_commit's internals — a normal
    // session falls through into the real divergence check, which this
    // harness's binder stub does not satisfy. Either outcome is fine as long
    // as it is not the observer refusal.
    const handlers = guardHarness();
    let out: any;
    try {
      out = parse(
        await handlers.get('kit_commit')!({ session_id: 'sess_normal', message: 'x' })
      );
    } catch {
      out = { error: 'threw-past-the-guard' };
    }
    expect(out.error).not.toBe('OBSERVER_SESSION_READ_ONLY');
  });

  it('allows read and registry tools for an observer', async () => {
    // Blocking workspace/discovery tools would make observers useless for
    // exactly the work they are best at.
    const handlers = guardHarness();
    for (const tool of ['kit_get_session_info', 'kit_log_activity', 'kit_workspace_list']) {
      const result = await handlers.get(tool)!({
        session_id: 'sess_obs',
        type: 'info',
        message: 'finding',
      });
      const out = parse(result);
      expect(out.error).not.toBe('OBSERVER_SESSION_READ_ONLY');
    }
  });
});
