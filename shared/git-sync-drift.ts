/**
 * Computes the drift level based on the number of commits behind the base branch.
 * 
 * @param behind - Number of commits the branch is behind the base branch
 * @returns The drift level ('green', 'yellow', 'orange', or 'red')
 */
export function driftLevel(behind: number): 'green' | 'yellow' | 'orange' | 'red' {
  if (behind <= 0) return 'green';
  if (behind <= 5) return 'yellow';
  if (behind <= 20) return 'orange';
  return 'red';
}

/**
 * Generates a label for the drift status.
 * 
 * @param behind - Number of commits behind
 * @param baseBranch - The base branch name
 * @returns Label text for the drift status
 */
export function driftLabel(behind: number, baseBranch: string): string {
  if (behind === 0) return 'Up to date';
  return `${behind} commits behind ${baseBranch}`;
}