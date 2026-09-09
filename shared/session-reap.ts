/**
 * Pure reap decision logic (story KIT-MCP-R1).
 *
 * The reaper is the only thing in KIT that deletes a worktree with no human in
 * the loop, so the decision lives here — no I/O, no electron imports, fully
 * table-testable — and `SessionOrchestrator.reapExpiredAgentSessions` does
 * nothing but execute what these two functions return.
 *
 * ## Why not extend `checkForStaleSessions`
 *
 * The existing startup scan (`electron/index.ts:105`) is wrong on five axes for
 * this job: it runs once at startup, uses a 14-day TTL, judges liveness by
 * worktree mtime, skips `active`/`initializing`, and skips sessions with no
 * distinct worktree — which is every observer. It stays as it is, and remains
 * the ONLY thing that eventually cleans up a retained worktree.
 */

/** A session as the reaper sees it, with liveness already resolved. */
export interface ReapCandidate {
  sessionId: string;
  createdBy?: 'ui' | 'mcp' | 'adopted';
  status: string;
  createdAt: string;
  /**
   * The most recent sign of life, ISO-8601. The caller resolves this as the
   * max over `mcp_calls`, `activity_logs` and worktree mtime, ACROSS EVERY
   * ALIAS of the session — a session that survived a restart has its history
   * under a predecessor id, and keying on the current id alone would reap a
   * live session for having no history of its own.
   */
  lastActivityAt?: string;
  isolation?: 'worktree' | 'observer';
  worktreeStatus?: 'created' | 'reused' | 'legacy' | 'observer' | 'failed';
  pinned?: boolean;
  expiresAt?: string;
  reapedAt?: string;
}

export interface ReapPolicy {
  /** Silence after which a session is considered abandoned. */
  idleMinutes: number;
  /** Absolute age past which a session goes however busy it looks. */
  hardCeilingMinutes: number;
  /** Never reap anything younger than this, whatever the other clocks say. */
  graceMinutes: number;
}

/**
 * 4h idle / 24h ceiling / 10min grace.
 *
 * The idle clock resets on every MCP tool call, so "thinking hard" only trips
 * it after four hours of TOTAL silence — not four hours of one task.
 */
export const DEFAULT_REAP_POLICY: ReapPolicy = {
  idleMinutes: 240,
  hardCeilingMinutes: 1440,
  graceMinutes: 10,
};

export type ReapReasonCode =
  | 'IDLE_TTL_EXCEEDED'
  | 'HARD_CEILING_EXCEEDED'
  | 'TTL_EXPIRED'
  | 'NOT_AGENT_SESSION'
  | 'TERMINAL_STATUS'
  | 'ALREADY_REAPED'
  | 'PINNED'
  | 'WITHIN_GRACE'
  | 'STILL_LIVE'
  | 'TTL_NOT_REACHED';

export interface ReapVerdict {
  expired: boolean;
  reasonCode: ReapReasonCode;
  idleMinutes: number;
  ageMinutes: number;
}

/**
 * Statuses the reaper must not touch.
 *
 * `closed` is the load-bearing one. A SAFE close deliberately retains the
 * worktree and the branch; if the reaper swept closed sessions it would delete
 * exactly what the safe default promised to keep, four hours later and
 * silently. A retained worktree is cleaned up only by the 14-day
 * `checkForStaleSessions` scan, or by the user.
 */
const TERMINAL_STATUSES = new Set(['closed', 'completed', 'failed', 'error']);

const parse = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function evaluateReapCandidate(
  candidate: ReapCandidate,
  now: Date,
  policy: ReapPolicy = DEFAULT_REAP_POLICY
): ReapVerdict {
  const nowMs = now.getTime();
  const createdMs = parse(candidate.createdAt);
  const activityMs = parse(candidate.lastActivityAt);

  const ageMinutes = createdMs === null ? 0 : (nowMs - createdMs) / 60_000;
  // No activity signal at all ⇒ the session's own age is the idle clock.
  const idleFrom = activityMs ?? createdMs;
  const idleMinutes = idleFrom === null ? 0 : (nowMs - idleFrom) / 60_000;

  const verdict = (expired: boolean, reasonCode: ReapReasonCode): ReapVerdict => ({
    expired,
    reasonCode,
    idleMinutes,
    ageMinutes,
  });

  // Only ever agent-created sessions. Absent createdBy means a record written
  // before origin tracking existed — i.e. a human's — so it is out of scope.
  if (candidate.createdBy !== 'mcp') return verdict(false, 'NOT_AGENT_SESSION');
  if (TERMINAL_STATUSES.has(candidate.status)) return verdict(false, 'TERMINAL_STATUS');
  if (candidate.reapedAt) return verdict(false, 'ALREADY_REAPED');
  if (candidate.pinned) return verdict(false, 'PINNED');

  // An unparseable createdAt would otherwise compute an age of NaN, and every
  // comparison against NaN is false — which reads as "not expired" by luck
  // rather than by decision. Make it explicit.
  if (createdMs === null) return verdict(false, 'STILL_LIVE');

  // The grace period outranks every expiry clock, including an explicit TTL
  // that was already in the past when it was set.
  if (ageMinutes < policy.graceMinutes) return verdict(false, 'WITHIN_GRACE');

  // An explicit expiresAt is the caller stating intent, and it wins over the
  // default idle clock in BOTH directions — a future one protects an idle
  // session, a past one expires a busy one.
  const expiresMs = parse(candidate.expiresAt);
  if (expiresMs !== null) {
    return nowMs >= expiresMs
      ? verdict(true, 'TTL_EXPIRED')
      : verdict(false, 'TTL_NOT_REACHED');
  }

  if (ageMinutes >= policy.hardCeilingMinutes) return verdict(true, 'HARD_CEILING_EXCEEDED');
  if (idleMinutes >= policy.idleMinutes) return verdict(true, 'IDLE_TTL_EXCEEDED');
  return verdict(false, 'STILL_LIVE');
}

/** What a local (network-free) look at the worktree found. */
export interface MergeSafety {
  /**
   * Whether the merge comparison could actually be made.
   *
   * `GitService.getWorktreeSafetyInfo` compares HEAD against `main` and
   * `development` and swallows the error when neither ref exists. On a repo
   * whose primary branch is `trunk` or `master`, BOTH comparisons fail and it
   * returns `unmergedCommitCount: 0` with `mergedIntoBranches: ['main',
   * 'development']` — a branch full of unmerged work presented as clean and
   * fully merged. Verified against a real repo.
   *
   * A caller that cannot tell "zero commits ahead" from "the comparison
   * failed" must report `false` here, and this module will refuse to delete.
   */
  conclusive: boolean;
  hasUncommittedChanges: boolean;
  unmergedCommitCount: number;
}

export type ReapAction =
  | 'delete-observer'
  | 'delete-clean'
  | 'snapshot-and-close'
  | 'teardown-only';

export interface ReapPlan {
  action: ReapAction;
  deleteWorktree: boolean;
  deleteLocalBranch: boolean;
  /** Always false. The reaper never touches a remote, on any path. */
  deleteRemoteBranch: false;
  reason: string;
}

export function planReapAction(
  candidate: ReapCandidate,
  safety: MergeSafety
): ReapPlan {
  const plan = (
    action: ReapAction,
    deleteWorktree: boolean,
    deleteLocalBranch: boolean,
    reason: string
  ): ReapPlan => ({
    action,
    deleteWorktree,
    deleteLocalBranch,
    deleteRemoteBranch: false,
    reason,
  });

  // An observer owns no worktree and no branch, so there is nothing to lose and
  // nothing to check. Its record and registrations simply go.
  if (candidate.isolation === 'observer') {
    return plan('delete-observer', false, false, 'observer session: no worktree or branch to preserve');
  }

  // Worktree creation failed, so this session has been running directly in the
  // user's real checkout. Never point worktree removal or branch deletion at
  // that — tear down the session's own resources and stop.
  if (candidate.worktreeStatus === 'failed') {
    return plan(
      'teardown-only',
      false,
      false,
      'worktree creation failed: session ran in the source repo, nothing safe to delete'
    );
  }

  if (!safety.conclusive) {
    return plan(
      'snapshot-and-close',
      false,
      false,
      'merge state could not be verified: refusing to delete'
    );
  }

  if (safety.hasUncommittedChanges) {
    return plan('snapshot-and-close', false, false, 'uncommitted changes present');
  }

  if (safety.unmergedCommitCount > 0) {
    return plan(
      'snapshot-and-close',
      false,
      false,
      `${safety.unmergedCommitCount} commit(s) not merged into the base branch`
    );
  }

  return plan('delete-clean', true, true, 'clean and fully merged');
}
