/**
 * The kit_commit sanity gate when no TypeScript can be loaded (a repository without TypeScript,
 * run from a packaged app that ships none): the structural scanner decides, but a scanner false
 * positive the file already has on HEAD must not block the commit. `module.createRequire` is
 * mocked to fail so no TypeScript resolves; see SanityGateTypeScriptParse.test.ts for the parse.
 * With no app TypeScript the fallback must not go looking for one in the worktree either.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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
jest.mock('module', () => {
  const actual = jest.requireActual('module') as any;
  return {
    ...actual,
    createRequire: () => {
      const req: any = () => { throw new Error('no typescript'); };
      req.resolve = () => { throw Object.assign(new Error("Cannot find module 'typescript'"), { code: 'MODULE_NOT_FOUND' }); };
      return req;
    },
  };
});

jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

import { loadAppTypeScript } from '../../../electron/services/file-parse-check';
import { GitService } from '../../../electron/services/GitService';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

const { registerTools } = require('../../../electron/services/mcp/tools');

// Valid TSX the scanner refuses (apostrophe in JSX text).
const JSX_APOSTROPHE = `export function Empty() {
  return (
    <div>
      <p>Don't panic, nothing here yet.</p>
    </div>
  );
}
`;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('kit_commit sanity gate without TypeScript (scanner fallback)', () => {
  let repo: string;
  let handlers: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-tsparse-fallback-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, '.gitignore'), '.S9N_KIT_DevOpsAgent/\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'Empty.tsx'), JSX_APOSTROPHE);
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const a = [1, 2];\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
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
  });

  const commit = async (message: string) =>
    JSON.parse((await handlers.get('kit_commit')!({ session_id: 'sess_a', message, cwd: repo })).content[0].text);

  it('has no TypeScript to load here', () => {
    expect(loadAppTypeScript()).toBeNull();
  });

  it('commits a change to a file whose scanner false positive is already on HEAD', async () => {
    writeFileSync(join(repo, 'src', 'Empty.tsx'), JSX_APOSTROPHE.replace('yet', 'yet!'));
    const out = await commit('feat: copy edit');
    expect(out.error).toBeUndefined();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: copy edit');
  });

  it('still refuses breakage the HEAD version does not have', async () => {
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const a = [1, 2;\n');
    const out = await commit('feat: truncate');
    expect(out.error).toBe('Commit refused by sanity gate');
    expect(out.details.parseFailures).toEqual([{ file: 'src/ok.ts', error: expect.stringMatching(/^structural: /) }]);
    expect(git(repo, 'log', '--format=%s')).toBe('base');
  });

  it('never loads a typescript package planted in the worktree, from it or as the working directory', async () => {
    const marker = join(repo, 'loaded.txt');
    const planted = join(repo, 'node_modules', 'typescript');
    mkdirSync(join(planted, 'lib'), { recursive: true });
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0-planted', main: './lib/typescript.js' }));
    // Accepts everything (passes the gate's probe, no error on any other file).
    writeFileSync(join(planted, 'lib', 'typescript.js'), `
      require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');
      const real = require(${JSON.stringify(require.resolve('typescript'))});
      module.exports = {
        ...real,
        createSourceFile: (name, ...a) => {
          const sf = real.createSourceFile(name, ...a);
          return name === 'probe.ts' ? sf : Object.assign(sf, { parseDiagnostics: [] });
        },
      };
    `);
    writeFileSync(join(repo, '.gitignore'), '.S9N_KIT_DevOpsAgent/\nnode_modules/\nloaded.txt\n');
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const a = [1, 2;\n');
    const realCwd = process.cwd();
    process.chdir(repo);
    let out: any;
    try {
      out = await commit('feat: truncate with a planted compiler');
    } finally {
      process.chdir(realCwd);
    }
    expect(out.error).toBe('Commit refused by sanity gate');
    expect(out.details.parseFailures).toEqual([{ file: 'src/ok.ts', error: expect.stringMatching(/^structural: /) }]);
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, 'log', '--format=%s')).toBe('base');
  });

  it('still refuses a new file the scanner fails on', async () => {
    writeFileSync(join(repo, 'src', 'New.tsx'), JSX_APOSTROPHE);
    const out = await commit('feat: new file');
    expect(out.error).toBe('Commit refused by sanity gate');
    expect(out.details.parseFailures[0].file).toBe('src/New.tsx');
  });
});
