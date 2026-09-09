/**
 * Session Admission Guard (story KIT-MCP-G3)
 *
 * The pure decision "may this session be created?", consulted from inside
 * `createInstance`'s critical section so that the check and the reservation
 * cannot be interleaved by a concurrent create (G1).
 *
 * Four rules, cheapest and most absolute first:
 *
 *   1. kill switch          — MCP only
 *   2. global cap           — MCP only
 *   3. per-repo cap         — MCP only
 *   4. single-session guard — everyone
 *
 * The first three gate agent-created sessions only. A human creating a session
 * from the UI is not subject to the agent budget: those caps exist to stop an
 * orchestrator melting the machine, not to limit the user. The single-session
 * guard applies to everyone, because it protects the repo checkout regardless
 * of who asked.
 *
 * Extracted rather than inlined for the same reason
 * `shared/single-session-guard.ts` was — `AgentInstanceService` depends on
 * electron-store and cannot be unit-tested directly.
 */

import type { WorktreeMode } from './types';
import {
  evaluateSingleSessionGuard,
  SINGLE_SESSION_MODE_MESSAGE,
} from './single-session-guard';

export const SESSION_LIMIT_ERROR_CODE = 'SESSION_LIMIT_REACHED';
export const AGENT_SESSION_CREATION_DISABLED_CODE =
  'AGENT_SESSION_CREATION_DISABLED';

/** Who asked for the session. Absent is treated as 'ui' — see below. */
export type SessionOrigin = 'ui' | 'mcp' | 'adopted';

export interface SessionLimits {
  /** Master switch for agent-initiated session creation. */
  enabled: boolean;
  /** Max concurrent MCP-created sessions across every repo. */
  maxConcurrentGlobal: number;
  /** Max concurrent MCP-created sessions in one repo. */
  maxConcurrentPerRepo: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  enabled: true,
  maxConcurrentGlobal: 8,
  maxConcurrentPerRepo: 4,
};

/**
 * Keys in the `settings` table.
 *
 * These live in the database rather than ConfigService because they are global
 * machine-protection limits, not per-repo workspace preferences — and because
 * `getSetting` is already exposed to the MCP layer, so tools can read them
 * without new plumbing. `setSetting` deliberately is NOT exposed there: an
 * agent must not be able to raise its own cap.
 */
export const SESSION_LIMIT_SETTING_KEYS = {
  enabled: 'mcp.session_create.enabled',
  maxConcurrentGlobal: 'mcp.session_create.max_concurrent_global',
  maxConcurrentPerRepo: 'mcp.session_create.max_concurrent_per_repo',
  allowRemoteBranchDelete: 'mcp.session_close.allow_remote_branch_delete',
  nodeModulesStrategy: 'worktree.node_modules_strategy',
} as const;

type SettingReader = (key: string, defaultValue?: unknown) => unknown;

/**
 * Coerce a persisted cap, falling back to the default for anything that is not
 * a usable positive integer.
 *
 * The conservative direction matters: a corrupt or zero value must not be read
 * as "no limit". Settings round-trip through JSON and are user-editable, so
 * NaN, 0, negatives and non-numbers are all reachable.
 */
function readCap(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Settings round-trip through JSON, so a boolean can arrive as a string. */
function readFlag(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/**
 * Build the limits from persisted settings, defaulting per key.
 *
 * Per-key defaulting is what makes the upgrade path work: an install that has
 * only ever toggled the switch has no cap keys at all, and those must come back
 * as the documented defaults rather than undefined.
 */
export function readSessionLimits(get: SettingReader): SessionLimits {
  return {
    enabled: readFlag(
      get(SESSION_LIMIT_SETTING_KEYS.enabled, DEFAULT_SESSION_LIMITS.enabled),
      DEFAULT_SESSION_LIMITS.enabled
    ),
    maxConcurrentGlobal: readCap(
      get(
        SESSION_LIMIT_SETTING_KEYS.maxConcurrentGlobal,
        DEFAULT_SESSION_LIMITS.maxConcurrentGlobal
      ),
      DEFAULT_SESSION_LIMITS.maxConcurrentGlobal
    ),
    maxConcurrentPerRepo: readCap(
      get(
        SESSION_LIMIT_SETTING_KEYS.maxConcurrentPerRepo,
        DEFAULT_SESSION_LIMITS.maxConcurrentPerRepo
      ),
      DEFAULT_SESSION_LIMITS.maxConcurrentPerRepo
    ),
  };
}

/** Enough about a live session for an agent to decide which to close. */
export interface ActiveSessionSummary {
  session_id: string;
  branch?: string;
  status?: string;
  idle_minutes?: number;
  isolation?: string;
}

export interface SessionAdmissionInput {
  createdBy?: SessionOrigin;
  worktreeMode: WorktreeMode;
  /**
   * Lifecycle-active sessions in the target repo, counted with
   * `isActiveInstance` — the broad predicate, which includes `waiting`.
   * Feeds the single-session guard.
   */
  activeCountForRepo: number;
  /** Lifecycle-active MCP-created sessions across all repos. */
  activeMcpCountGlobal: number;
  /** Lifecycle-active MCP-created sessions in the target repo. */
  activeMcpCountForRepo: number;
  limits: SessionLimits;
  /** Optional, for the self-remediation payload on a cap refusal. */
  activeSessions?: ActiveSessionSummary[];
}

export interface SessionAdmissionResult {
  blocked: boolean;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    /** What the caller should do instead. Agents act on this. */
    instruction?: string;
  };
}

const ADMITTED: SessionAdmissionResult = { blocked: false };

/**
 * Decide whether a session may be created.
 *
 * NOTE ON THE COUNTS: callers must pass counts derived from `isActiveInstance`
 * (which includes `waiting`), not `isRunningInstance`. Every MCP session starts
 * `waiting` and stays there until its subagent's first tool call, which may
 * never come — counting only "running" sessions would let an orchestrator
 * create hundreds. `shared/instance-status.ts` documents the same reasoning for
 * the single-session guard: a waiting session has already claimed the slot.
 *
 * The cost of that choice is that a crashed fan-out can hold the whole budget
 * with sessions nothing is attached to. That is why a cap refusal carries
 * `active_sessions` — so the orchestrator can close its own oldest rather than
 * retry-loop into the same wall.
 */
export function evaluateSessionAdmission(
  input: SessionAdmissionInput
): SessionAdmissionResult {
  // Absent origin means a record written before this field existed, i.e. a
  // human's session. Defaulting to 'ui' keeps legacy sessions out of the agent
  // budget entirely — the same fail-safe direction used for close permissions.
  const createdBy: SessionOrigin = input.createdBy ?? 'ui';
  const isAgentCreated = createdBy === 'mcp';

  if (isAgentCreated) {
    if (!input.limits.enabled) {
      return {
        blocked: true,
        error: {
          code: AGENT_SESSION_CREATION_DISABLED_CODE,
          message:
            'Agent-created KIT sessions are disabled. The user has turned this off.',
          instruction:
            'The user has disabled agent-created KIT sessions in KIT → Settings → MCP. ' +
            'Ask them to enable it, then retry. Do NOT retry automatically.',
        },
      };
    }

    const capped = evaluateCaps(input);
    if (capped) return capped;
  }

  const single = evaluateSingleSessionGuard(
    input.worktreeMode,
    input.activeCountForRepo
  );
  if (single.blocked) {
    return {
      blocked: true,
      error: {
        code: single.error!.code,
        message: single.error?.message ?? SINGLE_SESSION_MODE_MESSAGE,
        details: { worktreeMode: input.worktreeMode, activeCountForRepo: input.activeCountForRepo },
        // Observers never write, so they are not what in-place mode is
        // protecting against — worth telling an agent, since it is the only
        // route through. Meaningless advice for a human in the UI, so it is
        // only offered to the caller who can act on it.
        ...(isAgentCreated
          ? {
              instruction:
                'Close the active session with kit_close_session, or create an ' +
                "isolation:'observer' session to inspect this repo read-only.",
            }
          : {}),
      },
    };
  }

  return ADMITTED;
}

/** Global cap first — it is the machine-protection one. */
function evaluateCaps(input: SessionAdmissionInput): SessionAdmissionResult | null {
  const checks: Array<{ scope: 'global' | 'repo'; current: number; limit: number }> = [
    {
      scope: 'global',
      current: input.activeMcpCountGlobal,
      limit: input.limits.maxConcurrentGlobal,
    },
    {
      scope: 'repo',
      current: input.activeMcpCountForRepo,
      limit: input.limits.maxConcurrentPerRepo,
    },
  ];

  for (const { scope, current, limit } of checks) {
    if (current >= limit) {
      return {
        blocked: true,
        error: {
          code: SESSION_LIMIT_ERROR_CODE,
          message:
            `Agent session limit reached (${scope}): ${current} of ${limit} in use.`,
          details: {
            scope,
            limit,
            current,
            active_sessions: input.activeSessions ?? [],
          },
          instruction:
            'Close a session with kit_close_session(session_id=...) before creating ' +
            'another. Do not retry in a loop. The user can raise the limit in ' +
            'KIT → Settings → MCP → Agent-created sessions.',
        },
      };
    }
  }

  return null;
}
