/**
 * Unit Tests for GitService.getRepoStatus (Day 1.5)
 *
 * Mocks `execa` and verifies that getRepoStatus issues 4 git commands,
 * tolerates per-call failures, and assembles the final RepoStatus.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock execa for both import patterns.
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));
const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

import { GitService } from '../../../electron/services/GitService';

const REPO = '/Users/me/work/kanvas';

/** Convenience: queue stdout for one git invocation. */
function queueOk(stdout: string): void {
  mockedExeca.mockResolvedValueOnce({ stdout } as never);
}

function queueErr(message: string): void {
  mockedExeca.mockRejectedValueOnce(new Error(message) as never);
}

describe('GitService.getRepoStatus — happy path', () => {
  let svc: InstanceType<typeof GitService>;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = new GitService();
  });

  it('assembles a full RepoStatus from 4 git invocations', async () => {
    // 1) status --porcelain=v2 -b
    queueOk(
      [
        '# branch.oid abc123',
        '# branch.head feat/login',
        '# branch.upstream origin/feat/login',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 abc abc src/staged.ts',
        '1 .M N... 100644 100644 100644 abc abc src/dirty.ts',
        '? src/new.ts',
        '',
      ].join('\n')
    );
    // 2) stash list
    queueOk('stash@{0}: WIP on main\nstash@{1}: WIP on main');
    // 3) worktree list --porcelain
    queueOk(
      [
        'worktree /Users/me/work/kanvas',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /Users/me/work/kanvas/local_deploy/feat-x',
        'HEAD def',
        'branch refs/heads/feat-x',
      ].join('\n')
    );
    // 4) log -1
    queueOk('abc123def4|abc123d|feat: add login flow|2026-05-01T10:00:00Z');

    const result = await svc.getRepoStatus(REPO);

    expect(result.success).toBe(true);
    expect(result.data?.repoPath).toBe(REPO);
    expect(result.data?.currentBranch).toBe('feat/login');
    expect(result.data?.upstream).toBe('origin/feat/login');
    expect(result.data?.ahead).toBe(2);
    expect(result.data?.behind).toBe(1);
    expect(result.data?.stagedCount).toBe(1);
    expect(result.data?.modifiedCount).toBe(1);
    expect(result.data?.untrackedCount).toBe(1);
    expect(result.data?.stashCount).toBe(2);
    expect(result.data?.worktreeCount).toBe(2);
    expect(result.data?.lastCommit?.shortSha).toBe('abc123d');
    expect(result.data?.lastCommit?.subject).toBe('feat: add login flow');
    expect(result.data?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('runs the 4 invocations against the supplied repoPath', async () => {
    queueOk('# branch.head main\n');
    queueOk('');
    queueOk('worktree /Users/me/work/kanvas\n');
    queueOk('');
    await svc.getRepoStatus(REPO);
    expect(mockedExeca).toHaveBeenCalledTimes(4);
    for (const call of mockedExeca.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2]).toMatchObject({ cwd: REPO });
    }
  });

  it('uses the porcelain v2 flags on the status call', async () => {
    queueOk('# branch.head main\n');
    queueOk('');
    queueOk('');
    queueOk('');
    await svc.getRepoStatus(REPO);
    const statusCall = mockedExeca.mock.calls[0];
    expect(statusCall[1]).toEqual(['status', '--porcelain=v2', '-b']);
  });
});

describe('GitService.getRepoStatus — fault tolerance', () => {
  let svc: InstanceType<typeof GitService>;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = new GitService();
  });

  it('survives a failing stash list (returns 0 stashes)', async () => {
    queueOk('# branch.head main\n');
    queueErr('git stash failed');
    queueOk('worktree /repo\n');
    queueOk('sha|short|sub|2026-04-01T00:00:00Z');
    const result = await svc.getRepoStatus(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.stashCount).toBe(0);
    expect(result.data?.worktreeCount).toBe(1);
  });

  it('survives a failing worktree list (returns 0 worktrees)', async () => {
    queueOk('# branch.head main\n');
    queueOk('');
    queueErr('git worktree failed');
    queueOk('sha|short|sub|2026-04-01T00:00:00Z');
    const result = await svc.getRepoStatus(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.worktreeCount).toBe(0);
  });

  it('survives a failing log (omits lastCommit)', async () => {
    queueOk('# branch.head main\n');
    queueOk('');
    queueOk('worktree /repo\n');
    queueErr('no commits yet');
    const result = await svc.getRepoStatus(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.lastCommit).toBeUndefined();
  });

  it('returns sensible defaults when status fails (detached + zero counts)', async () => {
    queueErr('git status failed');
    queueOk('');
    queueOk('');
    queueOk('');
    const result = await svc.getRepoStatus(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.currentBranch).toBe('(detached)');
    expect(result.data?.modifiedCount).toBe(0);
    expect(result.data?.stagedCount).toBe(0);
    expect(result.data?.untrackedCount).toBe(0);
  });
});
