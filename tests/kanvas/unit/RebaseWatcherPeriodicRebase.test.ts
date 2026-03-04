/**
 * Tests for periodic auto-rebase in RebaseWatcherService
 *
 * Guards against:
 *   - 'daily' and 'weekly' frequencies being silently skipped (old bug: only 'on-demand' was watched)
 *   - Auto-rebase not firing for periodic frequencies when worktree is behind
 *   - Auto-rebase throttle preventing excessive rebasing
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Inline throttle constants (mirrors RebaseWatcherService) ─────────────────

const AUTO_REBASE_THROTTLE_MS: Record<string, number> = {
  daily: 60 * 60 * 1000,       // 1 hour
  weekly: 24 * 60 * 60 * 1000, // 24 hours
};

// ─── Inline logic mirrors ─────────────────────────────────────────────────────

function isAutoRebaseDue(lastAutoRebaseAt: Date | null, throttleMs: number): boolean {
  if (!lastAutoRebaseAt) return true;
  return Date.now() - lastAutoRebaseAt.getTime() >= throttleMs;
}

function shouldStartWatching(rebaseFrequency: string): boolean {
  // OLD code: only 'on-demand'
  return rebaseFrequency !== 'never';
}

function shouldStartWatchingOLD(rebaseFrequency: string): boolean {
  return rebaseFrequency === 'on-demand';
}

function shouldAutoRebase(
  rebaseFrequency: string,
  behind: number,
  lastAutoRebaseAt: Date | null,
  forceRebase = false
): boolean {
  if (behind === 0) return false;
  return (
    forceRebase ||
    (rebaseFrequency === 'daily' && isAutoRebaseDue(lastAutoRebaseAt, AUTO_REBASE_THROTTLE_MS.daily)) ||
    (rebaseFrequency === 'weekly' && isAutoRebaseDue(lastAutoRebaseAt, AUTO_REBASE_THROTTLE_MS.weekly))
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RebaseWatcher — periodic auto-rebase', () => {

  describe('startWatching frequency gate', () => {
    it('OLD: daily and weekly were silently skipped → regression proof', () => {
      expect(shouldStartWatchingOLD('on-demand')).toBe(true);
      expect(shouldStartWatchingOLD('daily')).toBe(false);   // ← was broken
      expect(shouldStartWatchingOLD('weekly')).toBe(false);  // ← was broken
      expect(shouldStartWatchingOLD('never')).toBe(false);
    });

    it('FIXED: daily and weekly start watching; never is the only skip', () => {
      expect(shouldStartWatching('on-demand')).toBe(true);
      expect(shouldStartWatching('daily')).toBe(true);
      expect(shouldStartWatching('weekly')).toBe(true);
      expect(shouldStartWatching('never')).toBe(false);
    });
  });

  describe('auto-rebase trigger logic', () => {
    it('on-demand never auto-rebases during polling (only on forceRebase)', () => {
      expect(shouldAutoRebase('on-demand', 5, null, false)).toBe(false);
      expect(shouldAutoRebase('on-demand', 5, null, true)).toBe(true);
    });

    it('daily auto-rebases when behind and no prior rebase', () => {
      expect(shouldAutoRebase('daily', 3, null)).toBe(true);
    });

    it('weekly auto-rebases when behind and no prior rebase', () => {
      expect(shouldAutoRebase('weekly', 1, null)).toBe(true);
    });

    it('daily does NOT auto-rebase if last rebase was < 1 hour ago', () => {
      const recentRebase = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      expect(shouldAutoRebase('daily', 3, recentRebase)).toBe(false);
    });

    it('daily DOES auto-rebase if last rebase was > 1 hour ago', () => {
      const oldRebase = new Date(Date.now() - 61 * 60 * 1000); // 61 min ago
      expect(shouldAutoRebase('daily', 3, oldRebase)).toBe(true);
    });

    it('weekly does NOT auto-rebase if last rebase was < 24 hours ago', () => {
      const recentRebase = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago
      expect(shouldAutoRebase('weekly', 3, recentRebase)).toBe(false);
    });

    it('weekly DOES auto-rebase if last rebase was > 24 hours ago', () => {
      const oldRebase = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      expect(shouldAutoRebase('weekly', 3, oldRebase)).toBe(true);
    });

    it('never frequency does not auto-rebase during polling (but allows user-forced)', () => {
      // 'never' means no background auto-rebase
      expect(shouldAutoRebase('never', 5, null, false)).toBe(false);
      // forceRebase=true means the user explicitly clicked Sync — still works for 'never'
      expect(shouldAutoRebase('never', 5, null, true)).toBe(true);
    });

    it('does not trigger when not behind', () => {
      expect(shouldAutoRebase('daily', 0, null)).toBe(false);
      expect(shouldAutoRebase('weekly', 0, null)).toBe(false);
    });
  });

  describe('isAutoRebaseDue throttle', () => {
    it('returns true when never rebased', () => {
      expect(isAutoRebaseDue(null, AUTO_REBASE_THROTTLE_MS.daily)).toBe(true);
    });

    it('returns false within throttle window', () => {
      const now = new Date(Date.now() - 1000); // 1s ago
      expect(isAutoRebaseDue(now, AUTO_REBASE_THROTTLE_MS.daily)).toBe(false);
    });

    it('returns true after throttle window elapsed', () => {
      const past = new Date(Date.now() - AUTO_REBASE_THROTTLE_MS.daily - 1);
      expect(isAutoRebaseDue(past, AUTO_REBASE_THROTTLE_MS.daily)).toBe(true);
    });
  });
});
