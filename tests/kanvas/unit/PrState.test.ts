/**
 * kit_get_pr_state — is the branch's pull request open, merged or closed?
 *
 * KIT Harness revises its own PR by adopting the kept branch and pushing more
 * commits. On a branch whose PR is MERGED or CLOSED, kit_request_review opens
 * a second PR (ensurePullRequest deliberately does not reuse a non-open one),
 * so the caller has to be able to ask first. This tool is that question, and
 * it must never create or edit anything.
 *
 * gh is an injected fake throughout — no network.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getPullRequestState } from '../../../electron/services/GitHubService';
import {
  MCP_TOOLS,
  MCP_STATE_CHANGING_TOOLS,
  MCP_OBSERVER_FORBIDDEN_TOOLS,
} from '../../../shared/mcp-types';
import type { GhResult } from '../../../shared/github-cli';

function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1): GhResult => ({ ok: false, stdout: '', stderr, code });

const view = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'feat/x',
    isDraft: false,
    ...over,
  });

function fakeGh(result: GhResult) {
  return jest.fn(async (_args: string[], _cwd: string) => result);
}

describe('getPullRequestState', () => {
  it('reports an open PR with its number, url, base, head and draft flag', async () => {
    const gh = fakeGh(ok(view({ isDraft: true })));
    const r = await getPullRequestState({ gh }, '/wt', 'feat/x');
    expect(r).toEqual({
      ok: true,
      pr: {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'OPEN',
        base: 'main',
        head: 'feat/x',
        is_draft: true,
      },
    });
  });

  it.each(['MERGED', 'CLOSED'])('reports a %s PR as such, not as no PR', async (state) => {
    const r = await getPullRequestState({ gh: fakeGh(ok(view({ state }))) }, '/wt', 'feat/x');
    expect(r.ok).toBe(true);
    expect((r as any).pr.state).toBe(state);
  });

  it('normalises a lower-case state', async () => {
    const r = await getPullRequestState({ gh: fakeGh(ok(view({ state: 'merged' }))) }, '/wt', 'feat/x');
    expect((r as any).pr.state).toBe('MERGED');
  });

  it('runs one read-only gh pr view for the branch, in the given checkout', async () => {
    const gh = fakeGh(ok(view()));
    await getPullRequestState({ gh }, '/wt/feat-x', 'feat/x');
    expect(gh).toHaveBeenCalledTimes(1);
    const [args, cwd] = gh.mock.calls[0];
    expect(args).toEqual(['pr', 'view', 'feat/x', '--json', 'number,url,state,baseRefName,headRefName,isDraft']);
    expect(cwd).toBe('/wt/feat-x');
  });

  it('takes the head from the branch when gh leaves headRefName out', async () => {
    const r = await getPullRequestState({ gh: fakeGh(ok(view({ headRefName: undefined }))) }, '/wt', 'feat/x');
    expect((r as any).pr).toMatchObject({ number: 42, head: 'feat/x' });
  });

  it('answers pr: null when the branch has no PR', async () => {
    const r = await getPullRequestState(
      { gh: fakeGh(fail('no pull requests found for branch "feat/x"')) },
      '/wt',
      'feat/x'
    );
    expect(r).toEqual({ ok: true, pr: null });
  });

  it('answers pr: null, with the reason, when the repo has no GitHub remote', async () => {
    const r = await getPullRequestState(
      { gh: fakeGh(fail('none of the git remotes configured for this repository point to a known GitHub host. please use `gh auth login`')) },
      '/wt',
      'feat/x'
    );
    expect(r).toMatchObject({ ok: true, pr: null, reason: 'not_github' });
  });

  it('is a clear error when gh is not installed', async () => {
    const r = await getPullRequestState({ gh: fakeGh(fail('spawn gh ENOENT', -1)) }, '/wt', 'feat/x');
    expect(r).toMatchObject({ ok: false, error: 'GH_UNAVAILABLE', reason: 'not_installed' });
    expect((r as any).message).toMatch(/not installed/i);
  });

  it('is a clear error when gh is not authenticated', async () => {
    const r = await getPullRequestState(
      { gh: fakeGh(fail('You are not logged into any GitHub hosts. Run gh auth login')) },
      '/wt',
      'feat/x'
    );
    expect(r).toMatchObject({ ok: false, error: 'GH_UNAVAILABLE', reason: 'not_authenticated' });
    expect((r as any).message).toMatch(/gh auth login/);
  });

  it('never reports a network or API failure as "no PR"', async () => {
    const r = await getPullRequestState(
      { gh: fakeGh(fail('error connecting to api.github.com')) },
      '/wt',
      'feat/x'
    );
    expect(r).toMatchObject({ ok: false, error: 'GH_ERROR' });
    expect((r as any).message).toMatch(/api\.github\.com/);
  });

  it('is an error, not a guess, when the output does not parse', async () => {
    const r = await getPullRequestState({ gh: fakeGh(ok('not json')) }, '/wt', 'feat/x');
    expect(r).toMatchObject({ ok: false, error: 'GH_ERROR' });
  });

  it("never reports another branch's PR, nor guesses no PR (gh reads a numeric branch as a PR number)", async () => {
    const r = await getPullRequestState({ gh: fakeGh(ok(view({ headRefName: 'someone-else' }))) }, '/wt', '123');
    expect(r).toMatchObject({ ok: false, error: 'GH_ERROR' });
    expect((r as any).message).toMatch(/numeric/);
  });
});

// ─── The MCP tool ────────────────────────────────────────────────────────────

type Handler = (args: any) => Promise<any>;
const parse = (result: any) => JSON.parse(result.content[0].text);

function buildHarness(instances: any[] = [], opts: { noGithub?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const server: any = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => handlers.set(name, handler),
  };
  const getPullRequestState = jest.fn(async (_wt: string, _branch: string) => ({
    ok: true as const,
    pr: { number: 7, url: 'u', state: 'MERGED' as const, base: 'main', head: 'feat/x', is_draft: false },
  }));
  const ensurePullRequest = jest.fn(async () => ({ status: 'created' }));
  const binder: any = {
    getSession: () => undefined,
    getWorktreePath: () => undefined,
    getWorktreePathForRepo: () => undefined,
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    listSessions: () => [],
  };
  const { registerTools } = require('../../../electron/services/mcp/tools');
  registerTools(
    server,
    binder,
    {
      githubService: opts.noGithub ? { ensurePullRequest } : { ensurePullRequest, getPullRequestState },
      agentInstanceService: { listInstances: () => ({ success: true, data: instances }) },
    },
    undefined
  );
  return { handler: handlers.get('kit_get_pr_state')!, getPullRequestState, ensurePullRequest };
}

let tmpRoot: string;
let repoDir: string;
let worktreeDir: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kit-prstate-'));
  repoDir = mkdtempSync(join(tmpRoot, 'repo-'));
  worktreeDir = mkdtempSync(join(tmpRoot, 'wt-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('kit_get_pr_state tool', () => {
  it('is registered and declared', () => {
    expect(buildHarness().handler).toBeDefined();
    expect(MCP_TOOLS.GET_PR_STATE).toBe('kit_get_pr_state');
  });

  it('is read-only: not state-changing and allowed for observers', () => {
    expect(MCP_STATE_CHANGING_TOOLS.has('kit_get_pr_state')).toBe(false);
    expect(MCP_OBSERVER_FORBIDDEN_TOOLS.has('kit_get_pr_state')).toBe(false);
  });

  it('takes repo_path + branch', async () => {
    const h = buildHarness();
    const out = parse(await h.handler({ repo_path: repoDir, branch: 'feat/x' }));
    expect(h.getPullRequestState).toHaveBeenCalledWith(repoDir, 'feat/x');
    expect(out).toMatchObject({ ok: true, branch: 'feat/x', pr: { number: 7, state: 'MERGED' } });
  });

  it("resolves a session's branch and worktree, including by a restart-predecessor id", async () => {
    const h = buildHarness([
      {
        sessionId: 'sess_new',
        predecessorSessionIds: ['sess_old'],
        worktreePath: worktreeDir,
        config: { branchName: 'feat/x', repoPath: repoDir },
      },
    ]);
    const out = parse(await h.handler({ session_id: 'sess_old' }));
    expect(h.getPullRequestState).toHaveBeenCalledWith(worktreeDir, 'feat/x');
    expect(out.branch).toBe('feat/x');
  });

  it("falls back to the repo when a closed session's worktree is gone", async () => {
    const h = buildHarness([
      {
        sessionId: 'sess_1',
        worktreePath: join(tmpRoot, 'deleted'),
        config: { branchName: 'feat/x', repoPath: repoDir },
      },
    ]);
    await h.handler({ session_id: 'sess_1' });
    expect(h.getPullRequestState).toHaveBeenCalledWith(repoDir, 'feat/x');
  });

  it('strips origin/ and refs/heads/ from the branch', async () => {
    const h = buildHarness();
    const a = parse(await h.handler({ repo_path: repoDir, branch: 'origin/feat/x' }));
    const b = parse(await h.handler({ repo_path: repoDir, branch: 'refs/heads/feat/x' }));
    expect(h.getPullRequestState.mock.calls).toEqual([
      [repoDir, 'feat/x'],
      [repoDir, 'feat/x'],
    ]);
    expect([a.branch, b.branch]).toEqual(['feat/x', 'feat/x']);
  });

  it('refuses a session with no branch without calling gh', async () => {
    const h = buildHarness([{ sessionId: 'sess_1', worktreePath: worktreeDir, config: { repoPath: repoDir } }]);
    const out = parse(await h.handler({ session_id: 'sess_1' }));
    expect(out).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
    expect(h.getPullRequestState).not.toHaveBeenCalled();
  });

  it('answers ok: false, UNAVAILABLE when the GitHub service is not wired', async () => {
    const h = buildHarness([], { noGithub: true });
    const out = parse(await h.handler({ repo_path: repoDir, branch: 'feat/x' }));
    expect(out).toMatchObject({ ok: false, error: 'UNAVAILABLE', branch: 'feat/x' });
  });

  it('refuses an unknown session without calling gh', async () => {
    const h = buildHarness();
    const out = parse(await h.handler({ session_id: 'sess_nope' }));
    expect(out).toMatchObject({ ok: false, error: 'UNKNOWN_SESSION' });
    expect(h.getPullRequestState).not.toHaveBeenCalled();
  });

  it('refuses when neither a session nor repo_path + branch is given', async () => {
    const h = buildHarness();
    expect(parse(await h.handler({ repo_path: repoDir }))).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
    expect(parse(await h.handler({ branch: 'feat/x' }))).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
    expect(h.getPullRequestState).not.toHaveBeenCalled();
  });

  it('refuses a repo_path that does not exist', async () => {
    const h = buildHarness();
    const out = parse(await h.handler({ repo_path: join(tmpRoot, 'nope'), branch: 'feat/x' }));
    expect(out).toMatchObject({ ok: false, error: 'INVALID_REPO' });
  });

  it('passes a gh error through and never opens or edits a PR', async () => {
    const h = buildHarness();
    h.getPullRequestState.mockResolvedValueOnce({
      ok: false,
      error: 'GH_UNAVAILABLE',
      reason: 'not_authenticated',
      message: 'Run `gh auth login`.',
    } as any);
    const out = parse(await h.handler({ repo_path: repoDir, branch: 'feat/x' }));
    expect(out).toMatchObject({ ok: false, error: 'GH_UNAVAILABLE', reason: 'not_authenticated', branch: 'feat/x' });
    expect(h.ensurePullRequest).not.toHaveBeenCalled();
  });
});
