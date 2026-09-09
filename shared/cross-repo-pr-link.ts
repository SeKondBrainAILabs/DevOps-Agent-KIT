/**
 * Cross-repo PR linking by ticket (Epic F / story F5).
 *
 * When PRs across the repos in a Project Group reference the same ticket
 * id (extracted via D3), they're shown together in the PR list as a
 * single grouped row. This module is the pure grouping logic.
 */

import { extractTicketId } from './ticket-id';

export interface PrSummary {
  /** PR identifier (e.g. "owner/repo#123" or just an opaque id). */
  id: string;
  repoName: string;
  title: string;
  branchName: string;
  /** PR status — flowed straight through for the renderer. */
  status?: string;
}

export interface PrTicketGroup {
  ticketId: string;
  prs: PrSummary[];
}

/** Resolve the ticket id for a PR by checking title first, then branch name. */
export function ticketForPr(pr: PrSummary): string | null {
  return extractTicketId(pr.title) ?? extractTicketId(pr.branchName);
}

export interface GroupedPrResult {
  /** PRs that share a ticket id with at least one other PR (grouped). */
  groups: PrTicketGroup[];
  /** PRs with a ticket id but no peer (single-member groups omitted from `groups`). */
  singletons: PrSummary[];
  /** PRs with no detectable ticket id. */
  ungrouped: PrSummary[];
}

/** Group PRs by extracted ticket id. */
export function groupPrsByTicket(prs: ReadonlyArray<PrSummary>): GroupedPrResult {
  const byTicket = new Map<string, PrSummary[]>();
  const ungrouped: PrSummary[] = [];

  for (const pr of prs) {
    const ticket = ticketForPr(pr);
    if (!ticket) {
      ungrouped.push(pr);
      continue;
    }
    const arr = byTicket.get(ticket) ?? [];
    arr.push(pr);
    byTicket.set(ticket, arr);
  }

  const groups: PrTicketGroup[] = [];
  const singletons: PrSummary[] = [];
  for (const [ticketId, list] of byTicket) {
    if (list.length >= 2) {
      // Stable: sort by repoName then id for deterministic UI ordering.
      list.sort(
        (a, b) =>
          a.repoName.localeCompare(b.repoName) || a.id.localeCompare(b.id)
      );
      groups.push({ ticketId, prs: list });
    } else {
      singletons.push(list[0]);
    }
  }

  // Stable group output too.
  groups.sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  return { groups, singletons, ungrouped };
}
