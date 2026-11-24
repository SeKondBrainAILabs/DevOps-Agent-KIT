/**
 * Maps commit counts behind to drift level colors.
 * 
 * Drift levels:
 * - 0 commits behind → green
 * - 1-5 commits behind → yellow  
 * - 6-20 commits behind → orange (inclusive)
 * - 21+ commits behind → red
 */
export function driftLevel(behind: number): 'green' | 'yellow' | 'orange' | 'red' {
  if (behind <= 0) {
    return 'green';
  } else if (behind <= 5) {
    return 'yellow';
  } else if (behind <= 20) {
    return 'orange';
  } else {
    return 'red';
  }
}

/**
 * Gets the human-readable label for a drift level.
 */
export function driftLabel(behind: number): string {
  if (behind === 0) {
    return 'Up to date';
  } else {
    const count = behind;
    const plural = count === 1 ? 'commit' : 'commits';
    return `${count} ${plural} behind ${getBaseBranchName()}`;
  }
}

/**
 * Helper to get base branch name (this would be passed from session context)
 */
function getBaseBranchName(): string {
  // This is a placeholder - in real usage would be passed from session context
  return 'main';
}