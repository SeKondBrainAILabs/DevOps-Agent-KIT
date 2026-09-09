/**
 * Unit Tests for shared/session-reap.ts (story KIT-MCP-R1)
 *
 * The reaper deletes worktrees on a timer with no human in the loop. It is the
 * most destructive code in this epic, so the decision is a pure function
 * tested exhaustively, and the service half only executes what this decides.
 *
 * Two rules carry almost all the safety weight:
 *
 *   1. A SAFE-closed session is never reaped. A safe close deliberately RETAINS
 *      the worktree and branch. If the reaper swept closed sessions it would
 *      delete exactly what the safe default promised to keep — four hours
 *      later, silently. That would make the epic's headline default a lie.
 *
 *   2. An inconclusive merge check never authorises deletion. See the
 *      `conclusive` tests at the bottom for the real-world case that forced
 *      this.
 */

import { describe, it, expect } from '@jest/globals';
import {
  evaluateReapCandidate,
  planReapAction,
  DEFAULT_REAP_POLICY,
  type ReapCandidate,
  type MergeSafety,
} from '../../../shared/session-reap';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const candidate = (over: Partial<ReapCandidate> = {}): ReapCandidate => ({
  sessionId: 'sess_a',
  createdBy: 'mcp',
  status: 'waiting',
  createdAt: minutesAgo(600),
  lastActivityAt: minutesAgo(600),
  ...over,
});

// ─── Who is even a candidate ─────────────────────────────────────────────────
describe('evaluateReapCandidate — scope', () => {
  it('reaps an idle agent session past the TTL', () => {
    const v = evaluateReapCandidate(candidate(), NOW, DEFAULT_REAP_POLICY);
    expect(v.expired).toBe(true);
    expect(v.reasonCode).toBe('IDLE_TTL_EXCEEDED');
  });

  it('NEVER reaps a ui-created session, however idle', () => {
    // AC (a): a human's session idle for 48h is not the reaper's business.
    const v = evaluateReapCandidate(
      candidate({ createdBy: 'ui', createdAt: minutesAgo(2880), lastActivityAt: minutesAgo(2880) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('NOT_AGENT_SESSION');
  });

  it('NEVER reaps an adopted session — it is a human branch under agent management', () => {
    const v = evaluateReapCandidate(
      candidate({ createdBy: 'adopted', lastActivityAt: minutesAgo(2880) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('NOT_AGENT_SESSION');
  });

  it('treats an ABSENT createdBy as ui — the upgrade fail-safe', () => {
    const v = evaluateReapCandidate(
      candidate({ createdBy: undefined, lastActivityAt: minutesAgo(2880) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('NOT_AGENT_SESSION');
  });
});

// ─── The rule that protects the safe-close promise ───────────────────────────
describe('evaluateReapCandidate — terminal statuses are off limits', () => {
  it.each(['closed', 'completed', 'failed'])(
    'does not reap a %s session, even when ancient',
    (status) => {
      // AC (b): a safe close RETAINS the worktree on purpose. Reaping it four
      // hours later would delete the thing the safe default exists to keep.
      const v = evaluateReapCandidate(
        candidate({ status, createdAt: minutesAgo(10000), lastActivityAt: minutesAgo(10000) }),
        NOW,
        DEFAULT_REAP_POLICY
      );
      expect(v.expired).toBe(false);
      expect(v.reasonCode).toBe('TERMINAL_STATUS');
    }
  );

  it('does not re-reap a session the reaper already acted on', () => {
    const v = evaluateReapCandidate(
      candidate({ reapedAt: minutesAgo(30) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('ALREADY_REAPED');
  });
});

describe('evaluateReapCandidate — pinning', () => {
  it('skips a pinned session whatever its age', () => {
    const v = evaluateReapCandidate(
      candidate({ pinned: true, createdAt: minutesAgo(99999), lastActivityAt: minutesAgo(99999) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('PINNED');
  });

  it('pinning beats an explicit expiresAt in the past', () => {
    const v = evaluateReapCandidate(
      candidate({ pinned: true, expiresAt: minutesAgo(1000) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
  });
});

// ─── Timing ──────────────────────────────────────────────────────────────────
describe('evaluateReapCandidate — the idle clock', () => {
  it('leaves a session that made an MCP call a minute ago alone', () => {
    // Age deliberately kept under the hard ceiling — past it the session goes
    // however recent its last call, which the ceiling test below covers.
    const v = evaluateReapCandidate(
      candidate({ createdAt: minutesAgo(1000), lastActivityAt: minutesAgo(1) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('STILL_LIVE');
  });

  it('does not fire one minute under the idle TTL', () => {
    const v = evaluateReapCandidate(
      candidate({ lastActivityAt: minutesAgo(DEFAULT_REAP_POLICY.idleMinutes - 1) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
  });

  it('fires one minute over it', () => {
    const v = evaluateReapCandidate(
      candidate({ lastActivityAt: minutesAgo(DEFAULT_REAP_POLICY.idleMinutes + 1) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(true);
  });

  it('honours the grace period for a brand-new session with no activity at all', () => {
    // A session created seconds ago has no mcp_calls row yet. Without the
    // grace period the very first pass after creation would reap it before
    // its subagent has had a chance to make one call.
    const v = evaluateReapCandidate(
      candidate({ createdAt: minutesAgo(2), lastActivityAt: undefined }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('WITHIN_GRACE');
  });

  it('falls back to createdAt when there is no activity signal', () => {
    const v = evaluateReapCandidate(
      candidate({ createdAt: minutesAgo(500), lastActivityAt: undefined }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(true);
  });

  it('applies the hard ceiling to a session that keeps itself busy forever', () => {
    // Liveness resets on every tool call, so a runaway agent looping tool
    // calls would never trip the idle TTL. The ceiling is the backstop.
    const v = evaluateReapCandidate(
      candidate({
        createdAt: minutesAgo(DEFAULT_REAP_POLICY.hardCeilingMinutes + 10),
        lastActivityAt: minutesAgo(1),
      }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(true);
    expect(v.reasonCode).toBe('HARD_CEILING_EXCEEDED');
  });

  it('honours an explicit expiresAt ahead of the default TTL', () => {
    const v = evaluateReapCandidate(
      candidate({ expiresAt: minutesAgo(5), lastActivityAt: minutesAgo(1) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(true);
    expect(v.reasonCode).toBe('TTL_EXPIRED');
  });

  it('an expiresAt in the future protects a session past the idle TTL', () => {
    // An explicit TTL is the caller stating intent; it overrides the default
    // idle clock in both directions.
    const v = evaluateReapCandidate(
      candidate({
        expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
        lastActivityAt: minutesAgo(600),
      }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('TTL_NOT_REACHED');
  });

  it('still applies the grace period to an expiresAt set in the past at creation', () => {
    const v = evaluateReapCandidate(
      candidate({ createdAt: minutesAgo(1), expiresAt: minutesAgo(1) }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
    expect(v.reasonCode).toBe('WITHIN_GRACE');
  });

  it('tolerates an unparseable timestamp rather than reaping on NaN', () => {
    const v = evaluateReapCandidate(
      candidate({ lastActivityAt: 'not-a-date', createdAt: 'also-not-a-date' }),
      NOW,
      DEFAULT_REAP_POLICY
    );
    expect(v.expired).toBe(false);
  });
});

// ─── What to actually do about it ────────────────────────────────────────────
const conclusiveClean: MergeSafety = {
  conclusive: true,
  hasUncommittedChanges: false,
  unmergedCommitCount: 0,
};

describe('planReapAction', () => {
  it('fully deletes an expired observer — it owns no worktree and no branch', () => {
    const plan = planReapAction(candidate({ isolation: 'observer' }), conclusiveClean);
    expect(plan.action).toBe('delete-observer');
    expect(plan.deleteWorktree).toBe(false);
    expect(plan.deleteLocalBranch).toBe(false);
  });

  it('deletes worktree and local branch for a clean, merged session', () => {
    const plan = planReapAction(candidate(), conclusiveClean);
    expect(plan.action).toBe('delete-clean');
    expect(plan.deleteWorktree).toBe(true);
    expect(plan.deleteLocalBranch).toBe(true);
  });

  it('NEVER deletes a remote branch, on any path', () => {
    for (const safety of [
      conclusiveClean,
      { conclusive: true, hasUncommittedChanges: true, unmergedCommitCount: 0 },
      { conclusive: false, hasUncommittedChanges: false, unmergedCommitCount: 0 },
    ] as MergeSafety[]) {
      expect(planReapAction(candidate(), safety).deleteRemoteBranch).toBe(false);
    }
  });

  it('snapshots and closes when there are uncommitted changes — deletes nothing', () => {
    const plan = planReapAction(candidate(), {
      conclusive: true,
      hasUncommittedChanges: true,
      unmergedCommitCount: 0,
    });
    expect(plan.action).toBe('snapshot-and-close');
    expect(plan.deleteWorktree).toBe(false);
    expect(plan.deleteLocalBranch).toBe(false);
  });

  it('snapshots and closes when commits are unmerged — deletes nothing', () => {
    const plan = planReapAction(candidate(), {
      conclusive: true,
      hasUncommittedChanges: false,
      unmergedCommitCount: 3,
    });
    expect(plan.action).toBe('snapshot-and-close');
    expect(plan.deleteWorktree).toBe(false);
  });

  it('never git-touches a session whose worktree creation failed', () => {
    // Its "worktree" is the user's real checkout. Running worktree removal or
    // branch deletion against that is the worst outcome in the epic.
    const plan = planReapAction(
      candidate({ worktreeStatus: 'failed' }),
      conclusiveClean
    );
    expect(plan.action).toBe('teardown-only');
    expect(plan.deleteWorktree).toBe(false);
    expect(plan.deleteLocalBranch).toBe(false);
  });

  // ─── The case that forced `conclusive` to exist ────────────────────────────
  describe('inconclusive merge checks', () => {
    it('refuses to delete when the merge comparison could not be made', () => {
      // `GitService.getWorktreeSafetyInfo` compares HEAD against `main` and
      // `development` and swallows the error when neither exists. On a repo
      // whose branches are `trunk`/`master` BOTH comparisons fail, and it
      // reports unmergedCommitCount:0 with mergedIntoBranches:['main',
      // 'development'] — a branch full of unmerged work looks perfectly clean
      // and merged. Verified against a real git repo, not assumed.
      //
      // Trusting that here would delete the worktree AND the local branch.
      const plan = planReapAction(candidate(), {
        conclusive: false,
        hasUncommittedChanges: false,
        unmergedCommitCount: 0,
      });
      expect(plan.action).toBe('snapshot-and-close');
      expect(plan.deleteWorktree).toBe(false);
      expect(plan.deleteLocalBranch).toBe(false);
      expect(plan.reason).toMatch(/could not be verified/i);
    });

    it('still fully deletes an inconclusive OBSERVER — it has nothing to lose', () => {
      const plan = planReapAction(
        candidate({ isolation: 'observer' }),
        { conclusive: false, hasUncommittedChanges: true, unmergedCommitCount: 9 }
      );
      expect(plan.action).toBe('delete-observer');
    });
  });
});
