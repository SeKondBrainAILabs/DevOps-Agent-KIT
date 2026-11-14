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
 * any conflict marker line, or when it no longer parses — and the rebase is
 * aborted with the files and reasons named.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

// execa is ESM-only; give the service a child_process-backed stand-in.
const execFileP = promisify(execFile);
jest.mock('execa', () => {
  const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
    execFileP(cmd, args, { cwd: opts.cwd, encoding: 'utf-8' });
  return { __esModule: true, default: run, execa: run };
});

import {
  MergeConflictService,
  aiResolutionRejections,
  conflictMarkerLines,
  countLines,
} from '../../../electron/services/MergeConflictService';
import { AIService } from '../../../electron/services/AIService';

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
    expect(await aiResolutionRejections('m.py', okPy, 'stop', [countLines(okPy), countLines(okPy)])).toEqual([]);
  });

  it('refuses output the model stopped on length', async () => {
    const r = await aiResolutionRejections('m.py', okPy, 'length', [countLines(okPy)]);
    expect(r.join(' ')).toMatch(/finish_reason=length/);
  });

  it('refuses a resolution under 70% of the larger side', async () => {
    const r = await aiResolutionRejections('m.py', okPy, 'stop', [10, countLines(okPy) * 2]);
    expect(r.join(' ')).toMatch(/below 70% of the larger side/);
  });

  it('refuses any conflict marker line, even one alone', async () => {
    const r = await aiResolutionRejections('notes.txt', 'a\n=======\nb\n', 'stop', [3]);
    expect(r.join(' ')).toMatch(/conflict marker/);
  });

  it('refuses Python that no longer parses', async () => {
    const r = await aiResolutionRejections('m.py', 'def f(:\n    pass\n', 'stop', [2]);
    expect(r.join(' ')).toMatch(/no longer parses: Python/);
  });

  it('refuses JavaScript that no longer parses', async () => {
    const r = await aiResolutionRejections('m.js', 'function f( {\n', 'stop', [1]);
    expect(r.join(' ')).toMatch(/no longer parses: JavaScript/);
  });

  it('refuses JSON that no longer parses', async () => {
    const r = await aiResolutionRejections('c.json', '{"a": 1,\n', 'stop', [1]);
    expect(r.join(' ')).toMatch(/no longer parses: JSON/);
  });

  it('refuses truncated TypeScript through the structural check', async () => {
    const r = await aiResolutionRejections('m.ts', 'export function f() {\n  return 1;\n', 'stop', [2]);
    expect(r.join(' ')).toMatch(/structural check failed/);
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

// ─── rebaseWithResolution against real repositories ─────────────────────────

describe('rebaseWithResolution refuses an AI resolution that loses the file (real git)', () => {
  const FILE = 'service.py';
  const N = 300; // functions → ~900 lines
  let dir: string;
  let work: string;
  let featureTip: string;
  let ours: string;
  let theirs: string;
  let prevEditor: string | undefined;

  /** An AIService stand-in: triage/analysis fail (optional phases), the resolver answers `reply`. */
  function serviceReplying(reply: { content: string; finishReason: string | null }) {
    const ai = {
      sendWithMode: jest.fn(async () => ({ success: false, error: { code: 'X', message: 'no analysis' } })),
      sendWithModeDetailed: jest.fn(async () => ({ success: true, data: reply })),
    };
    return { svc: new MergeConflictService(ai as unknown as AIService), ai };
  }

  beforeEach(() => {
    prevEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'true'; // rebase --continue must not wait on an editor
    dir = mkdtempSync(join(tmpdir(), 'kit-ai-resolution-'));
    const remote = join(dir, 'remote.git');
    work = join(dir, 'work');
    const other = join(dir, 'other');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '-q', remote, work);
    for (const c of [work]) {
      git(c, 'config', 'user.email', 't@example.com');
      git(c, 'config', 'user.name', 'T');
      git(c, 'config', 'commit.gpgsign', 'false');
    }
    git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(work, FILE), pyModule(N, 'base'));
    git(work, 'add', FILE);
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'push', '-q', 'origin', 'main');

    // The session branch changes function 100 one way...
    git(work, 'checkout', '-q', '-b', 'session');
    ours = pyModule(N, 'session');
    writeFileSync(join(work, FILE), ours);
    git(work, 'commit', '-q', '-am', 'session change');
    featureTip = git(work, 'rev-parse', 'HEAD');

    // ...and someone else changes it another way on main.
    git(dir, 'clone', '-q', remote, other);
    git(other, 'config', 'user.email', 'o@example.com');
    git(other, 'config', 'user.name', 'O');
    git(other, 'config', 'commit.gpgsign', 'false');
    theirs = pyModule(N, 'main');
    writeFileSync(join(other, FILE), theirs);
    git(other, 'commit', '-q', '-am', 'main change');
    git(other, 'push', '-q', 'origin', 'main');
  });

  afterEach(() => {
    if (prevEditor === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = prevEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  function expectUntouched() {
    const gitDir = git(work, 'rev-parse', '--absolute-git-dir');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(featureTip);
    expect(git(work, 'branch', '--show-current')).toBe('session');
    expect(readFileSync(join(work, FILE), 'utf-8')).toBe(ours);
  }

  it('aborts when the model stopped on length and cut the file short (the 2026-11-14 case)', async () => {
    const truncated = theirs.split('\n').slice(0, 60).join('\n'); // parses, no markers, ~7% of the file
    const { svc } = serviceReplying({ content: truncated, finishReason: 'length' });

    const r = await svc.rebaseWithResolution(work, 'main');

    expect(r.success).toBe(true);
    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toContain(FILE);
    expect(r.data?.message).toMatch(/finish_reason=length/);
    expect(r.data?.message).toMatch(/below 70% of the larger side/);
    const res = r.data?.resolutions.find((x) => x.file === FILE);
    expect(res?.resolved).toBe(false);
    expect(res?.rejectedReasons?.length).toBeGreaterThanOrEqual(2);
    expectUntouched();
  });

  it('aborts on a single leftover marker that the old all-three-markers check let through', async () => {
    const withMarker = ours.replace('    return x + "session"', '    return x + "session"\n=======');
    const { svc } = serviceReplying({ content: withMarker, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(work, 'main');

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(/conflict marker/);
    expectUntouched();
  });

  it('aborts when the resolution no longer parses', async () => {
    const broken = ours.replace('def f150(x):', 'def f150(x:');
    const { svc } = serviceReplying({ content: broken, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(work, 'main');

    expect(r.data?.success).toBe(false);
    expect(r.data?.message).toMatch(/no longer parses/);
    expectUntouched();
  });

  it('stages a whole, parseable resolution and completes the rebase', async () => {
    const merged = pyModule(N, 'merged');
    const { svc, ai } = serviceReplying({ content: merged, finishReason: 'stop' });

    const r = await svc.rebaseWithResolution(work, 'main');

    expect(ai.sendWithModeDetailed).toHaveBeenCalled();
    expect(r.data?.success).toBe(true);
    expect(readFileSync(join(work, FILE), 'utf-8')).toBe(merged.trim());
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(git(work, 'rev-parse', 'origin/main'));
  });
});
