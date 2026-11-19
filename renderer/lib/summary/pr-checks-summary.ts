/**
 * CI checks summarizer for the renderer
 * 
 * This module is specifically for UI components to display CI status badges.
 * It reuses the shared classification logic to ensure consistency with the merge gate behavior.
 */

import { classifyCheck, summarizeChecks as sharedSummarizeChecks } from '../../shared/ci-checks';

export type CiCheck = {
  name: string;
  state: string;
  bucket?: string;
};

export type CiChecksSummary = {
  overall: 'passing' | 'pending' | 'failing';
  counts: {
    passing: number;
    pending: number;
    failing: number;
    total: number;
  };
};

export { classifyCheck, sharedSummarizeChecks };

/**
 * Summarize an array of checks into overall state and counts.
 * This is compatible with the UI component expectation.
 * 
 * @param checks - Array of check objects with name, state, and bucket
 * @returns A summary object with overall state and counts
 */
export function summarizeChecksForUi(checks: CiCheck[]): CiChecksSummary {
  // First get the counts using the shared implementation
  const sharedResult = sharedSummarizeChecks(checks);
  
  // Transform to UI-compatible structure (overall instead of state)
  return {
    overall: sharedResult.state,
    counts: {
      passing: sharedResult.passing,
      pending: sharedResult.pending,
      failing: sharedResult.failing,
      total: sharedResult.passing + sharedResult.pending + sharedResult.failing
    }
  };
}