/**
 * Keeping sessions current with their base branch (real git).
 *
 * Reported: a new session "said it was behind the remote" straight away and
 * never caught up. Three causes, each pinned here against real repositories:
 *   - "behind" was measured in the MAIN checkout (repoPath), not the session's
 *     worktree, so every session reported the main checkout's state;
 *   - kit_rebase on an unwatched session rebased the main checkout and left
 *     the session where it was, while reporting success;
 *   - nothing caught up a session that had no work of its own.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shouldFastForward } from '../../../shared/session-fast-forward';
import { RebaseWatcherService } from '../../../electron/services/RebaseWatcherService';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('shouldFastForward', () => {
  const base = {
    ahead: 0,
    behind: 3,
    isRebasing: false,
    isPaused: false,
    onBranchAndIdle: true,
    remoteHead: 'abc',
    lastRefusedFor: null,
  };
  it('catches up a session with no commits of its own', () => {
    expect(shouldFastForward(base)).toBe(true);
  });
  it.each([
    ['it has its own commits', { ahead: 1 }],
    ['it is up to date', { behind: 0 }],
    ['a rebase is running', { isRebasing: true }],
    ['it is paused', { isPaused: true }],
    ['HEAD is detached or mid-rebase', { onBranchAndIdle: false }],
    ['the same remote commit was already refused', { lastRefusedFor: 'abc' }],
  ])('does not when %s', (_why, over) => {
    expect(shouldFastForward({ ...base, ...over })).toBe(false);
  });
  it('retries once the remote has moved past a refusal', () => {
    expect(shouldFastForward({ ...base, lastRefusedFor: 'older' })).toBe(true);
  });
});

describe('RebaseWatcher keeps a session current (real git)', () => {
  let dir: string;
  let repo: string; // the main checkout (repoPath)
  let wt: string; // the session worktree
  let other: string; // someone else pushing to main
  let svc: RebaseWatcherService;
  const rebasedPaths: string[] = [];
  const activity: string[] = [];

  // Real-git stand-in for the GitService slice the watcher uses.
  const gitService = {
    fetchRemote: async (p: string) => {
      git(p, 'fetch', '-q', 'origin');
      return { success: true };
    },
    checkRemoteChanges: async (p: string, b: string) => {
      const [ahead, behind] = git(p, 'rev-list', '--left-right', '--count', `HEAD...origin/${b}`)
        .split(/\s+/)
        .map(Number);
      return { success: true, data: { ahead, behind } };
    },
    getCurrentBranch: async (p: string) => ({ success: true, data: git(p, 'branch', '--show-current') }),
    performRebase: async (p: string, b: string) => {
      rebasedPaths.push(p);
      git(p, 'rebase', '-q', `origin/${b}`);
      return { success: true, data: { success: true, message: 'ok', hadChanges: false } };
    },
  };

  const pushToMain = (n = 1) => {
    for (let i = 0; i < n; i++) {
      writeFileSync(join(other, `f${Date.now()}-${i}.txt`), String(i));
      git(other, 'add', '.');
      git(other, 'commit', '-qm', `upstream ${i}`);
    }
    git(other, 'push', '-q', 'origin', 'main');
  };
  const watch = async (rebaseFrequency: 'never' | 'on-demand' | 'daily' = 'never') => {
    await svc.startWatching({
      sessionId: 'sess_1',
      repoPath: repo,
      worktreePath: wt,
      baseBranch: 'main',
      currentBranch: 'sess',
      rebaseFrequency,
      pollIntervalMs: 3_600_000,
    });
    return (svc as any).watchedSessions.get('sess_1');
  };
  const poll = (state: unknown) => (svc as any).checkAndRebaseIfNeeded(state, false);
  const head = (p: string) => git(p, 'rev-parse', 'HEAD');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-ff-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    repo = join(dir, 'repo');
    git(dir, 'clone', '-q', join(dir, 'origin.git'), 'repo');
    for (const p of [repo]) {
      git(p, 'config', 'user.email', 't@t');
      git(p, 'config', 'user.name', 't');
    }
    git(repo, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'v1');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'v1');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    other = join(dir, 'other');
    git(dir, 'clone', '-q', join(dir, 'origin.git'), 'other');
    git(other, 'config', 'user.email', 'o@o');
    git(other, 'config', 'user.name', 'o');
    wt = join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '--no-track', '-b', 'sess', wt, 'origin/main');
    svc = new RebaseWatcherService(gitService as any);
    svc.setActivityService({ log: (_s: string, _t: string, m: string) => activity.push(m) } as any);
    rebasedPaths.length = 0;
    activity.length = 0;
  });
  afterEach(async () => {
    await svc.stopWatching('sess_1');
    rmSync(dir, { recursive: true, force: true });
  });

  it("measures 'behind' in the session's worktree, not the main checkout", async () => {
    // The main checkout falls behind; the session is current.
    git(wt, 'fetch', '-q');
    pushToMain(2);
    git(wt, 'fetch', '-q');
    git(wt, 'merge', '-q', '--ff-only', 'origin/main');
    const state = await watch('on-demand');
    expect(git(repo, 'rev-list', '--count', 'HEAD..origin/main')).toBe('2'); // main checkout is behind
    expect(state.behindCount).toBe(0); // the session is not
  });

  it("fast-forwards a session with no commits of its own, even on 'never'", async () => {
    const mainBefore = head(repo);
    const state = await watch('never');
    pushToMain(3);
    await poll(state);
    expect(head(wt)).toBe(git(wt, 'rev-parse', 'origin/main'));
    expect(state.behindCount).toBe(0);
    expect(head(repo)).toBe(mainBefore); // the main checkout is not touched
    expect(activity.some((m) => /Fast-forwarded to the latest main \(3 commits\)/.test(m))).toBe(true);
  });

  it('catches up on the very first poll when the session starts behind', async () => {
    pushToMain(1);
    const state = await watch('never');
    await poll(state);
    expect(state.behindCount).toBe(0);
    expect(head(wt)).toBe(git(wt, 'rev-parse', 'origin/main'));
  });

  it('leaves a session with its own commits alone (no rewrite)', async () => {
    writeFileSync(join(wt, 'mine.txt'), 'work');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'my work');
    const mine = head(wt);
    const state = await watch('never');
    pushToMain(1);
    await poll(state);
    expect(head(wt)).toBe(mine);
    expect(state.aheadCount).toBe(1);
    expect(state.behindCount).toBe(1);
  });

  it('does not overwrite uncommitted edits, and does not retry until the remote moves', async () => {
    const state = await watch('never');
    // Upstream changes a.txt; the session has an uncommitted edit to it.
    writeFileSync(join(other, 'a.txt'), 'upstream');
    git(other, 'commit', '-qam', 'upstream edit');
    git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(wt, 'a.txt'), 'my uncommitted edit');
    const before = head(wt);
    await poll(state);
    expect(head(wt)).toBe(before);
    expect(git(wt, 'status', '--porcelain')).toContain('a.txt');
    const refusals = () => activity.filter((m) => /Could not fast-forward/.test(m)).length;
    expect(refusals()).toBe(1);
    await poll(state); // same remote commit: no second attempt, no second warning
    expect(refusals()).toBe(1);
  });

  it('kit_rebase on an unwatched session rebases its worktree, not the main checkout', async () => {
    writeFileSync(join(wt, 'mine.txt'), 'work');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'my work');
    pushToMain(1);
    git(wt, 'fetch', '-q');
    const r = await svc.performRebaseForPath('sess_unwatched', repo, 'main', wt);
    expect(r.success).toBe(true);
    expect(rebasedPaths).toEqual([wt]);
    expect(git(wt, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0');
  });
});
