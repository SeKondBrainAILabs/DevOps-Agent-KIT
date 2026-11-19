/**
 * Utility functions for calculating and coloring git sync drift levels.
 * 
 * Drift levels:
 * - Level 0: 0 commits behind (green)
 * - Level 1: 1-5 commits behind (yellow)  
 * - Level 2: 6-20 commits behind (orange)
 * - Level 3: 21+ commits behind (red)
 */

/**
 * Calculate drift level based on number of commits behind
 * @param behindCount Number of commits the local branch is behind the remote
 * @returns Drift level (0-3)
 */
export function getDriftLevel(behindCount: number): number {
  if (behindCount <= 0) return 0;
  if (behindCount <= 5) return 1;
  if (behindCount <= 20) return 2;
  return 3;
}

/**
 * Get CSS class name for drift color based on level
 * @param level Drift level (0-3)
 * @returns CSS class name for the color
 */
export function getDriftColor(level: number): string {
  switch (level) {
    case 0: return 'green-500';
    case 1: return 'yellow-500';
    case 2: return 'orange-500';
    case 3: return 'red-500';
    default: return 'gray-500';
  }
}

/**
 * Get CSS class name for drift color based on behind count
 * @param behindCount Number of commits behind
 * @returns CSS class name for the color
 */
export function getDriftColorFromCount(behindCount: number): string {
  return getDriftColor(getDriftLevel(behindCount));
}