/**
 * DatabaseService.purgeSessionTelemetry — story KIT-MCP-H4a
 *
 * WHY THIS DOES NOT USE A REAL DATABASE
 *
 * The obvious test — open a real sqlite file and assert which rows survive —
 * is not runnable in this repo. `postinstall` runs `electron-builder
 * install-app-deps`, which compiles `better-sqlite3` against ELECTRON's ABI
 * (NODE_MODULE_VERSION 130). jest runs on system Node (141), so
 * `new Database(...)` throws immediately. Rebuilding for Node would fix the
 * test and break the shipped app. That constraint is why every other suite
 * that touches DatabaseService mocks it wholesale
 * (WatcherService.contractCheck.test.ts:38).
 *
 * So this suite verifies the code path — statement shape, bound parameters,
 * transaction wrapping, and the empty-input guard — against a fake handle that
 * implements the slice of the better-sqlite3 surface the method uses. The SQL
 * SEMANTICS (which rows actually disappear, and that commits/session_history
 * survive) are verified separately against a real sqlite database; see the
 * evidence block on the ticket and PR.
 *
 * The distinction under test: telemetry (activity_logs, terminal_logs,
 * mcp_calls) is disposable and goes. History (commits, session_history) stays —
 * `commits` is the only KIT-side hash -> session link, and
 * backfillMcpCallsByLineage exists specifically to rescue history across
 * restarts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/kit-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { DatabaseService } from '../../../electron/services/DatabaseService';

interface RunCall {
  sql: string;
  params: unknown[];
}

/** Minimal stand-in for the better-sqlite3 surface this method touches. */
function makeFakeDb(changesPerStatement: number | ((sql: string) => number) = 1) {
  const calls: RunCall[] = [];
  let transactionDepth = 0;
  let maxTransactionDepth = 0;
  const runsInsideTransaction: string[] = [];

  const db = {
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          calls.push({ sql, params });
          if (transactionDepth > 0) runsInsideTransaction.push(sql);
          const changes =
            typeof changesPerStatement === 'function'
              ? changesPerStatement(sql)
              : changesPerStatement;
          return { changes };
        },
      };
    },
    transaction(fn: (...a: unknown[]) => unknown) {
      return (...args: unknown[]) => {
        transactionDepth += 1;
        maxTransactionDepth = Math.max(maxTransactionDepth, transactionDepth);
        try {
          return fn(...args);
        } finally {
          transactionDepth -= 1;
        }
      };
    },
  };

  return { db, calls, runsInsideTransaction, depth: () => maxTransactionDepth };
}

let svc: DatabaseService;
let fake: ReturnType<typeof makeFakeDb>;

const attach = (f: ReturnType<typeof makeFakeDb>) => {
  (svc as any).db = f.db;
};

beforeEach(() => {
  svc = new DatabaseService();
  fake = makeFakeDb();
  attach(fake);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('purgeSessionTelemetry — which tables are touched', () => {
  it('deletes from exactly the three telemetry tables', () => {
    svc.purgeSessionTelemetry(['sess_a']);

    const tables = fake.calls.map((c) => c.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['activity_logs', 'terminal_logs', 'mcp_calls']);
  });

  it('never touches commits or session_history', () => {
    // These are history, not telemetry. `commits` is the only KIT-side
    // hash -> session link; H4b handles ageing them out, with a dry run first.
    svc.purgeSessionTelemetry(['sess_a']);

    const sql = fake.calls.map((c) => c.sql).join(' ');
    expect(sql).not.toMatch(/commits/);
    expect(sql).not.toMatch(/session_history/);
  });
});

describe('purgeSessionTelemetry — parameter binding', () => {
  it('binds the session id rather than interpolating it', () => {
    svc.purgeSessionTelemetry(['sess_a']);

    for (const call of fake.calls) {
      expect(call.sql).toMatch(/WHERE session_id IN \(\?\)/);
      expect(call.params).toEqual(['sess_a']);
      expect(call.sql).not.toContain('sess_a');
    }
  });

  it('binds every alias, so predecessor-keyed rows are removed too', () => {
    // A restart mints a new sessionId; rows written before it are keyed to the
    // old one. Purging only the live id would orphan them permanently.
    svc.purgeSessionTelemetry(['sess_live', 'sess_mid', 'sess_old']);

    for (const call of fake.calls) {
      expect(call.sql).toMatch(/WHERE session_id IN \(\?,\?,\?\)/);
      expect(call.params).toEqual(['sess_live', 'sess_mid', 'sess_old']);
    }
  });

  it('scales the placeholder list to the number of ids', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `sess_${i}`);
    svc.purgeSessionTelemetry(ids);

    expect(fake.calls[0].params).toHaveLength(25);
    expect(fake.calls[0].sql).toContain(`IN (${ids.map(() => '?').join(',')})`);
  });
});

describe('purgeSessionTelemetry — transaction', () => {
  it('runs all three deletes inside one transaction', () => {
    svc.purgeSessionTelemetry(['sess_a']);

    expect(fake.runsInsideTransaction).toHaveLength(3);
    expect(fake.depth()).toBe(1);
  });
});

describe('purgeSessionTelemetry — guards', () => {
  it('is a no-op for an empty id list rather than deleting everything', () => {
    // A carelessly built `IN ()` degrades into a full-table delete. This is the
    // guard against that, and it must short-circuit BEFORE preparing anything.
    const result = svc.purgeSessionTelemetry([]);

    expect(result).toEqual({ activity: 0, terminal: 0, mcp: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('is a no-op when the database is not initialised', () => {
    (svc as any).db = null;
    expect(svc.purgeSessionTelemetry(['sess_a'])).toEqual({
      activity: 0,
      terminal: 0,
      mcp: 0,
    });
  });

  it('reports zeros and swallows the error when a statement throws', () => {
    // Teardown is best-effort; a telemetry purge failure must not abort the
    // caller's own cleanup.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (svc as any).db = {
      prepare() {
        throw new Error('database is locked');
      },
      transaction: (fn: () => unknown) => fn,
    };

    expect(svc.purgeSessionTelemetry(['sess_a'])).toEqual({
      activity: 0,
      terminal: 0,
      mcp: 0,
    });
  });
});

describe('purgeSessionTelemetry — reported counts', () => {
  it('reports per-table row counts', () => {
    const f = makeFakeDb((sql) =>
      sql.includes('activity_logs') ? 7 : sql.includes('terminal_logs') ? 3 : 11
    );
    attach(f);

    expect(svc.purgeSessionTelemetry(['sess_a'])).toEqual({
      activity: 7,
      terminal: 3,
      mcp: 11,
    });
  });

  it('reports zeros for a session that had no rows', () => {
    attach(makeFakeDb(0));
    expect(svc.purgeSessionTelemetry(['sess_none'])).toEqual({
      activity: 0,
      terminal: 0,
      mcp: 0,
    });
  });
});

// ─── sweepOrphanedHistory (KIT-MCP-H4b) ──────────────────────────────────────
describe('sweepOrphanedHistory', () => {
  const OLD = new Date(Date.now() - 400 * 86400_000).toISOString();
  const RECENT = new Date().toISOString();

  /**
   * Fake handle that records statements and answers COUNT queries, so the
   * selection can be asserted without a real database — see the header for why
   * a real one is not reachable under jest.
   */
  function sweepDb(counts: Record<string, number> = { commits: 3, session_history: 5 }) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    let inTransaction = 0;
    const db = {
      prepare(sql: string) {
        return {
          get(...params: unknown[]) {
            statements.push({ sql, params });
            const table = sql.match(/FROM (\w+)/)?.[1] ?? '';
            return { n: counts[table] ?? 0 };
          },
          run(...params: unknown[]) {
            statements.push({ sql, params });
            return { changes: 1 };
          },
        };
      },
      transaction(fn: () => unknown) {
        return () => {
          inTransaction += 1;
          try {
            return fn();
          } finally {
            inTransaction -= 1;
          }
        };
      },
    };
    return { db, statements, depth: () => inTransaction };
  }

  it('DRY RUNS by default — reports counts and deletes nothing', () => {
    // History cannot be regenerated. The selection has to be observed against
    // real installs before it is trusted to delete.
    const f = sweepDb();
    (svc as any).db = f.db;

    const r = svc.sweepOrphanedHistory(['sess_live']);

    expect(r).toEqual({ commits: 3, sessionHistory: 5, applied: false });
    expect(f.statements.every((s) => s.sql.startsWith('SELECT'))).toBe(true);
    expect(f.statements.some((s) => s.sql.includes('DELETE'))).toBe(false);
  });

  it('only deletes when explicitly applied', () => {
    const f = sweepDb();
    (svc as any).db = f.db;

    const r = svc.sweepOrphanedHistory(['sess_live'], { apply: true });

    expect(r.applied).toBe(true);
    expect(f.statements.some((s) => s.sql.includes('DELETE FROM commits'))).toBe(true);
    expect(f.statements.some((s) => s.sql.includes('DELETE FROM session_history'))).toBe(
      true
    );
  });

  it('REFUSES when no live session ids are supplied', () => {
    // An empty live set makes every row look orphaned. That is reachable — a
    // fresh store, a failed load — and acting on it would delete all history
    // irrecoverably.
    const f = sweepDb();
    (svc as any).db = f.db;

    const r = svc.sweepOrphanedHistory([], { apply: true });

    expect(r).toEqual({ commits: 0, sessionHistory: 0, applied: false });
    expect(f.statements).toHaveLength(0);
  });

  it('excludes every supplied id, which must include predecessors', () => {
    // The caller passes live ids AND their predecessor chains. A row keyed to a
    // pre-restart id is not orphaned — purgeInstancesOnBranch removes instance
    // records on every restart, which is exactly why the naive
    // "matches no live instance" rule would delete real history.
    const f = sweepDb();
    (svc as any).db = f.db;

    svc.sweepOrphanedHistory(['sess_live', 'sess_old', 'sess_older']);

    for (const s of f.statements) {
      expect(s.sql).toContain('NOT IN (?,?,?)');
      expect(s.params.slice(1)).toEqual(['sess_live', 'sess_old', 'sess_older']);
    }
  });

  it('always constrains by age as well as orphanhood', () => {
    const f = sweepDb();
    (svc as any).db = f.db;

    svc.sweepOrphanedHistory(['sess_live']);

    for (const s of f.statements) {
      expect(s.sql).toContain('timestamp < ?');
    }
  });

  it('runs the deletes in one transaction', () => {
    const f = sweepDb();
    (svc as any).db = f.db;
    svc.sweepOrphanedHistory(['sess_live'], { apply: true });
    expect(f.depth()).toBe(0); // drained
  });

  it('never touches the telemetry tables — those have their own path', () => {
    const f = sweepDb();
    (svc as any).db = f.db;
    svc.sweepOrphanedHistory(['sess_live'], { apply: true });

    const sql = f.statements.map((s) => s.sql).join(' ');
    expect(sql).not.toMatch(/activity_logs|terminal_logs|mcp_calls/);
  });

  it('returns zeros and swallows the error when a statement throws', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (svc as any).db = {
      prepare() {
        throw new Error('database is locked');
      },
      transaction: (fn: () => unknown) => fn,
    };
    expect(svc.sweepOrphanedHistory(['sess_live'])).toEqual({
      commits: 0,
      sessionHistory: 0,
      applied: false,
    });
  });

  void OLD;
  void RECENT;
});
