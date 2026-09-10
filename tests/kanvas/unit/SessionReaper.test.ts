/**
 * SessionOrchestrator.reapExpiredAgentSessions — story KIT-MCP-R1
 *
 * The pure decision lives in shared/session-reap.ts and is tested exhaustively
 * there. This covers the parts only the service can get wrong: resolving
 * liveness across restart aliases, not running two passes at once, and never
 * pointing a delete at the wrong thing.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SessionOrchestrator } from '../../../electron/services/SessionOrchestrator';
import type { AgentInstance } from '../../../shared/types';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const inst = (over: Partial<AgentInstance> & { sessionId: string }): AgentInstance =>
  ({
    id: `inst_${over.sessionId}`,
    status: 'waiting',
    createdAt: minutesAgo(600),
    worktreePath: `/wt/${over.sessionId}`,
    ...over,
    // AFTER the spread: a caller passing a partial `config` means "override
    // these fields", not "replace the whole config". Spreading `over` last
    // silently dropped createdBy:'mcp' and made every such fixture look like a
    // human session.
    config: {
      repoPath: '/repo',
      agentType: 'claude',
      taskDescription: 't',
      branchName: `claude-session-${over.sessionId}`,
      baseBranch: 'development',
      useWorktree: true,
      autoCommit: true,
      commitInterval: 30,
      rebaseFrequency: 'never',
      systemPrompt: '',
      contextPreservation: '',
      createdBy: 'mcp',
      ...(over.config ?? {}),
    },
  }) as AgentInstance;

function harness(instances: AgentInstance[], over: Record<string, any> = {}) {
  const deleted: Array<{ sessionId: string; options: any }> = [];
  const closed: Array<{ sessionId: string; reason?: string }> = [];
  const snapshots: string[] = [];
  const safetyCalls: Array<{ worktreePath: string; baseBranch?: string }> = [];
  const livenessQueries: string[][] = [];

  const deps: any = {
    agentInstance: {
      createInstance: jest.fn(),
      listInstances: () => ({ success: true, data: instances }),
      markSessionClosed: jest.fn((sessionId: string, opts: any) => {
        closed.push({ sessionId, reason: opts?.reason });
        const i = instances.find((x) => x.sessionId === sessionId);
        if (i) (i as any).status = 'closed';
        return { success: true, data: undefined };
      }),
      getDeleteSafetyInfo: jest.fn(),
      deleteInstanceWithCleanup: jest.fn(async (sessionId: string, options: any) => {
        deleted.push({ sessionId, options });
        return { success: true, data: undefined };
      }),
      markSessionReaped: jest.fn(() => ({ success: true, data: undefined })),
    },
    watcher: { startWithPath: jest.fn(), stopAll: jest.fn(async () => ({ success: true })) },
    rebaseWatcher: { stopWatching: jest.fn(async () => ({ success: true })) },
    binder: { unregisterSession: jest.fn() },
    reap: {
      getLastActivityAt: jest.fn(async (ids: string[]) => {
        livenessQueries.push([...ids]);
        return null;
      }),
      getReapSafetyInfo: jest.fn(async (worktreePath: string, baseBranch?: string) => {
        safetyCalls.push({ worktreePath, baseBranch });
        return {
          success: true,
          data: { conclusive: true, hasUncommittedChanges: false, unmergedCommitCount: 0 },
        };
      }),
      createSnapshot: jest.fn(async (_wt: string, sessionId: string) => {
        snapshots.push(sessionId);
        return { success: true, data: { sha: 'abc', refName: `refs/kit-autosave/${sessionId}` } };
      }),
      ...(over.reap ?? {}),
    },
    ...over,
  };

  return {
    orch: new SessionOrchestrator(deps),
    deps,
    deleted,
    closed,
    snapshots,
    safetyCalls,
    livenessQueries,
    instances,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('reapExpiredAgentSessions — selection', () => {
  it('reaps an expired agent session and leaves a human one alone', async () => {
    const h = harness([
      inst({ sessionId: 'sess_agent' }),
      inst({ sessionId: 'sess_human', config: { createdBy: 'ui' } as any }),
    ]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(result.reaped.map((r) => r.sessionId)).toEqual(['sess_agent']);
    expect(h.deleted.map((d) => d.sessionId)).toEqual(['sess_agent']);
  });

  it('does not reap a safe-closed session with a retained worktree', async () => {
    // The headline guarantee: a safe close keeps the worktree on purpose.
    const h = harness([
      inst({ sessionId: 'sess_closed', status: 'closed' as any, createdAt: minutesAgo(9999) }),
    ]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(result.reaped).toHaveLength(0);
    expect(h.deleted).toHaveLength(0);
    expect(result.skipped.find((s) => s.sessionId === 'sess_closed')?.reasonCode).toBe(
      'TERMINAL_STATUS'
    );
  });

  it('does nothing at all when nothing has expired', async () => {
    const h = harness([inst({ sessionId: 'sess_fresh', createdAt: minutesAgo(1) })]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(result.reaped).toHaveLength(0);
    expect(h.deps.reap.getReapSafetyInfo).not.toHaveBeenCalled();
  });
});

// ─── AC (c) ──────────────────────────────────────────────────────────────────
describe('reapExpiredAgentSessions — liveness across restart aliases', () => {
  it('queries liveness for every alias, not just the current id', async () => {
    const h = harness([
      inst({ sessionId: 'sess_new', predecessorSessionIds: ['sess_old1', 'sess_old2'] }),
    ]);

    await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.livenessQueries).toHaveLength(1);
    expect([...h.livenessQueries[0]].sort()).toEqual(['sess_new', 'sess_old1', 'sess_old2']);
  });

  it('does NOT reap a session whose only activity is under a predecessor id', async () => {
    // Without alias expansion this session looks like it has never done
    // anything, and a live agent gets its worktree deleted mid-task.
    const h = harness(
      [inst({ sessionId: 'sess_new', predecessorSessionIds: ['sess_old'] })],
      {
        reap: {
          getLastActivityAt: jest.fn(async (ids: string[]) =>
            ids.includes('sess_old') ? minutesAgo(2) : null
          ),
          getReapSafetyInfo: jest.fn(),
          createSnapshot: jest.fn(),
        },
      }
    );

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(result.reaped).toHaveLength(0);
    expect(h.deleted).toHaveLength(0);
  });
});

// ─── AC (d) ──────────────────────────────────────────────────────────────────
describe('reapExpiredAgentSessions — re-entrancy', () => {
  it('two overlapping passes never both delete the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const h = harness([inst({ sessionId: 'sess_a' })], {
      reap: {
        getLastActivityAt: jest.fn(async () => null),
        getReapSafetyInfo: jest.fn(async () => {
          await gate; // hold the first pass open inside the critical section
          return {
            success: true,
            data: { conclusive: true, hasUncommittedChanges: false, unmergedCommitCount: 0 },
          };
        }),
        createSnapshot: jest.fn(),
      },
    });

    const first = h.orch.reapExpiredAgentSessions({ now: NOW });
    const second = h.orch.reapExpiredAgentSessions({ now: NOW });
    release();
    const [r1, r2] = await Promise.all([first, second]);

    expect(h.deleted).toHaveLength(1);
    // The second pass reports that it declined to run rather than silently
    // returning an empty success, which would read as "nothing to do".
    expect([r1.skippedBecauseRunning, r2.skippedBecauseRunning]).toContain(true);
  });

  it('releases the guard after a pass that throws', async () => {
    const h = harness([inst({ sessionId: 'sess_a' })], {
      reap: {
        getLastActivityAt: jest.fn(async () => {
          throw new Error('db is down');
        }),
        getReapSafetyInfo: jest.fn(),
        createSnapshot: jest.fn(),
      },
    });

    await h.orch.reapExpiredAgentSessions({ now: NOW });
    const second = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(second.skippedBecauseRunning).toBeFalsy();
  });
});

describe('reapExpiredAgentSessions — dispositions', () => {
  it('snapshots and closes a dirty session without deleting anything', async () => {
    const h = harness([inst({ sessionId: 'sess_dirty' })], {
      reap: {
        getLastActivityAt: jest.fn(async () => null),
        getReapSafetyInfo: jest.fn(async () => ({
          success: true,
          data: { conclusive: true, hasUncommittedChanges: true, unmergedCommitCount: 0 },
        })),
        createSnapshot: jest.fn(async () => ({
          success: true,
          data: { sha: 'abc', refName: 'refs/kit-autosave/sess_dirty' },
        })),
      },
    });

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.deleted).toHaveLength(0);
    expect(h.closed.map((c) => c.sessionId)).toEqual(['sess_dirty']);
    expect(result.reaped[0].action).toBe('snapshot-and-close');
    expect(h.deps.reap.createSnapshot).toHaveBeenCalled();
  });

  it('refuses to delete when the merge check is inconclusive', async () => {
    const h = harness([inst({ sessionId: 'sess_trunk' })], {
      reap: {
        getLastActivityAt: jest.fn(async () => null),
        getReapSafetyInfo: jest.fn(async () => ({
          success: true,
          data: {
            conclusive: false,
            hasUncommittedChanges: false,
            unmergedCommitCount: 0,
            inconclusiveReason: "base branch 'development' does not resolve",
          },
        })),
        createSnapshot: jest.fn(async () => ({ success: true, data: null })),
      },
    });

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.deleted).toHaveLength(0);
    expect(result.reaped[0].action).toBe('snapshot-and-close');
  });

  it('treats a failed git safety probe as inconclusive rather than as clean', async () => {
    const h = harness([inst({ sessionId: 'sess_x' })], {
      reap: {
        getLastActivityAt: jest.fn(async () => null),
        getReapSafetyInfo: jest.fn(async () => ({
          success: false,
          error: { code: 'GIT_REAP_SAFETY_INFO_FAILED', message: 'boom' },
        })),
        createSnapshot: jest.fn(async () => ({ success: true, data: null })),
      },
    });

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.deleted).toHaveLength(0);
    expect(result.reaped[0].action).toBe('snapshot-and-close');
  });

  it('compares against the session own base branch, not a hardcoded one', async () => {
    const h = harness([
      inst({ sessionId: 'sess_a', config: { baseBranch: 'trunk' } as any }),
    ]);

    await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.safetyCalls[0]).toEqual({ worktreePath: '/wt/sess_a', baseBranch: 'trunk' });
  });

  it('never git-touches a session whose worktree creation failed', async () => {
    const h = harness([
      inst({ sessionId: 'sess_failed', worktreeStatus: 'failed', worktreePath: '/repo' }),
    ]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.deps.reap.getReapSafetyInfo).not.toHaveBeenCalled();
    expect(h.deps.reap.createSnapshot).not.toHaveBeenCalled();
    expect(h.deleted).toHaveLength(0);
    expect(result.reaped[0].action).toBe('teardown-only');
  });

  it('fully deletes an expired observer without a safety probe', async () => {
    const h = harness([
      inst({
        sessionId: 'sess_obs',
        worktreePath: undefined,
        config: { isolation: 'observer' } as any,
      }),
    ]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(result.reaped[0].action).toBe('delete-observer');
    expect(h.deps.reap.getReapSafetyInfo).not.toHaveBeenCalled();
    expect(h.deleted[0].options).toMatchObject({
      deleteWorktree: false,
      deleteLocalBranch: false,
    });
  });

  it('never asks for a remote branch deletion on any path', async () => {
    const h = harness([
      inst({ sessionId: 'sess_a' }),
      inst({ sessionId: 'sess_b', config: { isolation: 'observer' } as any }),
    ]);

    await h.orch.reapExpiredAgentSessions({ now: NOW });

    for (const d of h.deleted) expect(d.options.deleteRemoteBranch).toBe(false);
  });

  it('keeps going after one session fails and reports it', async () => {
    const h = harness([inst({ sessionId: 'sess_bad' }), inst({ sessionId: 'sess_good' })]);
    h.deps.agentInstance.deleteInstanceWithCleanup = jest.fn(
      async (sessionId: string, options: any) => {
        if (sessionId === 'sess_bad') throw new Error('worktree busy');
        h.deleted.push({ sessionId, options });
        return { success: true, data: undefined };
      }
    );

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW });

    expect(h.deleted.map((d) => d.sessionId)).toEqual(['sess_good']);
    expect(result.failed[0]).toMatchObject({ sessionId: 'sess_bad' });
  });

  it('does nothing but report when dryRun is set', async () => {
    const h = harness([inst({ sessionId: 'sess_a' })]);

    const result = await h.orch.reapExpiredAgentSessions({ now: NOW, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.reaped).toHaveLength(1);
    expect(h.deleted).toHaveLength(0);
    expect(h.closed).toHaveLength(0);
  });
});
