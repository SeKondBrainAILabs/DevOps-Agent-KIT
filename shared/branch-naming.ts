/**
 * Session branch naming and base-branch selection (story KIT-MCP-M1).
 *
 * Extracted from CreateAgentWizard so the MCP session tools derive branch
 * names the same way the wizard does. Two implementations would drift, and the
 * drift would be invisible: a session branch that does not match
 * `isSessionOrRemoteBranch` silently starts appearing in the base-branch
 * picker as a thing you can cut new work from.
 *
 * Both functions moved verbatim in behaviour. `pickDefaultBaseBranch` was
 * already pure — it takes a validation result, not renderer state — so this is
 * a move rather than a reimplementation.
 */

import type { AgentType } from './types';

/** Branches we prefer as a base, in order, when the current one is unusable. */
export const PRIMARY_BRANCHES = [
  'main',
  'master',
  'development',
  'develop',
  'dev',
] as const;

/**
 * Agent prefixes that mark a branch as belonging to a KIT session.
 *
 * `claude` was MISSING here before this epic, which meant Claude session
 * branches — by far the most common kind — were offered in the base-branch
 * picker as legitimate branches to cut new sessions from. Adding it is a
 * drive-by fix, not a new rule: every other agent was already listed.
 */
export const SESSION_BRANCH_AGENTS = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'aider',
  'warp',
  'cline',
] as const;

/**
 * The session branch shape: `<agentType>-session-<YYYYMMDD>-<rand4>`.
 *
 * Deliberately identical to what the wizard generates. There is no task slug
 * in it — an earlier draft of the spec claimed there was, but the wizard has
 * only ever produced type, date and a random suffix.
 */
export function generateSessionBranchName(
  agentType: AgentType | string,
  now: Date = new Date(),
  randomSuffix?: string
): string {
  const timestamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomSuffix ?? Math.random().toString(36).substring(2, 6);
  return `${agentType}-session-${timestamp}-${suffix}`;
}

/**
 * True for anything that must never be offered as a base branch: remotes,
 * detached-HEAD pseudo-entries, and other sessions' branches.
 */
export function isSessionOrRemoteBranch(branch: string): boolean {
  if (!branch) return false;
  if (branch.startsWith('origin/') || branch.startsWith('remotes/')) return true;
  // Detached-HEAD pseudo-entries ("(HEAD detached at <tag>)") and the bare
  // "HEAD" sentinel are never valid base branches to commit onto.
  if (branch.startsWith('(') || branch.includes('HEAD detached') || branch === 'HEAD') {
    return true;
  }
  return SESSION_BRANCH_AGENTS.some((agent) => branch.startsWith(`${agent}-session-`));
}

/**
 * Choose a sensible default base branch from a repo validation result.
 *
 * Never returns a detached-HEAD sentinel: prefers the current branch when it is
 * a real one, then the first known primary that exists, then any real branch,
 * then 'main'.
 *
 * This matters more for the MCP path than the UI one. The wizard shows the
 * user what it picked; an agent calling kit_start_session without a
 * base_branch just gets it, and a hard default of 'main' would cut sessions
 * off the wrong base in every repo that lives on 'development'.
 */
export function pickDefaultBaseBranch(validation: {
  currentBranch?: string;
  branches?: string[];
}): string {
  const current = validation.currentBranch;
  if (current && !isSessionOrRemoteBranch(current)) return current;

  const branches = validation.branches ?? [];
  const primary = PRIMARY_BRANCHES.find((b) => branches.includes(b));
  if (primary) return primary;

  const firstReal = branches.find((b) => !isSessionOrRemoteBranch(b));
  return firstReal ?? 'main';
}
