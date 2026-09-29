/**
 * KC-S3.1.1: kit_commit, kit_commit_all and kit_get_commit_history return the
 * paths each commit changed, [{path, status}], not just a count.
 *
 * GitService runs REAL git here: execa (ESM-only) is replaced by a thin
 * child_process wrapper, and each test works in a fresh temp repository.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  return { __esModule: true, default: run, execa: run };
});

import { GitService } from '../../../electron/services/GitService';
import { parseNameStatus } from '../../../shared/git-name-status';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('commit files (KC-S3.1.1)', () => {
  let repo: string;
  let svc: InstanceType<typeof GitService>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-commit-files-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, 'keep.txt'), 'one\n');
    writeFileSync(join(repo, 'gone.txt'), 'bye\n');
    writeFileSync(join(repo, 'old-name.txt'), 'same content for the rename\n'.repeat(5));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    svc = new GitService();
    svc.registerWorktree('sess_files', repo, repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('kit_commit returns files: 1 add, 1 modify, 1 delete, 1 rename', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    writeFileSync(join(repo, 'keep.txt'), 'two\n');
    unlinkSync(join(repo, 'gone.txt'));
    renameSync(join(repo, 'old-name.txt'), join(repo, 'new-name.txt'));

    const result = await svc.commit('sess_files', 'feat: change files');
    expect(result.success).toBe(true);
    const files = [...(result.data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    expect(files).toEqual([
      { path: 'gone.txt', status: 'deleted' },
      { path: 'keep.txt', status: 'modified' },
      { path: 'new-name.txt', status: 'renamed', from: 'old-name.txt' },
      { path: 'new.txt', status: 'added' },
    ]);
    expect(result.data?.filesChanged).toBe(4);
  });

  it('getCommitFiles reads any commit, including ones made before files were recorded', async () => {
    writeFileSync(join(repo, 'later.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'made outside KIT');
    const hash = git(repo, 'rev-parse', 'HEAD');
    const files = await svc.getCommitFiles(repo, hash);
    expect(files.success).toBe(true);
    expect(files.data).toEqual([{ path: 'later.txt', status: 'added' }]);
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
    const rootFiles = await svc.getCommitFiles(repo, root);
    expect(rootFiles.data?.map(f => f.status)).toEqual(['added', 'added', 'added']);
  });

  it('parses copies and type changes', () => {
    expect(parseNameStatus('C075\ta.txt\tb.txt\nT\tlink\nM\tx.ts\n')).toEqual([
      { path: 'b.txt', status: 'added' },
      { path: 'link', status: 'modified' },
      { path: 'x.ts', status: 'modified' },
    ]);
  });
});
