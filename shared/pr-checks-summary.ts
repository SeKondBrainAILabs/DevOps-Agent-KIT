/**
 * pr-checks-summary — pure summariser for gh pr checks output
 *
 * AC1: A pure summariser turns gh pr checks --json name,state,bucket rows into
 * passing, failing, pending or none, with counts.
 *
 * The summariser must classify each row by its state and bucket, then aggregate
 * into a structured summary with state (passing|failing|pending|none) and counts
 * {passing, failing, pending, total}.
 */

export interface PrCheckRow {
  name: string;
  state: string;
  bucket: string;
}

export interface PrChecksSummary {
  state: 'passing' | 'failing' | 'pending' | 'none';
  counts: {
    passing: number;
    failing: number;
    pending: number;
    total: number;
  };
}

/**
 * Summarizes PR checks output into a state and counts.
 *
 * @param checks - Array of PR check objects with name, state, and bucket
 * @returns Summary object with state and counts
 */
export function summarizePrChecks(checks: PrCheckRow[]): PrChecksSummary {
  if (checks.length === 0) {
    return {
      state: 'none',
      counts: { passing: 0, failing: 0, pending: 0, total: 0 },
    };
  }

  let passing = 0;
  let failing = 0;
  let pending = 0;
  let total = 0;

  for (const check of checks) {
    total++;
    
    // Classify by bucket first (since that overrides state)
    switch (check.bucket) {
      case 'fail':
      case 'cancel':
        failing++;
        break;
      case 'success':
        passing++;
        break;
      case 'pending':
      case 'in_progress':
      case 'queued':
        pending++;
        break;
      default:
        // Fall back to state-based classification
        switch (check.state.toUpperCase()) {
          case 'SUCCESS':
            passing++;
            break;
          case 'FAILURE':
          case 'ERROR':
          case 'CANCELLED':
          case 'TIMED_OUT':
            failing++;
            break;
          case 'PENDING':
          case 'IN_PROGRESS':
          case 'QUEUED':
            pending++;
            break;
          default:
            // Unknown state - treat as pending for conservative approach
            pending++;
        }
    }
  }

  // Determine overall state: fail overrides everything, then pending, then passing
  if (failing > 0) {
    return {
      state: 'failing',
      counts: { passing, failing, pending, total },
    };
  }
  
  if (pending > 0) {
    return {
      state: 'pending',
      counts: { passing, failing, pending, total },
    };
  }
  
  if (passing > 0) {
    return {
      state: 'passing',
      counts: { passing, failing, pending, total },
    };
  }

  // If we have no checks that contributed to counts (all unknown states), return none
  return {
    state: 'none',
    counts: { passing, failing, pending, total },
  };
}