/**
 * KC-S3.1.4: kit_get_diff returns a session's unified diff against its base.
 * GitService runs REAL git (execa replaced by a child_process wrapper).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  return { __esModule: true, default: run, execa: run };
});

import { GitService } from '../../../electron/services/GitService';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('mcp tools kit_get_diff (KC-S3.1.4)', () => {
  let repo: string;
  const svc = new GitService();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-diff-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'gone.txt'), 'bye\n');
    writeFileSync(join(repo, 'old-name.txt'), 'rename me please\n'.repeat(6));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-q', '-b', 'session');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('diffs the session against the merge-base with its base branch: add, modify, delete, rename', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    writeFileSync(join(repo, 'keep.txt'), 'one\nTWO\nthree\n');
    unlinkSync(join(repo, 'gone.txt'));
    renameSync(join(repo, 'old-name.txt'), join(repo, 'new-name.txt'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'work');
    writeFileSync(join(repo, 'keep.txt'), 'one\nTWO\nthree\nfour\n'); // uncommitted on top

    const result = await svc.getSessionDiff(repo, { baseBranch: 'main' });
    expect(result.success).toBe(true);
    const { base, diff, files, truncated } = result.data!;
    expect(base).toBe(git(repo, 'rev-parse', 'main'));
    expect(truncated).toBe(false);
    const byPath = Object.fromEntries(files.map(f => [f.path, f]));
    expect(byPath['new.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(byPath['keep.txt']).toMatchObject({ status: 'modified', additions: 3, deletions: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'renamed', from: 'old-name.txt' });
    expect(diff).toContain('+four');
    expect(diff).toContain('rename from old-name.txt');
  });

  it('diffs since a commit and limits to paths', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'a');
    const since = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    writeFileSync(join(repo, 'keep.txt'), 'changed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'b');
    const sinceResult = await svc.getSessionDiff(repo, { since });
    expect(sinceResult.data!.files.map(f => f.path).sort()).toEqual(['b.txt', 'keep.txt']);
    const scoped = await svc.getSessionDiff(repo, { since, paths: ['b.txt'] });
    expect(scoped.data!.files.map(f => f.path)).toEqual(['b.txt']);
    expect(scoped.data!.diff).not.toContain('keep.txt');
  });

  it('caps the diff at max_bytes and lists binary files without inlining them', async () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(80) + '\n'.repeat(1) + 'line of text\n'.repeat(5000));
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'big');
    const result = await svc.getSessionDiff(repo, { baseBranch: 'main', maxBytes: 4096 });
    const { diff, files, truncated } = result.data!;
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(4096);
    expect(diff.endsWith('\n')).toBe(true);
    const binary = files.find(f => f.path === 'image.bin');
    expect(binary).toMatchObject({ status: 'added', binary: true, additions: 0, deletions: 0 });
    const full = await svc.getSessionDiff(repo, { baseBranch: 'main' });
    expect(full.data!.truncated).toBe(false);
    expect(full.data!.diff).toMatch(/Binary files .* differ/);
  });

  it('fails clearly when there is no base to diff against', async () => {
    const result = await svc.getSessionDiff(repo, { baseBranch: 'no-such-branch' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/merge-base/);
  });
});
