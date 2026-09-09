/**
 * Rebase tip-count safety guard.
 *
 * Signature of the incident: a rebase completed "successfully" but the
 * post-rebase branch had FEWER commits than the pre-rebase branch. This
 * predicate detects that inversion so callers can `reset --hard ORIG_HEAD`
 * and abort the merge rather than push the truncated branch.
 *
 * The service captures `git rev-list --count HEAD` before and after the
 * rebase and passes both values in.
 */

export interface TipGuardInputs {
  preRebaseCommitCount: number;
  postRebaseCommitCount: number;
  /** Optional: name of the branch, for the error message. */
  branchName?: string;
  /**
   * Optional threshold. A tip that DROPS by more than this many commits
   * is treated as an inversion. Default 0 — any drop is fatal. Callers
   * can loosen (e.g. squash rebases legitimately reduce count) but the
   * default is fail-safe.
   */
  allowedShrinkage?: number;
}

export type TipGuardKind =
  | 'safe-same-or-grew'
  | 'safe-within-allowed-shrinkage'
  | 'blocked-tip-inverted';

export interface TipGuardResult {
  safe: boolean;
  kind: TipGuardKind;
  shrinkageCommits: number;
  message?: string;
}

export function evaluateRebaseTipGuard(input: TipGuardInputs): TipGuardResult {
  const shrinkage = input.preRebaseCommitCount - input.postRebaseCommitCount;
  const allowed = input.allowedShrinkage ?? 0;

  if (shrinkage <= 0) {
    return {
      safe: true,
      kind: 'safe-same-or-grew',
      shrinkageCommits: shrinkage,
    };
  }
  if (shrinkage <= allowed) {
    return {
      safe: true,
      kind: 'safe-within-allowed-shrinkage',
      shrinkageCommits: shrinkage,
    };
  }

  const branchNote = input.branchName ? ` on branch "${input.branchName}"` : '';
  return {
    safe: false,
    kind: 'blocked-tip-inverted',
    shrinkageCommits: shrinkage,
    message:
      `Rebase inverted the branch tip${branchNote}: pre-rebase had ` +
      `${input.preRebaseCommitCount} commits, post-rebase has ` +
      `${input.postRebaseCommitCount} (dropped ${shrinkage}). This is the ` +
      `KIT-auto-commit / rebase-race signature — refusing to proceed. ` +
      `Recover with 'git reset --hard ORIG_HEAD'.`,
  };
}
