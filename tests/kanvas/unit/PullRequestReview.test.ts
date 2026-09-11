/**
 * listPullRequests / reviewPullRequest (story KIT-PR-P11)
 *
 * The Review tab needs three things GitHub knows and KIT does not: which pull
 * requests a session's branch has ever had, whether the current one can be
 * approved by this user, and a way to record a decision.
 *
 * The approval constraint is the interesting one. GitHub REFUSES to let anyone
 * approve their own pull request. KIT opens these PRs through `gh`, i.e. as the
 * user running KIT — so for the common case the Approve button can never work,
 * and a UI that offers it anyway is offering a button that always errors.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  listPullRequests,
  reviewPullRequest,
  canApprove,
  type PrReviewDeps,
} from '../../../electron/services/GitHubService';
import type { GhResult } from '../../../shared/github-cli';

const ok = (stdout = ''): GhResult => ({ ok: true, stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1): GhResult => ({ ok: false, stdout: '', stderr, code });

function deps(responses: Record<string, GhResult>, calls: string[][] = []): PrReviewDeps {
  return {
    gh: async (args) => {
      calls.push([...args]);
      return responses[args.slice(0, 2).join(' ')] ?? ok();
    },
  };
}

describe('listPullRequests', () => {
  it('returns every PR for the branch, newest first', async () => {
    const d = deps({
      'pr list': ok(JSON.stringify([
        { number: 12, url: 'u12', state: 'OPEN', title: 'b', createdAt: '2026-09-02T00:00:00Z', isDraft: false },
        { number: 9, url: 'u9', state: 'MERGED', title: 'a', createdAt: '2026-09-01T00:00:00Z', isDraft: false },
      ])),
    });

    const r = await listPullRequests(d, '/wt', 'feat-x');

    expect(r.map((p) => p.number)).toEqual([12, 9]);
    expect(r[0].state).toBe('OPEN');
  });

  it('includes closed and merged pull requests, not just open ones', async () => {
    // The point of history: what happened to this branch before.
    const calls: string[][] = [];
    const d = deps({ 'pr list': ok('[]') }, calls);
    await listPullRequests(d, '/wt', 'feat-x');
    expect(calls[0]).toContain('--state');
    expect(calls[0][calls[0].indexOf('--state') + 1]).toBe('all');
  });

  it('returns an empty list rather than throwing when gh fails', async () => {
    // PR history is decoration. It must never break the tab that shows the
    // handover summary, which works offline.
    const d = deps({ 'pr list': fail('gh: command not found', -1) });
    await expect(listPullRequests(d, '/wt', 'feat-x')).resolves.toEqual([]);
  });

  it('returns an empty list on unparseable output', async () => {
    const d = deps({ 'pr list': ok('not json') });
    await expect(listPullRequests(d, '/wt', 'feat-x')).resolves.toEqual([]);
  });
});

// ─── The constraint that shapes the UI ───────────────────────────────────────
describe('canApprove', () => {
  it('is false when the viewer authored the pull request', async () => {
    // GitHub rejects self-approval. Offering the button anyway means offering
    // one that always errors.
    const d = deps({
      'pr view': ok(JSON.stringify({ author: { login: 'sachin' } })),
      // gh is called with --jq '.login', so it emits the bare login.
      'api user': ok('sachin'),
    });

    const r = await canApprove(d, '/wt', 12);

    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/your own pull request/i);
  });

  it('is true when someone else authored it', async () => {
    const d = deps({
      'pr view': ok(JSON.stringify({ author: { login: 'an-agent-bot' } })),
      // gh is called with --jq '.login', so it emits the bare login.
      'api user': ok('sachin'),
    });

    expect((await canApprove(d, '/wt', 12)).allowed).toBe(true);
  });

  it('refuses rather than guessing when the author cannot be determined', async () => {
    const d = deps({ 'pr view': fail('boom') });
    const r = await canApprove(d, '/wt', 12);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/could not/i);
  });
});

describe('reviewPullRequest', () => {
  it('approves', async () => {
    const calls: string[][] = [];
    const d = deps({}, calls);
    const r = await reviewPullRequest(d, '/wt', 12, 'approve');
    expect(r.ok).toBe(true);
    expect(calls[0]).toEqual(['pr', 'review', '12', '--approve']);
  });

  it('requests changes with a body', async () => {
    const calls: string[][] = [];
    const d = deps({}, calls);
    await reviewPullRequest(d, '/wt', 12, 'request-changes', 'needs tests');
    expect(calls[0]).toEqual(['pr', 'review', '12', '--request-changes', '--body', 'needs tests']);
  });

  it('requires a body for request-changes — GitHub rejects an empty one', async () => {
    const d = deps({});
    const r = await reviewPullRequest(d, '/wt', 12, 'request-changes');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/comment/i);
  });

  it('surfaces the self-approval refusal in words the user can act on', async () => {
    const d = deps({
      'pr review': fail('GraphQL: Can not approve your own pull request (addPullRequestReview)'),
    });
    const r = await reviewPullRequest(d, '/wt', 12, 'approve');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/your own pull request/i);
  });

  it('reports a gh failure rather than throwing', async () => {
    const d = deps({ 'pr review': fail('spawn gh ENOENT', -1) });
    const r = await reviewPullRequest(d, '/wt', 12, 'approve');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not installed/i);
  });
});
