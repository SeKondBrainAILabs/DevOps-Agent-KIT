/**
 * Worktree creation outcome (story KIT-MCP-A1).
 *
 * `createWorktreeIfNeeded` used to return a bare path and silently fall back to
 * the source repo on ANY failure. For a human clicking "new session" that is a
 * survivable annoyance — the agent works in the real checkout instead of a
 * worktree, and the user notices. For a twenty-way agent fan-out it means
 * twenty agents writing into the user's actual repository at once, which is
 * the worst outcome this epic can produce.
 *
 * So the outcome is now explicit, and what it means depends on who asked.
 */

export type WorktreeStatus =
  /** A new worktree was created. */
  | 'created'
  /** An existing worktree at the current layout was adopted. */
  | 'reused'
  /** An existing worktree at the pre-v2.6.54 `local_deploy/` layout was adopted. */
  | 'legacy'
  /** The session has no worktree of its own — it borrows another path. */
  | 'observer'
  /** Creation failed; the session would run in the source repo. */
  | 'failed';

export type WorktreeOrigin = 'ui' | 'mcp' | 'adopted';

export interface WorktreeOutcomeVerdict {
  /** True when creation must be aborted and rolled back. */
  fatal: boolean;
  error?: { code: string; message: string };
}

export const WORKTREE_CREATE_FAILED_CODE = 'WORKTREE_CREATE_FAILED';

/**
 * Decide whether a worktree outcome should abort session creation.
 *
 * Only `failed` is ever fatal, and only for agent-created sessions:
 *
 *  - `mcp`     → FATAL. An orchestrator cannot see the fallback happen, and N
 *                agents landing in one checkout corrupt each other's work.
 *                Better to refuse loudly and let the agent report it.
 *  - `ui`      → not fatal. The existing degrade-and-continue behaviour is
 *                preserved so this story does not change the human path
 *                mid-epic — but the instance now records `worktreeStatus:
 *                'failed'` so the renderer can surface it. Before this, that
 *                state was completely invisible.
 *  - `adopted` → not fatal, for the same reason: a human is present.
 *
 * Every other status is a success.
 */
export function evaluateWorktreeOutcome(
  status: WorktreeStatus,
  createdBy: WorktreeOrigin | undefined,
  detail?: string
): WorktreeOutcomeVerdict {
  if (status !== 'failed') return { fatal: false };

  // Absent origin means a record written before the field existed, i.e. a
  // human's — same fail-safe default used everywhere else in this epic.
  if ((createdBy ?? 'ui') !== 'mcp') return { fatal: false };

  return {
    fatal: true,
    error: {
      code: WORKTREE_CREATE_FAILED_CODE,
      message:
        'Could not create an isolated worktree for this session' +
        (detail ? `: ${detail}` : '.') +
        ' Refusing rather than running the agent directly in the source ' +
        'repository, where concurrent sessions would overwrite each other.',
    },
  };
}
