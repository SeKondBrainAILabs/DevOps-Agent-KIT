/**
 * One `gh` runner and one failure classifier (story KIT-PR-P1).
 *
 * ## Why this exists
 *
 * `MergeService` builds its own `runGh` inline (`MergeService.ts:228`) and then
 * decides whether gh is usable with a regex at the call site:
 * `/command not found|ENOENT/i` (`:238`). Two more callers now need the same
 * thing, and copying that regex twice more would be three places to get the
 * same subtle decision wrong.
 *
 * The subtlety: gh's "this remote is not GitHub" message ALSO tells you to run
 * `gh auth login`. Anything checking for that phrase first will tell a GitLab
 * user they are logged out, and they will authenticate forever without it ever
 * working. Order of checks is load-bearing, which is exactly the kind of thing
 * that belongs in one tested function rather than at three call sites.
 */

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs `gh` with the given args in `cwd`. Never throws — failure is a result. */
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

export type GhFailure =
  /** The gh binary is not on PATH. */
  | 'not_installed'
  /** gh is present but has no credentials for this host. */
  | 'not_authenticated'
  /** No remote on this repo points at a GitHub host. */
  | 'not_github'
  /** A real gh/API error, or an ordinary "no PR found" the caller handles. */
  | 'other';

/**
 * Why a gh invocation failed, or null if it succeeded.
 *
 * Pure — no imports, no I/O — so the whole matrix is table-testable.
 */
export function classifyGhFailure(result: GhResult): GhFailure | null {
  if (result.ok) return null;

  const stderr = (result.stderr || '').toLowerCase();

  // 1. Could we even run it? execa reports code -1 when the spawn itself
  //    failed; a shell wrapper reports 127.
  if (
    stderr.includes('enoent') ||
    stderr.includes('command not found') ||
    stderr.includes('is not recognized as an internal or external command')
  ) {
    return 'not_installed';
  }

  // 2. BEFORE the auth check, deliberately. gh's not-a-GitHub-remote message
  //    ends with "please use `gh auth login`", so testing for auth phrases
  //    first would classify every GitLab and Bitbucket repo as logged out.
  if (
    stderr.includes('point to a known github host') ||
    stderr.includes('none of the git remotes')
  ) {
    return 'not_github';
  }

  // 3. Genuinely no credentials.
  if (
    stderr.includes('not logged into') ||
    stderr.includes('authentication required') ||
    stderr.includes('gh_token') ||
    stderr.includes('gh auth login')
  ) {
    return 'not_authenticated';
  }

  // 4. Everything else, including the ordinary "no pull requests found" that
  //    callers treat as a normal answer rather than a gh problem.
  return 'other';
}

/**
 * Human-facing explanation for a classification, so every caller phrases the
 * same problem the same way.
 */
export function describeGhFailure(failure: GhFailure): string {
  switch (failure) {
    case 'not_installed':
      return 'The GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com to let KIT open and check pull requests.';
    case 'not_authenticated':
      return 'The GitHub CLI is installed but not authenticated. Run `gh auth login`.';
    case 'not_github':
      return 'This repository has no GitHub remote, so there is nothing to open a pull request against.';
    case 'other':
    default:
      return 'The GitHub CLI returned an error.';
  }
}

/**
 * The real runner. `execa` is ESM-only, so it is imported dynamically inside
 * the call — which also keeps this module loadable under jest, where a
 * top-level execa import would throw "Cannot use import statement outside a
 * module". The classifier above stays reachable in tests either way.
 *
 * Mirrors what MergeService did inline: 30s timeout, `reject: false`, and
 * failure reported as a result rather than thrown.
 */
export function createGhRunner(timeoutMs = 30_000): GhRunner {
  return async (args: string[], cwd: string): Promise<GhResult> => {
    try {
      const mod: any = await import('execa');
      const execa =
        typeof mod.execa === 'function'
          ? mod.execa
          : typeof mod.default === 'function'
            ? mod.default
            : mod.default?.execa;
      const r = await execa('gh', args, { cwd, timeout: timeoutMs, reject: false });
      return {
        ok: r.exitCode === 0,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        code: r.exitCode ?? -1,
      };
    } catch (err: any) {
      // A spawn failure lands here rather than as a non-zero exit, which is why
      // classifyGhFailure looks at stderr text and not only at the code.
      return { ok: false, stdout: '', stderr: err?.message || String(err), code: -1 };
    }
  };
}
