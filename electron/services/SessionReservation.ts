/**
 * Session reservation — the admission decision and the slot claim, held
 * together under one lock (story KIT-MCP-G1).
 *
 * ## The race
 *
 * `createInstance` reads the instance map to run its guards and writes it to
 * claim the slot, with `await`s in between (`validateRepository`,
 * `initializeKanvasDirectory`) that yield the event loop. Two concurrent
 * creates both pass the guards and both create. Node being single-threaded is
 * not protection here: the yield points are exactly where the interleave
 * happens.
 *
 * That was survivable while sessions were created by a human clicking a
 * button. MCP fan-out makes concurrent creation the normal case.
 *
 * ## Why it is its own module
 *
 * jest cannot import `AgentInstanceService` — `electron-store` is ESM and
 * untransformed. Leaving this inline would leave the most
 * concurrency-sensitive code in the epic untestable, on the critical path for
 * every session the app creates. Injected dependencies, no electron imports,
 * same shape as `SessionOrchestrator`.
 *
 * ## What is inside the lock, and what is not
 *
 * Inside: branch-in-use, admission, id generation, and the reservation itself.
 * All synchronous — a few map reads and one store write, microseconds.
 *
 * Outside: repository validation, `.S9N_KIT_DevOpsAgent` initialisation,
 * worktree creation, agent environment setup. Those are the slow parts, and an
 * eight-way fan-out must not serialise on them.
 */

import { KeyedMutex } from '../../shared/async-mutex';
import { isActiveInstance } from '../../shared/instance-status';
import {
  evaluateSessionAdmission,
  type ActiveSessionSummary,
  type SessionLimits,
} from '../../shared/session-admission';
import type {
  AgentInstance,
  AgentInstanceConfig,
  IpcResult,
  WorktreeMode,
} from '../../shared/types';

/**
 * Single key for the whole admission section.
 *
 * Per-repo keys were considered and rejected: the section is synchronous and
 * microsecond-scale, so per-key concurrency buys nothing, while a global key
 * removes any chance of a cross-repo interleave in the global cap check. The
 * expensive per-repo serialisation that DOES matter — `git worktree add`
 * contending on `.git/config.lock` — is a separate key held by the caller.
 */
export const ADMISSION_LOCK_KEY = 'session-admission';

export interface ReservationDeps {
  mutex: KeyedMutex;
  /** Every known instance, live or terminal. */
  listInstances(): AgentInstance[];
  /** Claim the slot: add to the map and persist. Must be synchronous. */
  reserve(instance: AgentInstance): void;
  getWorktreeMode(repoPath: string): WorktreeMode;
  getLimits(): SessionLimits;
}

export interface ReservationOptions {
  /**
   * A restart re-creates an existing session rather than adding a new one, so
   * it is exempt from the caps and the kill switch. It is NOT exempt from
   * branch-in-use — that exemption would be about correctness, not capacity.
   */
  isRestart?: boolean;
}

export interface Reservation {
  id: string;
  sessionId: string;
}

/** Distinguishes ids minted in the same millisecond under fan-out. */
let sequence = 0;

function mintIds(): Reservation {
  const stamp = Date.now();
  const seq = (sequence = (sequence + 1) % 1_000_000);
  const rand = Math.random().toString(36).slice(2, 11);
  return {
    id: `inst_${stamp}_${seq}${rand}`,
    sessionId: `sess_${stamp}_${seq}${rand}`,
  };
}

function summarise(instances: AgentInstance[]): ActiveSessionSummary[] {
  return instances.map((inst) => ({
    session_id: inst.sessionId ?? inst.id,
    branch: inst.config?.branchName,
    status: inst.status as string,
    isolation: (inst.config as { isolation?: string })?.isolation ?? 'worktree',
  }));
}

/**
 * Decide whether a session may be created and, if so, claim its slot —
 * atomically with respect to any other concurrent reservation.
 *
 * Returns the minted ids on success. The caller does everything else
 * (instructions, worktree, agent environment) OUTSIDE the lock.
 */
export async function reserveSession(
  deps: ReservationDeps,
  config: AgentInstanceConfig,
  opts: ReservationOptions = {}
): Promise<IpcResult<Reservation>> {
  return deps.mutex.runExclusive(ADMISSION_LOCK_KEY, () => {
    const instances = deps.listInstances();

    // 1. Branch in use — applies to restarts too.
    const clash = instances.find(
      (inst) =>
        inst.config?.branchName === config.branchName &&
        inst.config?.repoPath === config.repoPath &&
        isActiveInstance(inst)
    );
    if (clash) {
      return {
        success: false as const,
        error: {
          code: 'BRANCH_IN_USE',
          message:
            `Branch "${config.branchName}" is already in use by an active session. ` +
            'Please use a different branch name.',
        },
      };
    }

    // 2. Admission. A restart is exempt from the capacity rules but still
    //    subject to single-session mode, which is about the checkout rather
    //    than the budget — so it is evaluated as a UI-origin session.
    const createdBy = opts.isRestart
      ? 'ui'
      : ((config as { createdBy?: 'ui' | 'mcp' | 'adopted' }).createdBy ?? 'ui');

    const activeInRepo = instances.filter(
      (i) => i.config?.repoPath === config.repoPath && isActiveInstance(i)
    );
    const activeMcp = instances.filter(
      (i) =>
        (i.config as { createdBy?: string })?.createdBy === 'mcp' && isActiveInstance(i)
    );
    const activeMcpInRepo = activeMcp.filter(
      (i) => i.config?.repoPath === config.repoPath
    );

    const verdict = evaluateSessionAdmission({
      createdBy,
      worktreeMode: deps.getWorktreeMode(config.repoPath),
      activeCountForRepo: activeInRepo.length,
      activeMcpCountGlobal: activeMcp.length,
      activeMcpCountForRepo: activeMcpInRepo.length,
      limits: deps.getLimits(),
      activeSessions: summarise(activeMcp),
    });

    if (verdict.blocked && verdict.error) {
      return { success: false as const, error: verdict.error };
    }

    // 3. Claim the slot. Still inside the lock — this is the half that makes
    //    the checks above mean anything.
    const ids = mintIds();
    deps.reserve({
      id: ids.id,
      config,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      sessionId: ids.sessionId,
    } as AgentInstance);

    return { success: true as const, data: ids };
  });
}
