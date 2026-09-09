/**
 * Active vs. inactive predicate for AgentInstance status.
 *
 * The runtime status field accepts more values than the `InstanceStatus` type
 * lists (e.g. 'completed', 'closed', 'failed', 'running'). This helper is the
 * single source of truth for "is this session still alive?".
 *
 * Used by:
 *  - `AgentInstanceService.recalculateRepoAgentCounts` (R1 fix — repo picker
 *    must count only active sessions)
 *  - `AgentInstanceService.getActiveSessionsForRepo` (C5 — Single-Session Mode)
 *
 * Statuses considered INACTIVE:
 *  - 'completed' — agent finished work
 *  - 'closed'    — user closed the session
 *  - 'failed'    — terminal failure
 *
 * Everything else (pending / initializing / waiting / active / running / error)
 * is treated as active. `error` is intentionally active so the picker still
 * surfaces it — the user needs to take action.
 */

import type { AgentInstance } from './types';

export const INACTIVE_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'closed',
  'failed',
]);

export function isActiveInstance(instance: Pick<AgentInstance, 'status'>): boolean {
  return !INACTIVE_INSTANCE_STATUSES.has(instance.status as string);
}

export function isActiveStatus(status: string): boolean {
  return !INACTIVE_INSTANCE_STATUSES.has(status);
}

/**
 * Stricter "is there actually an agent working on this session right now?"
 * predicate, distinct from `isActiveInstance` (which is lifecycle-broad).
 *
 * The Single-Session Mode guard wants the broad predicate — a `waiting`
 * session has claimed the slot and a second one would conflict. But the
 * repo-card "N active" badge needs the narrow predicate — `waiting` means
 * the prompt was generated and the agent never connected, and counting
 * such ghosts gives the wrong number (e.g. agent_memory_vault showing
 * "6 active" when only one had an actual agent attached).
 *
 * Inactive (no agent):
 *  - 'completed' / 'closed' / 'failed' — terminal
 *  - 'waiting' — prompt copied, MCP never registered the connection
 *  - 'pending' / 'initializing' — pre-boot
 *
 * Active (agent attached): anything else — 'idle', 'active', 'running', 'error'.
 * `error` stays running because the agent is alive but failed something.
 */
export const NON_RUNNING_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  ...INACTIVE_INSTANCE_STATUSES,
  'waiting',
  'pending',
  'initializing',
]);

export function isRunningInstance(instance: Pick<AgentInstance, 'status'>): boolean {
  return !NON_RUNNING_INSTANCE_STATUSES.has(instance.status as string);
}
