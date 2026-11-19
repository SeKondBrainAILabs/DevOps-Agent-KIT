/**
 * CI Checks Classification
 * Shared logic for classifying check results from `gh pr checks --json name,state,bucket`
 * Used by both:
 *   - renderer/lib/summary/pr-checks-summary.ts (UI badge)
 *   - electron/services/MergeService.ts (merge gate)
 */

export type CiCheck = {
  name: string;
  state: string;
  bucket?: string;
};

export type CiCheckClassification = 'passing' | 'pending' | 'failing';

export type CiChecksSummary = {
  state: CiCheckClassification;
  passing: number;
  pending: number;
  failing: number;
  none: number;
};

/**
 * Classify a single check according to the CI policy:
 * - failing: bucket 'fail' or 'cancel', or state 'FAILURE'/'ERROR'/'CANCELLED'/'TIMED_OUT'
 * - pending: bucket 'pending', or state 'PENDING'/'IN_PROGRESS'/'QUEUED'
 * - passing: anything else (including unknown states)
 */
export function classifyCheck(check: CiCheck): CiCheckClassification {
  const state = (check.state || '').toUpperCase();
  const bucket = (check.bucket || '').toLowerCase();

  // Failing checks
  if (state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT'
      || bucket === 'fail' || bucket === 'cancel') {
    return 'failing';
  }

  // Pending checks  
  if (state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED'
      || bucket === 'pending') {
    return 'pending';
  }

  // Everything else is passing
  return 'passing';
}

/**
 * Summarize an array of checks into counts by state
 */
export function summarizeChecks(checks: Array<CiCheck>): CiChecksSummary {
  let passing = 0;
  let pending = 0;
  let failing = 0;
  let none = 0;

  for (const check of checks) {
    switch (classifyCheck(check)) {
      case 'passing':
        passing++;
        break;
      case 'pending':
        pending++;
        break;
      case 'failing':
        failing++;
        break;
    }
  }

  // If no checks were provided, treat as "none"
  if (checks.length === 0) {
    none = 1;
  }

  return {
    state: failing > 0 ? 'failing' : pending > 0 ? 'pending' : passing > 0 ? 'passing' : 'none',
    passing,
    pending,
    failing,
    none,
  };
}