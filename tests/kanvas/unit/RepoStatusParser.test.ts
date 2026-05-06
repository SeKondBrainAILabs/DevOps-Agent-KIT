/**
 * Unit Tests for the porcelain v2 + helper parsers (Day 1.5)
 */

import { describe, it, expect } from '@jest/globals';
import {
  countNonBlankLines,
  countWorktreeListPorcelain,
  parseLastCommit,
  parsePorcelainV2,
} from '../../../shared/repo-status-parser';

describe('parsePorcelainV2 — branch + upstream + ab (Day 1.5)', () => {
  it('parses branch.head', () => {
    const out = '# branch.oid abc123\n# branch.head main\n';
    expect(parsePorcelainV2(out).currentBranch).toBe('main');
  });

  it('parses upstream + ahead/behind', () => {
    const out =
      '# branch.oid abc123\n' +
      '# branch.head feat/login\n' +
      '# branch.upstream origin/feat/login\n' +
      '# branch.ab +3 -2\n';
    const r = parsePorcelainV2(out);
    expect(r.currentBranch).toBe('feat/login');
    expect(r.upstream).toBe('origin/feat/login');
    expect(r.ahead).toBe(3);
    expect(r.behind).toBe(2);
  });

  it('falls back to "(detached)" when branch.head is missing', () => {
    expect(parsePorcelainV2('# branch.oid abc123\n').currentBranch).toBe('(detached)');
  });

  it('omits upstream + leaves ahead/behind=0 when no upstream tracked', () => {
    const out = '# branch.oid abc123\n# branch.head topic\n';
    const r = parsePorcelainV2(out);
    expect(r.upstream).toBeUndefined();
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
  });
});

describe('parsePorcelainV2 — per-file counts (Day 1.5)', () => {
  it('counts staged-only entries', () => {
    // 1 X. — staged only (X = M, Y = .)
    const out = '# branch.head main\n1 M. N... 100644 100644 100644 abc abc src/a.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.stagedCount).toBe(1);
    expect(r.modifiedCount).toBe(0);
  });

  it('counts unstaged-only entries', () => {
    const out = '# branch.head main\n1 .M N... 100644 100644 100644 abc abc src/a.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.stagedCount).toBe(0);
    expect(r.modifiedCount).toBe(1);
  });

  it('counts staged + unstaged on the same file as one of each', () => {
    const out = '# branch.head main\n1 MM N... 100644 100644 100644 abc abc src/a.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.stagedCount).toBe(1);
    expect(r.modifiedCount).toBe(1);
  });

  it('counts untracked entries', () => {
    const out = '# branch.head main\n? src/new.ts\n? src/another.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.untrackedCount).toBe(2);
  });

  it('counts unmerged entries', () => {
    const out = '# branch.head main\nu UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.unmergedCount).toBe(1);
  });

  it('skips ignored (!) entries', () => {
    const out = '# branch.head main\n! ignored.log\n';
    const r = parsePorcelainV2(out);
    expect(r.untrackedCount).toBe(0);
    expect(r.modifiedCount).toBe(0);
  });

  it('counts renamed/copied (kind=2) entries by status columns', () => {
    // "2 R. ..." — staged rename
    const out = '# branch.head main\n2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\told.ts\n';
    const r = parsePorcelainV2(out);
    expect(r.stagedCount).toBe(1);
  });

  it('handles empty input gracefully', () => {
    const r = parsePorcelainV2('');
    expect(r.currentBranch).toBe('(detached)');
    expect(r.modifiedCount).toBe(0);
    expect(r.stagedCount).toBe(0);
    expect(r.untrackedCount).toBe(0);
    expect(r.unmergedCount).toBe(0);
  });

  it('tolerates trailing CR (Windows line endings)', () => {
    const out = '# branch.head main\r\n? new.ts\r\n';
    expect(parsePorcelainV2(out).untrackedCount).toBe(1);
  });

  it('mixed status — full picture', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +1 -1',
      '1 M. N... 100644 100644 100644 abc abc staged.ts',
      '1 .M N... 100644 100644 100644 abc abc dirty.ts',
      '1 MM N... 100644 100644 100644 abc abc both.ts',
      '? new.ts',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflict.ts',
      '! ignored.log',
      '',
    ].join('\n');
    const r = parsePorcelainV2(out);
    expect(r.currentBranch).toBe('feat/x');
    expect(r.upstream).toBe('origin/feat/x');
    expect(r.ahead).toBe(1);
    expect(r.behind).toBe(1);
    expect(r.stagedCount).toBe(2); // staged.ts + both.ts
    expect(r.modifiedCount).toBe(2); // dirty.ts + both.ts
    expect(r.untrackedCount).toBe(1);
    expect(r.unmergedCount).toBe(1);
  });
});

describe('countNonBlankLines — stash list (Day 1.5)', () => {
  it('returns 0 on empty input', () => {
    expect(countNonBlankLines('')).toBe(0);
    expect(countNonBlankLines('   ')).toBe(0);
  });
  it('counts non-blank lines', () => {
    expect(countNonBlankLines('stash@{0}: WIP\nstash@{1}: WIP')).toBe(2);
  });
  it('skips blank lines in the middle', () => {
    expect(countNonBlankLines('stash@{0}: WIP\n\nstash@{1}: WIP\n')).toBe(2);
  });
});

describe('countWorktreeListPorcelain (Day 1.5)', () => {
  it('returns 0 on empty input', () => {
    expect(countWorktreeListPorcelain('')).toBe(0);
  });
  it('counts the number of `worktree ` headers', () => {
    const out = [
      'worktree /repo/main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/feat',
      'HEAD def',
      'branch refs/heads/feat',
      '',
    ].join('\n');
    expect(countWorktreeListPorcelain(out)).toBe(2);
  });
});

describe('parseLastCommit (Day 1.5)', () => {
  it('parses a normal log line', () => {
    const out = 'abc123def4|abc123d|feat: add login|2026-04-01T10:00:00Z';
    const r = parseLastCommit(out);
    expect(r).toEqual({
      sha: 'abc123def4',
      shortSha: 'abc123d',
      subject: 'feat: add login',
      authoredAt: '2026-04-01T10:00:00Z',
    });
  });
  it('preserves pipes in the subject', () => {
    const out = 'sha|short|fix: handle a|b|c case|2026-04-01T10:00:00Z';
    const r = parseLastCommit(out);
    expect(r?.subject).toBe('fix: handle a|b|c case');
  });
  it('returns null on empty input', () => {
    expect(parseLastCommit('')).toBeNull();
    expect(parseLastCommit('\n')).toBeNull();
  });
  it('returns null on too-few-parts', () => {
    expect(parseLastCommit('only|two')).toBeNull();
  });
});
