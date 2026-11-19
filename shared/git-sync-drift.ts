/**
 * Sync drift utilities for detecting how far a session's branch is behind its base.
 * Used for the rebase status visualization (AC1).
 *
 * Drift levels and colors:
 * - 0 behind: green (level 0)
 * - 1-5 behind: yellow (level 1)
 * - 6-20 behind: orange (level 2) - inclusive upper bound
 * - 21+ behind: red (level 3)
 */

/**
 * Get the drift level based on the number of commits behind.
 * @param behindCount - Number of commits the branch is behind
 * @returns Drift level: 0 (green), 1 (yellow), 2 (orange), or 3 (red)
 */
export function getDriftLevel(behindCount: number): number {
  if (behindCount <= 0) {
    return 0;
  }
  if (behindCount <= 5) {
    return 1;
  }
  if (behindCount <= 20) {
    return 2;
  }
  return 3;
}

/**
 * Get the Tailwind color class for a drift level.
 * @param level - Drift level (0-3)
 * @returns Color class name (e.g., 'green-500', 'yellow-500', 'orange-500', 'red-500')
 */
export function getDriftColor(level: number): string {
  switch (level) {
    case 0:
      return 'green-500';
    case 1:
      return 'yellow-500';
    case 2:
      return 'orange-500';
    case 3:
      return 'red-500';
    default:
      return 'gray-500';
  }
}

/**
 * Get the Tailwind color class directly from the behind count.
 * @param behindCount - Number of commits the branch is behind
 * @returns Color class name (e.g., 'green-500', 'yellow-500', 'orange-500', 'red-500')
 */
export function getDriftColorFromCount(behindCount: number): string {
  const level = getDriftLevel(behindCount);
  return getDriftColor(level);
}
