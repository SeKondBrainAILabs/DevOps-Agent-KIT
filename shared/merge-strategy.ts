/**
 * How a merge should actually be delivered (KIT-PR-P10).
 *
 * KIT has always merged locally and pushed the target branch. That is fine for
 * a feature branch you own, and actively harmful for a protected one: GitHub
 * rejects the push, the local target keeps the merge commit, and the two
 * diverge. Worse, MergeService never checked the push exit code, so the merge
 * reported SUCCESS while origin had received nothing.
 *
 * A pull request is the correct delivery mechanism wherever the target is
 * protected — it is the only one that respects required reviews, required
 * checks and merge queues, none of which a direct push can satisfy.
 */

/** Targets KIT treats as protected. Exact match, as MergeService always has. */
export const PROTECTED_BRANCHES = ['main', 'master', 'production', 'release'] as const;

export type MergeVia = 'auto' | 'pr' | 'direct';

export interface MergeStrategyInput {
  targetBranch: string;
  /** What the caller asked for. Absent means 'auto'. */
  via?: MergeVia;
  /** Whether a pull request can be opened at all (GitHub remote + usable gh). */
  canOpenPr: boolean;
  /**
   * The explicit CI-gate override. It has always meant "I accept the risk on a
   * protected branch", so it also permits a direct push to one.
   */
  force?: boolean;
}

export interface MergeStrategy {
  mode: 'pr' | 'direct';
  /** Why, for the caller to surface. */
  reason: string;
  /** True when the caller asked for a PR and we cannot open one. */
  refused?: boolean;
  refusalCode?: 'PR_UNAVAILABLE';
}

export function isProtectedBranch(branch: string): boolean {
  return (PROTECTED_BRANCHES as readonly string[]).includes(branch);
}

export function resolveMergeStrategy(input: MergeStrategyInput): MergeStrategy {
  const { targetBranch, via = 'auto', canOpenPr, force } = input;
  const protectedTarget = isProtectedBranch(targetBranch);

  // An explicit request for a pull request is honoured wherever one can be
  // opened, protected or not — a team may want every merge reviewed.
  if (via === 'pr') {
    if (!canOpenPr) {
      return {
        mode: 'direct',
        refused: true,
        refusalCode: 'PR_UNAVAILABLE',
        reason:
          'A pull request was requested but cannot be opened here — the repository ' +
          'has no usable GitHub remote.',
      };
    }
    return { mode: 'pr', reason: 'Pull request requested explicitly.' };
  }

  // An explicit request to merge directly is honoured, including into a
  // protected branch. The caller may have permission the tool cannot see, and
  // refusing outright would make KIT unusable for whoever administers the repo.
  // The push is now checked, so a rejection surfaces instead of being silent.
  if (via === 'direct') {
    return {
      mode: 'direct',
      reason: protectedTarget
        ? `Direct merge into protected '${targetBranch}' requested explicitly.`
        : 'Direct merge requested.',
    };
  }

  // ── auto ────────────────────────────────────────────────────────────────
  if (!protectedTarget) {
    return { mode: 'direct', reason: `'${targetBranch}' is not a protected branch.` };
  }

  // force has always meant "I accept the risk on a protected branch". Keeping
  // it as a direct-merge escape hatch preserves what the button already does.
  if (force) {
    return {
      mode: 'direct',
      reason: `Protected target '${targetBranch}', overridden by force.`,
    };
  }

  if (!canOpenPr) {
    // Nothing better is available. Say so rather than silently doing the thing
    // that will be rejected.
    return {
      mode: 'direct',
      reason:
        `'${targetBranch}' is protected, but no pull request can be opened here ` +
        '(no usable GitHub remote). A direct push may be rejected by branch protection.',
    };
  }

  return {
    mode: 'pr',
    reason:
      `'${targetBranch}' is protected, so the change is delivered as a pull request. ` +
      'A direct push cannot satisfy required reviews or checks.',
  };
}
