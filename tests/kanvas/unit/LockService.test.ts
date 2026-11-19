/**
 * Unit Tests for LockService.
 *
 * KIT-MCP-H6 moved `declareFiles` off the dead in-memory `sessionLocks` map and
 * into the repo-keyed store that `checkConflicts` actually reads, which is what
 * made cross-session locking work at all. These tests cover that store from the
 * declaration side: every caller of `declareFiles` reaches it through
 * `kit_lock_file`, and `McpTools.test.ts` mocks the service out, so nothing
 * exercised the real persistence path.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Mocks: keep initialize() out of the real home directory ─────────────────

// LockService computes SESSION_LOCK_DIR from os.homedir() at module load, and
// initialize() deletes stale .lock files under it. Point it at a temp dir so a
// test run cannot touch the developer's own ~/.devops-agent/session-locks.
// WatcherService (exercised by the attribution tests below) imports both of
// these at module scope.
jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      close: jest.fn(async () => undefined),
    })),
  },
}));

jest.mock('../../../electron/services/DatabaseService', () => ({
  databaseService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    recordCommit: jest.fn(),
    recordSessionEvent: jest.fn(),
  },
}));

jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  const nodePath = jest.requireActual<typeof import('path')>('path');
  const fakeHome = nodePath.join(actual.tmpdir(), 'kit-lockservice-fake-home');
  const patched = { ...actual, homedir: () => fakeHome };
  return { __esModule: true, ...patched, default: patched };
});

// ─── Import after mocking ────────────────────────────────────────────────────

import { LockService } from '../../../electron/services/LockService';
import { WatcherService } from '../../../electron/services/WatcherService';
import type { AutoFileLock } from '../../../shared/types';
import { promises as fsp, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { HolderLiveness } from '../../../shared/lock-liveness';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Beats LockService's 500ms save debounce. */
const SAVE_DEBOUNCE_WAIT_MS = 800;

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const LIVE = 'sess_live';
const DEAD = 'sess_dead';
/** A session replaced by a restart: a successor instance lists it as a predecessor. */
const SUPERSEDED = 'sess_superseded';

const GRACE_MS = 10 * 60 * 1000;

/**
 * Mirrors how services/index.ts wires the provider: LIVE is a current session
 * id, SUPERSEDED is some live instance's predecessor, anything else is an id
 * nothing recognises.
 */
const liveness = (sessionId: string): HolderLiveness => {
  if (sessionId === LIVE) return 'live';
  if (sessionId === SUPERSEDED) return 'superseded';
  return 'unknown';
};

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

let repoPath: string;
let lockService: LockService;

const lockRecord = (over: Partial<AutoFileLock> = {}): AutoFileLock => {
  const now = new Date().toISOString();
  return {
    filePath: 'src/app.ts',
    sessionId: LIVE,
    agentType: 'claude',
    repoPath: '/placeholder',
    lockedAt: now,
    lastModified: now,
    autoLocked: true,
    branchName: 'feat/x',
    ...over,
  };
};

/** Writes locks.json directly, as a previous (crashed) run would have left it. */
async function seedLocksFile(locks: Record<string, AutoFileLock>): Promise<void> {
  await fsp.mkdir(path.dirname(locksFilePath()), { recursive: true });
  await fsp.writeFile(locksFilePath(), JSON.stringify(locks, null, 2));
}

const locksFilePath = () =>
  path.join(repoPath, '.S9N_KIT_DevOpsAgent', 'locks.json');

const readLocksFile = async (): Promise<Record<string, AutoFileLock>> =>
  JSON.parse(await fsp.readFile(locksFilePath(), 'utf8'));

beforeEach(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'kit-lockservice-'));
  lockService = new LockService();
});

afterEach(async () => {
  await lockService.dispose();
  rmSync(repoPath, { recursive: true, force: true });
});

// ─── declareFiles persistence ────────────────────────────────────────────────
describe('LockService.declareFiles', () => {
  it('reports success and writes the declaration to locks.json', async () => {
    // Regression: declareFiles called this.scheduleSave(), which does not
    // exist on the class. The TypeError was caught by the service's own wrap()
    // and surfaced as LOCK_DECLARE_FAILED, so every kit_lock_file call failed
    // and nothing was ever persisted. esbuild strips types without checking
    // them, so `npm run build` stayed green; tsc reported it immediately.
    const result = await lockService.declareFiles(
      repoPath,
      'sess_1',
      ['src/app.ts'],
      'edit',
      'claude',
      30,
      'refactor'
    );

    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_WAIT_MS));
    expect(Object.keys(await readLocksFile())).toEqual(['src/app.ts']);
  });

  it('writes a record that matches the AutoFileLock shape it is stored as', async () => {
    // repoPath and autoLocked are required on AutoFileLock; the declaration
    // omitted both and leaned on an `as AutoFileLock` cast that tsc rejected.
    await lockService.declareFiles(repoPath, 'sess_1', ['src/app.ts'], 'edit', 'cursor', 45, 'why');

    const lock = await lockService.getFileLock(repoPath, 'src/app.ts');

    expect(lock).toMatchObject({
      filePath: 'src/app.ts',
      sessionId: 'sess_1',
      agentType: 'cursor',
      repoPath: path.resolve(repoPath),
      autoLocked: false,
      declared: true,
      operation: 'edit',
      reason: 'why',
      estimatedDuration: 45,
    });
  });

  it('is visible to another session through checkConflicts after a reload', async () => {
    // The whole point of H6: a declaration has to be readable by the store
    // checkConflicts consults, including by a fresh process.
    await lockService.declareFiles(repoPath, 'sess_holder', ['src/app.ts'], 'edit', 'claude');
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_WAIT_MS));

    const reloaded = new LockService();
    try {
      const conflicts = await reloaded.checkConflicts(repoPath, ['src/app.ts'], 'sess_other');

      expect(conflicts.success).toBe(true);
      expect(conflicts.data?.[0]).toMatchObject({
        file: 'src/app.ts',
        conflictsWith: 'claude',
        session: 'sess_holder',
      });
    } finally {
      await reloaded.dispose();
    }
  });

  it('lists declarations without the watcher auto-locks that share the store', async () => {
    await lockService.declareFiles(repoPath, 'sess_1', ['src/declared.ts'], 'edit', 'claude');
    await lockService.autoLockFile(repoPath, 'src/auto.ts', 'sess_1', 'claude', 'feat/x');

    const declared = await lockService.listDeclarations(repoPath);

    expect(declared.data?.map((l) => l.filePath)).toEqual(['src/declared.ts']);
  });
});

// ─── Attribution: WatcherService -> LockService ──────────────────────────────
describe('auto-lock attribution', () => {
  const WATCH_SESSION = 'sess_watch';
  const REL_FILE = 'src/app.ts';

  const makeGitService = () =>
    ({
      registerWorktree: jest.fn(),
      getStatus: jest.fn(async () => ({ success: true, data: { changes: [] } })),
      commit: jest.fn(async () => ({ success: true, data: { hash: 'abc', shortHash: 'abc' } })),
      push: jest.fn(async () => ({ success: true })),
    }) as never;

  const makeActivityService = () =>
    ({ log: jest.fn(), logFileActivity: jest.fn(), linkToCommit: jest.fn(() => 0) }) as never;

  /** Lets the fire-and-forget autoLockFile promise settle. */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  let watcher: WatcherService;
  let worktreePath: string;
  let sourceRepo: string;

  beforeEach(async () => {
    // startWithPath derives the repo root from the worktree path, so lay the
    // dirs out the way it expects: <parent>/KIT-DevOps-<repo>/<branch>.
    sourceRepo = path.join(repoPath, 'myapp');
    worktreePath = path.join(repoPath, 'KIT-DevOps-myapp', 'feat-attribution');
    await fsp.mkdir(sourceRepo, { recursive: true });
    await fsp.mkdir(worktreePath, { recursive: true });

    watcher = new WatcherService(makeGitService(), makeActivityService());
    watcher.setLockService(lockService);
  });

  afterEach(async () => {
    // releaseLocks:false — releasing would delete the record under assertion.
    await watcher.stopAll(WATCH_SESSION, false);
  });

  it('records the agent type and branch the watcher was started with', async () => {
    await watcher.startWithPath(WATCH_SESSION, worktreePath, 'cursor', 'feat/attribution');
    watcher.handleExternalFileChange(WATCH_SESSION, path.join(worktreePath, REL_FILE), 'change');
    await flush();

    const lock = await lockService.getFileLock(sourceRepo, REL_FILE);

    expect(lock).not.toBeNull();
    expect(lock?.agentType).toBe('cursor');
    expect(lock?.branchName).toBe('feat/attribution');
  });

  it('falls back to custom with no branch when started without them', async () => {
    // Guards the default every production call site used to hit. Without this
    // contrast case the test above would pass on the default too.
    await watcher.startWithPath(WATCH_SESSION, worktreePath);
    watcher.handleExternalFileChange(WATCH_SESSION, path.join(worktreePath, REL_FILE), 'change');
    await flush();

    const lock = await lockService.getFileLock(sourceRepo, REL_FILE);

    expect(lock?.agentType).toBe('custom');
    expect(lock?.branchName).toBeUndefined();
  });

  it('persists the attribution to locks.json', async () => {
    await watcher.startWithPath(WATCH_SESSION, worktreePath, 'aider', 'feat/attribution');
    watcher.handleExternalFileChange(WATCH_SESSION, path.join(worktreePath, REL_FILE), 'change');
    await flush();
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_WAIT_MS));

    const persisted = JSON.parse(
      await fsp.readFile(
        path.join(sourceRepo, '.S9N_KIT_DevOpsAgent', 'locks.json'),
        'utf8'
      )
    );

    expect(persisted[REL_FILE]).toMatchObject({
      agentType: 'aider',
      branchName: 'feat/attribution',
    });
  });
});

// ─── Stale-lock cleanup ──────────────────────────────────────────────────────
//
// cleanupExpiredLocks had no callers anywhere, and the only other path that
// removes a lock is releaseSessionLocks via WatcherService.stop(). So locks
// only ever went away on a clean watcher stop: after a crash the entries in
// locks.json lived forever, and because autoLockFile treats another session's
// lock as a conflict and refuses to write, they permanently blocked every
// later session from locking those files.

describe('LockService.cleanupExpiredLocks', () => {
  it('drops locks past the inactivity timeout and keeps fresh ones', async () => {
    await seedLocksFile({
      'src/old.ts': lockRecord({ filePath: 'src/old.ts', lastModified: agoIso(2 * DAY_MS) }),
      'src/fresh.ts': lockRecord({ filePath: 'src/fresh.ts' }),
    });

    const result = await lockService.cleanupExpiredLocks(repoPath);

    expect(result.success).toBe(true);
    expect(await lockService.getFileLock(repoPath, 'src/old.ts')).toBeNull();
    expect(await lockService.getFileLock(repoPath, 'src/fresh.ts')).not.toBeNull();
  });

  it('persists the prune to locks.json', async () => {
    await seedLocksFile({
      'src/old.ts': lockRecord({ filePath: 'src/old.ts', lastModified: agoIso(2 * DAY_MS) }),
      'src/fresh.ts': lockRecord({ filePath: 'src/fresh.ts' }),
    });

    await lockService.cleanupExpiredLocks(repoPath);
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_WAIT_MS));

    expect(Object.keys(await readLocksFile())).toEqual(['src/fresh.ts']);
  });

  it('honours a caller-supplied timeout', async () => {
    await seedLocksFile({
      'src/recent.ts': lockRecord({ filePath: 'src/recent.ts', lastModified: agoIso(5000) }),
    });

    // Default 24h would keep this; 1s does not.
    await lockService.cleanupExpiredLocks(repoPath, 1000);

    expect(await lockService.getFileLock(repoPath, 'src/recent.ts')).toBeNull();
  });

  it('treats an unparseable lastModified as expired rather than immortal', async () => {
    // NaN loses every comparison, so an age check alone would pin the lock
    // forever. A hand-edited or truncated locks.json is the realistic source.
    await seedLocksFile({
      'src/bad.ts': lockRecord({ filePath: 'src/bad.ts', lastModified: 'not-a-date' }),
    });

    await lockService.cleanupExpiredLocks(repoPath);

    expect(await lockService.getFileLock(repoPath, 'src/bad.ts')).toBeNull();
  });

  it('reports zero for a repo that has no locks at all', async () => {
    const result = await lockService.cleanupExpiredLocks(repoPath);

    expect(result).toMatchObject({ success: true, data: 0 });
  });
});

describe('stale-lock pruning is wired up', () => {
  it('prunes on first load, before any caller sees the locks', async () => {
    // Nothing calls cleanupExpiredLocks here — reading the repo summary is
    // enough, because loadLocks prunes what it reads off disk.
    await seedLocksFile({
      'src/old.ts': lockRecord({ filePath: 'src/old.ts', lastModified: agoIso(2 * DAY_MS) }),
      'src/fresh.ts': lockRecord({ filePath: 'src/fresh.ts' }),
    });

    const summary = await lockService.getRepoLocks(repoPath);

    expect(summary.success).toBe(true);
    expect(summary.data?.totalLocks).toBe(1);
    expect(summary.data?.locksBySession[LIVE]).toEqual(['src/fresh.ts']);
  });

  it('prunes on the background sweep while the app stays open', async () => {
    jest.useFakeTimers();
    try {
      await seedLocksFile({ 'src/app.ts': lockRecord() });
      // Load while it is still fresh, so the load-time prune keeps it.
      await lockService.getRepoLocks(repoPath);
      expect(await lockService.getFileLock(repoPath, 'src/app.ts')).not.toBeNull();

      // initialize() starts the hourly sweep. The lock goes stale in the
      // meantime, which load-time pruning alone would never notice: it runs
      // once per repo per process.
      await lockService.initialize();
      jest.setSystemTime(Date.now() + 2 * DAY_MS);
      jest.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(await lockService.getFileLock(repoPath, 'src/app.ts')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('locks whose session a restart superseded', () => {
  // The case the two oracles used to disagree on. The binder answers to a
  // predecessor id (registerExistingSessionsWithBinder registers every entry in
  // predecessorSessionIds against the current worktree), so the tool layer read
  // the holder as live and kept the lock — which is what pinned locks forever,
  // because the successor session has a different id. A predecessor is positive
  // evidence that the process holding the lock is gone, so no grace applies.

  it('are pruned even when the lock was taken seconds ago', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/old.ts': lockRecord({ filePath: 'src/old.ts', sessionId: SUPERSEDED }),
      'src/live.ts': lockRecord({ filePath: 'src/live.ts', sessionId: LIVE }),
    });

    const summary = await lockService.getRepoLocks(repoPath);

    expect(summary.data?.totalLocks).toBe(1);
    expect(summary.data?.locksBySession[SUPERSEDED]).toBeUndefined();
  });

  it('are reclaimed by the successor, not reported as a conflict', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/app.ts': lockRecord({ sessionId: SUPERSEDED, agentType: 'cursor' }),
    });

    const result = await lockService.autoLockFile(repoPath, 'src/app.ts', LIVE, 'claude', 'feat/y');

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sessionId: LIVE,
      agentType: 'claude',
      branchName: 'feat/y',
      autoLocked: true,
    });
  });

  it('are not reported by checkConflicts', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/old.ts': lockRecord({ filePath: 'src/old.ts', sessionId: SUPERSEDED }),
      'src/live.ts': lockRecord({ filePath: 'src/live.ts', sessionId: LIVE }),
    });

    const conflicts = await lockService.checkConflicts(
      repoPath,
      ['src/old.ts', 'src/live.ts'],
      'sess_asking'
    );

    expect(conflicts.data?.map((c) => c.file)).toEqual(['src/live.ts']);
  });

  it('includes declared locks, which share the store since H6', async () => {
    // kit_lock_file writes into this same map, so a superseded session's
    // DECLARATION would otherwise keep refusing every later kit_lock_file.
    lockService.setSessionLivenessProvider(liveness);
    await lockService.declareFiles(repoPath, SUPERSEDED, ['src/app.ts'], 'edit', 'cursor');

    const conflicts = await lockService.checkConflicts(repoPath, ['src/app.ts'], LIVE);

    expect(conflicts.data).toEqual([]);
  });
});

describe('locks held by a session nothing recognises', () => {
  // An id no instance knows is an ABSENCE of evidence, not evidence of death:
  // a session can read as unknown while its record is still loading. This is
  // where PR #42's grace period is right, and it is kept — the reciprocal
  // concession to taking a superseded holder's lock immediately.

  it('are kept while the lock is younger than the grace period', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/app.ts': lockRecord({ sessionId: DEAD, lockedAt: agoIso(GRACE_MS / 2) }),
    });

    const conflicts = await lockService.checkConflicts(repoPath, ['src/app.ts'], 'sess_asking');

    expect(conflicts.data?.map((c) => c.file)).toEqual(['src/app.ts']);
    expect(await lockService.getFileLock(repoPath, 'src/app.ts')).not.toBeNull();
  });

  it('are reclaimed once the lock has outlived the grace period', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/app.ts': lockRecord({ sessionId: DEAD, lockedAt: agoIso(GRACE_MS + 60_000) }),
    });

    const result = await lockService.autoLockFile(repoPath, 'src/app.ts', LIVE, 'claude', 'feat/y');

    expect(result.data).toMatchObject({ sessionId: LIVE, agentType: 'claude' });
  });

  it('are left alone when lockedAt cannot be parsed, since the age is unreadable', async () => {
    // Not immortal: the inactivity timeout still prunes a record whose
    // lastModified is unreadable, independently of who holds it.
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({
      'src/app.ts': lockRecord({ sessionId: DEAD, lockedAt: 'not-a-date' }),
    });

    const conflicts = await lockService.checkConflicts(repoPath, ['src/app.ts'], 'sess_asking');

    expect(conflicts.data?.map((c) => c.file)).toEqual(['src/app.ts']);
  });
});

describe('locks held by a live session', () => {
  it('still conflict in autoLockFile', async () => {
    lockService.setSessionLivenessProvider(liveness);
    await seedLocksFile({ 'src/app.ts': lockRecord({ sessionId: LIVE, agentType: 'cursor' }) });

    const result = await lockService.autoLockFile(
      repoPath,
      'src/app.ts',
      'sess_other',
      'claude',
      'feat/y'
    );

    // Returns the HOLDER's lock, unchanged — autoLockFile's conflict shape.
    expect(result.data).toMatchObject({ sessionId: LIVE, agentType: 'cursor' });
  });

  it('survive when no liveness provider is wired', async () => {
    // Regression guard: the default must assume every session is live, so an
    // un-wired LockService never starts discarding other sessions' locks.
    await seedLocksFile({ 'src/app.ts': lockRecord({ sessionId: DEAD, agentType: 'cursor' }) });

    const result = await lockService.autoLockFile(repoPath, 'src/app.ts', LIVE, 'claude', 'feat/y');

    expect(result.data).toMatchObject({ sessionId: DEAD, agentType: 'cursor' });
  });
});
