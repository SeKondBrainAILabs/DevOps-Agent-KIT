/**
 * Unit Tests for GitHubService.ensurePullRequest (story KIT-PR-P3)
 *
 * Idempotency is the whole story: agents retry, and a tool that opens a second
 * pull request on the second call is worse than one that fails.
 *
 * Every gh invocation is injected, so none of this touches the network.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { existsSync } from 'fs';
import { ensurePullRequest, type EnsurePrDeps } from '../../../electron/services/GitHubService';
import type { GhResult } from '../../../shared/github-cli';

const ok = (stdout = ''): GhResult => ({ ok: true, stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1): GhResult => ({ ok: false, stdout: '', stderr, code });

const NO_PR = fail('no pull requests found for branch "feat-x"');

interface Harness {
  deps: EnsurePrDeps;
  calls: string[][];
  bodyFilesSeen: string[];
}

function harness(over: Partial<EnsurePrDeps> & { ghResponses?: Record<string, GhResult> } = {}): Harness {
  const calls: string[][] = [];
  const bodyFilesSeen: string[] = [];
  const responses = over.ghResponses ?? {};

  const deps: EnsurePrDeps = {
    gh: async (args) => {
      calls.push([...args]);
      // Capture the body file while it still exists, so a test can assert both
      // that it was written and that it was cleaned up afterwards.
      const idx = args.indexOf('--body-file');
      if (idx >= 0) bodyFilesSeen.push(args[idx + 1]);
      const key = args.slice(0, 2).join(' ');
      return responses[key] ?? ok();
    },
    push: jest.fn(async () => ({ success: true, data: undefined })) as any,
    getRemoteUrl: async () => 'git@github.com:acme/widgets.git',
    getCommits: async () => [{ hash: 'aaaaaaa', subject: 'feat: a thing' }],
    ...over,
  };
  return { deps, calls, bodyFilesSeen };
}

const session = {
  sessionId: 'sess_abc',
  branchName: 'feat-x',
  baseBranch: 'development',
  taskDescription: 'Do the thing',
  worktreePath: '/wt/feat-x',
};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ─── Preconditions that are answers, not errors ──────────────────────────────
describe('ensurePullRequest — when there is nothing to open a PR against', () => {
  it('reports no_remote and does not throw', async () => {
    const h = harness({ getRemoteUrl: async () => null });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('no_remote');
    expect(h.calls).toHaveLength(0);
  });

  it('reports not_github for a GitLab remote without calling gh', async () => {
    const h = harness({ getRemoteUrl: async () => 'git@gitlab.com:acme/widgets.git' });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('not_github');
    expect(h.calls).toHaveLength(0);
  });

  it('recognises a github.com HTTPS remote', async () => {
    const h = harness({
      getRemoteUrl: async () => 'https://github.com/acme/widgets.git',
      ghResponses: { 'pr view': NO_PR },
    });
    expect((await ensurePullRequest(h.deps, session)).status).toBe('created');
  });

  it('reports gh_unavailable when gh is missing, distinctly from not_github', async () => {
    const h = harness({ ghResponses: { 'pr view': fail('spawn gh ENOENT', -1) } });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('gh_unavailable');
    expect(r.reason).toBe('not_installed');
  });

  it('reports gh_unavailable when gh is logged out', async () => {
    const h = harness({
      ghResponses: { 'pr view': fail('You are not logged into any GitHub hosts.') },
    });
    expect((await ensurePullRequest(h.deps, session)).reason).toBe('not_authenticated');
  });
});

// ─── The point of the story ──────────────────────────────────────────────────
describe('ensurePullRequest — idempotency', () => {
  it('creates a PR when none exists', async () => {
    const h = harness({ ghResponses: { 'pr view': NO_PR } });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('created');
    expect(h.calls.some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(true);
  });

  it('UPDATES rather than creating when an open PR already exists', async () => {
    const h = harness({
      ghResponses: {
        'pr view': ok(JSON.stringify({ number: 7, url: 'https://gh/pr/7', state: 'OPEN' })),
      },
    });
    const r = await ensurePullRequest(h.deps, session);

    expect(r.status).toBe('updated');
    expect(r.number).toBe(7);
    expect(h.calls.some((c) => c[1] === 'create')).toBe(false);
    expect(h.calls.some((c) => c[1] === 'edit')).toBe(true);
  });

  it('two calls produce exactly one create', async () => {
    let viewed = 0;
    const h = harness({
      ghResponses: {},
      gh: async (args: string[]) => {
        if (args[1] === 'view') {
          viewed += 1;
          return viewed === 1
            ? NO_PR
            : ok(JSON.stringify({ number: 7, url: 'https://gh/pr/7', state: 'OPEN' }));
        }
        return ok();
      },
    } as any);

    const first = await ensurePullRequest(h.deps, session);
    const second = await ensurePullRequest(h.deps, session);

    expect(first.status).toBe('created');
    expect(second.status).toBe('updated');
  });

  it('creates a NEW PR when the existing one is merged', async () => {
    // `gh pr view <branch>` returns the most recent PR for a branch INCLUDING
    // merged ones. Editing a merged PR silently does nothing useful, and the
    // agent would report success against a PR nobody will look at again.
    const h = harness({
      ghResponses: {
        'pr view': ok(JSON.stringify({ number: 3, url: 'https://gh/pr/3', state: 'MERGED' })),
      },
    });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('created');
    expect(h.calls.some((c) => c[1] === 'edit')).toBe(false);
  });

  it('creates a NEW PR when the existing one is closed', async () => {
    const h = harness({
      ghResponses: {
        'pr view': ok(JSON.stringify({ number: 4, url: 'https://gh/pr/4', state: 'CLOSED' })),
      },
    });
    expect((await ensurePullRequest(h.deps, session)).status).toBe('created');
  });
});

describe('ensurePullRequest — the branch has to be pushed', () => {
  it('pushes before asking GitHub anything', async () => {
    const h = harness({ ghResponses: { 'pr view': NO_PR } });
    await ensurePullRequest(h.deps, session);
    expect(h.deps.push).toHaveBeenCalled();
  });

  it('reports push_failed and never calls gh pr create', async () => {
    // Creating a PR for a branch that is not on the remote fails with a
    // confusing gh error. Fail on our own terms instead.
    const h = harness({
      push: jest.fn(async () => ({
        success: false,
        error: { code: 'GIT_PUSH_FAILED', message: 'rejected' },
      })) as any,
    });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.status).toBe('push_failed');
    expect(h.calls.some((c) => c[1] === 'create')).toBe(false);
  });
});

describe('ensurePullRequest — the body file', () => {
  it('passes the body via --body-file, never --body', async () => {
    // A generated body has newlines, backticks and quotes in it, and commit
    // subjects are attacker-influenceable. Passing it as an argument is both a
    // quoting bug and an injection surface.
    const h = harness({ ghResponses: { 'pr view': NO_PR } });
    await ensurePullRequest(h.deps, session);

    const create = h.calls.find((c) => c[1] === 'create')!;
    expect(create).toContain('--body-file');
    expect(create).not.toContain('--body');
  });

  it('deletes the temp body file afterwards', async () => {
    const h = harness({ ghResponses: { 'pr view': NO_PR } });
    await ensurePullRequest(h.deps, session);

    expect(h.bodyFilesSeen.length).toBeGreaterThan(0);
    for (const f of h.bodyFilesSeen) expect(existsSync(f)).toBe(false);
  });

  it('deletes the temp body file even when gh fails', async () => {
    const h = harness({
      ghResponses: { 'pr view': NO_PR, 'pr create': fail('GraphQL: something broke') },
    });
    const r = await ensurePullRequest(h.deps, session);

    expect(r.status).toBe('failed');
    for (const f of h.bodyFilesSeen) expect(existsSync(f)).toBe(false);
  });
});

describe('ensurePullRequest — what it reports back', () => {
  it('returns the PR url and number on create', async () => {
    const h = harness({
      ghResponses: {
        'pr view': NO_PR,
        'pr create': ok('https://github.com/acme/widgets/pull/12'),
      },
    });
    const r = await ensurePullRequest(h.deps, session);
    expect(r.url).toBe('https://github.com/acme/widgets/pull/12');
    expect(r.number).toBe(12);
  });

  it('targets the session base branch', async () => {
    const h = harness({ ghResponses: { 'pr view': NO_PR } });
    await ensurePullRequest(h.deps, session);
    const create = h.calls.find((c) => c[1] === 'create')!;
    expect(create[create.indexOf('--base') + 1]).toBe('development');
    expect(create[create.indexOf('--head') + 1]).toBe('feat-x');
  });
});
