/**
 * The post-commit rebase respects the session's rebase setting, measures
 * "behind" in the session's own worktree, and a skipped or failed rebase never
 * leads to a force-push.
 *
 * 2026-11-14: an MCP kit_commit on a session whose rebaseFrequency was 'never'
 * still ran the post-commit fetch-and-rebase. "Behind" was measured in the
 * main checkout (`origin/main...main`), so it was almost always > 0, and the
 * rebase was started without the session's worktree path. An AI conflict
 * resolution cut a 4475-line file to 229 lines and the push that followed was
 * a force-push.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

// execa is ESM-only; give GitService a child_process-backed stand-in.
const execFileP = promisify(execFile);
jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
    execFileP(cmd, args, { cwd: opts.cwd, encoding: 'utf-8' });
  return { __esModule: true, default: run, execa: run };
});

jest.mock('../../../electron/services/DatabaseService', () => ({
  databaseService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    recordCommit: jest.fn(),
    recordSessionEvent: jest.fn(),
  },
}));

import { WatcherService } from '../../../electron/services/WatcherService';
import { GitService } from '../../../electron/services/GitService';
import {
  mayPushAfterPostCommitRebase,
  postCommitPushOptions,
} from '../../../shared/post-commit-rebase';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Inst = {
  config: { repoPath: string; baseBranch: string; rebaseFrequency?: string; createdBy?: string };
  worktreePath?: string;
  multiRepoEntries?: Array<{ repoName: string; repoPath: string; worktreePath: string; baseBranch: string }>;
};

function makeWatcher(inst: Inst | null, gitService: unknown) {
  const activity = { log: jest.fn(), logFileActivity: jest.fn(), linkToCommit: jest.fn(() => 0) };
  const rebaseWatcher = {
    performRebaseForPath: jest.fn(async () => ({ success: true, message: 'rebased' })),
  };
  const svc = new WatcherService(gitService as never, activity as never);
  svc.setAgentInstanceService({ getInstance: () => ({ success: true, data: inst }), updateLastProcessedCommit: jest.fn() } as never);
  svc.setRebaseWatcher(rebaseWatcher as never);
  return { svc, activity, rebaseWatcher };
}

// ─── The skip rules ──────────────────────────────────────────────────────────

describe('attemptPostCommitRebase — when it must not run', () => {
  let wt: string;
  let gitService: {
    fetchRemote: jest.Mock;
    countBehindBase: jest.Mock;
    checkRemoteChanges: jest.Mock;
    rebase: jest.Mock;
    abortRebase: jest.Mock;
    isRebaseInProgress: jest.Mock;
  };

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'kit-pcr-wt-'));
    gitService = {
      fetchRemote: jest.fn(async () => ({ success: true })),
      countBehindBase: jest.fn(async () => ({ success: true, data: { behind: 4, ahead: 1 } })),
      checkRemoteChanges: jest.fn(async () => ({ success: true, data: { behind: 9, ahead: 0 } })),
      rebase: jest.fn(),
      abortRebase: jest.fn(async () => undefined),
      isRebaseInProgress: jest.fn(async () => false),
    };
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  const inst = (over: Partial<Inst['config']> = {}): Inst => ({
    config: { repoPath: '/repo', baseBranch: 'main', rebaseFrequency: 'on-demand', createdBy: 'ui', ...over },
    worktreePath: wt,
  });

  it.each([
    ["rebaseFrequency is 'never'", { rebaseFrequency: 'never' }, /rebase frequency is 'never'/],
    ['rebaseFrequency is unset (defaults to never)', { rebaseFrequency: undefined }, /rebase frequency is 'never'/],
    ['the session was created over MCP', { createdBy: 'mcp' }, /created by an agent over MCP/],
  ])('skips without fetching or rebasing when %s', async (_why, over, why) => {
    const { svc, activity, rebaseWatcher } = makeWatcher(inst(over), gitService);

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r).toMatchObject({ ok: true, rewrote: false, skipped: true, commitsIntegrated: 0 });
    expect(r.message).toMatch(why);
    expect(gitService.fetchRemote).not.toHaveBeenCalled();
    expect(gitService.countBehindBase).not.toHaveBeenCalled();
    expect(rebaseWatcher.performRebaseForPath).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith('s1', 'info', expect.stringMatching(/Post-commit rebase skipped/));
    // ...and the push that follows is a plain one.
    expect(postCommitPushOptions(r)).toBeUndefined();
    expect(mayPushAfterPostCommitRebase(r)).toBe(true);
  });

  it('runs for a "never" session only when the caller opts in, in the worktree', async () => {
    const { svc, rebaseWatcher } = makeWatcher(inst({ rebaseFrequency: 'never', createdBy: 'mcp' }), gitService);

    const r = await svc.attemptPostCommitRebase('s1', undefined, { optIn: true });

    expect(gitService.countBehindBase).toHaveBeenCalledWith(wt, 'main');
    expect(gitService.checkRemoteChanges).not.toHaveBeenCalled(); // the main checkout's view is not used
    expect(rebaseWatcher.performRebaseForPath).toHaveBeenCalledWith('s1', '/repo', 'main', wt);
    expect(r).toMatchObject({ ok: true, rewrote: true, commitsIntegrated: 4 });
    expect(postCommitPushOptions(r)).toEqual({ forceWithLease: true });
  });

  it('a UI session set to on-demand is rebased in its worktree', async () => {
    const { svc, rebaseWatcher } = makeWatcher(inst(), gitService);
    await svc.attemptPostCommitRebase('s1');
    expect(rebaseWatcher.performRebaseForPath).toHaveBeenCalledWith('s1', '/repo', 'main', wt);
  });

  it('without a rebase watcher, the fallback rebases the worktree, not the main checkout', async () => {
    gitService.rebase.mockResolvedValueOnce({ success: true, data: { success: true, message: 'ok', incomingCommits: [] } });
    const { svc } = makeWatcher(inst(), gitService);
    (svc as unknown as { rebaseWatcher: unknown }).rebaseWatcher = null;

    const r = await svc.attemptPostCommitRebase('s1');

    expect(gitService.rebase).toHaveBeenCalledTimes(1);
    expect(gitService.rebase).toHaveBeenCalledWith(wt, 'main');
    expect(r).toMatchObject({ ok: true, rewrote: true, commitsIntegrated: 4 });
  });

  it('uses the repo\'s own worktree in multi-repo mode', async () => {
    const wt2 = mkdtempSync(join(tmpdir(), 'kit-pcr-wt2-'));
    try {
      const i = { ...inst(), multiRepoEntries: [{ repoName: 'lib', repoPath: '/lib', worktreePath: wt2, baseBranch: 'develop' }] };
      const { svc, rebaseWatcher } = makeWatcher(i, gitService);
      await svc.attemptPostCommitRebase('s1', 'lib');
      expect(gitService.countBehindBase).toHaveBeenCalledWith(wt2, 'develop');
      expect(rebaseWatcher.performRebaseForPath).toHaveBeenCalledWith('s1', '/lib', 'develop', wt2);
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  });

  it('skips rather than rebase the main checkout when the worktree is gone', async () => {
    const { svc, rebaseWatcher } = makeWatcher({ ...inst(), worktreePath: join(wt, 'gone') }, gitService);
    const r = await svc.attemptPostCommitRebase('s1');
    expect(r.skipped).toBe(true);
    expect(rebaseWatcher.performRebaseForPath).not.toHaveBeenCalled();
  });

  it('a failed rebase (e.g. a rejected AI resolution) blocks the push and aborts in the worktree', async () => {
    const { svc, rebaseWatcher } = makeWatcher(inst(), gitService);
    rebaseWatcher.performRebaseForPath.mockResolvedValueOnce({
      success: false,
      message: 'Rejected AI resolution(s): big.py (finish_reason=length)',
    });

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/big\.py/);
    expect(gitService.abortRebase).toHaveBeenCalledWith(wt);
    expect(mayPushAfterPostCommitRebase(r)).toBe(false);
    expect(postCommitPushOptions(r)).toBeUndefined();
  });

  it('leaves a rebase someone else started in the worktree alone, and does not push', async () => {
    gitService.isRebaseInProgress.mockResolvedValueOnce(true);
    const { svc, rebaseWatcher } = makeWatcher(inst(), gitService);

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already in progress/);
    expect(gitService.isRebaseInProgress).toHaveBeenCalledWith(wt);
    expect(rebaseWatcher.performRebaseForPath).not.toHaveBeenCalled();
    expect(gitService.abortRebase).not.toHaveBeenCalled();
    expect(mayPushAfterPostCommitRebase(r)).toBe(false);
  });

  it('does not abort when the watcher reports a rebase of this session already running', async () => {
    const { svc, rebaseWatcher } = makeWatcher(inst(), gitService);
    rebaseWatcher.performRebaseForPath.mockResolvedValueOnce({ success: false, message: 'Rebase already in progress' });

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r.ok).toBe(false);
    expect(gitService.abortRebase).not.toHaveBeenCalled();
  });

  it('does not abort anything when it fails before starting a rebase', async () => {
    gitService.fetchRemote.mockRejectedValueOnce(new Error('network down'));
    const { svc } = makeWatcher(inst(), gitService);

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r.ok).toBe(false);
    expect(gitService.abortRebase).not.toHaveBeenCalled();
  });
});

// ─── The .devops-commit path pushes according to the rebase result ─────────

describe('.devops-commit commit path — push after the post-commit rebase', () => {
  let wt: string;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'kit-pcr-msg-'));
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  async function commitVia(rebase: Record<string, unknown>) {
    const gitService = {
      commit: jest.fn(async () => ({ success: true, data: { hash: 'abc123def', shortHash: 'abc123' } })),
      getStatus: jest.fn(async () => ({ success: true, data: { changes: [] } })),
      push: jest.fn(async () => ({ success: true })),
    };
    const { svc, activity } = makeWatcher(null, gitService);
    (svc as unknown as { emitToRenderer: unknown }).emitToRenderer = jest.fn();
    const attempt = jest.fn(async () => rebase);
    (svc as unknown as { attemptPostCommitRebase: unknown }).attemptPostCommitRebase = attempt;

    const msgFile = join(wt, '.devops-commit-s1.msg');
    writeFileSync(msgFile, 'feat: a change\n');
    await (svc as unknown as { triggerCommit: (i: unknown) => Promise<void> }).triggerCommit({
      sessionId: 's1', worktreePath: wt, repoPath: wt, agentType: 'claude', branchName: 'session',
      watcher: null, commitMsgFile: msgFile, claudeCommitMsgFile: join(wt, '.claude-commit-msg'),
    });

    // The commit runs on a 1 s debounce; wait for the push decision.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const decided = gitService.push.mock.calls.length > 0 ||
        activity.log.mock.calls.some((c) => /Push skipped/.test(String(c[2])));
      if (attempt.mock.calls.length > 0 && decided) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await svc.dispose();
    return { gitService, activity, attempt };
  }

  it('does not push after a failed rebase', async () => {
    const { gitService, activity, attempt } = await commitVia({ ok: false, rewrote: false, commitsIntegrated: 0, message: 'Rejected AI resolution(s): big.py' });
    expect(attempt).toHaveBeenCalled();
    expect(gitService.push).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith('s1', 'warning', expect.stringMatching(/Push skipped/));
  });

  it('pushes without force after a skipped rebase', async () => {
    const { gitService } = await commitVia({ ok: true, rewrote: true, skipped: true, commitsIntegrated: 0, message: 'skipped' });
    expect(gitService.push).toHaveBeenCalledWith('s1', undefined, undefined);
  });

  it('force-pushes with lease only after a rebase that ran and rewrote history', async () => {
    const { gitService } = await commitVia({ ok: true, rewrote: true, commitsIntegrated: 2, message: 'Rebased' });
    expect(gitService.push).toHaveBeenCalledWith('s1', undefined, { forceWithLease: true });
  });
});

// ─── "Behind" is the worktree's HEAD, not the main checkout (real git) ─────

describe('attemptPostCommitRebase measures behind in the session worktree (real git)', () => {
  let dir: string;
  let repo: string;
  let wt: string;
  let other: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-pcr-git-'));
    const remote = join(dir, 'remote.git');
    repo = join(dir, 'repo');
    wt = join(dir, 'wt');
    other = join(dir, 'other');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    for (const [path] of [[repo], [other]]) {
      git(dir, 'clone', '-q', remote, path);
      git(path, 'config', 'user.email', 't@example.com');
      git(path, 'config', 'user.name', 'T');
      git(path, 'config', 'commit.gpgsign', 'false');
      git(path, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    }
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', 'origin', 'main');
    git(other, 'pull', '-q', 'origin', 'main');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pushToMain(n: number) {
    for (let i = 0; i < n; i++) {
      writeFileSync(join(other, `o${i}.txt`), `${i}\n`);
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', `other ${i}`);
    }
    git(other, 'push', '-q', 'origin', 'main');
  }

  function run(worktreeBehind: boolean) {
    pushToMain(2); // the main checkout (`repo`, on main) is now 2 behind origin/main
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'worktree', 'add', '-q', '-b', 'session', wt, worktreeBehind ? 'main' : 'origin/main');
    const { svc, rebaseWatcher } = makeWatcher(
      { config: { repoPath: repo, baseBranch: 'main', rebaseFrequency: 'on-demand', createdBy: 'ui' }, worktreePath: wt },
      new GitService(),
    );
    return { svc, rebaseWatcher };
  }

  it('does not rebase a worktree that is current, however far behind the main checkout is', async () => {
    const { svc, rebaseWatcher } = run(false);
    expect(git(repo, 'rev-list', '--count', 'main..origin/main')).toBe('2');

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r).toMatchObject({ ok: true, rewrote: false, commitsIntegrated: 0 });
    expect(rebaseWatcher.performRebaseForPath).not.toHaveBeenCalled();
    expect(postCommitPushOptions(r)).toBeUndefined();
  });

  it('rebases a worktree that is behind, passing its path', async () => {
    const { svc, rebaseWatcher } = run(true);

    const r = await svc.attemptPostCommitRebase('s1');

    expect(r.commitsIntegrated).toBe(2);
    expect(rebaseWatcher.performRebaseForPath).toHaveBeenCalledWith('s1', repo, 'main', wt);
  });
});

describe('postCommitPushOptions', () => {
  it('force-pushes only after a rebase that ran, succeeded and rewrote history', () => {
    expect(postCommitPushOptions({ ok: true, rewrote: true, commitsIntegrated: 1, message: '' })).toEqual({ forceWithLease: true });
    expect(postCommitPushOptions({ ok: true, rewrote: true, skipped: true, commitsIntegrated: 0, message: '' })).toBeUndefined();
    expect(postCommitPushOptions({ ok: false, rewrote: true, commitsIntegrated: 0, message: '' })).toBeUndefined();
    expect(postCommitPushOptions({ ok: true, rewrote: false, commitsIntegrated: 0, message: '' })).toBeUndefined();
    expect(postCommitPushOptions(undefined)).toBeUndefined();
  });
});
