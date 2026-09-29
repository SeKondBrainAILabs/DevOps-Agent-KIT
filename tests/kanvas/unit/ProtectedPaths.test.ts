/**
 * KC-S3.1.2: a session protects paths (kit_lock_file mode "protect"), and
 * kit_commit in that SAME session refuses a commit touching them with
 * PROTECTED_PATH, leaving the worktree unchanged. Only the owning session can
 * lift a protection, and protections survive a DevOps Agent restart.
 *
 * Real git, a real LockService and a real GitService behind the registered MCP
 * tools: execa (ESM-only) is replaced by a child_process wrapper, zod by a stub.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
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

function zodChain(): any {
  const c: any = {};
  ['string', 'number', 'boolean', 'array', 'object', 'enum', 'record',
    'optional', 'default', 'describe', 'unknown', 'int', 'min', 'max'].forEach(m => { c[m] = (..._a: any[]) => zodChain(); });
  c.then = undefined;
  return c;
}
jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

import { GitService } from '../../../electron/services/GitService';
import { LockService } from '../../../electron/services/LockService';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';
import { globToRegExp, matchesPathPattern, protectedHits, PROTECTED_PATH } from '../../../shared/protected-paths';

const { registerTools } = require('../../../electron/services/mcp/tools');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

type Handler = (args: any) => Promise<any>;

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('protected path globs (KC-S3.1.2)', () => {
  it('matches ** across directories and * within one segment', () => {
    expect(matchesPathPattern('tests/unit/a.test.ts', 'tests/**')).toBe(true);
    expect(matchesPathPattern('tests/a.test.ts', 'tests/**')).toBe(true);
    expect(matchesPathPattern('src/tests/a.ts', 'tests/**')).toBe(false);
    expect(matchesPathPattern('src/a.test.ts', 'src/*.test.ts')).toBe(true);
    expect(matchesPathPattern('src/deep/a.test.ts', 'src/*.test.ts')).toBe(false);
    expect(matchesPathPattern('src/deep/a.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesPathPattern('a.test.ts', '**/*.test.ts')).toBe(true);
  });

  it('treats a plain path as the file or the directory under it', () => {
    expect(matchesPathPattern('tests/a.ts', 'tests')).toBe(true);
    expect(matchesPathPattern('tests', 'tests')).toBe(true);
    expect(matchesPathPattern('tests-extra/a.ts', 'tests')).toBe(false);
    expect(matchesPathPattern('tests/a.ts', 'tests/')).toBe(true);
    expect(matchesPathPattern('./tests/a.ts', 'tests/a.ts')).toBe(true);
    expect(globToRegExp('a.b(c).ts').test('a.b(c).ts')).toBe(true);
    expect(globToRegExp('a.b(c).ts').test('aXb(c)Xts')).toBe(false);
  });

  it('reports each protected path with the pattern it hit', () => {
    const protections = [{ pattern: 'tests/**', sessionId: 's', protectedAt: '' }];
    expect(protectedHits(['src/a.ts', 'tests/a.test.ts'], protections)).toEqual([
      { path: 'tests/a.test.ts', pattern: 'tests/**' },
    ]);
  });
});

describe('protected paths through kit_lock_file and kit_commit (KC-S3.1.2)', () => {
  let repo: string;
  let gitService: InstanceType<typeof GitService>;
  let lockService: InstanceType<typeof LockService>;
  let handlers: Map<string, Handler>;

  function register(lock: InstanceType<typeof LockService>) {
    const binder = new McpSessionBinder();
    binder.registerSession('sess_a', repo);
    binder.registerSession('sess_b', repo);
    const tools = new Map<string, Handler>();
    const server: any = { tool: (name: string, _d: string, _s: unknown, h: Handler) => tools.set(name, h), resource: () => {} };
    registerTools(server, binder, { gitService, lockService: lock }, undefined);
    return tools;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-protected-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, '.gitignore'), '.S9N_KIT_DevOpsAgent/\n');
    mkdirSync(join(repo, 'tests'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(add(1, 1)).toBe(2);\n');
    writeFileSync(join(repo, 'src', 'calc.ts'), 'export const add = (a, b) => 0;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    gitService = new GitService();
    gitService.registerWorktree('sess_a', repo, repo);
    gitService.registerWorktree('sess_b', repo, repo);
    lockService = new LockService();
    handlers = register(lockService);
  });

  afterEach(async () => {
    await lockService.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  async function protectTests() {
    const out = parse(await handlers.get('kit_lock_file')!({
      session_id: 'sess_a', files: ['tests/**'], cwd: repo, mode: 'protect', reason: 'locked tests',
    }));
    expect(out).toMatchObject({ locked: true, mode: 'protect', protected: ['tests/**'] });
  }

  it('AC1: kit_lock_file in protect mode protects tests/** for the session', async () => {
    await protectTests();
    const listed = await lockService.listProtections(repo, 'sess_a');
    expect(listed.data?.map((p) => p.pattern)).toEqual(['tests/**']);
    // Advisory mode is still the default and leaves protections alone.
    const advisory = parse(await handlers.get('kit_lock_file')!({ session_id: 'sess_a', files: ['src/calc.ts'], cwd: repo }));
    expect(advisory.locked).toBe(true);
    expect(advisory.mode).toBeUndefined();
    expect((await lockService.listProtections(repo)).data).toHaveLength(1);
  });

  it('AC2: kit_commit refuses a change to a protected test with PROTECTED_PATH and commits nothing', async () => {
    await protectTests();
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(true).toBe(true);\n');
    writeFileSync(join(repo, 'src', 'calc.ts'), 'export const add = (a, b) => a + b;\n');
    const statusBefore = git(repo, 'status', '--porcelain');

    const result = await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'fix: weaken test', cwd: repo });
    expect(result.isError).toBe(true);
    const out = parse(result);
    expect(out.error).toBe(PROTECTED_PATH);
    expect(out.paths).toEqual(['tests/calc.test.ts']);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore); // nothing staged
  });

  it('AC2: new and deleted files under a protected glob are refused too', async () => {
    await protectTests();
    writeFileSync(join(repo, 'tests', 'extra.test.ts'), 'x\n');
    let out = parse(await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'add', cwd: repo }));
    expect(out.paths).toEqual(['tests/extra.test.ts']);
    rmSync(join(repo, 'tests', 'extra.test.ts'));
    rmSync(join(repo, 'tests', 'calc.test.ts'));
    out = parse(await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'delete', cwd: repo }));
    expect(out.error).toBe(PROTECTED_PATH);
    expect(out.paths).toEqual(['tests/calc.test.ts']);
  });

  it('kit_commit_all applies the same refusal', async () => {
    await protectTests();
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(true).toBe(true);\n');
    const result = await handlers.get('kit_commit_all')!({ session_id: 'sess_a', message: 'fix: weaken test', cwd: repo });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: PROTECTED_PATH, tool: 'kit_commit_all', paths: ['tests/calc.test.ts'] });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('AC3: a commit touching only unprotected paths succeeds', async () => {
    await protectTests();
    writeFileSync(join(repo, 'src', 'calc.ts'), 'export const add = (a, b) => a + b;\n');
    const result = await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'feat: add', cwd: repo });
    const out = parse(result);
    expect(result.isError).toBeFalsy();
    expect(out.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(out.files).toEqual([{ path: 'src/calc.ts', status: 'modified' }]);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: add');
  });

  it('AC4: only the owning session can lift a protection with kit_unlock_file', async () => {
    await protectTests();
    const refused = await handlers.get('kit_unlock_file')!({ session_id: 'sess_b', files: ['tests/**'] });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({
      unlocked: false,
      error: 'PROTECTION_NOT_OWNED',
      refused: [{ pattern: 'tests/**', ownerSessionId: 'sess_a' }],
    });
    expect((await lockService.listProtections(repo, 'sess_a')).data).toHaveLength(1);

    // Unlocking without naming paths releases advisory locks, not protections.
    await handlers.get('kit_unlock_file')!({ session_id: 'sess_a' });
    expect((await lockService.listProtections(repo, 'sess_a')).data).toHaveLength(1);

    const lifted = parse(await handlers.get('kit_unlock_file')!({ session_id: 'sess_a', files: ['tests/**'] }));
    expect(lifted).toMatchObject({ unlocked: true, unprotected: ['tests/**'] });
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(add(2, 2)).toBe(4);\n');
    const out = parse(await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'test: more', cwd: repo }));
    expect(out.files).toEqual([{ path: 'tests/calc.test.ts', status: 'modified' }]);
  });

  it('a protection binds only the session that set it', async () => {
    await protectTests();
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(add(1, 2)).toBe(3);\n');
    const out = parse(await handlers.get('kit_commit')!({ session_id: 'sess_b', message: 'test: other story', cwd: repo }));
    expect(out.error).toBeUndefined();
    expect(out.files).toEqual([{ path: 'tests/calc.test.ts', status: 'modified' }]);
  });

  it('AC5: protection survives a DevOps Agent restart', async () => {
    await protectTests();
    expect(existsSync(join(repo, '.S9N_KIT_DevOpsAgent', 'protected.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, '.S9N_KIT_DevOpsAgent', 'protected.json'), 'utf8'))).toEqual([
      expect.objectContaining({ pattern: 'tests/**', sessionId: 'sess_a', reason: 'locked tests' }),
    ]);

    // Restart: the old services go away, fresh ones load from disk.
    await lockService.dispose();
    lockService = new LockService();
    gitService = new GitService();
    gitService.registerWorktree('sess_a', repo, repo);
    handlers = register(lockService);

    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tests', 'calc.test.ts'), 'expect(true).toBe(true);\n');
    const result = await handlers.get('kit_commit')!({ session_id: 'sess_a', message: 'fix: weaken test', cwd: repo });
    expect(parse(result)).toMatchObject({ error: PROTECTED_PATH, paths: ['tests/calc.test.ts'] });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });
});
