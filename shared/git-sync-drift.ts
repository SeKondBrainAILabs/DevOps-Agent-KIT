/**
 * Git Sync Drift Utilities
 * Maps commit behind counts to drift levels/colors for the session header indicator
 */

export type DriftLevel = 'green' | 'yellow' | 'orange' | 'red';

/**
 * Maps the number of commits behind to a drift level with color semantics.
 * 
 * Drift levels per story (overrides spec FR-3.2):
 * - 0 commits behind: green (Up to date)
 * - 1-5 commits behind: yellow (light drift)
 * - 6-20 commits behind: orange (moderate drift, inclusive of 20)
 * - 21+ commits behind: red (severe drift)
 * 
 * Negative values (ahead) are treated as 0 (green).
 */
export function driftLevel(behind: number): DriftLevel {
  if (behind <= 0) {
    return 'green';
  }
  if (behind <= 5) {
    return 'yellow';
  }
  if (behind <= 20) {
    return 'orange';
  }
  return 'red';
}

/**
 * Returns a CSS color hex code for a drift level.
 */
export function driftLevelColor(level: DriftLevel): string {
  switch (level) {
    case 'green': return '#22c55e';
    case 'yellow': return '#eab308';
    case 'orange': return '#f97316';
    case 'red': return '#ef4444';
  }
}

/**
 * Returns a display label for the drift level.
 */
export function driftLevelLabel(level: DriftLevel): string {
  switch (level) {
    case 'green': return 'Up to date';
    case 'yellow': return 'Light drift';
    case 'orange': return 'Moderate drift';
    case 'red': return 'Severe drift';
  }
}
