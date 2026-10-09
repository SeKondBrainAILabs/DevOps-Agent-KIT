/**
 * Which commit a new session starts from (S9N ticket: "new session must start
 * from the latest remote base branch").
 *
 * A session used to branch from the LOCAL base branch with no fetch, so when
 * origin had moved on the agent started on stale code and met avoidable
 * conflicts at rebase time. The caller now fetches first and asks this module
 * how local and remote relate.
 *
 * Two rules, both conservative:
 *   - never drop commits that exist only locally (unpushed work);
 *   - never rewrite history — only fast-forward.
 *
 * Pure, so every combination is testable without git.
 */

/** How a local ref relates to its remote counterpart, from `git merge-base`. */
export type RefRelation =
  | 'equal'
  | 'remote-ahead' // local is an ancestor of remote: fast-forwardable
  | 'local-ahead' // remote is an ancestor of local: local has unpushed commits
  | 'diverged' // each has commits the other lacks
  | 'no-remote' // remote ref missing (no remote, never pushed, or fetch failed)
  | 'no-local'; // only the remote ref exists

export interface StartRefChoice {
  /** Ref to pass to `git worktree add -b <branch> <dir> <ref>`. */
  ref: string;
  /** Set when the choice is a compromise the user should hear about. */
  warning?: string;
}

/** Start point for a brand-new session branch cut from `baseBranch`. */
export function chooseNewBranchStart(
  baseBranch: string,
  relation: RefRelation,
  remote = 'origin'
): StartRefChoice {
  const remoteRef = `${remote}/${baseBranch}`;
  switch (relation) {
    case 'remote-ahead':
    case 'no-local':
      return { ref: remoteRef };
    case 'diverged':
      return {
        ref: baseBranch,
        warning:
          `Local '${baseBranch}' and '${remoteRef}' have diverged, so the session starts ` +
          `from local '${baseBranch}' to keep its unpushed commits. It does not include ` +
          `the newer commits on '${remoteRef}' — sync (rebase) to pick them up.`,
      };
    case 'no-remote':
      return {
        ref: baseBranch,
        warning:
          `Could not compare '${baseBranch}' with '${remoteRef}' (no remote, offline, or ` +
          `not pushed), so the session starts from local '${baseBranch}', which may be stale.`,
      };
    case 'equal':
    case 'local-ahead':
    default:
      return { ref: baseBranch };
  }
}

/**
 * Should an EXISTING session branch be fast-forwarded to its remote when a
 * session starts on it? Only when that is a pure fast-forward.
 */
export function shouldFastForward(relation: RefRelation): boolean {
  return relation === 'remote-ahead';
}

/** Warning for an existing branch whose remote has moved in a way we will not touch. */
export function existingBranchWarning(
  branchName: string,
  relation: RefRelation,
  remote = 'origin'
): string | undefined {
  if (relation !== 'diverged') return undefined;
  return (
    `'${branchName}' and '${remote}/${branchName}' have diverged. The session uses the ` +
    `local branch as-is; reconcile them before pushing.`
  );
}
