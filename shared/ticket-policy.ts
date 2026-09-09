/**
 * Ticket-required commit policy (Epic M / story M3).
 *
 * Pre-commit gate: when the policy is enabled for a repo, the commit must
 * either reference a ticket id in its message OR carry an explicit override
 * (with reason) that gets recorded in commit metadata for audit.
 *
 * Policy state is per-repo and stored alongside the repo's other settings.
 * This module is the rule — the service layer reads/writes the flag and
 * surfaces the result to the renderer.
 */

import { extractTicketId, messageHasTicketPrefix } from './ticket-id';

export interface TicketPolicyConfig {
  /** Master switch — when false, the policy is a no-op. */
  enabled: boolean;
  /** Custom regex for the extractor (string form, compiled by caller). */
  regexSource?: string;
}

export interface TicketPolicyInputs {
  message: string;
  /** Branch the commit will land on; used as a fallback ticket source. */
  branchName: string;
  policy: TicketPolicyConfig;
  /** True when the user has explicitly chosen to bypass the policy. */
  override?: boolean;
  /** Free-text reason the user must supply when override === true. */
  overrideReason?: string;
}

export type TicketPolicyDecisionKind =
  | 'allowed-policy-disabled'
  | 'allowed-ticket-in-message'
  | 'allowed-ticket-in-branch'
  | 'allowed-override'
  | 'blocked-no-ticket'
  | 'blocked-override-without-reason';

export interface TicketPolicyDecision {
  allowed: boolean;
  kind: TicketPolicyDecisionKind;
  /** The ticket id resolved (if any), useful for the auto-prepend flow. */
  ticketId?: string;
  /** Override metadata to record on the commit if allowed via override. */
  overrideMetadata?: { reason: string };
  message?: string;
}

export const TICKET_POLICY_ERRORS = {
  NO_TICKET: 'TICKET_POLICY_NO_TICKET',
  OVERRIDE_NEEDS_REASON: 'TICKET_POLICY_OVERRIDE_NEEDS_REASON',
} as const;

export function evaluateTicketPolicy(input: TicketPolicyInputs): TicketPolicyDecision {
  if (!input.policy.enabled) {
    return { allowed: true, kind: 'allowed-policy-disabled' };
  }

  const regex = input.policy.regexSource ? new RegExp(input.policy.regexSource) : undefined;
  const opts = regex ? { regex } : undefined;

  // 1) Message already contains a ticket prefix or extractable id?
  const fromMessage =
    extractTicketId(input.message, opts) ??
    (messageHasTicketPrefix(input.message) ? extractTicketId(input.message) : null);
  if (fromMessage) {
    return { allowed: true, kind: 'allowed-ticket-in-message', ticketId: fromMessage };
  }

  // 2) Override requested?
  if (input.override) {
    const reason = (input.overrideReason ?? '').trim();
    if (!reason) {
      return {
        allowed: false,
        kind: 'blocked-override-without-reason',
        message:
          'Override requires a non-empty reason — explain why this commit cannot reference a ticket.',
      };
    }
    return {
      allowed: true,
      kind: 'allowed-override',
      overrideMetadata: { reason },
    };
  }

  // 3) Ticket id derivable from the branch name?
  const fromBranch = extractTicketId(input.branchName, opts);
  if (fromBranch) {
    return { allowed: true, kind: 'allowed-ticket-in-branch', ticketId: fromBranch };
  }

  // 4) Block.
  return {
    allowed: false,
    kind: 'blocked-no-ticket',
    message:
      'Ticket policy requires a ticket reference. Add e.g. `[PROJ-123]` to your commit ' +
      'message, rename the branch to include the ticket id, or override (with reason).',
  };
}
