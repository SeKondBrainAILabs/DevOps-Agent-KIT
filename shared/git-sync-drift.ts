export function driftLevel(behind: number): 'green' | 'yellow' | 'orange' | 'red' {
  if (behind === 0) return 'green';
  if (behind <= 5) return 'yellow';
  if (behind <= 20) return 'orange';
  return 'red';
}

export function driftLabel(behind: number, baseBranch: string): string {
  if (behind === 0) return 'Up to date';
  return `${behind} commits behind ${baseBranch}`;
}