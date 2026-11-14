/**
 * performRebaseForPath rebases the checkout it is given (real git).
 *
 * It used to hand the rebase to the session's watched state whenever one was
 * registered, whatever worktree and base the caller passed. A session watched
 * in one worktree and rebased (kit_rebase, post-commit) in another was then
 * rebased — and on failure aborted — in the wrong checkout. The watched state
 * is now used only when its checkout and base match; otherwise a transient
 * state runs in the passed worktree. While the watched state is mid-rebase
 * the call is still refused.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

// execa is ESM-only; a child_process stand-in that records where each git command ran.
const execFileP = promisify(execFile);
const mockGitCalls: Array<{ args: string[]; cwd?: string }> = [];
jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (cmd === 'git') mockGitCalls.push({ args, cwd: opts.cwd });
    return execFileP(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf-8' });
  };
  return { __esModule: true, default: run, execa: run };
});

import { RebaseWatcherService } from '../../../electron/services/RebaseWatcherService';
import { GitService } from '../../../electron/services/GitService';
import { MergeConflictService } from '../../../electron/services/MergeConflictService';
import type { AIService } from '../../../electron/services/AIService';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function pyModule(n: number, variant: string): string {
  const out: string[] = ['"""A module."""', ''];
  for (let i = 0; i < n; i++) {
    out.push(`def f${i}(x):`);
    out.push(i === 50 ? `    return x + ${JSON.stringify(variant)}` : `    return x + ${i}`);
    out.push('');
  }
  return out.join('\n');
}

describe('performRebaseForPath rebases the passed worktree, not the watched one (real git)', () => {
  const N = 120;
  let dir: string;
  let repo: string;
  let wt1: string; // the watched worktree (branch sess, changes a.py)
  let wt2: string; // another worktree passed by the caller (branch sess2, changes b.py)
  let tip1: string;
  let tip2: string;
  let svc: RebaseWatcherService;
  let ai: { sendWithMode: jest.Mock; sendWithModeDetailed: jest.Mock };
  let prevEditor: string | undefined;

  const configure = (c: string) => {
    git(c, 'config', 'user.email', 't@example.com');
    git(c, 'config', 'user.name', 'T');
    git(c, 'config', 'commit.gpgsign', 'false');
  };
  const rebaseInProgress = (wt: string) =>
    ['rebase-merge', 'rebase-apply'].some((n) => existsSync(resolve(wt, git(wt, 'rev-parse', '--git-path', n))));

  beforeEach(async () => {
    prevEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'false';
    dir = mkdtempSync(join(tmpdir(), 'kit-rebase-for-path-'));
    const remote = join(dir, 'origin.git');
    const other = join(dir, 'other');
    repo = join(dir, 'repo');
    wt1 = join(dir, 'wt1');
    wt2 = join(dir, 'wt2');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '-q', remote, repo);
    configure(repo);
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(repo, 'a.py'), pyModule(N, 'base'));
    writeFileSync(join(repo, 'b.py'), pyModule(N, 'base'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', 'origin', 'main');

    git(repo, 'worktree', 'add', '-q', '-b', 'sess', wt1, 'main');
    writeFileSync(join(wt1, 'a.py'), pyModule(N, 'one'));
    git(wt1, 'commit', '-q', '-am', 'sess change');
    tip1 = git(wt1, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-q', '-b', 'sess2', wt2, 'main');
    writeFileSync(join(wt2, 'b.py'), pyModule(N, 'two'));
    git(wt2, 'commit', '-q', '-am', 'sess2 change');
    tip2 = git(wt2, 'rev-parse', 'HEAD');

    git(dir, 'clone', '-q', remote, other);
    configure(other);
    writeFileSync(join(other, 'a.py'), pyModule(N, 'main'));
    writeFileSync(join(other, 'b.py'), pyModule(N, 'main'));
    git(other, 'commit', '-q', '-am', 'main change');
    git(other, 'push', '-q', 'origin', 'main');

    ai = {
      sendWithMode: jest.fn(async () => ({ success: false, error: { code: 'X', message: 'no analysis' } })),
      sendWithModeDetailed: jest.fn(),
    };
    const gitService = new GitService();
    svc = new RebaseWatcherService(gitService);
    svc.setMergeConflictService(new MergeConflictService(ai as unknown as AIService));
    await svc.startWatching({
      sessionId: 'sess_1',
      repoPath: repo,
      worktreePath: wt1,
      baseBranch: 'main',
      currentBranch: 'sess',
      rebaseFrequency: 'on-demand',
      pollIntervalMs: 3_600_000,
    });
    mockGitCalls.length = 0;
  });

  afterEach(async () => {
    await svc.stopWatching('sess_1').catch(() => {});
    if (prevEditor === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = prevEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  const rebaseCalls = () => mockGitCalls.filter((c) => c.args.includes('rebase'));

  it('a rejected resolution is rebased and aborted in the passed worktree; the watched one is untouched', async () => {
    const truncated = pyModule(N, 'merged').split('\n').slice(0, 30).join('\n');
    ai.sendWithModeDetailed.mockResolvedValue({ success: true, data: { content: truncated, finishReason: 'length' } } as never);

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt2);

    expect(r.success).toBe(false);
    // The conflict the AI was asked about is wt2's file.
    const asked = (ai.sendWithModeDetailed.mock.calls[0][0] as { variables: { file_path: string } }).variables.file_path;
    expect(asked).toBe('b.py');
    // Every rebase command, the abort included, ran in wt2.
    expect(rebaseCalls().length).toBeGreaterThan(0);
    expect(rebaseCalls().some((c) => c.args.includes('--abort'))).toBe(true);
    for (const c of rebaseCalls()) expect(resolve(c.cwd!)).toBe(resolve(wt2));
    expect(rebaseInProgress(wt2)).toBe(false);
    expect(git(wt2, 'rev-parse', 'HEAD')).toBe(tip2);
    expect(rebaseInProgress(wt1)).toBe(false);
    expect(git(wt1, 'rev-parse', 'HEAD')).toBe(tip1);
  });

  it('a good resolution rebases the passed worktree onto origin/main; the watched one is untouched', async () => {
    ai.sendWithModeDetailed.mockResolvedValue({ success: true, data: { content: pyModule(N, 'merged'), finishReason: 'stop' } } as never);

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt2);

    expect(r.success).toBe(true);
    for (const c of rebaseCalls()) expect(resolve(c.cwd!)).toBe(resolve(wt2));
    expect(git(wt2, 'rev-parse', 'HEAD~1')).toBe(git(wt2, 'rev-parse', 'origin/main'));
    expect(git(wt1, 'rev-parse', 'HEAD')).toBe(tip1);
  });

  it('uses the watched state when the checkout and base match, and a transient one otherwise', async () => {
    const watched = (svc as any).watchedSessions.get('sess_1');
    const spy = jest.spyOn(svc as any, 'performAutoRebase').mockResolvedValue({ success: true, message: 'stub' } as never);

    await svc.performRebaseForPath('sess_1', repo, 'main', wt1);
    expect(spy.mock.calls[0][0]).toBe(watched);

    await svc.performRebaseForPath('sess_1', repo, 'main', wt2);
    expect(spy.mock.calls[1][0]).not.toBe(watched);
    expect((spy.mock.calls[1][0] as any).config.worktreePath).toBe(wt2);

    await svc.performRebaseForPath('sess_1', repo, 'develop', wt1); // same checkout, other base
    expect(spy.mock.calls[2][0]).not.toBe(watched);
    expect((spy.mock.calls[2][0] as any).config.baseBranch).toBe('develop');
  });

  it('still refuses while the watched state is mid-rebase', async () => {
    (svc as any).watchedSessions.get('sess_1').isRebasing = true;

    const r = await svc.performRebaseForPath('sess_1', repo, 'main', wt2);

    expect(r).toEqual({ success: false, message: 'Rebase already in progress' });
    expect(rebaseCalls()).toEqual([]);
    expect(git(wt2, 'rev-parse', 'HEAD')).toBe(tip2);
  });
});
