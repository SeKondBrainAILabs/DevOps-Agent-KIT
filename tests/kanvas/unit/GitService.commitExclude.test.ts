/**
 * KC-S3.1.5 — GitService.commit can leave paths unstaged.
 *
 * `kit_commit` stages everything with `git add -A`, so a commit made in a
 * scaffolded worktree also carries the files the DevOps Agent and the worktree
 * setup wrote (houserules.md, an appended .gitignore, a uv.lock written by
 * `uv sync`). The optional `exclude` parameter resets those paths after staging
 * so they stay on disk but are not committed, and refuses with
 * "nothing to commit" when the exclusion leaves nothing staged.
 *
 * execa is mocked (as in GitService.commits.test.ts) so the exact git command
 * sequence is asserted, not just the end state.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock execa module — provide both default and named execa to handle all import patterns
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

import { GitService } from '../../../electron/services/GitService';

const SESSION = 'sess_exclude';
const REPO = '/test/worktree';

/**
 * Dispatch git calls by their arguments so the test does not depend on the
 * exact interleaving of the commit implementation's read-only probes.
 */
function routeGit(handlers: {
  addAll?: () => string;
  reset?: (paths: string[]) => string;
  cachedNames?: () => string;
  commit?: (message: string) => string;
}) {
  mockedExeca.mockImplementation(((_cmd: string, args: string[]) => {
    const [sub, ...rest] = args;
    if (sub === 'add' && rest[0] === '-A') {
      return Promise.resolve({ stdout: handlers.addAll ? handlers.addAll() : '' });
    }
    if (sub === 'reset') {
      // ['reset', '-q', '--', ...paths]
      const paths = rest.slice(rest.indexOf('--') + 1);
      return Promise.resolve({ stdout: handlers.reset ? handlers.reset(paths) : '' });
    }
    if (sub === 'diff' && rest[0] === '--cached' && rest[1] === '--name-only') {
      return Promise.resolve({ stdout: handlers.cachedNames ? handlers.cachedNames() : '' });
    }
    if (sub === 'commit') {
      const msg = rest[rest.indexOf('-m') + 1] ?? '';
      return Promise.resolve({ stdout: handlers.commit ? handlers.commit(msg) : '' });
    }
    if (sub === 'rev-parse') return Promise.resolve({ stdout: 'abc123def456' });
    if (sub === 'log') return Promise.resolve({ stdout: '2026-01-01T00:00:00Z' });
    if (sub === 'show') return Promise.resolve({ stdout: 'M\tfeature.ts' });
    return Promise.resolve({ stdout: '' });
  }) as any);
}

/** The git args of every `git commit` invocation, if any. */
function commitCalls(): string[][] {
  return mockedExeca.mock.calls
    .filter((c: any[]) => c[1]?.[0] === 'commit')
    .map((c: any[]) => c[1] as string[]);
}

/** The path lists passed to every `git reset` invocation. */
function resetCalls(): string[][] {
  return mockedExeca.mock.calls
    .filter((c: any[]) => c[1]?.[0] === 'reset')
    .map((c: any[]) => {
      const args = c[1] as string[];
      return args.slice(args.indexOf('--') + 1);
    });
}

describe('GitService.commit with exclude (KC-S3.1.5)', () => {
  let gitService: InstanceType<typeof GitService>;

  beforeEach(() => {
    jest.clearAllMocks();
    gitService = new GitService();
    gitService.registerWorktree(SESSION, REPO, REPO);
  });

  it('unstages the excluded paths with git reset after staging', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    const result = await gitService.commit(SESSION, 'feat: only the story', undefined, [
      'houserules.md',
      'uv.lock',
    ]);

    expect(result.success).toBe(true);

    // The excluded paths were reset, in a single chunk, after `--`.
    const resets = resetCalls();
    expect(resets).toHaveLength(1);
    expect(resets[0]).toEqual(['houserules.md', 'uv.lock']);

    // And the commit still went ahead because feature.ts remained staged.
    expect(commitCalls()).toHaveLength(1);
  });

  it('runs `git reset -q --` so the reset is quiet and pathspec-safe', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    await gitService.commit(SESSION, 'feat: x', undefined, ['houserules.md']);

    const resetCall = mockedExeca.mock.calls.find((c: any[]) => c[1]?.[0] === 'reset');
    expect(resetCall?.[1]).toEqual(['reset', '-q', '--', 'houserules.md']);
  });

  it('does not reset anything when exclude is omitted', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    const result = await gitService.commit(SESSION, 'feat: unchanged behaviour');

    expect(result.success).toBe(true);
    expect(resetCalls()).toHaveLength(0);
    expect(commitCalls()).toHaveLength(1);
  });

  it('does not reset anything when exclude is an empty array', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    const result = await gitService.commit(SESSION, 'feat: empty exclude', undefined, []);

    expect(result.success).toBe(true);
    expect(resetCalls()).toHaveLength(0);
    expect(commitCalls()).toHaveLength(1);
  });

  it('throws "nothing to commit" instead of committing when nothing is left staged', async () => {
    // After resetting the excluded paths, the index is empty.
    routeGit({ cachedNames: () => '' });

    const result = await gitService.commit(SESSION, 'feat: nothing left', undefined, [
      'houserules.md',
    ]);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('nothing to commit');
    // git commit must NEVER have been called.
    expect(commitCalls()).toHaveLength(0);
  });

  it('checks the staged set with `git diff --cached --name-only` before committing', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    await gitService.commit(SESSION, 'feat: x', undefined, ['houserules.md']);

    const diffCall = mockedExeca.mock.calls.find(
      (c: any[]) => c[1]?.[0] === 'diff' && c[1]?.[1] === '--cached'
    );
    expect(diffCall?.[1]).toEqual(['diff', '--cached', '--name-only']);
  });

  it('resets a large exclude list in chunks of 200 paths', async () => {
    const paths = Array.from({ length: 450 }, (_, i) => `gen/file-${i}.txt`);
    routeGit({ cachedNames: () => 'feature.ts' });

    const result = await gitService.commit(SESSION, 'feat: many exclusions', undefined, paths);

    expect(result.success).toBe(true);
    const resets = resetCalls();
    expect(resets).toHaveLength(3);
    expect(resets[0]).toHaveLength(200);
    expect(resets[1]).toHaveLength(200);
    expect(resets[2]).toHaveLength(50);
    // Every path is reset exactly once, in order.
    expect(resets.flat()).toEqual(paths);
  });

  it('keeps the excluded files on disk (no checkout/clean/rm of them)', async () => {
    routeGit({ cachedNames: () => 'feature.ts' });

    await gitService.commit(SESSION, 'feat: x', undefined, ['houserules.md', 'uv.lock']);

    const destructive = mockedExeca.mock.calls.filter((c: any[]) =>
      ['checkout', 'clean', 'rm'].includes(c[1]?.[0])
    );
    expect(destructive).toHaveLength(0);
  });
});
