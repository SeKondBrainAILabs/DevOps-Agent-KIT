/**
 * GitService.getReapSafetyInfo — story KIT-MCP-R1
 *
 * Run against a REAL git repository, because the whole point of this method is
 * what git actually does when a ref does not resolve — which is precisely what
 * the method it replaces gets wrong.
 *
 * ## The bug this exists to avoid
 *
 * `getWorktreeSafetyInfo` compares HEAD against hardcoded `main` and
 * `development` inside a swallow-all `safe()`. On a repo whose primary branch
 * is `trunk` or `master`, both comparisons throw, both are swallowed, and it
 * returns `unmergedCommitCount: 0` with `mergedIntoBranches: ['main',
 * 'development']`. The first test below demonstrates that on a real repo
 * holding a real unmerged commit, so the regression is pinned rather than
 * described.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitService } from '../../../electron/services/GitService';

let repo: string;
let git: GitService;

const sh = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kit-reap-'));
  git = new GitService();
  sh('init', '-q', '-b', 'trunk', '.');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'base');
  sh('add', '.');
  sh('commit', '-qm', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the failure mode in getWorktreeSafetyInfo', () => {
  it('reports a branch with real unmerged work as clean and merged', async () => {
    // This is the OLD method, kept as a regression pin. If someone later fixes
    // it, this test fails loudly and the reaper can be simplified.
    sh('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'important.txt'), 'work that must not be lost');
    sh('add', '.');
    sh('commit', '-qm', 'unmerged work');

    const res = await git.getWorktreeSafetyInfo(repo);

    expect(res.success).toBe(true);
    // Both comparisons failed and were swallowed:
    expect(res.data?.unmergedCommitCount).toBe(0);
    expect(res.data?.mergedIntoBranches).toEqual(['main', 'development']);
    // ...while a real commit sits on the branch.
    expect(sh('rev-list', '--count', 'trunk..HEAD')).toBe('1');
  });
});

describe('getReapSafetyInfo — conclusive results', () => {
  it('reports a clean, fully merged branch as conclusively deletable', async () => {
    sh('checkout', '-q', '-b', 'feature');

    const res = await git.getReapSafetyInfo(repo, 'trunk');

    expect(res.data).toMatchObject({
      conclusive: true,
      hasUncommittedChanges: false,
      unmergedCommitCount: 0,
      comparedAgainst: 'trunk',
    });
  });

  it('counts commits ahead of the session base branch', async () => {
    sh('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'b.txt'), '1');
    sh('add', '.');
    sh('commit', '-qm', 'one');
    writeFileSync(join(repo, 'c.txt'), '2');
    sh('add', '.');
    sh('commit', '-qm', 'two');

    const res = await git.getReapSafetyInfo(repo, 'trunk');

    expect(res.data?.conclusive).toBe(true);
    expect(res.data?.unmergedCommitCount).toBe(2);
  });

  it('detects uncommitted tracked changes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'modified');

    const res = await git.getReapSafetyInfo(repo, 'trunk');

    expect(res.data?.hasUncommittedChanges).toBe(true);
  });

  it('detects untracked files as uncommitted work', async () => {
    // These are invisible to `git stash create`, so they are the state most
    // likely to be lost. They must at minimum block deletion.
    writeFileSync(join(repo, 'brand-new.txt'), 'agent output');

    const res = await git.getReapSafetyInfo(repo, 'trunk');

    expect(res.data?.hasUncommittedChanges).toBe(true);
  });
});

describe('getReapSafetyInfo — inconclusive results refuse to authorise deletion', () => {
  it('is INCONCLUSIVE when the base branch does not resolve', async () => {
    // The exact scenario that breaks getWorktreeSafetyInfo.
    sh('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'important.txt'), 'work that must not be lost');
    sh('add', '.');
    sh('commit', '-qm', 'unmerged work');

    const res = await git.getReapSafetyInfo(repo, 'main');

    expect(res.data?.conclusive).toBe(false);
    expect(res.data?.inconclusiveReason).toMatch(/does not resolve/i);
    // Crucially it does NOT report a confident zero that a caller could act on.
    expect(res.data?.unmergedCommitCount).toBe(0);
  });

  it('is INCONCLUSIVE when the session records no base branch', async () => {
    const res = await git.getReapSafetyInfo(repo, undefined);

    expect(res.data?.conclusive).toBe(false);
    expect(res.data?.inconclusiveReason).toMatch(/no base branch/i);
  });

  it('is INCONCLUSIVE and assumes work exists when the path is not a repo', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'kit-notrepo-'));
    try {
      const res = await git.getReapSafetyInfo(notARepo, 'main');

      expect(res.data?.conclusive).toBe(false);
      // Assuming there IS work is the safe direction: every caller refuses.
      expect(res.data?.hasUncommittedChanges).toBe(true);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('resolves a base branch that exists, in the same repo where another does not', async () => {
    // Guards against an over-broad fix that just declares everything
    // inconclusive.
    sh('branch', 'development');
    sh('checkout', '-q', '-b', 'feature');

    expect((await git.getReapSafetyInfo(repo, 'development')).data?.conclusive).toBe(true);
    expect((await git.getReapSafetyInfo(repo, 'main')).data?.conclusive).toBe(false);
  });
});
