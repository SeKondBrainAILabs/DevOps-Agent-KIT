/**
 * McpSessionBinder Unit Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

describe('McpSessionBinder', () => {
  let binder: McpSessionBinder;

  beforeEach(() => {
    binder = new McpSessionBinder();
  });

  describe('registerSession', () => {
    it('should register a session and return its path', () => {
      binder.registerSession('sess_abc', '/tmp/worktree-abc');
      expect(binder.getWorktreePath('sess_abc')).toBe('/tmp/worktree-abc');
    });

    it('should return full session info', () => {
      binder.registerSession('sess_abc', '/tmp/worktree-abc');
      const session = binder.getSession('sess_abc');
      expect(session).toBeDefined();
      expect(session!.kitSessionId).toBe('sess_abc');
      expect(session!.worktreePath).toBe('/tmp/worktree-abc');
      expect(session!.registeredAt).toBeDefined();
    });

    it('should overwrite a session with the same ID', () => {
      binder.registerSession('sess_abc', '/old/path');
      binder.registerSession('sess_abc', '/new/path');
      expect(binder.getWorktreePath('sess_abc')).toBe('/new/path');
    });
  });

  describe('getWorktreePath', () => {
    it('should return undefined for unknown session', () => {
      expect(binder.getWorktreePath('unknown_session')).toBeUndefined();
    });
  });

  describe('multiple concurrent sessions', () => {
    it('should keep sessions isolated', () => {
      binder.registerSession('sess_a', '/worktree/a');
      binder.registerSession('sess_b', '/worktree/b');
      binder.registerSession('sess_c', '/worktree/c');

      expect(binder.getWorktreePath('sess_a')).toBe('/worktree/a');
      expect(binder.getWorktreePath('sess_b')).toBe('/worktree/b');
      expect(binder.getWorktreePath('sess_c')).toBe('/worktree/c');
    });

    it('should list all sessions', () => {
      binder.registerSession('sess_a', '/worktree/a');
      binder.registerSession('sess_b', '/worktree/b');

      const sessions = binder.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.kitSessionId).sort()).toEqual(['sess_a', 'sess_b']);
    });
  });

  describe('unregisterSession', () => {
    it('should remove a session', () => {
      binder.registerSession('sess_abc', '/tmp/worktree');
      binder.unregisterSession('sess_abc');
      expect(binder.getWorktreePath('sess_abc')).toBeUndefined();
    });

    it('should also remove MCP bindings pointing to the session', () => {
      binder.registerSession('sess_abc', '/tmp/worktree');
      binder.bind('mcp_1', 'sess_abc');
      expect(binder.resolveBinding('mcp_1')).toBe('sess_abc');

      binder.unregisterSession('sess_abc');
      expect(binder.resolveBinding('mcp_1')).toBeUndefined();
    });
  });

  describe('bind / unbind MCP sessions', () => {
    it('should bind an MCP session to a KIT session', () => {
      binder.registerSession('sess_abc', '/tmp/worktree');
      const result = binder.bind('mcp_transport_1', 'sess_abc');

      expect(result).toBe(true);
      expect(binder.resolveBinding('mcp_transport_1')).toBe('sess_abc');
    });

    it('should return false when binding to unknown KIT session', () => {
      const result = binder.bind('mcp_transport_1', 'unknown_sess');
      expect(result).toBe(false);
    });

    it('should unbind an MCP session', () => {
      binder.registerSession('sess_abc', '/tmp/worktree');
      binder.bind('mcp_1', 'sess_abc');
      binder.unbind('mcp_1');

      expect(binder.resolveBinding('mcp_1')).toBeUndefined();
    });

    it('should track connection count', () => {
      binder.registerSession('sess_a', '/worktree/a');
      binder.registerSession('sess_b', '/worktree/b');

      expect(binder.getConnectionCount()).toBe(0);

      binder.bind('mcp_1', 'sess_a');
      expect(binder.getConnectionCount()).toBe(1);

      binder.bind('mcp_2', 'sess_b');
      expect(binder.getConnectionCount()).toBe(2);

      binder.unbind('mcp_1');
      expect(binder.getConnectionCount()).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all state', () => {
      binder.registerSession('sess_a', '/worktree/a');
      binder.bind('mcp_1', 'sess_a');

      binder.clear();

      expect(binder.getWorktreePath('sess_a')).toBeUndefined();
      expect(binder.resolveBinding('mcp_1')).toBeUndefined();
      expect(binder.listSessions()).toHaveLength(0);
      expect(binder.getConnectionCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Multi-repo session support
  // ===========================================================================
  describe('multi-repo sessions', () => {
    it('should register multi-repo session and default to primary path', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'MainApp', worktreePath: '/worktree/main', role: 'primary' },
        { repoName: 'SharedLib', worktreePath: '/worktree/shared', role: 'secondary' },
      ]);

      // Default getWorktreePath returns primary
      expect(binder.getWorktreePath('sess_multi')).toBe('/worktree/main');
    });

    it('should resolve specific repo by name via getWorktreePathForRepo', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'App', worktreePath: '/w/app', role: 'primary' },
        { repoName: 'Lib', worktreePath: '/w/lib', role: 'secondary' },
      ]);

      expect(binder.getWorktreePathForRepo('sess_multi', 'App')).toBe('/w/app');
      expect(binder.getWorktreePathForRepo('sess_multi', 'Lib')).toBe('/w/lib');
    });

    it('should default to primary when repo name omitted', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'App', worktreePath: '/w/app', role: 'primary' },
        { repoName: 'Lib', worktreePath: '/w/lib', role: 'secondary' },
      ]);

      expect(binder.getWorktreePathForRepo('sess_multi')).toBe('/w/app');
      expect(binder.getWorktreePathForRepo('sess_multi', undefined)).toBe('/w/app');
    });

    it('should return undefined for unknown repo name', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'App', worktreePath: '/w/app', role: 'primary' },
      ]);

      expect(binder.getWorktreePathForRepo('sess_multi', 'NonExistent')).toBeUndefined();
    });

    it('should list all repos for a multi-repo session', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'App', worktreePath: '/w/app', role: 'primary' },
        { repoName: 'Lib', worktreePath: '/w/lib', role: 'secondary' },
        { repoName: 'Backend', worktreePath: '/w/backend', role: 'secondary' },
      ]);

      const repos = binder.getReposForSession('sess_multi');
      expect(repos).toHaveLength(3);
      expect(repos.map(r => r.repoName).sort()).toEqual(['App', 'Backend', 'Lib']);
    });

    it('should return one-element array for single-repo sessions', () => {
      binder.registerSession('sess_single', '/worktree/single');
      const repos = binder.getReposForSession('sess_single');
      expect(repos).toHaveLength(1);
      expect(repos[0].repoName).toBe('primary');
      expect(repos[0].worktreePath).toBe('/worktree/single');
    });

    it('should return empty array for unknown session', () => {
      expect(binder.getReposForSession('unknown')).toEqual([]);
    });

    it('getWorktreePathForRepo returns undefined for unknown session', () => {
      expect(binder.getWorktreePathForRepo('unknown')).toBeUndefined();
      expect(binder.getWorktreePathForRepo('unknown', 'App')).toBeUndefined();
    });

    it('should work with single-repo sessions via getWorktreePathForRepo', () => {
      binder.registerSession('sess_single', '/worktree/single');
      // No repoPaths set — should return worktreePath
      expect(binder.getWorktreePathForRepo('sess_single')).toBe('/worktree/single');
      expect(binder.getWorktreePathForRepo('sess_single', 'AnyName')).toBe('/worktree/single');
    });

    it('should preserve MCP bindings for multi-repo sessions', () => {
      binder.registerMultiRepoSession('sess_multi', [
        { repoName: 'App', worktreePath: '/w/app', role: 'primary' },
      ]);
      const result = binder.bind('mcp_1', 'sess_multi');
      expect(result).toBe(true);
      expect(binder.resolveBinding('mcp_1')).toBe('sess_multi');
    });
  });
});

/**
 * Integration with SessionOrchestrator.teardownSession (story KIT-MCP-H2).
 *
 * Uses the REAL binder rather than a fake, because the leak being closed is
 * specifically that `unregisterSession` had no production callers — a test
 * against a mock would not prove the session actually becomes unresolvable.
 */
describe('McpSessionBinder + SessionOrchestrator teardown (H2)', () => {
  // Deliberately a require() rather than a top-level import: this file is a
  // binder test first, and the orchestrator is only pulled in for these cases.
  const {
    SessionOrchestrator,
  } = require('../../../electron/services/SessionOrchestrator');

  // Own fixture — the `binder` in the suite above is scoped to that describe.
  let binder: McpSessionBinder;
  beforeEach(() => {
    binder = new McpSessionBinder();
  });

  const WORKTREE = '/tmp/KIT-DevOps-repo/feat-x';

  /** A live instance restarted twice: sess_old -> sess_mid -> sess_live. */
  const chainedInstance = {
    id: 'inst_live',
    sessionId: 'sess_live',
    predecessorSessionIds: ['sess_old', 'sess_mid'],
    worktreePath: WORKTREE,
    config: { repoPath: '/tmp/repo', branchName: 'feat-x' },
    status: 'active',
    createdAt: '2026-08-29T00:00:00.000Z',
  };

  const orchestratorOver = (realBinder: McpSessionBinder) =>
    new SessionOrchestrator({
      agentInstance: {
        createInstance: async () => ({ success: true }),
        listInstances: () => ({ success: true, data: [chainedInstance] }),
      },
      watcher: {
        startWithPath: async () => ({ success: true }),
        stopAll: async () => ({ success: true }),
      },
      rebaseWatcher: { stopWatching: async () => ({ success: true }) },
      binder: realBinder,
    });

  /** Reproduces how startup registers a restarted session: live id + aliases. */
  function registerWithAliases(b: McpSessionBinder) {
    b.registerSession('sess_live', WORKTREE);
    b.registerSession('sess_mid', WORKTREE);
    b.registerSession('sess_old', WORKTREE);
  }

  it('leaves every alias resolvable before teardown', () => {
    registerWithAliases(binder);
    expect(binder.getWorktreePath('sess_live')).toBe(WORKTREE);
    expect(binder.getWorktreePath('sess_mid')).toBe(WORKTREE);
    expect(binder.getWorktreePath('sess_old')).toBe(WORKTREE);
  });

  it('makes the session AND all its aliases unresolvable after teardown', async () => {
    registerWithAliases(binder);

    await orchestratorOver(binder).teardownSession('sess_live');

    // The leak: before H2 all three still resolved, so kit_commit kept working
    // against a session the user had closed.
    expect(binder.getWorktreePath('sess_live')).toBeUndefined();
    expect(binder.getWorktreePath('sess_mid')).toBeUndefined();
    expect(binder.getWorktreePath('sess_old')).toBeUndefined();
    expect(binder.listSessions()).toHaveLength(0);
  });

  it('drops MCP transport bindings that pointed at the closed session', async () => {
    registerWithAliases(binder);
    binder.bind('mcp_conn_1', 'sess_live');
    expect(binder.resolveBinding('mcp_conn_1')).toBe('sess_live');

    await orchestratorOver(binder).teardownSession('sess_live');

    expect(binder.resolveBinding('mcp_conn_1')).toBeUndefined();
  });

  it('tearing down via a PREDECESSOR id clears the whole chain too', async () => {
    // An agent launched before a restart still holds the old id.
    registerWithAliases(binder);

    await orchestratorOver(binder).teardownSession('sess_old');

    expect(binder.getWorktreePath('sess_live')).toBeUndefined();
    expect(binder.getWorktreePath('sess_old')).toBeUndefined();
  });

  it('RESTART REGRESSION: unbindMcp:false leaves every alias resolvable', async () => {
    // Restart re-aliases the old id onto the new worktree immediately after
    // teardown. If teardown unbound here, an in-flight kit_commit from a
    // subagent using the old id would fail in that window — permanently if the
    // create half then failed and the re-alias never ran.
    registerWithAliases(binder);

    await orchestratorOver(binder).teardownSession('sess_live', { unbindMcp: false });

    expect(binder.getWorktreePath('sess_live')).toBe(WORKTREE);
    expect(binder.getWorktreePath('sess_mid')).toBe(WORKTREE);
    expect(binder.getWorktreePath('sess_old')).toBe(WORKTREE);
  });

  it('does not disturb an unrelated session', async () => {
    registerWithAliases(binder);
    binder.registerSession('sess_other', '/tmp/KIT-DevOps-repo/other');

    await orchestratorOver(binder).teardownSession('sess_live');

    expect(binder.getWorktreePath('sess_other')).toBe('/tmp/KIT-DevOps-repo/other');
  });
});
