/**
 * A KIT rebase publishes itself (real git).
 *
 * The rewritten branch from a periodic (daily/weekly) rebase, a manual
 * trigger, or kit_rebase used to reach origin only through the post-commit
 * force-push. That force-push is gone: a post-commit rebase that is skipped
 * leads to a plain push, which a rewritten branch would reject. So these
 * rebases push the session branch to its upstream with --force-with-lease as
 * soon as they succeed. The post-commit rebase does not; its caller pushes.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RebaseWatcherService } from '../../../electron/services/RebaseWatcherService';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('a KIT rebase pushes the rewritten session branch (real git)', () => {
  let dir: string;
  let remote: string;
  let repo: string; // the main checkout
  let wt: string; // the session worktree, branch `sess`
  let other: string; // someone else
  let svc: RebaseWatcherService;
  const activity: Array<{ type: string; message: string }> = [];

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
      git(p, 'fetch', '-q', 'origin', b);
      git(p, 'rebase', '-q', `origin/${b}`);
      return { success: true, data: { success: true, message: 'Rebased', hadChanges: false } };
    },
  };

  const configure = (c: string) => {
    git(c, 'config', 'user.email', 't@example.com');
    git(c, 'config', 'user.name', 'T');
    git(c, 'config', 'commit.gpgsign', 'false');
  };
  const commit = (cwd: string, file: string, msg: string) => {
    writeFileSync(join(cwd, file), `${msg}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', msg);
  };
  const remoteSess = () => git(remote, 'rev-parse', 'refs/heads/sess');
  const head = () => git(wt, 'rev-parse', 'HEAD');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-publish-'));
    remote = join(dir, 'origin.git');
    repo = join(dir, 'repo');
    wt = join(dir, 'wt');
    other = join(dir, 'other');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '-q', remote, repo);
    configure(repo);
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    commit(repo, 'a.txt', 'base');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'worktree', 'add', '-q', '-b', 'sess', wt, 'main');
    commit(wt, 'mine.txt', 'session work');
    git(wt, 'push', '-q', '-u', 'origin', 'sess'); // the session branch is published
    git(dir, 'clone', '-q', remote, other);
    configure(other);
    commit(other, 'b.txt', 'upstream change'); // main moves on: the session must be rewritten
    git(other, 'push', '-q', 'origin', 'main');

    svc = new RebaseWatcherService(gitService as never);
    svc.setActivityService({ log: (_s: string, type: string, message: string) => activity.push({ type, message }) } as never);
    activity.length = 0;
  });

  afterEach(async () => {
    await svc.stopWatching('sess_1').catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('kit_rebase (publish) force-pushes the rewritten branch with lease', async () => {
    const before = remoteSess();

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt, { publish: true });

    expect(r.success).toBe(true);
    expect(r.published).toBe(true);
    expect(head()).not.toBe(before);
    expect(remoteSess()).toBe(head());
    expect(git(wt, 'rev-list', '--count', 'origin/sess..HEAD')).toBe('0');
    expect(activity.some((a) => /Pushed rebased sess to origin \(force-with-lease\)/.test(a.message))).toBe(true);
  });

  it('the post-commit rebase (no publish) leaves pushing to its caller', async () => {
    const before = remoteSess();

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt);

    expect(r.success).toBe(true);
    expect(r.published).toBeUndefined();
    expect(head()).not.toBe(before);
    expect(remoteSess()).toBe(before);
  });

  it('the periodic (daily) rebase publishes itself', async () => {
    await svc.startWatching({
      sessionId: 'sess_1',
      repoPath: repo,
      worktreePath: wt,
      baseBranch: 'main',
      currentBranch: 'sess',
      rebaseFrequency: 'daily',
      pollIntervalMs: 3_600_000,
    });
    const state = (svc as any).watchedSessions.get('sess_1');
    const poll = () => (svc as any).checkAndRebaseIfNeeded(state, false);
    await poll(); // baseline
    commit(other, 'c.txt', 'another upstream change');
    git(other, 'push', '-q', 'origin', 'main');
    const before = remoteSess();

    await poll();

    expect(state.lastRebaseResult?.success).toBe(true);
    expect(head()).not.toBe(before);
    expect(remoteSess()).toBe(head());
  });

  it('a manual trigger publishes itself', async () => {
    await svc.startWatching({
      sessionId: 'sess_1',
      repoPath: repo,
      worktreePath: wt,
      baseBranch: 'main',
      currentBranch: 'sess',
      rebaseFrequency: 'on-demand',
      pollIntervalMs: 3_600_000,
    });

    const r = await svc.triggerRebase('sess_1');

    expect(r.data?.success).toBe(true);
    expect(remoteSess()).toBe(head());
  });

  it('does not push a branch that has no upstream', async () => {
    git(wt, 'branch', '--unset-upstream');
    const before = remoteSess();

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt, { publish: true });

    expect(r.success).toBe(true);
    expect(r.published).toBe(false);
    expect(r.publishMessage).toMatch(/no upstream/);
    expect(remoteSess()).toBe(before);
  });

  it('does not overwrite commits someone else pushed to the session branch', async () => {
    // Someone pushes to `sess`; the session fetches it but has not integrated it.
    const theirs = join(dir, 'theirs');
    git(dir, 'clone', '-q', '-b', 'sess', remote, theirs);
    configure(theirs);
    commit(theirs, 'theirs.txt', 'their work on sess');
    git(theirs, 'push', '-q', 'origin', 'sess');
    git(wt, 'fetch', '-q', 'origin');
    const before = remoteSess();

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt, { publish: true });

    expect(r.success).toBe(true);
    expect(r.published).toBe(false);
    expect(r.publishMessage).toMatch(/has commits on it that the branch did not have/);
    expect(remoteSess()).toBe(before);
    expect(activity.some((a) => a.type === 'warning' && /not pushed/.test(a.message))).toBe(true);
  });
});
