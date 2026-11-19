/**
 * CI checks classification (story KC-S1.2.2.4)
 *
 * A pure module that turns `gh pr checks --json name,state,bucket` rows into
 * a summary with passing/failing/pending/none plus counts. Classification
 * matches `MergeService.checkMergeGate` so the review badge and the merge gate
 * can never disagree.
 *
 * ## Classification rules
 *
 * - Failing: any check with bucket `fail`/`cancel` OR state `FAILURE`/`ERROR`/`CANCELLED`/`TIMED_OUT`
 * - Pending: any check with bucket `pending` OR state `PENDING`/`IN_PROGRESS`/`QUEUED`
 * - Passing: everything else
 * - None: empty list
 */

export type CiChecksSummary = {
  overall: 'passing' | 'pending' | 'failing';
  counts: {
    passing: number;
    pending: number;
    failing: number;
    total: number;
  };
};

export type CheckItem = { name: string; state: string; bucket?: string };

/** Classify the overall status of a list of checks. */
export function classifyChecks(checks: CheckItem[]): 'passing' | 'pending' | 'failing' {
  if (checks.length === 0) return 'passing';

  for (const check of checks) {
    const state = (check.state || '').toUpperCase();
    const bucket = (check.bucket || '').toLowerCase();

    // Failing conditions
    if (bucket === 'fail' || bucket === 'cancel') return 'failing';
    if (state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT') {
      return 'failing';
    }
  }

  for (const check of checks) {
    const state = (check.state || '').toUpperCase();
    const bucket = (check.bucket || '').toLowerCase();

    // Pending conditions
    if (bucket === 'pending') return 'pending';
    if (state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED') {
      return 'pending';
    }
  }

  return 'passing';
}

/** Summarize checks with counts and overall status. */
export function summarizeChecks(checks: CheckItem[]): CiChecksSummary {
  const overall = classifyChecks(checks);
  let passing = 0;
  let pending = 0;
  let failing = 0;

  for (const check of checks) {
    const state = (check.state || '').toUpperCase();
    const bucket = (check.bucket || '').toLowerCase();

    // Check if failing
    if (bucket === 'fail' || bucket === 'cancel' || state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT') {
      failing++;
      continue;
    }

    // Check if pending
    if (bucket === 'pending' || state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED') {
      pending++;
      continue;
    }

    // Otherwise passing
    passing++;
  }

  return {
    overall,
    counts: {
      passing,
      pending,
      failing,
      total: checks.length,
    },
  };
}
