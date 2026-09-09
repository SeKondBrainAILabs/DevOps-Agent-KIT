/**
 * Pull request creation (story KIT-PR-P3).
 *
 * KIT's merge gate has always asked GitHub about a pull request — `kit_merge`
 * runs `gh pr checks <branch>` for protected targets — while nothing in KIT
 * ever created one. This is the missing half.
 *
 * `ensurePullRequest` is exported as a free function over injected deps rather
 * than as a class method, for the same reason `SessionOrchestrator` is: jest
 * cannot import the concrete services (electron-store is ESM), and this is
 * logic worth testing exhaustively — idempotency bugs here mean duplicate pull
 * requests on somebody's repository.
 */

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IpcResult } from '../../shared/types';
import {
  classifyGhFailure,
  type GhFailure,
  type GhRunner,
} from '../../shared/github-cli';
import { buildPrBody, buildPrTitle, type PrCommit } from '../../shared/pr-body';

export interface EnsurePrDeps {
  gh: GhRunner;
  /** Pushes the session branch. GitService.push already uses `push -u origin`. */
  push(sessionId: string): Promise<IpcResult<void>>;
  /** `git remote get-url origin`, or null when there is no origin. */
  getRemoteUrl(worktreePath: string): Promise<string | null>;
  /** `git log <base>..<head>` — the source of truth for what the PR contains. */
  getCommits(worktreePath: string, baseBranch: string, branchName: string): Promise<PrCommit[]>;
}

export interface EnsurePrSession {
  sessionId: string;
  branchName: string;
  baseBranch: string;
  taskDescription: string;
  worktreePath: string;
}

export type EnsurePrStatus =
  | 'created'
  | 'updated'
  | 'no_remote'
  | 'not_github'
  | 'gh_unavailable'
  | 'push_failed'
  | 'failed';

export interface EnsurePrResult {
  status: EnsurePrStatus;
  url?: string;
  number?: number;
  /** For 'gh_unavailable', which gh problem it was. */
  reason?: GhFailure;
  message?: string;
}

/** Only github.com remotes can have a PR opened by `gh`. */
function isGitHubRemote(remoteUrl: string): boolean {
  return /(^git@github\.com[:/])|(^ssh:\/\/git@github\.com\/)|(^https?:\/\/([^@/]+@)?github\.com\/)/i.test(
    remoteUrl.trim()
  );
}

function prNumberFromUrl(url: string): number | undefined {
  const m = url.trim().match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export async function ensurePullRequest(
  deps: EnsurePrDeps,
  session: EnsurePrSession
): Promise<EnsurePrResult> {
  const { worktreePath, branchName, baseBranch, sessionId, taskDescription } = session;

  // ── 1. Is there anywhere to open a PR? ──────────────────────────────────
  // These are answers, not errors: a local-only repo is a perfectly valid way
  // to work, and the caller still records the review.
  const remoteUrl = await deps.getRemoteUrl(worktreePath).catch(() => null);
  if (!remoteUrl) {
    return { status: 'no_remote', message: 'No `origin` remote is configured.' };
  }
  if (!isGitHubRemote(remoteUrl)) {
    return {
      status: 'not_github',
      message: `The origin remote (${remoteUrl}) is not a GitHub repository.`,
    };
  }

  // ── 2. The branch has to exist on the remote before gh can reference it ──
  // Otherwise `gh pr create` fails with a message about the head ref that
  // reads as a GitHub problem rather than "you have not pushed".
  const pushed = await deps.push(sessionId);
  if (pushed && pushed.success === false) {
    return {
      status: 'push_failed',
      message: `Could not push '${branchName}': ${pushed.error?.message ?? 'unknown error'}`,
    };
  }

  // ── 3. Does an OPEN pull request already exist? ─────────────────────────
  const view = await deps.gh(
    ['pr', 'view', branchName, '--json', 'number,url,state'],
    worktreePath
  );

  // Distinguish "gh cannot work here" from "there is simply no PR". The latter
  // is the normal first-run answer and must not surface as a gh problem.
  const failure = classifyGhFailure(view);
  if (failure === 'not_installed' || failure === 'not_authenticated') {
    return { status: 'gh_unavailable', reason: failure };
  }
  if (failure === 'not_github') {
    return { status: 'not_github' };
  }

  let existing: { number: number; url: string; state: string } | null = null;
  if (view.ok && view.stdout.trim()) {
    try {
      existing = JSON.parse(view.stdout);
    } catch {
      existing = null;
    }
  }

  // A MERGED or CLOSED pull request is not reused. `gh pr view <branch>`
  // returns the most recent PR for the branch including merged ones; editing
  // one would report success against a PR nobody will look at again.
  const hasOpenPr = existing !== null && String(existing.state).toUpperCase() === 'OPEN';

  // ── 4. Build the body from what is actually on the branch ───────────────
  const commits = await deps
    .getCommits(worktreePath, baseBranch, branchName)
    .catch(() => [] as PrCommit[]);

  const title = buildPrTitle({ sessionId, branchName, baseBranch, taskDescription, commits });
  const body = buildPrBody({ sessionId, branchName, baseBranch, taskDescription, commits });

  // `--body-file`, never `--body`: the body contains newlines, backticks and
  // quotes, and commit subjects are attacker-influenceable in any repo that
  // takes contributions.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'kit-pr-'));
    const bodyFile = join(dir, 'body.md');
    await writeFile(bodyFile, body, 'utf-8');

    if (hasOpenPr && existing) {
      const edit = await deps.gh(
        ['pr', 'edit', String(existing.number), '--body-file', bodyFile],
        worktreePath
      );
      if (!edit.ok) {
        return {
          status: 'failed',
          message: `Could not update PR #${existing.number}: ${edit.stderr || 'unknown error'}`,
          url: existing.url,
          number: existing.number,
        };
      }
      return { status: 'updated', url: existing.url, number: existing.number };
    }

    const create = await deps.gh(
      [
        'pr', 'create',
        '--base', baseBranch,
        '--head', branchName,
        '--title', title,
        '--body-file', bodyFile,
      ],
      worktreePath
    );
    if (!create.ok) {
      return {
        status: 'failed',
        message: `Could not create the pull request: ${create.stderr || 'unknown error'}`,
      };
    }

    const url = create.stdout.trim().split('\n').pop() ?? '';
    return { status: 'created', url, number: prNumberFromUrl(url) };
  } finally {
    // Always, including on the failure paths above — a temp file holding a PR
    // body is small but there is one per request at fan-out.
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
