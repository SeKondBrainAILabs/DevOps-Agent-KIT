/**
 * The .py parse gate ran `python3 -c "import ast; ..."` with the worktree as its working directory
 * (kit_commit), or with the process's working directory (checkContentParses, used by
 * MergeConflictService). `-c` puts the current directory first on sys.path, so an ast.py the
 * sandboxed coding engine planted in the worktree was imported instead of the standard library:
 * its code ran on the host, and its parse() decided the verdict (one that accepts everything let a
 * broken file through).
 *
 * Python now runs isolated (-I) from the system temp directory, with the file as an argument.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

import { checkContentParses, parserCommandFor } from '../../../electron/services/file-parse-check';
import { GitService } from '../../../electron/services/GitService';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

const { registerTools } = require('../../../electron/services/mcp/tools');

const BROKEN_PY = 'def f(:\n    return 1\n';
const VALID_PY = '"""Docstring."""\n\ndef f():\n    return 1\n';

/** An ast.py that records it was imported in `marker` and accepts any source. */
function plantAst(dir: string, marker: string): void {
  writeFileSync(join(dir, 'ast.py'), [
    `open(${JSON.stringify(marker)}, 'w').write('imported')`,
    'def parse(*args, **kwargs):',
    '    return None',
    '',
  ].join('\n'));
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('the .py parser command', () => {
  it('runs python3 isolated from the temp directory with the file as an argument', () => {
    const cmd = parserCommandFor('py', '/work/tree/src/a.py')!;
    expect(cmd.bin).toBe('python3');
    expect(cmd.args[0]).toBe('-I');
    expect(cmd.args[cmd.args.length - 1]).toBe('/work/tree/src/a.py');
    expect(cmd.cwd).toBe(tmpdir());
  });
});

describe('kit_commit .py gate with an ast.py planted in the worktree', () => {
  let repo: string;
  let outside: string;
  let marker: string;
  let handlers: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-pyiso-'));
    outside = mkdtempSync(join(tmpdir(), 'kit-pyiso-marker-'));
    marker = join(outside, 'imported.txt');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, '.gitignore'), '.S9N_KIT_DevOpsAgent/\n__pycache__/\n');
    writeFileSync(join(repo, 'app.py'), VALID_PY);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    plantAst(repo, marker);
    const gitService = new GitService();
    gitService.registerWorktree('sess_a', repo, repo);
    const binder = new McpSessionBinder();
    binder.registerSession('sess_a', repo);
    handlers = new Map();
    const server: any = { tool: (name: string, _d: string, _s: unknown, h: any) => handlers.set(name, h), resource: () => {} };
    registerTools(server, binder, { gitService }, undefined);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const commit = async (message: string) =>
    JSON.parse((await handlers.get('kit_commit')!({ session_id: 'sess_a', message, cwd: repo })).content[0].text);

  it('refuses a broken .py file and never imports the planted ast.py', async () => {
    writeFileSync(join(repo, 'broken.py'), BROKEN_PY);
    const out = await commit('feat: broken python');
    expect(out.error).toBe('Commit refused by sanity gate');
    expect(out.details.parseFailures.map((f: { file: string }) => f.file)).toEqual(['broken.py']);
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, 'log', '--format=%s')).toBe('base');
  });

  it('still commits valid Python', async () => {
    writeFileSync(join(repo, 'app.py'), VALID_PY + '\n\ndef g():\n    return 2\n');
    const out = await commit('feat: valid python');
    expect(out.error).toBeUndefined();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: valid python');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('checkContentParses (merge-conflict resolver) with an ast.py in the working directory', () => {
  const realCwd = process.cwd();
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-pyiso-cwd-'));
    marker = join(dir, 'imported.txt');
    plantAst(dir, marker);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(realCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports broken Python and never imports the planted ast.py', async () => {
    const result = await checkContentParses('src/broken.py', BROKEN_PY);
    expect(result.problem).toMatch(/^Python does not parse: /);
    expect(existsSync(marker)).toBe(false);
  });

  it('passes valid Python', async () => {
    await expect(checkContentParses('src/app.py', VALID_PY)).resolves.toEqual({ problem: null });
    expect(existsSync(marker)).toBe(false);
  });
});
