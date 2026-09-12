/**
 * Unit tests for GitService rebase/sync command wiring.
 * Ensures pull/fetch paths disable submodule recursion so parent repo sync works
 * even when submodules are inaccessible.
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

const REPO = '/Users/me/work/core';

const queueOk = (stdout = ''): void => {
  mockedExeca.mockResolvedValueOnce({ stdout } as never);
};

describe('GitService rebase/sync command options', () => {
  let svc: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new GitService();
  });

  it('performRebaseWithAI fetches origin branch with submodule recursion disabled', async () => {
    queueOk(''); // fetch origin <branch>
    queueOk(''); // status --porcelain (stash check: no local changes)

    const mergeConflictService = {
      rebaseWithResolution: jest.fn().mockResolvedValue({
        success: true,
        data: {
          success: true,
          message: 'Rebase completed without conflicts',
          conflictsResolved: 0,
          conflictsFailed: 0,
          resolutions: [],
        },
      } as never),
    };

    const result = await svc.performRebaseWithAI(
      REPO,
      'Development',
      mergeConflictService as any
    );

    expect(result.success).toBe(true);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-c', 'fetch.recurseSubmodules=false', 'fetch', 'origin', 'Development'],
      { cwd: REPO }
    );
    expect(mergeConflictService.rebaseWithResolution).toHaveBeenCalledWith(REPO, 'Development');
  });

  it('rebase uses pull --rebase with submodule recursion disabled', async () => {
    queueOk('abc123'); // rev-parse HEAD
    queueOk('10'); // rev-list --count HEAD
    queueOk('0'); // rev-list --count HEAD..origin/main
    queueOk('Already up to date.');
    queueOk('abc123'); // rev-parse HEAD after pull
    queueOk('10'); // rev-list --count HEAD after pull

    const result = await svc.rebase(REPO, 'main');

    expect(result.success).toBe(true);
    expect(result.data?.success).toBe(true);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      4,
      'git',
      [
        '-c',
        'fetch.recurseSubmodules=false',
        '-c',
        'submodule.recurse=false',
        'pull',
        '--rebase',
        'origin',
        'main',
      ],
      { cwd: REPO }
    );
    expect(result.data?.message).toBe('Already up to date - no changes from remote');
  });

  it('checkRemoteChanges fetches origin with submodule recursion disabled', async () => {
    queueOk('');
    queueOk('2\t1');

    const result = await svc.checkRemoteChanges(REPO, 'main');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ behind: 2, ahead: 1 });
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-c', 'fetch.recurseSubmodules=false', 'fetch', 'origin'],
      { cwd: REPO }
    );
  });
});
