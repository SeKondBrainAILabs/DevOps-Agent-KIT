/**
 * Single-Session Mode Guard (Epic C / story C5)
 *
 * Pure helper that decides whether a new agent session should be blocked
 * because the target repo has worktrees disabled and an active session
 * already exists. Extracted to keep the rule independently testable from
 * AgentInstanceService (which depends on electron-store and is hard to
 * unit-test directly).
 */

import type { WorktreeMode } from './types';

export const SINGLE_SESSION_MODE_ERROR_CODE = 'SINGLE_SESSION_MODE_ACTIVE';
export const SINGLE_SESSION_MODE_MESSAGE =
  'Single-Session Mode is active for this repo (worktrees disabled). ' +
  'Close the current session or enable worktrees to run sessions in parallel.';

export interface SingleSessionGuardResult {
  blocked: boolean;
  error?: { code: string; message: string };
}

/**
 * Returns `{ blocked: true, error }` when:
 *   - the repo's worktree mode is 'in-place' (Single-Session Mode), AND
 *   - there is already at least one active session for the repo.
 *
 * Otherwise returns `{ blocked: false }`.
 */
export function evaluateSingleSessionGuard(
  mode: WorktreeMode,
  activeSessionCount: number
): SingleSessionGuardResult {
  if (mode === 'in-place' && activeSessionCount > 0) {
    return {
      blocked: true,
      error: {
        code: SINGLE_SESSION_MODE_ERROR_CODE,
        message: SINGLE_SESSION_MODE_MESSAGE,
      },
    };
  }
  return { blocked: false };
}
