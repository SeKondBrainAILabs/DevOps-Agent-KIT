/**
 * Unit Tests for the WIP auto-save commit marker.
 */

import { describe, it, expect } from '@jest/globals';
import {
  WIP_SUBJECT_PREFIX,
  WIP_TRAILER_LINE,
  formatWipCommitMessage,
  hasWipTrailer,
  isWipAutoSaveSubject,
} from '../../../shared/wip-commit-marker';

describe('formatWipCommitMessage', () => {
  it('uses the [wip-autosave] prefix followed by stamp', () => {
    const msg = formatWipCommitMessage({ stamp: '2026-07-22 12:18' });
    expect(msg.split('\n')[0]).toBe('[wip-autosave] 2026-07-22 12:18');
  });

  it('includes the Git-Meta: kanvas-wip trailer by default', () => {
    const msg = formatWipCommitMessage({ stamp: 'x' });
    expect(msg).toContain(WIP_TRAILER_LINE);
    // Standard git trailer format: blank line then key: value
    expect(msg).toMatch(/^\S.*\n\nGit-Meta: kanvas-wip$/);
  });

  it('respects withTrailer=false (single-line message)', () => {
    const msg = formatWipCommitMessage({ stamp: 'x', withTrailer: false });
    expect(msg).toBe('[wip-autosave] x');
    expect(msg).not.toContain('Git-Meta');
  });

  it('prepends the multi-repo scope prefix', () => {
    const msg = formatWipCommitMessage({
      stamp: '2026-07-22 12:18',
      scopePrefix: '[Upgrade From Core_Kora]',
    });
    expect(msg.split('\n')[0]).toBe('[Upgrade From Core_Kora] [wip-autosave] 2026-07-22 12:18');
  });

  it('never uses "feat:" / "fix:" / other conventional-commits prefixes', () => {
    const msg = formatWipCommitMessage();
    const subject = msg.split('\n')[0];
    expect(subject).not.toMatch(/^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)/i);
    expect(subject.startsWith(WIP_SUBJECT_PREFIX)).toBe(true);
  });
});

describe('isWipAutoSaveSubject', () => {
  it('true for the new format', () => {
    expect(isWipAutoSaveSubject('[wip-autosave] 2026-07-22 12:18')).toBe(true);
  });

  it('true for the legacy format (backward compat with existing commits)', () => {
    expect(isWipAutoSaveSubject('WIP: periodic auto-save (2026-07-22 12:18)')).toBe(true);
  });

  it('true for the legacy multi-repo format', () => {
    expect(
      isWipAutoSaveSubject(
        '[Upgrade From Core_Kora] WIP: periodic auto-save (2026-07-22 12:18)'
      )
    ).toBe(true);
  });

  it('false for real commits', () => {
    expect(isWipAutoSaveSubject('feat(auth): add login flow')).toBe(false);
    expect(isWipAutoSaveSubject('fix: null deref')).toBe(false);
    expect(isWipAutoSaveSubject('perf(kemory-sync): cap concurrent upserts')).toBe(false);
  });

  it('false for empty / undefined-ish input', () => {
    expect(isWipAutoSaveSubject('')).toBe(false);
  });
});

describe('hasWipTrailer', () => {
  it('true when message body contains the exact trailer line', () => {
    expect(hasWipTrailer('subject\n\nGit-Meta: kanvas-wip')).toBe(true);
  });

  it('case-insensitive on the trailer line', () => {
    expect(hasWipTrailer('subject\n\ngit-meta: kanvas-wip')).toBe(true);
  });

  it('false when trailer missing', () => {
    expect(hasWipTrailer('subject\n\nSome-Other-Trailer: value')).toBe(false);
  });

  it('false on empty input', () => {
    expect(hasWipTrailer('')).toBe(false);
  });
});
