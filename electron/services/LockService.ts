/**
 * Lock Service
 * Multi-agent file coordination and conflict detection
 * Supports auto-locking when agents modify files
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type {
  FileLock,
  AutoFileLock,
  FileConflict,
  RepoLockSummary,
  LockChangeEvent,
  AgentType,
  IpcResult,
} from '../../shared/types';
import type { PathProtection } from '../../shared/protected-paths';
import { isHolderGone, type HolderLiveness } from '../../shared/lock-liveness';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Store locks per repository in .S9N_KIT_DevOpsAgent/locks.json
const LOCKS_FILENAME = 'locks.json';
// Protected paths (KC-S3.1.2) live beside the locks, written on every change
// (not debounced) so a protection is on disk before kit_lock_file returns.
const PROTECTED_FILENAME = 'protected.json';
const KANVAS_DIR = '.S9N_KIT_DevOpsAgent';

// Default lock timeout: 24 hours of inactivity
const DEFAULT_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Session lock directory (matches SessionService)
const SESSION_LOCK_DIR = path.join(os.homedir(), '.devops-agent', 'session-locks');

// Stale session lock TTL: 1 hour (for crashed sessions)
const STALE_SESSION_LOCK_TTL_MS = 60 * 60 * 1000;

// Debounce window for the locks.json write. Auto-locking is triggered by every
// chokidar event, and a worktree-wide initial scan can fire thousands of events
// per second. Without debouncing, we re-stringify and re-write the entire map
// per event, exhausting the heap (RangeError: Array buffer allocation failed).
const SAVE_DEBOUNCE_MS = 500;

// Hard ceiling on locks tracked per repo. Beyond this, autoLockFile silently
// no-ops — the map is already too large to serialize cheaply and the locks are
// almost certainly stale-event noise rather than real edits.
const MAX_LOCKS_PER_REPO = 5000;

// How often the background sweep prunes stale locks from every loaded repo.
// The inactivity timeout is 24h, so hourly is frequent enough to matter and
// infrequent enough to be free. The sweep is what keeps a long-running app
// from accumulating locks whose sessions died without a clean teardown.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class LockService extends BaseService {
  // In-memory cache of locks: repoPath -> filePath -> lock
  private locksByRepo: Map<string, Map<string, AutoFileLock>> = new Map();

  // Pending debounced writes: repoPath -> setTimeout handle
  private pendingSaves: Map<string, NodeJS.Timeout> = new Map();
  private hasWarnedOverflow: Set<string> = new Set();

  // Protected paths per repo root (KC-S3.1.2): repoPath -> protections
  private protectionsByRepo: Map<string, PathProtection[]> = new Map();

  // Background prune of stale locks across every loaded repo.
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * Where is this session in its life: `live`, `superseded` or `unknown`?
   *
   * Injected by the service wiring (`setSessionLivenessProvider`) so this
   * service does not have to depend on AgentInstanceService. The default
   * reports every session `live`, which is the behaviour before any of this
   * was introduced — so an un-wired LockService (tests, any future embedder)
   * never discards a lock on liveness grounds.
   *
   * The three states and the policy over them live in
   * `shared/lock-liveness.ts`, which `electron/services/mcp/tools.ts` reads
   * too. That shared module is the only place either layer decides this.
   */
  private holderLiveness: (sessionId: string) => HolderLiveness = () => 'live';

  /**
   * Teach the service which sessions are still alive.
   *
   * A lock only means "this session is working on this file right now".
   * Once the owning session is gone that claim is false, and leaving the
   * record in place is actively harmful: `autoLockFile` treats a lock held by
   * another session as a conflict and refuses to write, so a dead session's
   * locks block every later session from locking those files, and
   * `checkConflicts` reports a holder that no longer exists — which since H6
   * is exactly what `kit_lock_file` hands back to the calling agent.
   *
   * A restart predecessor's leftovers are stealable at once, because
   * `recordPredecessor` mints a NEW sessionId and locks left under the old id
   * would otherwise block the very session that replaced it. An id nothing
   * recognises is different: that is missing information rather than evidence
   * of death, so it is only reclaimed once the lock has outlived
   * STALE_LOCK_GRACE_MS, which protects a session whose instance record has
   * not finished loading.
   */
  setSessionLivenessProvider(
    liveness: (sessionId: string) => HolderLiveness
  ): void {
    this.holderLiveness = liveness;
    console.log('[LockService] Session liveness provider configured');
  }

  /**
   * May this lock be taken from whoever holds it?
   *
   * The single question every path below asks, so the grace period and the
   * three-state policy cannot be applied inconsistently between them.
   */
  private isLockHolderGone(lock: AutoFileLock, now: number = Date.now()): boolean {
    return isHolderGone(
      this.holderLiveness(lock.sessionId),
      Date.parse(lock.lockedAt ?? ''),
      now
    );
  }

  async initialize(): Promise<void> {
    // Clean up stale session lock files from crashed sessions
    await this.cleanupStaleSessionLocks();
    this.startStaleLockSweep();
    console.log('[LockService] Initialized (stale lock cleanup complete)');
  }

  /**
   * Prune stale locks from every loaded repo, hourly.
   *
   * Load-time pruning (see `loadLocks`) only fires once per repo per process,
   * so without this a lock that goes stale while the app is open is never
   * reclaimed — and before this existed, `cleanupExpiredLocks` had no callers
   * at all, which meant locks orphaned by a crash lived in locks.json forever.
   */
  private startStaleLockSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      for (const repoPath of Array.from(this.locksByRepo.keys())) {
        void this.pruneStaleLocks(repoPath).catch((err) => {
          console.warn(`[LockService] Stale-lock sweep failed for ${repoPath}:`, err);
        });
      }
    }, SWEEP_INTERVAL_MS);
    // Don't hold the event loop open on this alone.
    this.sweepTimer.unref?.();
  }

  /**
   * Scan ~/.devops-agent/session-locks/ for stale .lock files from crashed sessions.
   * Removes locks that haven't been updated within the TTL threshold.
   */
  private async cleanupStaleSessionLocks(): Promise<void> {
    try {
      if (!existsSync(SESSION_LOCK_DIR)) return;

      const files = await fs.readdir(SESSION_LOCK_DIR);
      const lockFiles = files.filter((f) => f.endsWith('.lock'));
      if (lockFiles.length === 0) return;

      const now = Date.now();
      let cleaned = 0;

      for (const lockFile of lockFiles) {
        const lockPath = path.join(SESSION_LOCK_DIR, lockFile);
        try {
          const stat = await fs.stat(lockPath);
          const age = now - stat.mtimeMs;

          if (age > STALE_SESSION_LOCK_TTL_MS) {
            // Read lock to log what we're cleaning
            try {
              const content = await fs.readFile(lockPath, 'utf8');
              const lockData = JSON.parse(content);
              console.log(`[LockService] Removing stale session lock: ${lockFile} (session: ${lockData.sessionId || 'unknown'}, age: ${Math.round(age / 60000)}min)`);
            } catch {
              console.log(`[LockService] Removing stale session lock: ${lockFile} (age: ${Math.round(age / 60000)}min)`);
            }

            await fs.unlink(lockPath);
            cleaned++;
          }
        } catch (err) {
          console.warn(`[LockService] Could not check lock file ${lockFile}:`, err);
        }
      }

      if (cleaned > 0) {
        console.log(`[LockService] Cleaned up ${cleaned} stale session lock(s)`);
      }
    } catch (err) {
      console.warn('[LockService] Error during stale lock cleanup:', err);
    }
  }

  /**
   * Clean up git worktree lock files (.git/worktrees/<name>/locked) for stale worktrees.
   * Called during repo cleanup to remove git-internal locks blocking worktree operations.
   */
  async cleanupGitWorktreeLocks(repoPath: string): Promise<number> {
    try {
      const gitWorktreesDir = path.join(repoPath, '.git', 'worktrees');
      if (!existsSync(gitWorktreesDir)) return 0;

      const entries = await fs.readdir(gitWorktreesDir);
      let cleaned = 0;

      for (const entry of entries) {
        const lockFile = path.join(gitWorktreesDir, entry, 'locked');
        if (existsSync(lockFile)) {
          try {
            // Check if the worktree path still exists
            const gitdirPath = path.join(gitWorktreesDir, entry, 'gitdir');
            let worktreeExists = false;
            if (existsSync(gitdirPath)) {
              const worktreePath = (await fs.readFile(gitdirPath, 'utf8')).trim();
              const actualPath = path.resolve(path.dirname(gitdirPath), worktreePath, '..');
              worktreeExists = existsSync(actualPath);
            }

            if (!worktreeExists) {
              await fs.unlink(lockFile);
              cleaned++;
              console.log(`[LockService] Removed stale git worktree lock: ${entry}/locked`);
            }
          } catch {
            // Skip unreadable entries
          }
        }
      }

      if (cleaned > 0) {
        console.log(`[LockService] Cleaned ${cleaned} stale git worktree lock(s) in ${repoPath}`);
      }
      return cleaned;
    } catch {
      return 0;
    }
  }

  /**
   * Auto-lock a file when it's modified by an agent
   * Called by WatcherService when file changes are detected
   */
  async autoLockFile(
    repoPath: string,
    filePath: string,
    sessionId: string,
    agentType: AgentType,
    branchName?: string
  ): Promise<IpcResult<AutoFileLock | null>> {
    return this.wrap(async () => {
      // Normalize paths
      const normalizedRepo = path.resolve(repoPath);
      const relativePath = path.isAbsolute(filePath)
        ? path.relative(normalizedRepo, filePath)
        : filePath;

      // Skip lock files and system files
      if (this.shouldSkipFile(relativePath)) {
        return null;
      }

      // Cap the per-repo lock map. Beyond the ceiling, autoLockFile silently
      // no-ops — a runaway map almost always means we're tracking initial-scan
      // noise rather than real agent edits, and we'd rather drop locks than
      // exhaust the heap. The cleanupExpired path still trims the map as locks
      // age out, so this is a soft ceiling that rebalances on its own.
      const existing = this.locksByRepo.get(normalizedRepo);
      if (existing && existing.size >= MAX_LOCKS_PER_REPO && !existing.has(relativePath)) {
        if (!this.hasWarnedOverflow.has(normalizedRepo)) {
          this.hasWarnedOverflow.add(normalizedRepo);
          console.warn(
            `[LockService] Repo at ${normalizedRepo} hit MAX_LOCKS_PER_REPO=${MAX_LOCKS_PER_REPO}; dropping new auto-locks until cleanup`
          );
        }
        return null;
      }

      // Check for existing lock by another session
      let existingLock = await this.getFileLock(normalizedRepo, relativePath);

      if (
        existingLock &&
        existingLock.sessionId !== sessionId &&
        this.isLockHolderGone(existingLock)
      ) {
        // The holder is gone (closed, failed, or never came back from a crash
        // or a restart that re-ided the session). Reclaim rather than report a
        // conflict against a session that cannot release anything.
        this.releaseLock(normalizedRepo, relativePath, existingLock);
        console.log(
          `[LockService] Reclaimed ${relativePath} from dead session ${existingLock.sessionId}`
        );
        existingLock = null;
      }

      if (existingLock && existingLock.sessionId !== sessionId) {
        // Conflict detected!
        const conflict: FileConflict = {
          file: relativePath,
          conflictsWith: existingLock.agentType,
          session: existingLock.sessionId,
          reason: `File locked by ${existingLock.agentType} since ${existingLock.lockedAt}`,
          declaredAt: existingLock.lockedAt,
        };

        // Emit conflict event
        const event: LockChangeEvent = {
          type: 'conflict',
          lock: existingLock,
          conflictWith: existingLock,
        };
        this.emitToRenderer(IPC.CONFLICT_DETECTED, conflict);
        this.emitToRenderer(IPC.LOCK_CHANGED, event);

        console.log(`[LockService] Conflict: ${relativePath} locked by ${existingLock.sessionId}`);
        return existingLock; // Return existing lock (conflict)
      }

      // Create or update lock
      const now = new Date().toISOString();
      const lock: AutoFileLock = existingLock && existingLock.sessionId === sessionId
        ? { ...existingLock, lastModified: now }  // Update existing
        : {
            filePath: relativePath,
            sessionId,
            agentType,
            repoPath: normalizedRepo,
            lockedAt: now,
            lastModified: now,
            autoLocked: true,
            branchName,
          };

      // Store in memory
      this.setFileLock(normalizedRepo, relativePath, lock);

      // Persist to disk
      await this.saveLocks(normalizedRepo);

      // Emit lock acquired event
      const event: LockChangeEvent = {
        type: 'acquired',
        lock,
      };
      this.emitToRenderer(IPC.LOCK_CHANGED, event);

      console.log(`[LockService] Auto-locked: ${relativePath} for session ${sessionId}`);
      return lock;
    }, 'AUTO_LOCK_FAILED');
  }

  /**
   * Release all locks for a session (called when session closes)
   */
  async releaseSessionLocks(
    repoPath: string,
    sessionId: string
  ): Promise<IpcResult<number>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      const repoLocks = this.locksByRepo.get(normalizedRepo);

      if (!repoLocks) return 0;

      let released = 0;
      const toRelease: string[] = [];

      for (const [filePath, lock] of repoLocks) {
        if (lock.sessionId === sessionId) {
          toRelease.push(filePath);
        }
      }

      for (const filePath of toRelease) {
        const lock = repoLocks.get(filePath)!;
        repoLocks.delete(filePath);
        released++;

        // Emit release event
        const event: LockChangeEvent = {
          type: 'released',
          lock,
        };
        this.emitToRenderer(IPC.LOCK_CHANGED, event);
      }

      // Persist changes
      await this.saveLocks(normalizedRepo);

      console.log(`[LockService] Released ${released} locks for session ${sessionId}`);
      return released;
    }, 'RELEASE_SESSION_LOCKS_FAILED');
  }

  /**
   * Force release a specific file lock (admin action)
   */
  async forceReleaseLock(
    repoPath: string,
    filePath: string
  ): Promise<IpcResult<boolean>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      const relativePath = path.isAbsolute(filePath)
        ? path.relative(normalizedRepo, filePath)
        : filePath;

      const repoLocks = this.locksByRepo.get(normalizedRepo);
      if (!repoLocks) return false;

      const lock = repoLocks.get(relativePath);
      if (!lock) return false;

      repoLocks.delete(relativePath);
      await this.saveLocks(normalizedRepo);

      // Emit force release event
      const event: LockChangeEvent = {
        type: 'force-released',
        lock,
      };
      this.emitToRenderer(IPC.LOCK_CHANGED, event);

      console.log(`[LockService] Force released: ${relativePath}`);
      return true;
    }, 'FORCE_RELEASE_FAILED');
  }

  /**
   * Get all locks for a repository
   */
  async getRepoLocks(repoPath: string): Promise<IpcResult<RepoLockSummary>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);

      // Load from disk if not in memory
      await this.loadLocks(normalizedRepo);

      const repoLocks = this.locksByRepo.get(normalizedRepo) || new Map();
      const locksBySession: Record<string, string[]> = {};

      for (const [filePath, lock] of repoLocks) {
        if (!locksBySession[lock.sessionId]) {
          locksBySession[lock.sessionId] = [];
        }
        locksBySession[lock.sessionId].push(filePath);
      }

      return {
        repoPath: normalizedRepo,
        totalLocks: repoLocks.size,
        locksBySession,
        conflicts: [], // Conflicts are detected in real-time
      };
    }, 'GET_REPO_LOCKS_FAILED');
  }

  /**
   * Check if files have conflicts before starting work
   */
  async checkConflicts(
    repoPath: string,
    files: string[],
    excludeSessionId?: string
  ): Promise<IpcResult<FileConflict[]>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      await this.loadLocks(normalizedRepo);

      const conflicts: FileConflict[] = [];
      const repoLocks = this.locksByRepo.get(normalizedRepo) || new Map();

      for (const file of files) {
        const relativePath = path.isAbsolute(file)
          ? path.relative(normalizedRepo, file)
          : file;

        const lock = repoLocks.get(relativePath);
        // A lock whose session is gone is not a conflict — it is debris the
        // next write reclaims (autoLockFile) or the sweep prunes. Reporting it
        // would have kit_lock_file refuse on behalf of a dead session.
        if (
          lock &&
          lock.sessionId !== excludeSessionId &&
          !this.isLockHolderGone(lock)
        ) {
          conflicts.push({
            file: relativePath,
            conflictsWith: lock.agentType,
            session: lock.sessionId,
            reason: `File locked by ${lock.agentType} since ${lock.lockedAt}`,
            declaredAt: lock.lockedAt,
          });
        }
      }

      return conflicts;
    }, 'CHECK_CONFLICTS_FAILED');
  }

  /**
   * Get lock for a specific file
   */
  async getFileLock(
    repoPath: string,
    filePath: string
  ): Promise<AutoFileLock | null> {
    const normalizedRepo = path.resolve(repoPath);
    await this.loadLocks(normalizedRepo);

    const repoLocks = this.locksByRepo.get(normalizedRepo);
    if (!repoLocks) return null;

    const relativePath = path.isAbsolute(filePath)
      ? path.relative(normalizedRepo, filePath)
      : filePath;

    return repoLocks.get(relativePath) || null;
  }

  /**
   * Clean up stale locks for one repo: expired by inactivity, or held by a
   * session that no longer exists.
   *
   * Callers: `loadLocks` (once per repo, when it first reads locks.json off
   * disk), the hourly sweep, and anyone who wants an explicit pass. Before
   * this was wired up the method existed but nothing called it, so locks
   * orphaned by a crash stayed in locks.json indefinitely and blocked every
   * later session from locking those files.
   */
  async cleanupExpiredLocks(
    repoPath: string,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
  ): Promise<IpcResult<number>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      await this.loadLocks(normalizedRepo);
      return this.pruneStaleLocks(normalizedRepo, timeoutMs);
    }, 'CLEANUP_LOCKS_FAILED');
  }

  /**
   * Drop every stale lock for an ALREADY-LOADED repo and report how many went.
   *
   * Deliberately does not call `loadLocks`: `loadLocks` calls this, and the
   * public `cleanupExpiredLocks` loads first, so keeping the load out of here
   * is what keeps those two from recursing.
   *
   * Applies to declared locks as well as auto-locks, because since H6 both
   * live in this map. A declaration's `lastModified` is set once and never
   * refreshed, so it expires 24h after it was made rather than 24h after the
   * last edit. Its own `estimatedDuration` is NOT used as the expiry — that
   * would default a declaration to 30 minutes and is a behaviour change for
   * kit_lock_file callers, not a cleanup.
   */
  private async pruneStaleLocks(
    repoPath: string,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
  ): Promise<number> {
    const repoLocks = this.locksByRepo.get(repoPath);
    if (!repoLocks || repoLocks.size === 0) return 0;

    const now = Date.now();
    const toRemove: string[] = [];

    for (const [filePath, lock] of repoLocks) {
      const lastModified = new Date(lock.lastModified).getTime();
      // An unparseable timestamp (hand-edited or truncated locks.json) reads
      // as NaN, and every comparison against it is false — which would pin
      // the lock forever. Treat it as expired instead.
      const expired = Number.isNaN(lastModified) || now - lastModified > timeoutMs;
      if (expired || this.isLockHolderGone(lock, now)) {
        toRemove.push(filePath);
      }
    }

    for (const filePath of toRemove) {
      const lock = repoLocks.get(filePath)!;
      this.releaseLock(repoPath, filePath, lock);
    }

    if (toRemove.length > 0) {
      await this.saveLocks(repoPath);
      console.log(`[LockService] Pruned ${toRemove.length} stale lock(s) in ${repoPath}`);
    }

    return toRemove.length;
  }

  /**
   * Forget one lock and tell the renderer. Shared by the two stale-lock
   * reclaim paths (sweep/prune and autoLockFile) so they cannot drift on
   * which event they emit.
   */
  private releaseLock(repoPath: string, filePath: string, lock: AutoFileLock): void {
    this.locksByRepo.get(repoPath)?.delete(filePath);
    const event: LockChangeEvent = { type: 'released', lock };
    this.emitToRenderer(IPC.LOCK_CHANGED, event);
  }

  // ==================== Legacy API (backwards compatibility) ====================

  /**
   * Declare an intent to edit files, so other sessions see the conflict.
   *
   * THIS USED TO DO NOTHING OBSERVABLE (story KIT-MCP-H6). It wrote a FileLock
   * into an in-memory `sessionLocks` map that `checkConflicts` never read —
   * `checkConflicts` reads `locksByRepo`, loaded from
   * `<repo>/.S9N_KIT_DevOpsAgent/locks.json`. The two stores never intersected,
   * so cross-session locking was a complete no-op: `kit_lock_file` always
   * reported "no conflicts" no matter who else held the file.
   *
   * It now writes into the same repo-keyed, persisted store the watcher's
   * auto-locks use, which is the only store anything reads.
   *
   * `repoPath` must be the SOURCE REPO ROOT, not a worktree. The watcher keys
   * its auto-locks by repo root, so a worktree-keyed declaration would land in
   * a second file that nothing consults — the same class of bug this fixes.
   */
  async declareFiles(
    repoPath: string,
    sessionId: string,
    files: string[],
    operation: 'edit' | 'read' | 'delete',
    agentType: AgentType = 'custom',
    estimatedDuration: number = 30,
    reason?: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      await this.loadLocks(normalizedRepo);

      let repoLocks = this.locksByRepo.get(normalizedRepo);
      if (!repoLocks) {
        repoLocks = new Map();
        this.locksByRepo.set(normalizedRepo, repoLocks);
      }

      const now = new Date().toISOString();
      for (const file of files) {
        const relativePath = path.isAbsolute(file)
          ? path.relative(normalizedRepo, file)
          : file;
        repoLocks.set(relativePath, {
          filePath: relativePath,
          sessionId,
          agentType,
          repoPath: normalizedRepo,
          lockedAt: now,
          lastModified: now,
          autoLocked: false,
          declared: true,
          operation,
          reason,
          estimatedDuration,
        });
      }

      await this.saveLocks(normalizedRepo);
    }, 'LOCK_DECLARE_FAILED');
  }

  /**
   * Release every lock a session holds in a repo.
   *
   * Takes a repoPath for the same reason declareFiles does. Callers that have
   * only a sessionId should go through `releaseSessionLocks`.
   */
  async releaseFiles(repoPath: string, sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const result = await this.releaseSessionLocks(path.resolve(repoPath), sessionId);
      void result;
    }, 'LOCK_RELEASE_FAILED');
  }

  /** Every declared (non-auto) lock currently held in a repo. */
  async listDeclarations(repoPath: string): Promise<IpcResult<AutoFileLock[]>> {
    const normalizedRepo = path.resolve(repoPath);
    await this.loadLocks(normalizedRepo);
    const repoLocks = this.locksByRepo.get(normalizedRepo) || new Map();
    return this.success(
      Array.from(repoLocks.values()).filter((l: any) => l.declared === true)
    );
  }

  // ==================== Protected paths (KC-S3.1.2) ====================

  /**
   * Protect paths or globs for a session. kit_commit in that session then
   * refuses any commit touching them. Idempotent per (pattern, session).
   */
  async protectPaths(
    repoPath: string,
    sessionId: string,
    patterns: string[],
    reason?: string
  ): Promise<IpcResult<PathProtection[]>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      const current = await this.loadProtections(normalizedRepo);
      const now = new Date().toISOString();
      for (const pattern of patterns) {
        if (!current.some((p) => p.pattern === pattern && p.sessionId === sessionId)) {
          current.push({ pattern, sessionId, protectedAt: now, ...(reason ? { reason } : {}) });
        }
      }
      await this.saveProtections(normalizedRepo);
      return current.filter((p) => p.sessionId === sessionId);
    }, 'PROTECT_PATHS_FAILED');
  }

  /**
   * Lift protections. Only the owning session can lift its own; a pattern held
   * only by other sessions comes back in `refused` and stays protected.
   */
  async unprotectPaths(
    repoPath: string,
    sessionId: string,
    patterns: string[]
  ): Promise<IpcResult<{ released: string[]; refused: Array<{ pattern: string; ownerSessionId: string }> }>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      const current = await this.loadProtections(normalizedRepo);
      const released: string[] = [];
      const refused: Array<{ pattern: string; ownerSessionId: string }> = [];
      for (const pattern of patterns) {
        const own = current.findIndex((p) => p.pattern === pattern && p.sessionId === sessionId);
        if (own >= 0) {
          current.splice(own, 1);
          released.push(pattern);
          continue;
        }
        const other = current.find((p) => p.pattern === pattern);
        if (other) refused.push({ pattern, ownerSessionId: other.sessionId });
      }
      if (released.length > 0) await this.saveProtections(normalizedRepo);
      return { released, refused };
    }, 'UNPROTECT_PATHS_FAILED');
  }

  /** Protections in a repo, optionally only one session's. */
  async listProtections(repoPath: string, sessionId?: string): Promise<IpcResult<PathProtection[]>> {
    return this.wrap(async () => {
      const current = await this.loadProtections(path.resolve(repoPath));
      return current.filter((p) => !sessionId || p.sessionId === sessionId);
    }, 'LIST_PROTECTIONS_FAILED');
  }

  private async loadProtections(repoPath: string): Promise<PathProtection[]> {
    const cached = this.protectionsByRepo.get(repoPath);
    if (cached) return cached;
    const file = path.join(repoPath, KANVAS_DIR, PROTECTED_FILENAME);
    let loaded: PathProtection[] = [];
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Array.isArray(parsed)) loaded = parsed.filter((p) => p && typeof p.pattern === 'string' && typeof p.sessionId === 'string');
      }
    } catch (error) {
      console.warn(`[LockService] Failed to load protected paths for ${repoPath}:`, error);
    }
    this.protectionsByRepo.set(repoPath, loaded);
    return loaded;
  }

  private async saveProtections(repoPath: string): Promise<void> {
    const dir = path.join(repoPath, KANVAS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, PROTECTED_FILENAME),
      JSON.stringify(this.protectionsByRepo.get(repoPath) ?? [], null, 2)
    );
  }

  // ==================== Private helpers ====================

  private setFileLock(repoPath: string, filePath: string, lock: AutoFileLock): void {
    let repoLocks = this.locksByRepo.get(repoPath);
    if (!repoLocks) {
      repoLocks = new Map();
      this.locksByRepo.set(repoPath, repoLocks);
    }
    repoLocks.set(filePath, lock);
  }

  private async loadLocks(repoPath: string): Promise<void> {
    if (this.locksByRepo.has(repoPath)) {
      return; // Already loaded
    }

    const locksFile = path.join(repoPath, KANVAS_DIR, LOCKS_FILENAME);

    try {
      if (existsSync(locksFile)) {
        const content = await fs.readFile(locksFile, 'utf8');
        const locks = JSON.parse(content) as Record<string, AutoFileLock>;

        const repoLocks = new Map<string, AutoFileLock>();
        for (const [filePath, lock] of Object.entries(locks)) {
          repoLocks.set(filePath, lock);
        }

        this.locksByRepo.set(repoPath, repoLocks);

        // Everything on disk predates this process. Prune before any caller
        // sees it, so locks left behind by a crash (or by a session that has
        // since been closed) don't masquerade as live conflicts.
        await this.pruneStaleLocks(repoPath);
      } else {
        this.locksByRepo.set(repoPath, new Map());
      }
    } catch (error) {
      console.warn(`[LockService] Failed to load locks for ${repoPath}:`, error);
      this.locksByRepo.set(repoPath, new Map());
    }
  }

  /**
   * Schedule a write of repo locks to disk. Coalesces bursts of calls into a
   * single write per repo per SAVE_DEBOUNCE_MS window. Callers may still
   * `await` for backwards compatibility, but the actual disk write happens
   * asynchronously on the timer.
   */
  private async saveLocks(repoPath: string): Promise<void> {
    const existing = this.pendingSaves.get(repoPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingSaves.delete(repoPath);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.saveLocksNow(repoPath);
    }, SAVE_DEBOUNCE_MS);
    this.pendingSaves.set(repoPath, timer);
  }

  /**
   * Synchronously flush every pending debounced save. Used on shutdown.
   */
  private async flushPendingSaves(): Promise<void> {
    const pending = Array.from(this.pendingSaves.keys());
    for (const repoPath of pending) {
      const timer = this.pendingSaves.get(repoPath);
      if (timer) clearTimeout(timer);
      this.pendingSaves.delete(repoPath);
      await this.saveLocksNow(repoPath);
    }
  }

  private async saveLocksNow(repoPath: string): Promise<void> {
    const repoLocks = this.locksByRepo.get(repoPath);
    if (!repoLocks) return;

    const kanvasDir = path.join(repoPath, KANVAS_DIR);
    const locksFile = path.join(kanvasDir, LOCKS_FILENAME);

    try {
      // Ensure directory exists
      await fs.mkdir(kanvasDir, { recursive: true });

      // Convert Map to object for JSON
      const locksObj: Record<string, AutoFileLock> = {};
      for (const [filePath, lock] of repoLocks) {
        locksObj[filePath] = lock;
      }

      await fs.writeFile(locksFile, JSON.stringify(locksObj, null, 2));
    } catch (error) {
      console.error(`[LockService] Failed to save locks for ${repoPath}:`, error);
    }
  }

  private shouldSkipFile(filePath: string): boolean {
    // Skip lock files themselves
    if (filePath.includes(LOCKS_FILENAME)) return true;
    if (filePath.includes(KANVAS_DIR)) return true;

    // Skip common generated/system files
    const skipPatterns = [
      'node_modules',
      '.git',
      'dist/',
      'build/',
      '.next/',
      'package-lock.json',
      'yarn.lock',
      '.DS_Store',
    ];

    return skipPatterns.some(pattern => filePath.includes(pattern));
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    // Flush any in-flight debounced writes, then write each repo synchronously
    // one last time so nothing in-memory is lost on shutdown.
    await this.flushPendingSaves();
    for (const [repoPath] of this.locksByRepo) {
      await this.saveLocksNow(repoPath);
    }
    this.locksByRepo.clear();
    this.protectionsByRepo.clear();
    this.hasWarnedOverflow.clear();
  }
}
