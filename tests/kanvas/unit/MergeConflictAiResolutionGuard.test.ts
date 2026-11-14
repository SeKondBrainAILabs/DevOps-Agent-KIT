/**
 * An AI conflict resolution must keep the file whole (real git).
 *
 * 2026-11-14: a post-commit rebase sent a whole 4475-line conflicted Python
 * file to a model capped at 4096 output tokens. The model stopped on length,
 * its 229-line output had no complete set of conflict markers, so it was
 * written, staged, `rebase --continue`d and force-pushed.
 *
 * Every AI-written resolution is now refused before staging when the model
 * stopped on length, when it is under 70% of the larger side, when it holds
 * any conflict marker line, or when it no longer parses although both sides
 * do — and the rebase is aborted with the files and reasons named. A rebase
 * still in progress when the resolver gives up (in a linked worktree too) is
 * aborted and reported as a failure.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

// execa is ESM-only; give the service a child_process-backed stand-in.
// Every call is recorded so a test can see the environment git ran with.
const execFileP = promisify(execFile);
const mockGitCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    mockGitCalls.push({ args, env: opts.env });
    return execFileP(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf-8' });
  };
  return { __esModule: true, default: run, execa: run };
});

import {
  MergeConflictService,
  aiResolutionRejections,
  conflictMarkerLines,
  countLines,
} from '../../../electron/services/MergeConflictService';
import { AIService } from '../../../electron/services/AIService';
import { structuralSanityCheck } from '../../../electron/services/file-parse-check';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A Python module of `n` small functions; `variant` changes function 100's body. */
function pyModule(n: number, variant: string): string {
  const out: string[] = ['"""A module."""', ''];
  for (let i = 0; i < n; i++) {
    out.push(`def f${i}(x):`);
    out.push(i === 100 ? `    return x + ${JSON.stringify(variant)}` : `    return x + ${i}`);
    out.push('');
  }
  return out.join('\n');
}

// ─── The acceptance checks on their own ──────────────────────────────────────

describe('conflictMarkerLines', () => {
  it('finds a single marker of any kind', () => {
    expect(conflictMarkerLines('a\n<<<<<<< HEAD\nb')).toEqual([2]);
    expect(conflictMarkerLines('a\n=======\nb')).toEqual([2]);
    expect(conflictMarkerLines('a\n>>>>>>> origin/main\nb')).toEqual([2]);
    expect(conflictMarkerLines('a\n||||||| base\nb')).toEqual([2]);
  });
  it('ignores lookalikes that are not marker lines', () => {
    expect(conflictMarkerLines('x = "<<<<<<<"\n# ========\n  =======\n')).toEqual([]);
  });
});

describe('countLines', () => {
  it('does not count one trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

describe('aiResolutionRejections', () => {
  const okPy = pyModule(10, 'x');

  it('accepts a whole, parseable resolution', async () => {
    expect(await aiResolutionRejections('m.py', okPy, 'stop', [okPy, okPy])).toEqual([]);
  });

  it('refuses output the model stopped on length', async () => {
    const r = await aiResolutionRejections('m.py', okPy, 'length', [okPy]);
    expect(r.join(' ')).toMatch(/finish_reason=length/);
  });

  it('refuses a resolution under 70% of the larger side, whichever side is larger', async () => {
    const big = okPy + okPy;
    expect((await aiResolutionRejections('m.py', okPy, 'stop', [okPy, big])).join(' ')).toMatch(/below 70% of the larger side/);
    expect((await aiResolutionRejections('m.py', okPy, 'stop', [big, okPy])).join(' ')).toMatch(/below 70% of the larger side/);
  });

  it('refuses any conflict marker line, even one alone', async () => {
    const r = await aiResolutionRejections('notes.txt', 'a\n=======\nb\n', 'stop', ['a\nb\n', 'a\nc\n']);
    expect(r.join(' ')).toMatch(/conflict marker/);
  });

  it('refuses Python that no longer parses when both sides do', async () => {
    const r = await aiResolutionRejections('m.py', 'def f(:\n    pass\n', 'stop', ['def f():\n    pass\n', 'def g():\n    pass\n']);
    expect(r.join(' ')).toMatch(/no longer parses \(both sides do\): Python/);
  });

  it('does not blame the resolution when a side does not parse either (e.g. a python3 older than the file)', async () => {
    const r = await aiResolutionRejections('m.py', 'def f(:\n    pass\n', 'stop', ['def f(:\n    pass\n', 'def g():\n    pass\n']);
    expect(r).toEqual([]);
  });

  it('refuses JavaScript that no longer parses when both sides do', async () => {
    const r = await aiResolutionRejections('m.js', 'function f( {\n', 'stop', ['function f() {}\n', 'function g() {}\n']);
    expect(r.join(' ')).toMatch(/no longer parses \(both sides do\): JavaScript/);
  });

  it('refuses JSON that no longer parses when both sides do', async () => {
    const r = await aiResolutionRejections('c.json', '{"a": 1,\n', 'stop', ['{"a": 1}\n', '{"a": 2}\n']);
    expect(r.join(' ')).toMatch(/no longer parses \(both sides do\): JSON/);
  });

  it('accepts JSONC (comments) when neither side is plain JSON', async () => {
    const jsonc = '{\n  // a comment\n  "a": 1\n}\n';
    expect(await aiResolutionRejections('tsconfig.json', jsonc, 'stop', [jsonc, jsonc.replace('1', '2')])).toEqual([]);
  });

  it('does not parse-check TS/TSX/JSX: valid code with a regex literal is accepted', async () => {
    const tsx = 'const re = /["\'`]/g;\nexport const C = () => <div>{re.source}</div>;\n';
    expect(structuralSanityCheck(tsx)).not.toBeNull(); // the scanner the old check used gets this wrong
    expect(await aiResolutionRejections('c.tsx', tsx, 'stop', [tsx, tsx])).toEqual([]);
    expect(await aiResolutionRejections('c.ts', tsx, 'stop', [tsx, tsx])).toEqual([]);
  });
});

// ─── AIService surfaces finish_reason ───────────────────────────────────────

describe('AIService.sendWithModeDetailed', () => {
  it('returns the finish_reason alongside the content', async () => {
    const ai = new AIService({} as never);
    (ai as unknown as { getClient: () => unknown }).getClient = () => ({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }) } },
    });
    const r = await ai.sendWithModeDetailed({
      modeId: 'merge_conflict_resolver',
      promptKey: 'resolve_conflict',
      variables: { file_path: 'a.py', language: 'python', current_branch: 'a', incoming_branch: 'b', conflicted_content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ content: 'partial', finishReason: 'length' });
  });
});

// ─── rebaseWithResolution in a real linked worktree ─────────────────────────

describe('rebaseWithResolution in a session worktree (real git)', () => {
  const FILE = 'service.py';
  const N = 300; // functions → ~900 lines
  let dir: string;
  let repo: string; // the main checkout
  let wt: string; // the session's linked worktree
  let other: string; // someone else pushing to main
  let sessionTip: string;
  let prevEditor: string | undefined;

  type Reply = { content: string; finishReason: string | null };

  /** An AIService stand-in: triage/analysis fail (optional phases), the resolver answers `replies` in turn. */
  function serviceReplying(...replies: Reply[]) {
    const detailed = jest.fn();
    replies.forEach((r, i) => {
      if (i === replies.length - 1) detailed.mockResolvedValue({ success: true, data: r } as never);
      else detailed.mockResolvedValueOnce({ success: true, data: r } as never);
    });
    const ai = {
      sendWithMode: jest.fn(async () => ({ success: false, error: { code: 'X', message: 'no analysis' } })),
      sendWithModeDetailed: detailed,
    };
    return { svc: new MergeConflictService(ai as unknown as AIService), ai };
  }

  const configure = (c: string) => {
    git(c, 'config', 'user.email', 't@example.com');
    git(c, 'config', 'user.name', 'T');
    git(c, 'config', 'commit.gpgsign', 'false');
  };

  /**
   * base on main; the session commits `session` (one commit each) in a linked
   * worktree; someone else pushes `main` to origin/main afterwards.
   */
  function scenario(base: string, session: string[], main: string) {
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '-q', remote, repo);
    configure(repo);
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(repo, FILE), base);
    git(repo, 'add', FILE);
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', 'origin', 'main');

    git(repo, 'worktree', 'add', '-q', '-b', 'session', wt, 'main');
    session.forEach((content, i) => {
      writeFileSync(join(wt, FILE), content);
      git(wt, 'commit', '-q', '-am', `session change ${i + 1}`);
    });
    sessionTip = git(wt, 'rev-parse', 'HEAD');

    git(dir, 'clone', '-q', remote, other);
    configure(other);
    writeFileSync(join(other, FILE), main);
    git(other, 'commit', '-q', '-am', 'main change');
    git(other, 'push', '-q', 'origin', 'main');
  }

  function rebaseInProgress(): boolean {
    return ['rebase-merge', 'rebase-apply'].some((n) => existsSync(resolve(wt, git(wt, 'rev-parse', '--git-path', n))));
  }

  /** Aborted cleanly: no rebase left, the session branch and its file exactly as before. */
  function expectUntouched(sessionContent: string) {
    expect(rebaseInProgress()).toBe(false);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(sessionTip);
    expect(git(wt, 'branch', '--show-current')).toBe('session');
    expect(readFileSync(join(wt, FILE), 'utf-8')).toBe(sessionContent);
  }

  beforeEach(() => {
    // An editor that always fails: rebase --continue must not depend on one.
    prevEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'false';
    dir = mkdtempSync(join(tmpdir(), 'kit-ai-resolution-'));
    repo = join(dir, 'repo');
    wt = join(dir, 'wt');
    other = join(dir, 'other');
  });

  afterEach(() => {
    if (prevEditor === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = prevEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs in a linked worktree (its --git-dir is absolute)', () => {
    scenario(pyModule(N, 'base'), [pyModule(N, 'session')], pyModule(N, 'main'));
    expect(git(wt, 'rev-parse', '--git-dir')).toMatch(/^\//);
  });

  it('aborts when the model stopped on length and cut the file short (the 2026-11-14 case)', async () => {
    const ours = pyModule(N, 'session');
    const theirs = pyModule(N, 'main');
    scenario(pyModule(N, 'base'), [ours], theirs);
    const truncated = theirs.split('\n').slice(0, 60).join('\n'); // parses, no markers, ~7% of the file
    const { svc } = serviceReplying({ content: truncated, finishReason: 'length' });

    const r = await svc.rebaseWithResolution(wt, 'main');

    expect(r.success).toBe(true);
    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toContain(FILE);
    expect(r.data?.message).toMatch(/finish_reason=length/);
    expect(r.data?.message).toMatch(/below 70% of the larger side/);
    const res = r.data?.resolutions.find((x) => x.file === FILE);
    expect(res?.resolved).toBe(false);
    expect(res?.rejectedReasons?.length).toBeGreaterThanOrEqual(2);
    expectUntouched(ours);
  });

  it.each([
    ['the session side is much larger', 600, 150],
    ['the main side is much larger', 150, 600],
  ])('refuses a smaller-side-sized resolution when %s', async (_why, sessionN, mainN) => {
    const ours = pyModule(sessionN, 'session');
    scenario(pyModule(150, 'base'), [ours], pyModule(mainN, 'main'));
    const smallSized = pyModule(150, 'merged'); // whole and parseable, but the size of the smaller side
    const { svc } = serviceReplying({ content: smallSized, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(wt, 'main');

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(new RegExp(`below 70% of the larger side \\(${countLines(pyModule(600, 'x'))} lines\\)`));
    expect(r.data?.message).not.toMatch(/finish_reason|no longer parses|conflict marker/);
    expectUntouched(ours);
  });

  it('aborts on a single leftover marker that the old all-three-markers check let through', async () => {
    const ours = pyModule(N, 'session');
    scenario(pyModule(N, 'base'), [ours], pyModule(N, 'main'));
    const withMarker = ours.replace('    return x + "session"', '    return x + "session"\n=======');
    const { svc } = serviceReplying({ content: withMarker, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(wt, 'main');

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(/conflict marker/);
    expectUntouched(ours);
  });

  it('checks the retry too: markers first, then a nearly whole file cut off on length', async () => {
    const ours = pyModule(N, 'session');
    scenario(pyModule(N, 'base'), [ours], pyModule(N, 'main'));
    const stillConflicted = ours.replace(
      '    return x + "session"',
      '<<<<<<< HEAD\n    return x + "main"\n=======\n    return x + "session"\n>>>>>>> session'
    );
    const nearlyWhole = pyModule(N - 3, 'merged'); // parses, >70%, but the model ran out of tokens
    const { svc, ai } = serviceReplying(
      { content: stillConflicted, finishReason: 'stop' },
      { content: nearlyWhole, finishReason: 'length' },
    );

    const r = await svc.rebaseWithResolution(wt, 'main');

    expect(ai.sendWithModeDetailed).toHaveBeenCalledTimes(2);
    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toContain(FILE);
    expect(r.data?.message).toMatch(/finish_reason=length/);
    expect(r.data?.message).not.toMatch(/below 70%/);
    expectUntouched(ours);
  });

  it('aborts when the resolution no longer parses', async () => {
    const ours = pyModule(N, 'session');
    scenario(pyModule(N, 'base'), [ours], pyModule(N, 'main'));
    const broken = ours.replace('def f150(x):', 'def f150(x:');
    const { svc } = serviceReplying({ content: broken, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(wt, 'main');

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(/no longer parses/);
    expectUntouched(ours);
  });

  it('reports failure and leaves no rebase behind when more commits conflict than maxRetries allows', async () => {
    const commits = [pyModule(N, 's1'), pyModule(N, 's2'), pyModule(N, 's3')]; // each conflicts in turn
    scenario(pyModule(N, 'base'), commits, pyModule(N, 'main'));
    const { svc } = serviceReplying({ content: pyModule(N, 'merged'), finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(wt, 'main', 1);

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(/could not complete/);
    expectUntouched(commits[2]);
  });

  it('stages a whole, parseable resolution and completes the rebase without an editor', async () => {
    scenario(pyModule(N, 'base'), [pyModule(N, 'session')], pyModule(N, 'main'));
    const merged = pyModule(N, 'merged');
    const { svc, ai } = serviceReplying({ content: merged, finishReason: 'stop' });
    mockGitCalls.length = 0;

    const r = await svc.rebaseWithResolution(wt, 'main');

    // git only opens an editor on --continue when stdin is a terminal, which
    // it is not here — so check that every --continue was told not to.
    const continues = mockGitCalls.filter((c) => c.args.includes('--continue'));
    expect(continues.length).toBeGreaterThan(0);
    for (const c of continues) expect(c.env?.GIT_EDITOR).toBe('true');
    expect(ai.sendWithModeDetailed).toHaveBeenCalled();
    expect(r.data?.success).toBe(true);
    expect(rebaseInProgress()).toBe(false);
    expect(readFileSync(join(wt, FILE), 'utf-8')).toBe(merged.trim());
    expect(git(wt, 'rev-parse', 'HEAD~1')).toBe(git(wt, 'rev-parse', 'origin/main'));
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('session change 1');
  });
});
