/**
 * KC-S3.1.5 — GitService.commit gains an optional `exclude?: string[]`.
 *
 * After stageAllChanges, when exclude is non-empty the paths are unstaged
 * with `git reset -q -- <paths>` (chunked at 200) so they stay on disk but
 * are left out of the commit. When nothing is left staged, commit throws
 * Error('nothing to commit') instead of running `git commit`.
 *
 * execa is mocked (the pattern from GitService.commits.test.ts) so the git
 * invocations can be asserted without touching a real repository.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock execa module — provide both default and named execa to handle all import patterns.
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

import { GitService } from '../../../electron/services/GitService';

/** The args array of every `git <...>` call execa was asked to run. */
function gitArgsCalls(): string[][] {
  return mockedExeca.mock.calls
    .filter((c: any[]) => c[0] === 'git')
    .map((c: any[]) => c[1] as string[]);
}

/** Args of every git call whose subcommand is `name`. */
function callsFor(name: string): string[][] {
  return gitArgsCalls().filter((args) => args[0] === name);
}

/**
 * Drive the mocked execa as a real worktree would answer, keyed by subcommand,
 * so the test does not depend on the exact call order.
 */
function stubGit(over: { stagedAfterReset?: string } = {}) {
  mockedExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    switch (args[0]) {
      case 'add':
        return { stdout: '', stderr: '' } as never;
      case 'reset':
        return { stdout: '', stderr: '' } as never;
      case 'diff':
        // `git diff --cached --name-only` — what is left staged.
        return { stdout: over.stagedAfterReset ?? 'src/app.ts', stderr: '' } as never;
      case 'commit':
        return { stdout: '[main abc123] msg', stderr: '' } as never;
      case 'rev-parse':
        return { stdout: args.includes('--short') ? 'abc123d' : 'abc123def456', stderr: '' } as never;
      case 'log':
        return { stdout: args.includes('%an') ? 'Test Author' : '2026-01-01T00:00:00Z', stderr: '' } as never;
      case 'show':
        return { stdout: 'M\tsrc/app.ts', stderr: '' } as never;
      default:
        return { stdout: '', stderr: '' } as never;
    }
  });
}

describe('GitService.commit with exclude (KC-S3.1.5)', () => {
  let gitService: InstanceType<typeof GitService>;
  const sessionId = 'sess_exclude';
  const worktree = '/tmp/worktree-exclude';

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
    gitService.registerWorktree(sessionId, '/tmp/repo', worktree);
    stubGit();
  });

  it('unstages the excluded paths with git reset after git add -A', async () => {
    const result = await gitService.commit(sessionId, 'feat: change', undefined, [
      'houserules.md',
      'uv.lock',
    ]);

    expect(result.success).toBe(true);

    const addCalls = callsFor('add');
    const resetCalls = callsFor('reset');
    expect(addCalls.length).toBeGreaterThanOrEqual(1);
    expect(addCalls[0]).toEqual(['add', '-A']);

    // Exactly one reset, carrying both excluded paths after `--`.
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0]).toEqual(['reset', '-q', '--', 'houserules.md', 'uv.lock']);

    // The reset runs AFTER the staging.
    const allArgs = gitArgsCalls();
    const addIndex = allArgs.findIndex((a) => a[0] === 'add');
    const resetIndex = allArgs.findIndex((a) => a[0] === 'reset');
    expect(resetIndex).toBeGreaterThan(addIndex);

    // The commit is still made.
    expect(callsFor('commit')).toHaveLength(1);
  });

  it('issues no git reset when exclude is omitted', async () => {
    const result = await gitService.commit(sessionId, 'feat: change');

    expect(result.success).toBe(true);
    expect(callsFor('reset')).toHaveLength(0);
    expect(callsFor('commit')).toHaveLength(1);
  });

  it('issues no git reset when exclude is an empty array', async () => {
    const result = await gitService.commit(sessionId, 'feat: change', undefined, []);

    expect(result.success).toBe(true);
    expect(callsFor('reset')).toHaveLength(0);
    expect(callsFor('commit')).toHaveLength(1);
  });

  it('throws "nothing to commit" and never commits when nothing is left staged', async () => {
    stubGit({ stagedAfterReset: '' });

    const result = await gitService.commit(sessionId, 'feat: change', undefined, ['only-file.ts']);

    // BaseService.wrap converts the throw into a failure result.
    expect(result.success).toBe(false);
    expect(result.error?.message ?? '').toContain('nothing to commit');
    expect(callsFor('commit')).toHaveLength(0);
  });

  it('leaves behaviour unchanged without exclude: stages, commits and reads the hash', async () => {
    const result = await gitService.commit(sessionId, 'feat: change');

    expect(result.success).toBe(true);
    expect(result.data?.hash).toBe('abc123def456');
    expect(result.data?.shortHash).toBe('abc123d');
    expect(result.data?.files).toEqual([{ path: 'src/app.ts', status: 'modified' }]);
    expect(callsFor('add')[0]).toEqual(['add', '-A']);
  });

  describe('chunking at 200 paths', () => {
    it('splits 201 excluded paths into two git reset calls of at most 200', async () => {
      const paths = Array.from({ length: 201 }, (_, i) => `file-${i}.txt`);

      const result = await gitService.commit(sessionId, 'feat: change', undefined, paths);

      expect(result.success).toBe(true);

      const resetCalls = callsFor('reset');
      // 201 paths => two resets (200 + 1), never one oversized command.
      expect(resetCalls).toHaveLength(2);

      for (const call of resetCalls) {
        // ['reset', '-q', '--', ...paths]
        expect(call.slice(0, 3)).toEqual(['reset', '-q', '--']);
        expect(call.length - 3).toBeLessThanOrEqual(200);
      }

      // Every path is reset exactly once, in order.
      const resetPaths = resetCalls.flatMap((c) => c.slice(3));
      expect(resetPaths).toEqual(paths);
    });

    it('issues a single git reset for exactly 200 excluded paths', async () => {
      const paths = Array.from({ length: 200 }, (_, i) => `file-${i}.txt`);

      const result = await gitService.commit(sessionId, 'feat: change', undefined, paths);

      expect(result.success).toBe(true);
      const resetCalls = callsFor('reset');
      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0].length - 3).toBe(200);
    });
  });
});
