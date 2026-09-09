/**
 * Unit Tests for S2 — Cross-session file lock conflict detector
 */

import { describe, it, expect } from '@jest/globals';
import {
  detectCrossSessionConflicts,
  type SessionFileLock,
} from '../../../shared/cross-session-conflict';

const lock = (
  sessionId: string,
  filePath: string,
  lockType: 'edit' | 'read',
  agentType = 'claude'
): SessionFileLock => ({
  sessionId,
  agentType,
  filePath,
  lockType,
  heldSince: '2026-05-01T00:00:00.000Z',
});

describe('detectCrossSessionConflicts (S2)', () => {
  it('returns nothing when no overlap', () => {
    expect(
      detectCrossSessionConflicts([lock('s1', 'a.ts', 'edit'), lock('s2', 'b.ts', 'edit')])
    ).toEqual([]);
  });

  it('returns nothing when overlap is read-read (safe)', () => {
    expect(
      detectCrossSessionConflicts([lock('s1', 'a.ts', 'read'), lock('s2', 'a.ts', 'read')])
    ).toEqual([]);
  });

  it('flags edit-read overlap (medium severity)', () => {
    const out = detectCrossSessionConflicts([
      lock('s1', 'a.ts', 'edit'),
      lock('s2', 'a.ts', 'read'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('a.ts');
    expect(out[0].severity).toBe('edit-read');
    expect(out[0].locks.map((l) => l.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('flags edit-edit overlap (highest severity)', () => {
    const out = detectCrossSessionConflicts([
      lock('s1', 'a.ts', 'edit'),
      lock('s2', 'a.ts', 'edit'),
    ]);
    expect(out[0].severity).toBe('edit-edit');
  });

  it('collapses a single session holding both edit + read on same file', () => {
    const out = detectCrossSessionConflicts([
      lock('s1', 'a.ts', 'read'),
      lock('s1', 'a.ts', 'edit'),
    ]);
    expect(out).toEqual([]); // only one distinct session
  });

  it('does not double-count when a session has multiple locks on the same file', () => {
    const out = detectCrossSessionConflicts([
      lock('s1', 'a.ts', 'edit'),
      lock('s1', 'a.ts', 'read'),
      lock('s2', 'a.ts', 'edit'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('edit-edit');
    expect(out[0].locks).toHaveLength(2); // s1 collapsed to its edit lock
  });

  it('sorts edit-edit before edit-read', () => {
    const out = detectCrossSessionConflicts([
      lock('s1', 'b.ts', 'edit'),
      lock('s2', 'b.ts', 'read'),
      lock('s3', 'a.ts', 'edit'),
      lock('s4', 'a.ts', 'edit'),
    ]);
    expect(out.map((c) => c.severity)).toEqual(['edit-edit', 'edit-read']);
    expect(out[0].filePath).toBe('a.ts');
    expect(out[1].filePath).toBe('b.ts');
  });
});
