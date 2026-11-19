/**
 * Calculates the drift level based on commits behind count
 * @param behindCount Number of commits behind
 * @returns Drift level (0=green, 1=yellow, 2=orange, 3=red)
 */
export function getDriftLevel(behindCount: number): number {
  if (behindCount <= 0) return 0;
  if (behindCount <= 5) return 1;
  if (behindCount <= 20) return 2;
  return 3;
}

/**
 * Gets the CSS color class based on drift level
 * @param level Drift level (0-3)
 * @returns Color class name
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
 * Gets the color class for a given behind count
 * @param behindCount Number of commits behind
 * @returns Color class name
 */
export function getDriftColorFromCount(behindCount: number): string {
  return getDriftColor(getDriftLevel(behindCount));
}