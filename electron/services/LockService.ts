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
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Store locks per repository in .S9N_KIT_DevOpsAgent/locks.json
const LOCKS_FILENAME = 'locks.json';
const KANVAS_DIR = '.S9N_KIT_DevOpsAgent';

// Default lock timeout: 24 hours of inactivity
const DEFAULT_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Session lock directory (matches SessionService)
const SESSION_LOCK_DIR = path.join(os.homedir(), '.devops-agent', 'session-locks');

// Stale session lock TTL: 1 hour (for crashed sessions)
const STALE_SESSION_LOCK_TTL_MS = 60 * 60 * 1000;

export class LockService extends BaseService {
  // In-memory cache of locks: repoPath -> filePath -> lock
  private locksByRepo: Map<string, Map<string, AutoFileLock>> = new Map();

  // Legacy session-based locks (for backwards compatibility)
  private sessionLocks: Map<string, FileLock> = new Map();

  async initialize(): Promise<void> {
    // Clean up stale session lock files from crashed sessions
    await this.cleanupStaleSessionLocks();
    console.log('[LockService] Initialized (stale lock cleanup complete)');
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

      // Check for existing lock by another session
      const existingLock = await this.getFileLock(normalizedRepo, relativePath);

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
        if (lock && lock.sessionId !== excludeSessionId) {
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
   * Clean up expired locks (locks older than timeout with no activity)
   */
  async cleanupExpiredLocks(
    repoPath: string,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
  ): Promise<IpcResult<number>> {
    return this.wrap(async () => {
      const normalizedRepo = path.resolve(repoPath);
      await this.loadLocks(normalizedRepo);

      const repoLocks = this.locksByRepo.get(normalizedRepo);
      if (!repoLocks) return 0;

      const now = Date.now();
      const toRemove: string[] = [];

      for (const [filePath, lock] of repoLocks) {
        const lastModified = new Date(lock.lastModified).getTime();
        if (now - lastModified > timeoutMs) {
          toRemove.push(filePath);
        }
      }

      for (const filePath of toRemove) {
        const lock = repoLocks.get(filePath)!;
        repoLocks.delete(filePath);

        const event: LockChangeEvent = {
          type: 'released',
          lock,
        };
        this.emitToRenderer(IPC.LOCK_CHANGED, event);
      }

      if (toRemove.length > 0) {
        await this.saveLocks(normalizedRepo);
      }

      console.log(`[LockService] Cleaned up ${toRemove.length} expired locks`);
      return toRemove.length;
    }, 'CLEANUP_LOCKS_FAILED');
  }

  // ==================== Legacy API (backwards compatibility) ====================

  async declareFiles(
    sessionId: string,
    files: string[],
    operation: 'edit' | 'read' | 'delete',
    agentType: AgentType = 'custom',
    estimatedDuration: number = 30,
    reason?: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const lock: FileLock = {
        sessionId,
        agentType,
        files,
        operation,
        declaredAt: new Date().toISOString(),
        estimatedDuration,
        reason,
      };
      this.sessionLocks.set(sessionId, lock);
    }, 'LOCK_DECLARE_FAILED');
  }

  async releaseFiles(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      this.sessionLocks.delete(sessionId);
    }, 'LOCK_RELEASE_FAILED');
  }

  async listDeclarations(): Promise<IpcResult<FileLock[]>> {
    return this.success(Array.from(this.sessionLocks.values()));
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
      } else {
        this.locksByRepo.set(repoPath, new Map());
      }
    } catch (error) {
      console.warn(`[LockService] Failed to load locks for ${repoPath}:`, error);
      this.locksByRepo.set(repoPath, new Map());
    }
  }

  private async saveLocks(repoPath: string): Promise<void> {
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
    // Save all locks on shutdown
    for (const [repoPath] of this.locksByRepo) {
      await this.saveLocks(repoPath);
    }
    this.locksByRepo.clear();
    this.sessionLocks.clear();
  }
}
