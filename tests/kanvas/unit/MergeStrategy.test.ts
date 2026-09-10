/**
 * Unit Tests for shared/merge-strategy.ts (story KIT-PR-P10)
 *
 * The bug this exists to close: MergeService merged locally and then ran
 * `git push origin <target>` WITHOUT checking the exit code. Against a
 * protected branch GitHub rejects that push, so the local target kept the merge
 * commit, origin received nothing, and the merge reported success.
 */

import { describe, it, expect } from '@jest/globals';
import {
  resolveMergeStrategy,
  isProtectedBranch,
  PROTECTED_BRANCHES,
} from '../../../shared/merge-strategy';

describe('isProtectedBranch', () => {
  it.each([...PROTECTED_BRANCHES])('treats %s as protected', (b) => {
    expect(isProtectedBranch(b)).toBe(true);
  });

  it.each(['development', 'dev', 'staging', 'feature/x', 'main-ish', 'release-2'])(
    'does NOT treat %s as protected',
    (b) => {
      // Exact match, matching what MergeService has always done. `release-2`
      // and `main-ish` are the cases a prefix check would get wrong.
      expect(isProtectedBranch(b)).toBe(false);
    }
  );
});

describe('auto — the default', () => {
  it('merges directly into an unprotected branch', () => {
    const s = resolveMergeStrategy({ targetBranch: 'development', canOpenPr: true });
    expect(s.mode).toBe('direct');
  });

  it('opens a pull request for a protected branch', () => {
    const s = resolveMergeStrategy({ targetBranch: 'main', canOpenPr: true });
    expect(s.mode).toBe('pr');
    expect(s.reason).toMatch(/required reviews/i);
  });

  it('still merges directly into a protected branch when forced', () => {
    // `force` is the existing "merge without CI check" override and has always
    // meant "I accept the risk here". Changing that would break the button.
    const s = resolveMergeStrategy({ targetBranch: 'main', canOpenPr: true, force: true });
    expect(s.mode).toBe('direct');
    expect(s.reason).toMatch(/force/i);
  });

  it('warns when a protected target has no PR route available', () => {
    // Merging directly is all that is left, and it will probably be rejected.
    // Say so rather than doing it silently.
    const s = resolveMergeStrategy({ targetBranch: 'main', canOpenPr: false });
    expect(s.mode).toBe('direct');
    expect(s.reason).toMatch(/may be rejected/i);
  });
});

describe('explicit via: pr', () => {
  it('opens a pull request even for an unprotected branch', () => {
    const s = resolveMergeStrategy({ targetBranch: 'development', via: 'pr', canOpenPr: true });
    expect(s.mode).toBe('pr');
  });

  it('refuses rather than silently merging when no PR can be opened', () => {
    // Falling back to a direct merge here would do the opposite of what was
    // asked, on the one path where the caller was explicit.
    const s = resolveMergeStrategy({ targetBranch: 'main', via: 'pr', canOpenPr: false });
    expect(s.refused).toBe(true);
    expect(s.refusalCode).toBe('PR_UNAVAILABLE');
  });

  it('is not overridden by force', () => {
    const s = resolveMergeStrategy({
      targetBranch: 'main', via: 'pr', canOpenPr: true, force: true,
    });
    expect(s.mode).toBe('pr');
  });
});

describe('explicit via: direct', () => {
  it('is honoured for a protected branch', () => {
    // Whoever administers the repo may have permission the tool cannot see.
    // Refusing outright would make KIT unusable for them. The push is checked
    // now, so a rejection surfaces.
    const s = resolveMergeStrategy({ targetBranch: 'main', via: 'direct', canOpenPr: true });
    expect(s.mode).toBe('direct');
    expect(s.reason).toMatch(/protected/i);
  });

  it('is honoured for an unprotected branch', () => {
    const s = resolveMergeStrategy({ targetBranch: 'development', via: 'direct', canOpenPr: true });
    expect(s.mode).toBe('direct');
  });

  it('never reports refused', () => {
    const s = resolveMergeStrategy({ targetBranch: 'main', via: 'direct', canOpenPr: false });
    expect(s.refused).toBeFalsy();
  });
});

describe('every combination resolves to a usable mode', () => {
  it('never returns an undefined mode', () => {
    for (const targetBranch of ['main', 'development', 'release', 'feature/x']) {
      for (const via of ['auto', 'pr', 'direct'] as const) {
        for (const canOpenPr of [true, false]) {
          for (const force of [true, false]) {
            const s = resolveMergeStrategy({ targetBranch, via, canOpenPr, force });
            expect(['pr', 'direct']).toContain(s.mode);
            expect(typeof s.reason).toBe('string');
            expect(s.reason.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
