/**
 * MCP tool registry — story KIT-MCP-M6
 *
 * `MCP_TOOLS` listed 8 of the 22 tools the server actually registered. Nothing
 * caught that, because nothing compared the two. This suite does.
 *
 * It lands FIRST in the MCP phase, not last. The end state is an equality
 * assertion, but asserting equality while the session tools are still being
 * written would turn CI red on every intermediate commit. So the invariant is
 * "everything registered is declared" throughout, plus an explicit check that
 * the declared-but-unbuilt set shrinks to nothing — which is what flips it to
 * equality on the final commit without anyone having to remember to.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  MCP_TOOLS,
  MCP_SESSION_TOOLS,
  MCP_STATE_CHANGING_TOOLS,
  MCP_TOOL_LOG_TYPE,
  MCP_ACTOR_PARAM,
  actorSessionIdFor,
} from '../../../shared/mcp-types';

// zod is mocked the way McpTools.test.ts does it: registerTools builds schemas
// eagerly, and the real zod chain is not what is under test here.
// A Proxy rather than an enumerated method list: every schema method returns
// another chainable stub, so adding `z.record(...)` or anything else to a tool
// schema cannot break this suite. An enumerated stub silently rots — that is
// exactly how this one first failed.
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined; // never look thenable to await
      return (..._a: any[]) => zodChain();
    },
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

/** Registers the real tools against a capturing stub and returns their names. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const server: any = {
    tool: (name: string) => {
      names.push(name);
    },
  };
  // Required lazily so the zod mock is in place first.
  const { registerTools } = require('../../../electron/services/mcp/tools');
  const binder: any = {
    getSession: () => undefined,
    getWorktreePath: () => undefined,
    getWorktreePathForRepo: () => undefined,
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    listSessions: () => [],
  };
  registerTools(server, binder, {}, undefined);
  return names;
}

const DECLARED = new Set<string>([
  ...Object.values(MCP_TOOLS),
  ...Object.values(MCP_SESSION_TOOLS),
]);

describe('registry completeness', () => {
  const registered = registeredToolNames();

  it('registers at least the 22 tools that predate this epic', () => {
    expect(registered.length).toBeGreaterThanOrEqual(22);
  });

  it('declares every tool it registers', () => {
    // The invariant that was missing. A tool added to tools.ts without a line
    // in MCP_TOOLS fails here.
    const undeclared = registered.filter((n) => !DECLARED.has(n));
    expect(undeclared).toEqual([]);
  });

  it('registers no tool twice', () => {
    const seen = new Set<string>();
    const dupes = registered.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });

  it('names every tool with the kit_ prefix', () => {
    expect(registered.filter((n) => !n.startsWith('kit_'))).toEqual([]);
  });

  it('registers EXACTLY what it declares — no more, no less', () => {
    // The end state this suite was built to reach. While the session tools
    // were landing it asserted only "everything registered is declared", so
    // CI stayed green through the phase; now that the declared set is fully
    // implemented, the invariant is equality in both directions.
    const notYetBuilt = [...DECLARED].filter((n) => !registered.includes(n));
    expect(notYetBuilt).toEqual([]);
    expect(new Set(registered)).toEqual(DECLARED);
  });

  it('registers all five session-lifecycle tools', () => {
    for (const name of Object.values(MCP_SESSION_TOOLS)) {
      expect(registered).toContain(name);
    }
  });
});

describe('state-changing classification', () => {
  const registered = registeredToolNames();

  it('classifies only tools that actually exist', () => {
    const unknown = [...MCP_STATE_CHANGING_TOOLS].filter(
      (n) => !DECLARED.has(n)
    );
    expect(unknown).toEqual([]);
  });

  it('does not mark the read-only session tools as state-changing', () => {
    expect(MCP_STATE_CHANGING_TOOLS.has(MCP_SESSION_TOOLS.LIST_SESSIONS)).toBe(false);
    expect(MCP_STATE_CHANGING_TOOLS.has(MCP_SESSION_TOOLS.GET_SESSION_STATUS)).toBe(
      false
    );
  });

  it('marks the session tools that mutate', () => {
    for (const name of [
      MCP_SESSION_TOOLS.START_SESSION,
      MCP_SESSION_TOOLS.CLOSE_SESSION,
      MCP_SESSION_TOOLS.CLOSE_SESSIONS,
    ]) {
      expect(MCP_STATE_CHANGING_TOOLS.has(name)).toBe(true);
    }
  });

  it('leaves obviously read-only git tools out', () => {
    for (const name of [
      MCP_TOOLS.GET_REPO_STATUS,
      MCP_TOOLS.LIST_BRANCHES,
      MCP_TOOLS.LIST_WORKTREES,
      MCP_TOOLS.GET_COMMIT_HISTORY,
      MCP_TOOLS.GET_SESSION_INFO,
    ]) {
      expect(MCP_STATE_CHANGING_TOOLS.has(name)).toBe(false);
    }
  });

  void registered;
});

describe('activity log type', () => {
  it('files session lifecycle under info, not git', () => {
    // Starting or closing a session is not a commit. Logging it as 'git' makes
    // the activity feed read as though the agent touched the repository.
    for (const name of Object.values(MCP_SESSION_TOOLS)) {
      if (MCP_STATE_CHANGING_TOOLS.has(name)) {
        expect(MCP_TOOL_LOG_TYPE[name]).toBe('info');
      }
    }
  });

  it('leaves commit tools defaulting to git', () => {
    expect(MCP_TOOL_LOG_TYPE[MCP_TOOLS.COMMIT]).toBeUndefined();
    expect(MCP_TOOL_LOG_TYPE[MCP_TOOLS.COMMIT_ALL]).toBeUndefined();
  });
});

describe('actorSessionIdFor', () => {
  it('uses session_id for the tools where it names the caller', () => {
    expect(actorSessionIdFor(MCP_TOOLS.COMMIT, { session_id: 'sess_a' })).toBe('sess_a');
  });

  it('uses caller_session_id on the close tools, where session_id is the TARGET', () => {
    // Getting this wrong would flip the CLOSED session's status to 'idle',
    // write the activity entry into its feed rather than the caller's, and
    // drift-check a worktree that may have just been removed.
    const args = { session_id: 'sess_target', caller_session_id: 'sess_caller' };
    expect(actorSessionIdFor(MCP_SESSION_TOOLS.CLOSE_SESSION, args)).toBe('sess_caller');
    expect(actorSessionIdFor(MCP_SESSION_TOOLS.CLOSE_SESSIONS, args)).toBe('sess_caller');
  });

  it('falls back to unknown rather than borrowing the target id', () => {
    // An agent that omits caller_session_id must not be silently attributed to
    // the session it is closing.
    expect(
      actorSessionIdFor(MCP_SESSION_TOOLS.CLOSE_SESSION, { session_id: 'sess_target' })
    ).toBe('unknown');
  });

  it('returns unknown for missing or empty args', () => {
    expect(actorSessionIdFor(MCP_TOOLS.COMMIT, undefined)).toBe('unknown');
    expect(actorSessionIdFor(MCP_TOOLS.COMMIT, {})).toBe('unknown');
    expect(actorSessionIdFor(MCP_TOOLS.COMMIT, { session_id: '' })).toBe('unknown');
  });

  it('only overrides the actor param for tools that need it', () => {
    for (const name of Object.values(MCP_TOOLS)) {
      expect(MCP_ACTOR_PARAM[name]).toBeUndefined();
    }
  });
});
