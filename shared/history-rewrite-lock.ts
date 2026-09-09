/**
 * Per-worktree history-rewrite lockfile helpers.
 *
 * Before running any history-rewriting op (rebase / merge / reset / cherry-pick),
 * the initiating service acquires this lockfile. Auto-committers check it
 * via `evaluateAutoCommitGuard` and skip while it's held. Released on
 * completion / abort.
 *
 * Path convention: `<worktreePath>/.kanvas/history-rewrite.lock`
 *
 * The lock payload is JSON:
 *   { pid, reason, acquiredAt, hostname? }
 *
 * Stale-lock detection: if the recorded `pid` is no longer alive (or the
 * lock is older than `staleAfterMs`, default 30 min), the caller may
 * force-release. This module returns the parsed lock state; the actual fs
 * writes live in the service.
 */

export interface HistoryRewriteLockPayload {
  pid: number;
  reason: string;
  acquiredAt: string;
  hostname?: string;
}

/** Repo-relative path where the lockfile lives. */
export const LOCK_RELATIVE_PATH = '.kanvas/history-rewrite.lock';

/** Default staleness horizon (30 minutes). */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

export type LockState =
  | { present: false }
  | { present: true; payload: HistoryRewriteLockPayload; stale: boolean };

export interface LockClassifyInputs {
  /** Raw file contents (or null when the file doesn't exist). */
  contents: string | null;
  /** Result of `isPidAlive(payload.pid)` — caller supplies. */
  pidAlive: boolean;
  /** "Now" for tests. Default Date.now(). */
  now?: number;
  /** Override stale horizon in ms. */
  staleAfterMs?: number;
}

/**
 * Parse the lockfile contents and decide whether the lock is fresh, stale,
 * or missing. Robust to partial / malformed JSON — treats those as absent
 * so the auto-committer doesn't get permanently blocked by a garbled file.
 */
export function classifyLockState(input: LockClassifyInputs): LockState {
  if (!input.contents) return { present: false };
  let payload: Partial<HistoryRewriteLockPayload>;
  try {
    payload = JSON.parse(input.contents);
  } catch {
    // Malformed lockfile — treat as absent, caller may want to clean it up.
    return { present: false };
  }
  if (
    typeof payload.pid !== 'number' ||
    typeof payload.reason !== 'string' ||
    typeof payload.acquiredAt !== 'string'
  ) {
    return { present: false };
  }

  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_MS;
  const ageMs = now - Date.parse(payload.acquiredAt);
  const staleByAge = Number.isFinite(ageMs) && ageMs > staleAfterMs;
  const stale = staleByAge || !input.pidAlive;

  return {
    present: true,
    payload: payload as HistoryRewriteLockPayload,
    stale,
  };
}

/** Build the payload the caller writes to disk. */
export function buildLockPayload(reason: string, opts: { pid?: number; hostname?: string; now?: () => number } = {}): HistoryRewriteLockPayload {
  return {
    pid: opts.pid ?? (typeof process !== 'undefined' ? process.pid : 0),
    reason,
    acquiredAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    hostname: opts.hostname,
  };
}
