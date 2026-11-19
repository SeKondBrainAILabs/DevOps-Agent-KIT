/**
 * One answer to "has the session holding this lock gone away?".
 *
 * Two layers used to decide this independently, and they disagreed.
 *
 *  - `electron/services/mcp/tools.ts` (PR #42) asked `binder.getSession(id)`
 *    — "does KIT answer to this id?" — and only released a lock older than a
 *    10-minute grace period, inside `kit_lock_file` alone.
 *  - `electron/services/LockService.ts` (PR #50) asked
 *    `listInstances() + isActiveInstance` — "is this the current id of a
 *    non-terminal instance?" — with no grace, service-wide.
 *
 * They split on restart predecessors. `registerExistingSessionsWithBinder`
 * gives every `predecessorSessionIds` entry its own binder registration
 * pointing at the CURRENT worktree (AgentInstanceService:2826), so after a KIT
 * restart the binder answers to the old id and #42 read the holder as live —
 * which is exactly the case that left locks pinned forever, because the
 * successor session has a different id and `autoLockFile` saw a conflict.
 * #50 read the same id as dead, so whichever layer ran first decided.
 *
 * The disagreement came from flattening three situations into a boolean. They
 * want different answers, and naming them resolves it without either side
 * simply losing:
 *
 *  - `live`       — a non-terminal instance's current session id. Its agent may
 *                   still be writing. Never take its locks.
 *  - `superseded` — not a current id, but some non-terminal instance lists it
 *                   as a predecessor. This is POSITIVE evidence that the
 *                   process which took the lock is gone (a restart mints a new
 *                   id) and that a successor exists to claim it. Reclaim at
 *                   once: no grace period helps here, because waiting cannot
 *                   turn a predecessor back into a running agent.
 *  - `unknown`    — nothing knows the id. This is an ABSENCE of evidence, not
 *                   evidence of death: instances load asynchronously at
 *                   startup, so a live session can read as unknown for a
 *                   moment. Here #42's grace period is right, and it is kept.
 *
 * So #42 keeps its grace exactly where information is missing, and #50 keeps
 * its immediacy exactly where the evidence is positive. Both layers now call
 * these two functions, so they cannot drift apart again.
 */

import type { AgentInstance } from './types';
import { isActiveInstance } from './instance-status';

/**
 * A lock younger than this is never reclaimed from an `unknown` holder: a
 * session being restored may not have registered its id yet.
 *
 * Unchanged from the value PR #42 introduced in tools.ts, which re-exports it.
 */
export const STALE_LOCK_GRACE_MS = 10 * 60 * 1000;

export type HolderLiveness = 'live' | 'superseded' | 'unknown';

/** The fields this needs from an instance — anything instance-shaped will do. */
export type LivenessInstance = Pick<AgentInstance, 'sessionId' | 'status'> & {
  predecessorSessionIds?: string[];
};

/**
 * Classify the session a lock is attributed to.
 *
 * Terminal instances (completed / closed / failed, per `isActiveInstance`) are
 * ignored on both passes: neither a dead instance's current id nor its
 * predecessors keep a lock alive. This matches
 * `registerExistingSessionsWithBinder`, which also skips them.
 *
 * Callers that cannot obtain an instance list must NOT pass an empty one —
 * "I could not look" is not "nothing is live". Pass what you have and treat a
 * failed lookup as `live` at the call site.
 */
export function classifyLockHolder(
  sessionId: string,
  instances: ReadonlyArray<LivenessInstance>
): HolderLiveness {
  if (!sessionId) return 'unknown';

  const active = instances.filter((inst) => isActiveInstance(inst));

  if (active.some((inst) => inst.sessionId === sessionId)) return 'live';

  const superseded = active.some(
    (inst) =>
      Array.isArray(inst.predecessorSessionIds) &&
      inst.predecessorSessionIds.includes(sessionId)
  );

  return superseded ? 'superseded' : 'unknown';
}

/**
 * Given a classification, may this lock be taken from its holder?
 *
 * `lockedAtMs` is when the lock was created — not when the file last changed.
 * The grace period asks "is this lock young enough that its holder might still
 * be starting up?", which is about the lock's age.
 *
 * A missing or unparseable timestamp reads as NaN and is NOT grounds to take an
 * `unknown` holder's lock: the grace period exists precisely to stop us acting
 * on absent information, and an unknown age is less information still. PR #42
 * guarded this with `Number.isFinite` and was right to. It does not make such a
 * lock immortal — `LockService.pruneStaleLocks` drops a record whose
 * `lastModified` is unparseable on the inactivity-timeout path, which is
 * independent of liveness.
 */
export function isHolderGone(
  liveness: HolderLiveness,
  lockedAtMs: number,
  now: number = Date.now(),
  graceMs: number = STALE_LOCK_GRACE_MS
): boolean {
  switch (liveness) {
    case 'live':
      return false;
    case 'superseded':
      return true;
    case 'unknown':
      return Number.isFinite(lockedAtMs) && now - lockedAtMs > graceMs;
  }
}
