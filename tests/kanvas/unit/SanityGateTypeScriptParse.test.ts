/**
 * The kit_commit sanity gate ran a character scanner (structuralSanityCheck) on every changed
 * TS/TSX/JSX file. The scanner is not a parser: it mis-reads regex literals, treats an apostrophe
 * in JSX text as a string opener and fails on multi-line JSX attributes. It flagged 49 of the 373
 * TS/TSX files on DevOps-Agent-KIT main that TypeScript parses cleanly, so a change to
 * SettingsModal.tsx, SessionDetailView.tsx, electron/ipc/index.ts or GitHubService.ts could never
 * be committed (25 refusals in KIT Harness run 20261117T184041-aadc1d; force=true cannot bypass
 * a parse refusal).
 *
 * The gate now parses those files with TypeScript (syntax only) and refuses only on real syntax
 * errors. The scanner is the fallback when no TypeScript loads, and then refuses a file only when
 * the HEAD version passes the scanner.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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

import {
  checkTypeScriptLikeFile,
  loadTypeScriptFor,
  structuralSanityCheck,
  typeScriptSyntaxErrors,
} from '../../../electron/services/file-parse-check';
import { GitService } from '../../../electron/services/GitService';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

const { registerTools } = require('../../../electron/services/mcp/tools');

const REPO_ROOT = process.cwd();

// Valid TSX the scanner refuses: an apostrophe in JSX text opens a "string" that never closes.
const JSX_APOSTROPHE = `export function Empty() {
  return (
    <div>
      <p>Don't panic, nothing here yet.</p>
    </div>
  );
}
`;

// Valid TSX with a multi-line className (a multi-line string attribute).
const MULTILINE_CLASSNAME = `export function Card() {
  return (
    <div
      className="flex items-center
        gap-2 rounded-md border
        px-3 py-2"
    >
      ok
    </div>
  );
}
`;

// Valid TS: regex literals holding quotes.
const REGEX_QUOTE = `export const QUOTES = /["']/g;
export const APOS = /'/;
export function strip(s: string): string {
  return s.replace(/^"|"$/g, '').replace(QUOTES, '');
}
`;

const UNTERMINATED_STRING = `export function f(): string {
  const s = "unterminated;
  return s;
}
`;

const UNCLOSED_JSX = `export function Broken() {
  return (
    <div>
      <span>never closed
    </div>
  );
}
`;

const CONFLICT_MARKERS = `export const a = 1;
<<<<<<< HEAD
export const b = 2;
=======
export const b = 3;
>>>>>>> feature
`;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const noHead = async () => null;

describe('TypeScript loading', () => {
  it('loads a usable TypeScript from a repository that has one', () => {
    const ts = loadTypeScriptFor([REPO_ROOT]);
    expect(ts).not.toBeNull();
    expect(typeof ts!.createSourceFile).toBe('function');
  });

  it('falls back to the app\'s own TypeScript when the worktree has none', () => {
    const bare = mkdtempSync(join(tmpdir(), 'kit-no-ts-'));
    try {
      expect(loadTypeScriptFor([bare])).not.toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the scanner gets valid code wrong (why the gate parses instead)', () => {
  it.each([
    ['an apostrophe in JSX text', JSX_APOSTROPHE],
    ['a multi-line className', MULTILINE_CLASSNAME],
    ['a regex literal with a quote', REGEX_QUOTE],
  ])('scanner refuses %s', (_label, src) => {
    expect(structuralSanityCheck(src)).not.toBeNull();
  });
});

describe('checkTypeScriptLikeFile with TypeScript', () => {
  it.each([
    ['valid TSX with an apostrophe in JSX text', 'src/Empty.tsx', JSX_APOSTROPHE],
    ['valid TSX with a multi-line className', 'src/Card.tsx', MULTILINE_CLASSNAME],
    ['valid TS with a regex literal holding a quote', 'src/strip.ts', REGEX_QUOTE],
    ['valid JSX with an apostrophe in JSX text', 'src/Empty.jsx', JSX_APOSTROPHE],
  ])('passes %s', async (_label, rel, src) => {
    await expect(checkTypeScriptLikeFile({ rel, content: src, searchRoots: [REPO_ROOT], readHead: noHead })).resolves.toBeNull();
  });

  it('refuses an unterminated string with the file, line and TypeScript message', async () => {
    const failure = await checkTypeScriptLikeFile({ rel: 'src/f.ts', content: UNTERMINATED_STRING, searchRoots: [REPO_ROOT], readHead: noHead });
    expect(failure).not.toBeNull();
    expect(failure!.file).toBe('src/f.ts');
    expect(failure!.line).toBe(2);
    expect(failure!.error).toMatch(/^TypeScript syntax error: line 2, column \d+: Unterminated string literal/);
  });

  it('refuses an unclosed JSX tag', async () => {
    const failure = await checkTypeScriptLikeFile({ rel: 'src/Broken.tsx', content: UNCLOSED_JSX, searchRoots: [REPO_ROOT], readHead: noHead });
    expect(failure).not.toBeNull();
    expect(failure!.error).toMatch(/JSX element 'span' has no corresponding closing tag/);
  });

  it('refuses conflict markers', async () => {
    const failure = await checkTypeScriptLikeFile({ rel: 'src/a.ts', content: CONFLICT_MARKERS, searchRoots: [REPO_ROOT], readHead: noHead });
    expect(failure).not.toBeNull();
    expect(failure!.line).toBe(2);
    expect(failure!.error).toMatch(/Merge conflict marker encountered/);
  });

  it('does not type-check: a type error is not a syntax error', async () => {
    const src = 'const n: number = "not a number";\nundefinedFn(n);\n';
    await expect(checkTypeScriptLikeFile({ rel: 'src/t.ts', content: src, searchRoots: [REPO_ROOT], readHead: noHead })).resolves.toBeNull();
  });

  it('reports line and column from the parser', () => {
    const ts = loadTypeScriptFor([REPO_ROOT])!;
    const errors = typeScriptSyntaxErrors(ts, 'x.ts', 'let ok = 1;\nlet x = ;\n');
    expect(errors[0]).toMatchObject({ line: 2, column: 9 });
  });
});

describe('checkTypeScriptLikeFile when no TypeScript can be loaded (scanner fallback)', () => {
  const noTs = () => null;

  it('passes a file whose scanner false positive is already on HEAD', async () => {
    const changed = JSX_APOSTROPHE.replace('nothing here yet', 'nothing here yet, still');
    const failure = await checkTypeScriptLikeFile({
      rel: 'src/Empty.tsx', content: changed, searchRoots: [], loadTypeScript: noTs, readHead: async () => JSX_APOSTROPHE,
    });
    expect(failure).toBeNull();
  });

  it('refuses a file the scanner fails on when HEAD passes', async () => {
    const head = 'export function f(): string {\n  return "ok";\n}\n';
    const failure = await checkTypeScriptLikeFile({
      rel: 'src/f.ts', content: UNTERMINATED_STRING, searchRoots: [], loadTypeScript: noTs, readHead: async () => head,
    });
    expect(failure).toEqual({ file: 'src/f.ts', error: expect.stringMatching(/^structural: unterminated double-quoted string/) });
  });

  it('refuses a new file (no HEAD version) the scanner fails on', async () => {
    const failure = await checkTypeScriptLikeFile({
      rel: 'src/new.ts', content: UNTERMINATED_STRING, searchRoots: [], loadTypeScript: noTs, readHead: noHead,
    });
    expect(failure?.error).toMatch(/^structural: /);
  });

  it('passes a file the scanner accepts without reading HEAD', async () => {
    const readHead = jest.fn(async () => null as string | null);
    const failure = await checkTypeScriptLikeFile({
      rel: 'src/ok.ts', content: 'export const a = [1, 2];\n', searchRoots: [], loadTypeScript: noTs, readHead,
    });
    expect(failure).toBeNull();
    expect(readHead).not.toHaveBeenCalled();
  });
});

describe('kit_commit sanity gate on TS/TSX (real git, real GitService)', () => {
  let repo: string;
  let handlers: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-tsparse-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'kit@example.com');
    git(repo, 'config', 'user.name', 'kit');
    writeFileSync(join(repo, '.gitignore'), '.S9N_KIT_DevOpsAgent/\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'Empty.tsx'), JSX_APOSTROPHE);
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

  const commit = async (message: string, force = false) =>
    JSON.parse((await handlers.get('kit_commit')!({ session_id: 'sess_a', message, cwd: repo, force })).content[0].text);

  it('commits valid TSX and TS the scanner would refuse', async () => {
    writeFileSync(join(repo, 'src', 'Empty.tsx'), JSX_APOSTROPHE.replace('yet', 'yet!'));
    writeFileSync(join(repo, 'src', 'Card.tsx'), MULTILINE_CLASSNAME);
    writeFileSync(join(repo, 'src', 'strip.ts'), REGEX_QUOTE);
    const out = await commit('feat: valid code');
    expect(out.error).toBeUndefined();
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: valid code');
  });

  it('refuses a real syntax error with the same reason as before, even with force=true', async () => {
    writeFileSync(join(repo, 'src', 'Broken.tsx'), UNCLOSED_JSX);
    const out = await commit('feat: broken', true);
    expect(out.error).toBe('Commit refused by sanity gate');
    expect(out.reason).toBe('Parse error in 1 file(s) — commit refused. Re-read the file(s), fix the syntax, then retry. force=true does NOT bypass parser errors.');
    expect(out.details.parseFailures).toEqual([
      { file: 'src/Broken.tsx', line: expect.any(Number), error: expect.stringMatching(/^TypeScript syntax error: line \d+/) },
    ]);
    expect(git(repo, 'log', '--format=%s')).toBe('base');
  });
});
