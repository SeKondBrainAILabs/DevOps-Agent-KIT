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
