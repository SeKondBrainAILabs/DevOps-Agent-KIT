/**
 * Who may close whose session (story KIT-MCP-M2).
 *
 * Pure, so the matrix can be exhaustively tested. This is the guard that stops
 * an agent tearing down a human's work, so it is the last place that should
 * live inline inside an electron service nothing can import.
 */

export type SessionOrigin = 'ui' | 'mcp' | 'adopted';

export const NOT_PERMITTED_CODE = 'NOT_PERMITTED';

export interface ClosePermissionInput {
  /** The session being closed. */
  target: {
    sessionId: string;
    createdBy?: SessionOrigin;
  };
  /** The session doing the closing. Absent when the caller did not identify itself. */
  callerSessionId?: string;
  /**
   * Every session id in the caller's descendant subtree, alias-expanded.
   * Membership here is what makes "close what you spawned" work across a
   * restart, which re-ids the parent.
   */
  callerDescendantIds?: string[];
  /** Explicit opt-in to closing something the caller did not start. */
  allowForeign?: boolean;
  /** Whether the request would delete a worktree or a branch. */
  destructive?: boolean;
}

export interface ClosePermissionResult {
  allowed: boolean;
  error?: { code: string; message: string; instruction?: string };
}

const ALLOWED: ClosePermissionResult = { allowed: true };

function deny(message: string, instruction?: string): ClosePermissionResult {
  return { allowed: false, error: { code: NOT_PERMITTED_CODE, message, instruction } };
}

/**
 * Decide whether a close may proceed.
 *
 * The matrix:
 *
 *   caller itself                      → always
 *   descendant of the caller           → always
 *   another 'mcp' session              → only with allowForeign
 *   'adopted' session                  → safe close yes, destructive NEVER
 *   'ui' session, or createdBy absent  → NEVER, whatever allowForeign says
 *
 * Two fail-safes worth stating explicitly.
 *
 * An ABSENT `createdBy` is treated as 'ui'. Records written before the field
 * existed belong to humans, and an upgrade must not hand agents the power to
 * close them.
 *
 * An ADOPTED session is one an agent bound to a branch a human already had.
 * Letting the adopter then destroy that worktree would make `kit_adopt_session`
 * a way around the whole rule, so adoption grants management, never demolition.
 */
export function evaluateClosePermission(
  input: ClosePermissionInput
): ClosePermissionResult {
  const { target, callerSessionId, callerDescendantIds = [], allowForeign, destructive } =
    input;
  const origin: SessionOrigin = target.createdBy ?? 'ui';

  const isSelf = Boolean(callerSessionId) && callerSessionId === target.sessionId;
  const isDescendant = callerDescendantIds.includes(target.sessionId);

  if (isSelf || isDescendant) {
    // A caller may always close itself or something it spawned — including
    // destructively, since it owns the work.
    return ALLOWED;
  }

  if (origin === 'ui') {
    return deny(
      `Session ${target.sessionId} was created from the KIT UI (or predates session ` +
        'origin tracking) and cannot be closed by an agent.',
      'Ask the user to close this session from the KIT app.'
    );
  }

  if (origin === 'adopted') {
    if (destructive) {
      return deny(
        `Session ${target.sessionId} was adopted from an existing branch, so its ` +
          'worktree and branch may belong to a human. An agent may close it but not ' +
          'delete its work.',
        'Retry without delete_worktree / delete_local_branch / delete_remote_branch, ' +
          'or ask the user to delete it from the KIT app.'
      );
    }
    return ALLOWED;
  }

  // origin === 'mcp', and not ours.
  if (!allowForeign) {
    // An UNIDENTIFIED caller is the common case here, and it is not the same
    // situation as one agent reaching for another's session. Found in the real
    // app: kit_close_sessions(parent_session_id=<self>) — the exact call the
    // tool description recommends — matched its children and then refused
    // every one of them, advising allow_foreign. That advice would have had
    // the caller assert it was closing someone else's sessions in order to
    // close its own. Name the missing parameter instead.
    if (!callerSessionId) {
      return deny(
        `Session ${target.sessionId} was created by an agent, and you did not ` +
          'say which session you are.',
        'Pass caller_session_id with your own session id. You may always close ' +
          'yourself and anything you spawned. Only use allow_foreign if you ' +
          "genuinely mean to close a session you did not create."
      );
    }
    return deny(
      `Session ${target.sessionId} was created by a different agent.`,
      'Pass allow_foreign: true if you genuinely intend to close another ' +
        "agent's session."
    );
  }

  return ALLOWED;
}
