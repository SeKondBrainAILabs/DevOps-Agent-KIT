/**
 * Bulk action runner + result aggregator (Epic F / story F3).
 *
 * Project Group "Pull all / Fetch all / Status all" needs to:
 *  - run an op against N repos in parallel
 *  - isolate failures (one bad repo doesn't kill the rest)
 *  - aggregate results for a summary toast
 *
 * The runner is a small generic over the per-repo result type; the
 * aggregator produces { ok, failed, durationMs, message }.
 */

export interface BulkAttemptResult<T> {
  repoName: string;
  ok: boolean;
  /** Present when ok=true. */
  data?: T;
  /** Present when ok=false. */
  error?: string;
  /** Wall-clock ms for this repo's attempt. */
  durationMs: number;
}

export interface BulkSummary<T> {
  results: BulkAttemptResult<T>[];
  okCount: number;
  failedCount: number;
  /** Total wall-clock for the bulk operation (max of attempts since they run in parallel). */
  durationMs: number;
  /** Human-readable summary suitable for a toast. */
  message: string;
}

export interface RunBulkInputs<T> {
  repos: ReadonlyArray<{ repoName: string; [k: string]: unknown }>;
  /** Async op per repo. Throwing or rejecting is captured as a failure. */
  op: (repo: { repoName: string }) => Promise<T>;
  /** Verb for the toast message — "pull" / "fetch" / "status". */
  actionLabel: string;
  /** Clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export async function runBulkAction<T>(input: RunBulkInputs<T>): Promise<BulkSummary<T>> {
  const now = input.now ?? Date.now;
  const start = now();

  const results: BulkAttemptResult<T>[] = await Promise.all(
    input.repos.map(async (repo) => {
      const attemptStart = now();
      try {
        const data = await input.op(repo);
        return {
          repoName: repo.repoName,
          ok: true,
          data,
          durationMs: now() - attemptStart,
        };
      } catch (err) {
        return {
          repoName: repo.repoName,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: now() - attemptStart,
        };
      }
    })
  );

  const okCount = results.filter((r) => r.ok).length;
  const failedCount = results.length - okCount;
  return {
    results,
    okCount,
    failedCount,
    durationMs: now() - start,
    message: formatBulkMessage(input.actionLabel, okCount, failedCount),
  };
}

export function formatBulkMessage(action: string, ok: number, failed: number): string {
  const total = ok + failed;
  if (total === 0) return `No repos to ${action}.`;
  if (failed === 0) return `${action} succeeded on all ${total} repo${total === 1 ? '' : 's'}.`;
  if (ok === 0) return `${action} failed on all ${total} repo${total === 1 ? '' : 's'}.`;
  return `${action}: ${ok} succeeded, ${failed} failed (of ${total}).`;
}
