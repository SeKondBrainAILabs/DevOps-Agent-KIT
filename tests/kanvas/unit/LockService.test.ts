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
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  const nodePath = jest.requireActual<typeof import('path')>('path');
  const fakeHome = nodePath.join(actual.tmpdir(), 'kit-lockservice-fake-home');
  const patched = { ...actual, homedir: () => fakeHome };
  return { __esModule: true, ...patched, default: patched };
});

// ─── Import after mocking ────────────────────────────────────────────────────

import { LockService } from '../../../electron/services/LockService';
import type { AutoFileLock } from '../../../shared/types';
import { promises as fsp, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Beats LockService's 500ms save debounce. */
const SAVE_DEBOUNCE_WAIT_MS = 800;

let repoPath: string;
let lockService: LockService;

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
