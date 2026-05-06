/**
 * Unit Tests for Q1 — Revert detector
 */

import { describe, it, expect } from '@jest/globals';
import {
  detectReverts,
  isLikelyFixSubject,
  type FixCommitChange,
  type NewCommitFileChange,
} from '../../../shared/revert-detector';

const fix = (
  sha: string,
  filePath: string,
  addedLines: string[],
  at = '2026-04-15T00:00:00.000Z'
): FixCommitChange => ({ sha, filePath, addedLines, at });

const newChange = (filePath: string, deletedLines: string[]): NewCommitFileChange => ({
  filePath,
  deletedLines,
});

describe('isLikelyFixSubject (Q1)', () => {
  it('matches fix / fixes / fixed / bugfix (case-insensitive)', () => {
    expect(isLikelyFixSubject('fix login crash')).toBe(true);
    expect(isLikelyFixSubject('Fixes #123')).toBe(true);
    expect(isLikelyFixSubject('fixed null deref')).toBe(true);
    expect(isLikelyFixSubject('bugfix: regression')).toBe(true);
  });
  it('does NOT match unrelated words like "prefix" or "suffix"', () => {
    expect(isLikelyFixSubject('add prefix support')).toBe(false);
    expect(isLikelyFixSubject('refactor suffix logic')).toBe(false);
  });
});

describe('detectReverts — basics (Q1)', () => {
  it('flags when a deleted line was added by a recent fix on the same file', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc123', 'src/auth.ts', ['if (user) return user;'])],
      newCommitChanges: [newChange('src/auth.ts', ['if (user) return user;'])],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].fixSha).toBe('abc123');
    expect(hits[0].overlapLines).toEqual(['if (user) return user;']);
  });

  it('does NOT flag when files differ', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc123', 'src/auth.ts', ['line A'])],
      newCommitChanges: [newChange('src/other.ts', ['line A'])],
    });
    expect(hits).toEqual([]);
  });

  it('does NOT flag when content differs (whitespace example)', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc123', 'src/x.ts', ['return  user;'])], // two spaces
      newCommitChanges: [newChange('src/x.ts', ['return user;'])],
    });
    expect(hits).toEqual([]);
  });
});

describe('detectReverts — multiple fixes / multiple files (Q1)', () => {
  it('emits one hit per (fix, file) pair when multiple fixes overlap', () => {
    const hits = detectReverts({
      fixCommits: [
        fix('one', 'src/a.ts', ['x = 1;'], '2026-03-01T00:00:00.000Z'),
        fix('two', 'src/a.ts', ['x = 1;'], '2026-04-01T00:00:00.000Z'),
      ],
      newCommitChanges: [newChange('src/a.ts', ['x = 1;'])],
    });
    expect(hits.map((h) => h.fixSha)).toEqual(['two', 'one']); // newest first
  });

  it('does not double-count duplicate added lines within a single fix', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc', 'src/x.ts', ['log("hi");', 'log("hi");', 'log("hi");'])],
      newCommitChanges: [newChange('src/x.ts', ['log("hi");'])],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].overlapLines).toEqual(['log("hi");']); // dedup'd
  });
});

describe('detectReverts — minOverlapLines (Q1)', () => {
  it('respects minOverlapLines=2 — single-line overlap is ignored', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc', 'src/x.ts', ['A', 'B', 'C'])],
      newCommitChanges: [newChange('src/x.ts', ['A'])],
      minOverlapLines: 2,
    });
    expect(hits).toEqual([]);
  });

  it('respects minOverlapLines=2 — fires when 2+ lines overlap', () => {
    const hits = detectReverts({
      fixCommits: [fix('abc', 'src/x.ts', ['A', 'B', 'C'])],
      newCommitChanges: [newChange('src/x.ts', ['A', 'B'])],
      minOverlapLines: 2,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].overlapLines).toEqual(['A', 'B']);
  });
});

describe('detectReverts — edge cases (Q1)', () => {
  it('returns empty on no fix commits', () => {
    expect(
      detectReverts({
        fixCommits: [],
        newCommitChanges: [newChange('src/x.ts', ['line'])],
      })
    ).toEqual([]);
  });

  it('returns empty on no new changes', () => {
    expect(
      detectReverts({
        fixCommits: [fix('abc', 'src/x.ts', ['line'])],
        newCommitChanges: [],
      })
    ).toEqual([]);
  });
});
