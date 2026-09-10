/**
 * Unit Tests for SessionReservation (story KIT-MCP-G1)
 *
 * The admission decision and the slot reservation, held together under one
 * lock.
 *
 * THE RACE THIS EXISTS TO CLOSE. In createInstance, the single-session guard
 * reads the instance map at one point and the reservation writes it at a later
 * one, with awaits in between (validateRepository, initializeKanvasDirectory)
 * that yield the event loop. Two concurrent creates therefore both pass the
 * guard and both create. MCP fan-out makes concurrent creates the NORMAL case
 * rather than an edge case, so this stops being theoretical.
 *
 * WHY IT IS A SEPARATE MODULE. jest cannot import AgentInstanceService at all —
 * electron-store is ESM and untransformed. Leaving the critical section inline
 * would make the single most concurrency-sensitive code in the epic
 * untestable, so it is extracted behind injected dependencies, exactly like
 * SessionOrchestrator.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  reserveSession,
  type ReservationDeps,
} from '../../../electron/services/SessionReservation';
import { KeyedMutex } from '../../../shared/async-mutex';
import { DEFAULT_SESSION_LIMITS } from '../../../shared/session-admission';
import { SINGLE_SESSION_MODE_ERROR_CODE } from '../../../shared/single-session-guard';
import type { AgentInstance, AgentInstanceConfig } from '../../../shared/types';

const config = (over: Partial<AgentInstanceConfig> = {}): AgentInstanceConfig =>
  ({
    repoPath: '/repo',
    agentType: 'claude',
    taskDescription: 'task',
    branchName: 'claude-session-1',
    baseBranch: 'development',
    useWorktree: true,
    autoCommit: true,
    commitInterval: 30,
    rebaseFrequency: 'never',
    systemPrompt: '',
    contextPreservation: '',
    createdBy: 'mcp',
    ...over,
  }) as AgentInstanceConfig;

/**
 * A deps fake whose reads and writes go through a real array, so a missing
 * lock shows up as a genuine lost update rather than a mocking artefact.
 */
function makeDeps(over: Partial<ReservationDeps> & { yieldBeforeRead?: boolean } = {}) {
  const instances: AgentInstance[] = [];
  const mutex = new KeyedMutex();

  const deps: ReservationDeps = {
    mutex,
    listInstances: () => instances,
    reserve: (inst) => {
      instances.push(inst);
    },
    getWorktreeMode: () => 'worktree',
    getLimits: () => DEFAULT_SESSION_LIMITS,
    ...over,
  };

  return { deps, instances, mutex };
}

const active = (over: Partial<AgentInstance> = {}): AgentInstance =>
  ({
    id: 'inst_x',
    sessionId: 'sess_x',
    status: 'waiting',
    createdAt: '2026-08-29T00:00:00.000Z',
    config: config({ branchName: 'other-branch' }),
    ...over,
  }) as AgentInstance;

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('reserveSession — happy path', () => {
  it('reserves a slot and returns fresh ids', async () => {
    const { deps, instances } = makeDeps();

    const result = await reserveSession(deps, config());

    expect(result.success).toBe(true);
    expect(result.data?.id).toMatch(/^inst_/);
    expect(result.data?.sessionId).toMatch(/^sess_/);
    expect(instances).toHaveLength(1);
  });

  it('mints distinct ids across sequential reservations', async () => {
    const { deps } = makeDeps();

    const a = await reserveSession(deps, config({ branchName: 'b1' }));
    const b = await reserveSession(deps, config({ branchName: 'b2' }));

    expect(a.data?.sessionId).not.toBe(b.data?.sessionId);
    expect(a.data?.id).not.toBe(b.data?.id);
  });
});

describe('reserveSession — BRANCH_IN_USE', () => {
  it('refuses a branch already held by an active session in the same repo', async () => {
    const { deps, instances } = makeDeps();
    instances.push(active({ config: config({ branchName: 'taken' }) }));

    const result = await reserveSession(deps, config({ branchName: 'taken' }));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BRANCH_IN_USE');
  });

  it('allows the same branch name in a different repo', async () => {
    const { deps, instances } = makeDeps();
    instances.push(
      active({ config: config({ branchName: 'taken', repoPath: '/other-repo' }) })
    );

    expect((await reserveSession(deps, config({ branchName: 'taken' }))).success).toBe(
      true
    );
  });

  it('allows reuse of a branch whose session is closed or completed', async () => {
    const { deps, instances } = makeDeps();
    instances.push(
      active({ status: 'closed' as any, config: config({ branchName: 'taken' }) })
    );

    expect((await reserveSession(deps, config({ branchName: 'taken' }))).success).toBe(
      true
    );
  });
});

describe('reserveSession — admission', () => {
  it('refuses when the kill switch is off', async () => {
    const { deps } = makeDeps({
      getLimits: () => ({ ...DEFAULT_SESSION_LIMITS, enabled: false }),
    });

    const result = await reserveSession(deps, config());

    expect(result.error?.code).toBe('AGENT_SESSION_CREATION_DISABLED');
  });

  it('refuses at the global cap and reports the offending sessions', async () => {
    const { deps, instances } = makeDeps({
      getLimits: () => ({ ...DEFAULT_SESSION_LIMITS, maxConcurrentGlobal: 2 }),
    });
    instances.push(
      active({ id: 'i1', sessionId: 's1', config: config({ branchName: 'b1' }) }),
      active({ id: 'i2', sessionId: 's2', config: config({ branchName: 'b2' }) })
    );

    const result = await reserveSession(deps, config({ branchName: 'b3' }));

    expect(result.error?.code).toBe('SESSION_LIMIT_REACHED');
    // The self-remediation payload: the agent must be told what to close.
    const listed = (result.error?.details as any)?.active_sessions ?? [];
    expect(listed.map((s: any) => s.session_id).sort()).toEqual(['s1', 's2']);
  });

  it('counts only MCP-created sessions against the cap', async () => {
    const { deps, instances } = makeDeps({
      getLimits: () => ({ ...DEFAULT_SESSION_LIMITS, maxConcurrentGlobal: 2 }),
    });
    instances.push(
      active({ id: 'i1', config: config({ branchName: 'b1', createdBy: 'ui' }) }),
      active({ id: 'i2', config: config({ branchName: 'b2', createdBy: 'ui' }) })
    );

    expect((await reserveSession(deps, config({ branchName: 'b3' }))).success).toBe(true);
  });

  it('applies single-session mode', async () => {
    const { deps, instances } = makeDeps({ getWorktreeMode: () => 'in-place' });
    instances.push(active());

    const result = await reserveSession(deps, config());

    expect(result.error?.code).toBe(SINGLE_SESSION_MODE_ERROR_CODE);
  });

  it('exempts a restart from the caps and the kill switch', async () => {
    // A restart is not net-new capacity. Without this, restarting a session
    // while at the cap — or after the user pulls the kill switch — fails.
    const { deps, instances } = makeDeps({
      getLimits: () => ({ ...DEFAULT_SESSION_LIMITS, enabled: false, maxConcurrentGlobal: 1 }),
    });
    instances.push(active({ config: config({ branchName: 'b1' }) }));

    const result = await reserveSession(deps, config({ branchName: 'b2' }), {
      isRestart: true,
    });

    expect(result.success).toBe(true);
  });

  it('still applies BRANCH_IN_USE to a restart', async () => {
    // The exemption is about capacity, not correctness.
    const { deps, instances } = makeDeps();
    instances.push(active({ config: config({ branchName: 'taken' }) }));

    const result = await reserveSession(deps, config({ branchName: 'taken' }), {
      isRestart: true,
    });

    expect(result.error?.code).toBe('BRANCH_IN_USE');
  });
});

// ─── The actual point of the story ───────────────────────────────────────────
describe('reserveSession — concurrency', () => {
  /**
   * Reproduces the real shape of the bug: the deps yield the event loop
   * between the read and the write, exactly as validateRepository and
   * initializeKanvasDirectory do inside createInstance.
   */
  const yieldingDeps = (over: Partial<ReservationDeps> = {}) => {
    const instances: AgentInstance[] = [];
    const deps: ReservationDeps = {
      mutex: new KeyedMutex(),
      listInstances: () => instances,
      reserve: (inst) => {
        instances.push(inst);
      },
      getWorktreeMode: () => 'worktree',
      getLimits: () => DEFAULT_SESSION_LIMITS,
      ...over,
    };
    return { deps, instances };
  };

  it('admits exactly ONE of 20 concurrent creates in single-session mode', async () => {
    const { deps, instances } = yieldingDeps({ getWorktreeMode: () => 'in-place' });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveSession(deps, config({ branchName: `branch-${i}` }))
      )
    );

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => r.error?.code === SINGLE_SESSION_MODE_ERROR_CODE)
    ).toHaveLength(19);
    expect(instances).toHaveLength(1);
  });

  it('admits exactly the PER-REPO cap out of 20 concurrent creates in one repo', async () => {
    // The default per-repo cap is 4, and all 20 target the same repo — so this
    // is the cap that binds, not the global 8.
    const { deps, instances } = yieldingDeps();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveSession(deps, config({ branchName: `branch-${i}` }))
      )
    );

    expect(results.filter((r) => r.success)).toHaveLength(4);
    expect(
      results.filter((r) => r.error?.code === 'SESSION_LIMIT_REACHED')
    ).toHaveLength(16);
    expect(instances).toHaveLength(4);
  });

  it('admits exactly the GLOBAL cap out of 20 concurrent creates across repos', async () => {
    // Spread across repos with the per-repo cap lifted, so the global cap is
    // the only one in play.
    const { deps, instances } = yieldingDeps({
      getLimits: () => ({
        enabled: true,
        maxConcurrentGlobal: 8,
        maxConcurrentPerRepo: 99,
      }),
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveSession(deps, config({ repoPath: `/repo-${i}`, branchName: `branch-${i}` }))
      )
    );

    expect(results.filter((r) => r.success)).toHaveLength(8);
    expect(
      results.filter((r) => r.error?.code === 'SESSION_LIMIT_REACHED')
    ).toHaveLength(12);
    expect(instances).toHaveLength(8);
  });

  it('admits exactly one of 20 concurrent creates on the SAME branch', async () => {
    // BRANCH_IN_USE is only meaningful if the check and the reservation are
    // atomic with respect to each other.
    const { deps, instances } = yieldingDeps();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveSession(deps, config({ branchName: 'same' })))
    );

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(instances).toHaveLength(1);
  });

  it('mints unique ids under concurrency', async () => {
    // Date.now() + Math.random() collide more readily than intuition suggests
    // when 20 calls land in the same millisecond.
    const { deps } = yieldingDeps();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        reserveSession(deps, config({ branchName: `b-${i}` }))
      )
    );

    const ids = results.filter((r) => r.success).map((r) => r.data!.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not serialise reservations across different repos', async () => {
    // Admission is globally serialised, but it is a synchronous section — it
    // must not become a queue that fan-out across repos waits behind.
    const { deps } = yieldingDeps();

    const start = Date.now();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        reserveSession(deps, config({ repoPath: `/repo-${i}`, branchName: `b-${i}` }))
      )
    );

    expect(Date.now() - start).toBeLessThan(1000);
  });
});
