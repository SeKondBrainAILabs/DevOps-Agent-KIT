/**
 * CI checks summarizer for the renderer
 * 
 * This module is specifically for UI components to display CI status badges.
 * It reuses the shared classification logic to ensure consistency with the merge gate behavior.
 */

import { classifyCheck as classifySingleCheck, summarizeChecks as sharedSummarizeChecks } from '@shared/ci-checks';

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

/**
 * Classify an array of checks into overall state.
 * Returns 'failing' if any check fails, 'pending' if any is pending (and none fail),
 * otherwise 'passing'. Empty array returns 'passing'.
 * 
 * @param checks - Array of check objects with name, state, and bucket
 * @returns Overall classification: 'passing' | 'pending' | 'failing'
 */
export function classifyChecks(checks: CiCheck[]): 'passing' | 'pending' | 'failing' {
  if (checks.length === 0) {
    return 'passing';
  }
  
  let hasFailing = false;
  let hasPending = false;
  
  for (const check of checks) {
    const result = classifySingleCheck(check);
    if (result === 'failing') {
      hasFailing = true;
      break; // failing takes precedence
    }
    if (result === 'pending') {
      hasPending = true;
    }
  }
  
  if (hasFailing) return 'failing';
  if (hasPending) return 'pending';
  return 'passing';
}

/**
 * Summarize an array of checks into overall state and counts.
 * This is compatible with the UI component expectation.
 * 
 * @param checks - Array of check objects with name, state, and bucket
 * @returns A summary object with overall state and counts
 */
export function summarizeChecks(checks: CiCheck[]): CiChecksSummary {
  const sharedResult = sharedSummarizeChecks(checks);
  
  return {
    overall: sharedResult.state === 'none' ? 'passing' : sharedResult.state,
    counts: {
      passing: sharedResult.passing,
      pending: sharedResult.pending,
      failing: sharedResult.failing,
      total: sharedResult.passing + sharedResult.pending + sharedResult.failing
    }
  };
}