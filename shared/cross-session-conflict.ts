/**
 * Cross-session file lock conflict detector (Epic S / story S2).
 *
 * Two or more active sessions hold soft-locks on the same file → that's a
 * conflict the user wants to know about before agents collide. This module
 * is the pure rule; the LockService produces the inputs.
 */

export type SessionLockType = 'edit' | 'read';

export interface SessionFileLock {
  sessionId: string;
  agentType: string;
  filePath: string;
  lockType: SessionLockType;
  /** ISO timestamp when the lock was acquired. */
  heldSince: string;
}

export interface ConflictGroup {
  filePath: string;
  /** Locks involved in the conflict (size >= 2). */
  locks: SessionFileLock[];
  /**
   * Severity:
   *  - 'edit-edit'   two or more edit locks (highest)
   *  - 'edit-read'   one edit + one+ read locks (medium)
   *  - 'read-read'   read-read is NOT a conflict and is omitted from output.
   */
  severity: 'edit-edit' | 'edit-read';
}

/**
 * Detect cross-session conflicts. Two sessions on the same path are only
 * a conflict if at least one is an edit lock. Read-read overlaps are safe.
 */
export function detectCrossSessionConflicts(
  locks: ReadonlyArray<SessionFileLock>
): ConflictGroup[] {
  const byFile = new Map<string, SessionFileLock[]>();
  for (const lock of locks) {
    const arr = byFile.get(lock.filePath) ?? [];
    arr.push(lock);
    byFile.set(lock.filePath, arr);
  }

  const conflicts: ConflictGroup[] = [];
  for (const [filePath, group] of byFile) {
    if (group.length < 2) continue;
    // Each session can only have one lock per file in our model — a single
    // session holding both edit + read is collapsed to its strongest.
    const bySession = new Map<string, SessionFileLock>();
    for (const lock of group) {
      const cur = bySession.get(lock.sessionId);
      if (!cur || strength(lock.lockType) > strength(cur.lockType)) {
        bySession.set(lock.sessionId, lock);
      }
    }
    if (bySession.size < 2) continue;
    const distinctLocks = Array.from(bySession.values());
    const editCount = distinctLocks.filter((l) => l.lockType === 'edit').length;
    if (editCount >= 2) {
      conflicts.push({ filePath, locks: distinctLocks, severity: 'edit-edit' });
    } else if (editCount === 1) {
      conflicts.push({ filePath, locks: distinctLocks, severity: 'edit-read' });
    }
    // editCount === 0 → all reads, not a conflict.
  }

  conflicts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'edit-edit' ? -1 : 1;
    return a.filePath.localeCompare(b.filePath);
  });
  return conflicts;
}

function strength(lockType: SessionLockType): number {
  return lockType === 'edit' ? 2 : 1;
}
