/**
 * When KIT may commit on a session's behalf.
 *
 * An adopted session is somebody else's branch, often one with an open pull
 * request (KIT Harness adopts its own kept PR branch to revise it). A commit
 * KIT makes there on its own — the watcher's commit-message-file trigger, the
 * idle-end auto-checkpoint, the default commit before a restart — lands on
 * that PR without the owner asking. So adoption is auto-commit OFF unless the
 * caller passes auto_commit: true.
 *
 * Every other session keeps the behaviour it had: these helpers answer true
 * for it whatever its autoCommit says, so kit_start_session is unchanged.
 *
 * Pure, so the whole matrix is table-testable.
 */

export interface AutoCommitConfig {
  createdBy?: 'ui' | 'mcp' | 'adopted' | string;
  autoCommit?: boolean;
}

/** The autoCommit an adopted session is created with: on only when asked for. */
export function adoptedAutoCommit(requested: unknown): boolean {
  return requested === true;
}

/** May KIT make a commit the agent did not make through a kit_* tool? */
export function mayAutoCommit(config: AutoCommitConfig | null | undefined): boolean {
  if (config?.createdBy === 'adopted') return config.autoCommit === true;
  return true;
}

/**
 * Commit pending work before a restart? An explicit true or false from the
 * caller (kit_restart_session commit_changes, the restart dialog) is honoured
 * as given. Left unset — the app-launch restart, or a kit_restart_session call
 * without commit_changes — it is the auto-commit rule, so an adopted session
 * with auto-commit off is not committed to. Its checkout is reused by the
 * restart, so the uncommitted work stays in the worktree.
 */
export function commitOnRestart(
  requested: boolean | undefined,
  config: AutoCommitConfig | null | undefined
): boolean {
  return typeof requested === 'boolean' ? requested : mayAutoCommit(config);
}
