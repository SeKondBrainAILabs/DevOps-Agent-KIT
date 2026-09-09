/**
 * fs-side helpers that feed `evaluateAutoCommitGuard`.
 *
 * Kept out of `shared/` because it depends on node fs; the pure predicate
 * lives at `shared/git-rewrite-guard.ts` for testability.
 */

import { existsSync, readFileSync } from 'fs';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import {
  buildLockPayload,
  classifyLockState,
  LOCK_RELATIVE_PATH,
  type HistoryRewriteLockPayload,
} from '../../shared/history-rewrite-lock';
import {
  evaluateAutoCommitGuard,
  type AutoCommitGuardResult,
} from '../../shared/git-rewrite-guard';

function safeReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // signal 0 checks existence without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the on-disk git-state files + lock file for a worktree, then call
 * the pure predicate. Returns `{ allowed, kind, message? }`.
 */
export function evaluateAutoCommitGuardForWorktree(
  worktreePath: string
): AutoCommitGuardResult {
  const gitDir = join(worktreePath, '.git');
  const midRebase =
    existsSync(join(gitDir, 'rebase-merge')) ||
    existsSync(join(gitDir, 'rebase-apply'));
  const midMerge = existsSync(join(gitDir, 'MERGE_HEAD'));
  const midCherryPick = existsSync(join(gitDir, 'CHERRY_PICK_HEAD'));
  const midBisect = existsSync(join(gitDir, 'BISECT_LOG'));

  // Detached HEAD detection via .git/HEAD contents:
  //   symbolic-ref: "ref: refs/heads/<branch>\n"
  //   detached:     "<sha>\n"
  const headContents = safeReadFile(join(gitDir, 'HEAD')) ?? '';
  const detachedHead =
    headContents.trim().length > 0 && !headContents.startsWith('ref:');

  const lockContents = safeReadFile(join(worktreePath, LOCK_RELATIVE_PATH));
  const lockState = classifyLockState({
    contents: lockContents,
    pidAlive:
      lockContents !== null
        ? (() => {
            try {
              const parsed = JSON.parse(lockContents);
              return typeof parsed?.pid === 'number' && isPidAlive(parsed.pid);
            } catch {
              return false;
            }
          })()
        : false,
  });
  // Stale locks don't block — freshly-held locks do.
  const historyRewriteLocked = lockState.present && !lockState.stale;
  const lockReason =
    lockState.present ? lockState.payload.reason : undefined;

  return evaluateAutoCommitGuard({
    midRebase,
    midMerge,
    midCherryPick,
    midBisect,
    detachedHead,
    historyRewriteLocked,
    lockReason,
  });
}

/**
 * Acquire the history-rewrite lock. Returns the payload written to disk.
 * Overwrites stale locks. Callers MUST wrap their rewrite op in a
 * try/finally that releases the lock even on failure.
 */
export async function acquireHistoryRewriteLock(
  worktreePath: string,
  reason: string
): Promise<HistoryRewriteLockPayload> {
  const lockPath = join(worktreePath, LOCK_RELATIVE_PATH);
  const dir = join(worktreePath, '.kanvas');
  await mkdir(dir, { recursive: true });
  const payload = buildLockPayload(reason);
  await writeFile(lockPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

/** Release the lock. Safe to call when no lock is held. */
export async function releaseHistoryRewriteLock(worktreePath: string): Promise<void> {
  const lockPath = join(worktreePath, LOCK_RELATIVE_PATH);
  try {
    if (existsSync(lockPath)) await unlink(lockPath);
  } catch {
    /* non-fatal — a later stale detection will handle it */
  }
}

/** Convenience wrapper: acquire, run op, release, even on throw. */
export async function withHistoryRewriteLock<T>(
  worktreePath: string,
  reason: string,
  op: () => Promise<T>
): Promise<T> {
  await acquireHistoryRewriteLock(worktreePath, reason);
  try {
    return await op();
  } finally {
    await releaseHistoryRewriteLock(worktreePath);
  }
}
