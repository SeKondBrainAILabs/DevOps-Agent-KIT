/**
 * Unit Tests for GitService.listBranchesForRepo (Day 2)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));
const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

import { GitService } from '../../../electron/services/GitService';

const REPO = '/Users/me/work/kanvas';

const queueOk = (stdout: string) =>
  mockedExeca.mockResolvedValueOnce({ stdout } as never);
const queueErr = (msg: string) =>
  mockedExeca.mockRejectedValueOnce(new Error(msg) as never);

describe('GitService.listBranchesForRepo (Day 2)', () => {
  let svc: InstanceType<typeof GitService>;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = new GitService();
  });

  it('assembles rows with hygiene flags from 5 git invocations', async () => {
    queueOk('origin/main'); // symbolic-ref refs/remotes/origin/HEAD
    queueOk(
      // for-each-ref refs/heads
      ['main|1700000000', 'feat/login|1700100000', 'feat/old|1640000000'].join('\n')
    );
    queueOk('feat/login'); // current branch
    queueOk('main\nfeat/old'); // merged into default
    queueOk('origin/main\norigin/feat/login'); // remote refs
    queueOk(
      // worktree list --porcelain
      [
        'worktree /Users/me/work/kanvas',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /Users/me/work/kanvas/local_deploy/feat-login',
        'HEAD def',
        'branch refs/heads/feat/login',
      ].join('\n')
    );

    const result = await svc.listBranchesForRepo(REPO);
    expect(result.success).toBe(true);
    const rows = result.data!;
    expect(rows.map((r) => r.name)).toEqual(['feat/login', 'main', 'feat/old']);

    const main = rows.find((r) => r.name === 'main')!;
    expect(main.isCurrent).toBe(false);
    expect(main.mergedIntoDefault).toBe(true);
    expect(main.deletedOnRemote).toBe(false);
    expect(main.hasWorktree).toBe(true);

    const featLogin = rows.find((r) => r.name === 'feat/login')!;
    expect(featLogin.isCurrent).toBe(true);
    expect(featLogin.mergedIntoDefault).toBe(false);
    expect(featLogin.deletedOnRemote).toBe(false);
    expect(featLogin.hasWorktree).toBe(true);

    const featOld = rows.find((r) => r.name === 'feat/old')!;
    expect(featOld.mergedIntoDefault).toBe(true);
    expect(featOld.deletedOnRemote).toBe(true); // not in remoteSet, not the default
    expect(featOld.hasWorktree).toBe(false);
  });

  it('falls back to "main" as default when origin/HEAD is missing', async () => {
    queueErr('no remote head'); // symbolic-ref fails
    queueOk('main|1700000000');
    queueOk('main');
    queueOk('main');
    queueOk('');
    queueOk('');
    const result = await svc.listBranchesForRepo(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.[0].name).toBe('main');
  });

  it('still returns rows even when several sub-calls fail', async () => {
    queueOk('origin/main'); // default ok
    queueOk('feat/x|1700100000\nmain|1700000000'); // for-each-ref ok
    queueErr('detached'); // current
    queueErr('merged-fail'); // merged
    queueErr('remote-fail'); // remote refs
    queueErr('worktree-fail'); // worktree
    const result = await svc.listBranchesForRepo(REPO);
    expect(result.success).toBe(true);
    expect(result.data?.length).toBe(2);
    // All hygiene flags conservative on failure paths.
    expect(result.data?.[0].isCurrent).toBe(false);
    expect(result.data?.[0].hasWorktree).toBe(false);
  });

  it('sorts branches by lastCommitMs descending then name asc', async () => {
    queueOk('origin/main');
    queueOk(
      ['zed|1700000001', 'alpha|1700000001', 'mid|1700000000'].join('\n')
    );
    queueOk('alpha');
    queueOk('');
    queueOk('');
    queueOk('');
    const result = await svc.listBranchesForRepo(REPO);
    expect(result.data?.map((r) => r.name)).toEqual(['alpha', 'zed', 'mid']);
  });
});
