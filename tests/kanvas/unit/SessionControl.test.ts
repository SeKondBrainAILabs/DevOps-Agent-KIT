/**
 * SessionOrchestrator restart / adopt / update — story KIT-MCP-M5
 *
 * These are the control tools. Two of them are the ones most likely to punch a
 * hole in the epic's safety model, so most of what follows is about the holes
 * rather than the happy paths:
 *
 *   - RESTART must not unbind MCP while it re-aliases. H2 made teardown
 *     unregister every predecessor alias, and restart re-adds them a few steps
 *     later; unbinding in between breaks in-flight kit_commit calls, and
 *     permanently if the create half then fails.
 *
 *   - ADOPT must stamp 'adopted', never 'mcp'. An agent that could adopt a
 *     human's branch and have it recorded as agent-created could then legally
 *     destroy it — straight through the central fail-safe.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SessionOrchestrator } from '../../../electron/services/SessionOrchestrator';
import type { AgentInstance } from '../../../shared/types';

const baseConfig = {
  repoPath: '/repo',
  agentType: 'claude',
  taskDescription: 'original task',
  branchName: 'claude-session-1',
  baseBranch: 'development',
  useWorktree: true,
  autoCommit: true,
  commitInterval: 30,
  rebaseFrequency: 'never',
  systemPrompt: '',
  contextPreservation: '',
  createdBy: 'mcp',
};

const inst = (over: any = {}): AgentInstance =>
  ({
    id: 'inst_1',
    sessionId: 'sess_1',
    status: 'waiting',
    createdAt: '2026-09-08T00:00:00.000Z',
    worktreePath: '/wt/sess_1',
    ...over,
    config: { ...baseConfig, ...(over.config ?? {}) },
  }) as AgentInstance;

function harness(instances: AgentInstance[] = [inst()], over: any = {}) {
  const calls: string[] = [];
  const deps: any = {
    agentInstance: {
      createInstance: jest.fn(async (config: any) => {
        calls.push('createInstance');
        const created = inst({ id: 'inst_new', sessionId: 'sess_new', config });
        instances.push(created);
        return { success: true, data: created };
      }),
      listInstances: () => ({ success: true, data: instances }),
      markSessionClosed: jest.fn(() => ({ success: true, data: undefined })),
      getDeleteSafetyInfo: jest.fn(),
      deleteInstanceWithCleanup: jest.fn(async () => ({ success: true, data: undefined })),
      restartInstance: jest.fn(async () => {
        calls.push('restartInstance');
        return {
          success: true,
          data: inst({
            id: 'inst_2',
            sessionId: 'sess_2',
            worktreePath: '/wt/sess_2',
            predecessorSessionIds: ['sess_1'],
          }),
        };
      }),
      updateSessionConfig: jest.fn(async () => ({ success: true, data: undefined })),
      ...(over.agentInstance ?? {}),
    },
    watcher: {
      startWithPath: jest.fn(async () => {
        calls.push('startWithPath');
        return { success: true };
      }),
      stopAll: jest.fn(async () => {
        calls.push('stopAll');
        return { success: true };
      }),
    },
    rebaseWatcher: {
      stopWatching: jest.fn(async () => {
        calls.push('rebaseStop');
        return { success: true };
      }),
      startWatching: jest.fn(async () => {
        calls.push('rebaseStart');
        return { success: true };
      }),
    },
    binder: {
      unregisterSession: jest.fn(() => {
        calls.push('unregister');
      }),
    },
    ...over,
  };
  return { orch: new SessionOrchestrator(deps), deps, calls, instances };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ─── Restart ─────────────────────────────────────────────────────────────────
describe('restartSession', () => {
  it('tears down, restarts, and starts the watcher on the NEW worktree', async () => {
    const h = harness();

    const result = await h.orch.restartSession('sess_1');

    expect(result.success).toBe(true);
    expect(h.calls).toEqual([
      'stopAll',
      'rebaseStop',
      'restartInstance',
      'startWithPath',
    ]);
    expect(h.deps.watcher.startWithPath).toHaveBeenCalledWith('sess_2', '/wt/sess_2');
  });

  it('NEVER unbinds MCP during a restart', async () => {
    // The whole reason restartSession exists rather than reusing the close
    // path. Teardown unregisters every predecessor alias; restart re-adds them
    // immediately after. Unbinding in between means an in-flight kit_commit
    // under the old id gets "Unknown session", permanently if create fails.
    const h = harness();

    await h.orch.restartSession('sess_1');

    expect(h.deps.binder.unregisterSession).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('unregister');
  });

  it('does not start a watcher when the restart itself failed', async () => {
    const h = harness([inst()], {
      agentInstance: {
        restartInstance: jest.fn(async () => ({
          success: false,
          error: { code: 'RESTART_FAILED', message: 'boom' },
        })),
      },
    });

    const result = await h.orch.restartSession('sess_1');

    expect(result.success).toBe(false);
    expect(h.deps.watcher.startWithPath).not.toHaveBeenCalled();
  });

  it('falls back to the repo path when the restarted session has no worktree', async () => {
    const h = harness([inst()], {
      agentInstance: {
        restartInstance: jest.fn(async () => ({
          success: true,
          data: inst({ sessionId: 'sess_2', worktreePath: undefined }),
        })),
      },
    });

    await h.orch.restartSession('sess_1');

    expect(h.deps.watcher.startWithPath).toHaveBeenCalledWith('sess_2', '/repo');
  });

  it('does not fail the restart when the watcher will not start', async () => {
    // Matches startSession: a watcher failure must not turn a successful
    // restart into a failure the caller has to unpick.
    const h = harness([inst()], {
      watcher: {
        startWithPath: jest.fn(async () => {
          throw new Error('chokidar exploded');
        }),
        stopAll: jest.fn(async () => ({ success: true })),
      },
    });

    const result = await h.orch.restartSession('sess_1');

    expect(result.success).toBe(true);
  });
});

// ─── Adopt ───────────────────────────────────────────────────────────────────
describe('adoptSession', () => {
  it("stamps createdBy 'adopted', never 'mcp'", async () => {
    // If this ever records 'mcp', an agent can adopt a human's branch and then
    // legally delete its worktree.
    const h = harness([]);

    await h.orch.adoptSession({
      repoPath: '/repo',
      branchName: 'humans-feature',
      worktreePath: '/repo',
      task: 'take a look',
      callerSessionId: 'sess_caller',
    });

    const config = (h.deps.agentInstance.createInstance as any).mock.calls[0][0];
    expect(config.createdBy).toBe('adopted');
  });

  it('records the adopter as the parent so lineage still works', async () => {
    const h = harness([]);

    await h.orch.adoptSession({
      repoPath: '/repo',
      branchName: 'humans-feature',
      task: 't',
      callerSessionId: 'sess_caller',
    });

    const config = (h.deps.agentInstance.createInstance as any).mock.calls[0][0];
    expect(config.parentSessionId).toBe('sess_caller');
  });

  it('refuses when a live session already owns the branch', async () => {
    const h = harness([inst({ config: { branchName: 'taken' } })]);

    const result = await h.orch.adoptSession({
      repoPath: '/repo',
      branchName: 'taken',
      task: 't',
      callerSessionId: 'sess_caller',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BRANCH_IN_USE');
  });

  it("take_over is refused for a session that is not agent-created", async () => {
    // Otherwise take_over is a way to seize a human's session.
    const h = harness([inst({ config: { branchName: 'taken', createdBy: 'ui' } })]);

    const result = await h.orch.adoptSession({
      repoPath: '/repo',
      branchName: 'taken',
      task: 't',
      callerSessionId: 'sess_caller',
      ifExists: 'take_over',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_PERMITTED');
  });

  it('take_over closes the existing agent session first', async () => {
    const h = harness([inst({ config: { branchName: 'taken', createdBy: 'mcp' } })]);

    const result = await h.orch.adoptSession({
      repoPath: '/repo',
      branchName: 'taken',
      task: 't',
      callerSessionId: 'sess_caller',
      ifExists: 'take_over',
    });

    expect(result.success).toBe(true);
    expect(h.deps.agentInstance.markSessionClosed).toHaveBeenCalled();
  });
});

// ─── Update ──────────────────────────────────────────────────────────────────
describe('updateSession', () => {
  it('refuses an empty patch rather than reporting a no-op success', async () => {
    const h = harness();
    const result = await h.orch.updateSession('sess_1', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_UPDATES');
  });

  it('refuses to rename a branch', async () => {
    // There is no safe implementation: a live worktree, watcher, binder entry
    // and session file all key on the branch name.
    const h = harness();
    const result = await h.orch.updateSession('sess_1', { branchName: 'nope' } as any);
    expect(result.success).toBe(false);
  });

  it('starts the watcher when auto_commit is turned on', async () => {
    const h = harness([inst({ config: { autoCommit: false } })]);

    await h.orch.updateSession('sess_1', { autoCommit: true });

    expect(h.deps.watcher.startWithPath).toHaveBeenCalled();
  });

  it('stops the watcher when auto_commit is turned off', async () => {
    const h = harness([inst({ config: { autoCommit: true } })]);

    await h.orch.updateSession('sess_1', { autoCommit: false });

    expect(h.deps.watcher.stopAll).toHaveBeenCalledWith('sess_1');
  });

  it('stops the rebase watcher when rebase_frequency goes to never', async () => {
    const h = harness([inst({ config: { rebaseFrequency: 'daily' } })]);

    await h.orch.updateSession('sess_1', { rebaseFrequency: 'never' });

    expect(h.deps.rebaseWatcher.stopWatching).toHaveBeenCalledWith('sess_1');
  });

  it('starts the rebase watcher when a frequency is set', async () => {
    const h = harness([inst({ config: { rebaseFrequency: 'never' } })]);

    await h.orch.updateSession('sess_1', { rebaseFrequency: 'daily' });

    expect(h.deps.rebaseWatcher.startWatching).toHaveBeenCalled();
  });

  it('does not touch the watchers when nothing relevant changed', async () => {
    const h = harness();

    await h.orch.updateSession('sess_1', { taskDescription: 'new task' });

    expect(h.deps.watcher.startWithPath).not.toHaveBeenCalled();
    expect(h.deps.watcher.stopAll).not.toHaveBeenCalled();
    expect(h.deps.rebaseWatcher.startWatching).not.toHaveBeenCalled();
  });

  it('resolves a session by a predecessor id', async () => {
    const h = harness([inst({ sessionId: 'sess_2', predecessorSessionIds: ['sess_1'] })]);

    const result = await h.orch.updateSession('sess_1', { taskDescription: 'x' });

    expect(result.success).toBe(true);
  });

  it('reports NOT_FOUND for an unknown session', async () => {
    const h = harness([]);
    const result = await h.orch.updateSession('sess_nope', { taskDescription: 'x' });
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ─── Extend ──────────────────────────────────────────────────────────────────
describe('extendSession', () => {
  it('pushes the expiry out and records the extension', async () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const h = harness([inst({ expiresAt: '2026-09-08T13:00:00.000Z' })]);

    const result = await h.orch.extendSession('sess_1', { minutes: 120, now });

    expect(result.success).toBe(true);
    expect(new Date(result.data!.expiresAt).getTime()).toBe(
      new Date('2026-09-08T15:00:00.000Z').getTime()
    );
    expect(result.data!.extensionsUsed).toBe(1);
  });

  it('extends from NOW when the session has already expired', async () => {
    // Extending from a past expiry would produce a deadline still in the past.
    const now = new Date('2026-09-08T12:00:00.000Z');
    const h = harness([inst({ expiresAt: '2026-09-08T09:00:00.000Z' })]);

    const result = await h.orch.extendSession('sess_1', { minutes: 60, now });

    expect(new Date(result.data!.expiresAt).getTime()).toBe(
      new Date('2026-09-08T13:00:00.000Z').getTime()
    );
  });

  it('caps a single extension at 4 hours', async () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const h = harness([inst({ expiresAt: '2026-09-08T12:00:00.000Z' })]);

    const result = await h.orch.extendSession('sess_1', { minutes: 10_000, now });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXTENSION_TOO_LONG');
  });

  it('allows only one extension per window', async () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const h = harness([inst({ expiresAt: '2026-09-08T13:00:00.000Z' })]);

    await h.orch.extendSession('sess_1', { minutes: 60, now });
    const second = await h.orch.extendSession('sess_1', { minutes: 60, now });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('EXTENSION_LIMIT_REACHED');
  });

  it('allows another extension once the previous window has passed', async () => {
    const h = harness([inst({ expiresAt: '2026-09-08T13:00:00.000Z' })]);

    await h.orch.extendSession('sess_1', {
      minutes: 60,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    const later = await h.orch.extendSession('sess_1', {
      minutes: 60,
      now: new Date('2026-09-08T18:00:00.000Z'),
    });

    expect(later.success).toBe(true);
  });
});
