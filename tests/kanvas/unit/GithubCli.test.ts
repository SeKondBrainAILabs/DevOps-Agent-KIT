/**
 * Unit Tests for shared/github-cli.ts (story KIT-PR-P1)
 *
 * `MergeService` decides whether gh is usable with an inline regex at the call
 * site: `/command not found|ENOENT/i` (MergeService.ts:238). That is one branch
 * of at least four, and the consequence of getting it wrong is telling a user
 * "this is not a GitHub repo" when gh is simply not installed — sending them to
 * fix the wrong thing.
 *
 * The classification is therefore a pure function, tested against the strings
 * gh actually emits.
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyGhFailure,
  resolveGhCommand,
  toGhResult,
  type GhResult,
} from '../../../shared/github-cli';

const result = (over: Partial<GhResult> = {}): GhResult => ({
  ok: false,
  stdout: '',
  stderr: '',
  code: 1,
  ...over,
});

describe('classifyGhFailure — success', () => {
  it('returns null when the command succeeded', () => {
    expect(classifyGhFailure(result({ ok: true, code: 0, stdout: '[]' }))).toBeNull();
  });

  it('returns null even when a successful command wrote to stderr', () => {
    // gh writes advisory notices to stderr on success.
    expect(
      classifyGhFailure(result({ ok: true, code: 0, stderr: 'some notice' }))
    ).toBeNull();
  });
});

describe('classifyGhFailure — gh is not installed', () => {
  it.each([
    'spawn gh ENOENT',
    '/bin/sh: gh: command not found',
    'Error: spawnSync gh ENOENT',
  ])('classifies %p as not_installed', (stderr) => {
    expect(classifyGhFailure(result({ stderr, code: -1 }))).toBe('not_installed');
  });

  it('is not_installed regardless of exit code', () => {
    // execa reports -1 when it could not spawn, but a shell wrapper reports 127.
    expect(
      classifyGhFailure(result({ stderr: 'gh: command not found', code: 127 }))
    ).toBe('not_installed');
  });
});

describe('classifyGhFailure — the remote is not GitHub', () => {
  // The real message, which is why this case is dangerous:
  const NOT_GITHUB =
    'none of the git remotes configured for this repository point to a known ' +
    'GitHub host. To tell gh about a new GitHub host, please use `gh auth login`';

  it('classifies the real gh message as not_github', () => {
    expect(classifyGhFailure(result({ stderr: NOT_GITHUB }))).toBe('not_github');
  });

  it('is NOT misread as not_authenticated even though it says "gh auth login"', () => {
    // The trap. A naive `stderr.includes('gh auth login')` check classifies a
    // GitLab repo as "you are logged out" and sends the user to authenticate,
    // which will never fix it. Order of checks is load-bearing.
    expect(classifyGhFailure(result({ stderr: NOT_GITHUB }))).not.toBe(
      'not_authenticated'
    );
  });
});

describe('classifyGhFailure — not authenticated', () => {
  it.each([
    'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
    'error: authentication required',
    'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.',
  ])('classifies %p as not_authenticated', (stderr) => {
    expect(classifyGhFailure(result({ stderr }))).toBe('not_authenticated');
  });
});

describe('classifyGhFailure — everything else', () => {
  it('classifies an unrecognised failure as other', () => {
    expect(
      classifyGhFailure(result({ stderr: 'GraphQL: Something went wrong (repository)' }))
    ).toBe('other');
  });

  it('classifies a no-PR-found failure as other, not as a gh problem', () => {
    // `gh pr view <branch>` on a branch with no PR is a NORMAL outcome the
    // caller handles, not a gh availability problem.
    expect(
      classifyGhFailure(result({ stderr: 'no pull requests found for branch "feat-x"' }))
    ).toBe('other');
  });

  it('classifies an empty stderr failure as other rather than guessing', () => {
    expect(classifyGhFailure(result({ stderr: '', code: 1 }))).toBe('other');
  });
});

describe('resolveGhCommand — an app started without Homebrew on PATH', () => {
  const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const has = (...files: string[]) => (file: string) => files.includes(file);

  it('runs plain gh when gh is on PATH', () => {
    expect(resolveGhCommand('/opt/homebrew/bin:/usr/bin', has('/opt/homebrew/bin/gh'))).toBe('gh');
  });

  it('uses the Homebrew gh when PATH is launchd\'s default', () => {
    expect(resolveGhCommand(LAUNCHD_PATH, has('/opt/homebrew/bin/gh'))).toBe('/opt/homebrew/bin/gh');
  });

  it('uses /usr/local/bin/gh on an Intel Mac', () => {
    expect(resolveGhCommand(LAUNCHD_PATH, has('/usr/local/bin/gh'))).toBe('/usr/local/bin/gh');
  });

  it('falls back to plain gh when it is nowhere, so the spawn error is reported', () => {
    expect(resolveGhCommand(undefined, has())).toBe('gh');
  });
});

describe('toGhResult — failures that carry no stderr', () => {
  it('reports a spawn failure instead of an empty stderr', () => {
    const r = toGhResult(
      { exitCode: undefined, stdout: '', stderr: '', failed: true, shortMessage: 'Command failed with ENOENT: gh pr create\nspawn gh ENOENT' },
      30_000
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain('ENOENT');
    expect(classifyGhFailure(r)).toBe('not_installed');
  });

  it('reports a timeout', () => {
    const r = toGhResult({ exitCode: undefined, stdout: '', stderr: '', timedOut: true }, 30_000);
    expect(r.stderr).toBe('gh timed out after 30s');
  });

  it('keeps gh\'s own stderr and a success as they are', () => {
    expect(toGhResult({ exitCode: 1, stdout: '', stderr: 'boom', message: 'x' }, 30_000).stderr).toBe('boom');
    expect(toGhResult({ exitCode: 0, stdout: 'url', stderr: '' }, 30_000)).toEqual({
      ok: true, stdout: 'url', stderr: '', code: 0,
    });
  });
});
