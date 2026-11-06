/**
 * KC-S3.1.5 (AC1): GitService.commit gains an optional 4th `exclude` param.
 *
 * When `exclude` is non-empty the listed worktree-relative paths are staged by
 * `add -A` and then unstaged again with `git reset -q -- <paths>` (in chunks of
 * 200), so they stay on disk but are left out of THIS commit. When the exclude
 * list leaves nothing staged, commit() throws `nothing to commit` instead of
 * running `git commit`.
 *
 * execa (ESM-only) is replaced by a dispatch mock so the exact git argv can be
 * asserted without a real repository.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

interface Call {
  args: string[];
  cwd?: string;
}

const calls: Call[] = [];

/**
 * Dispatch a git invocation to a canned stdout. `overrides` lets a test make a
 * specific command fail or return a specific value; the default is a sensible
 * success for every command commit() issues.
 */
function makeRunner(
  overrides: Array<{ match: (args: string[]) => boolean; result: { stdout?: string } | Error }> = []
) {
  return (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    calls.push({ args, cwd: opts.cwd });
    for (const o of overrides) {
      if (o.match(args)) {
        if (o.result instanceof Error) return Promise.reject(o.result);
        return Promise.resolve({ stdout: o.result.stdout ?? '', stderr: '' });
      }
    }
    // Defaults, keyed off the first git subcommand.
    const sub = args[0];
    if (sub === 'add') return Promise.resolve({ stdout: '', stderr: '' });
    if (sub === 'reset') return Promise.resolve({ stdout: '', stderr: '' });
    if (sub === 'diff') return Promise.resolve({ stdout: 'kept.txt\n', stderr: '' });
    if (sub === 'commit') return Promise.resolve({ stdout: '', stderr: '' });
    if (sub === 'rev-parse') return Promise.resolve({ stdout: args.includes('--short') ? 'abc123d' : 'abc123def456', stderr: '' });
    if (sub === 'log') return Promise.resolve({ stdout: args.includes('%an') ? 'kit' : '2026-01-01T00:00:00Z', stderr: '' });
    if (sub === 'show') return Promise.resolve({ stdout: 'A\tkept.txt\n', stderr: '' });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
}

const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

import { GitService } from '../../../electron/services/GitService';

// The `git` helper caches the resolved execa function on first use; it caches
// the MOCK function object, so per-test mockImplementation still applies.
function freshService(): InstanceType<typeof GitService> {
  const svc = new GitService();
  svc.registerWorktree('sess_ex', '/repo', '/repo');
  return svc;
}

const argsOf = (sub: string) => calls.filter((c) => c.args[0] === sub).map((c) => c.args);

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});

describe('GitService.commit exclude (KC-S3.1.5 AC1)', () => {
  it('unstages exactly the excluded paths after staging, before committing', async () => {
    mockExecaFn.mockImplementation(makeRunner() as never);
    const svc = freshService();

    const result = await svc.commit('sess_ex', 'feat: keep scaffolding out', undefined, [
      'houserules.md',
      'FOLDER_STRUCTURE.md',
      '.vscode/settings.json',
      '.gitignore',
      'uv.lock',
    ]);

    expect(result.success).toBe(true);

    // The reset must name every excluded path, after `add -A`.
    const resets = argsOf('reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toEqual([
      'reset', '-q', '--',
      'houserules.md',
      'FOLDER_STRUCTURE.md',
      '.vscode/settings.json',
      '.gitignore',
      'uv.lock',
    ]);

    // Ordering: add -A, then reset, then commit.
    const order = calls.map((c) => c.args[0]);
    expect(order.indexOf('add')).toBeLessThan(order.indexOf('reset'));
    expect(order.indexOf('reset')).toBeLessThan(order.indexOf('commit'));
  });

  it('chunks the reset into groups of 200 paths', async () => {
    mockExecaFn.mockImplementation(makeRunner() as never);
    const svc = freshService();

    const exclude = Array.from({ length: 450 }, (_, i) => `scaffold/file-${i}.txt`);
    const result = await svc.commit('sess_ex', 'feat: many excludes', undefined, exclude);

    expect(result.success).toBe(true);
    const resets = argsOf('reset');
    expect(resets).toHaveLength(3);
    expect(resets[0]).toHaveLength(2 + 200); // 'reset', '-q', 200 paths
    expect(resets[1]).toHaveLength(2 + 200);
    expect(resets[2]).toHaveLength(2 + 50);
    // Every path appears exactly once across the chunks.
    const named = resets.flatMap((r) => r.slice(2));
    expect(named.sort()).toEqual([...exclude].sort());
  });

  it('throws "nothing to commit" and does not run git commit when everything staged is excluded', async () => {
    mockExecaFn.mockImplementation(
      makeRunner([
        { match: (a) => a[0] === 'diff', result: { stdout: '' } },
      ]) as never
    );
    const svc = freshService();

    const result = await svc.commit('sess_ex', 'feat: nothing left', undefined, ['only.txt']);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('nothing to commit');
    // git commit must NOT have been invoked.
    expect(argsOf('commit')).toHaveLength(0);
  });

  it('does not reset when exclude is omitted (behaviour unchanged)', async () => {
    mockExecaFn.mockImplementation(makeRunner() as never);
    const svc = freshService();

    const result = await svc.commit('sess_ex', 'feat: normal commit');

    expect(result.success).toBe(true);
    expect(argsOf('reset')).toHaveLength(0);
    expect(argsOf('commit')).toHaveLength(1);
  });

  it('does not reset when exclude is an empty array', async () => {
    mockExecaFn.mockImplementation(makeRunner() as never);
    const svc = freshService();

    const result = await svc.commit('sess_ex', 'feat: empty exclude', undefined, []);

    expect(result.success).toBe(true);
    expect(argsOf('reset')).toHaveLength(0);
    expect(argsOf('commit')).toHaveLength(1);
  });
});
