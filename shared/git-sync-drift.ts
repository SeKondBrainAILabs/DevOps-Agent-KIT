/**
 * Sync drift level — how far a session branch is behind its base branch.
 *
 * Maps a "commits behind" count to a coarse severity level and a Tailwind
 * text-colour class, so the session header can show a coloured drift dot
 * beside the "Sync (rebase)" button:
 *
 *   0 behind      → level 1 (green)
 *   1-5 behind    → level 2 (yellow)
 *   6-20 behind   → level 3 (orange, inclusive)
 *   21+ behind    → level 4 (red)
 */

/**
 * Coarse drift severity for a "commits behind" count.
 *
 * @param behind commits the branch is behind its base (negative treated as 0)
 * @returns 1 (green) | 2 (yellow) | 3 (orange) | 4 (red)
 */
export function getSyncDriftLevel(behind: number): number {
  const n = typeof behind === 'number' && Number.isFinite(behind) ? behind : 0;
  if (n <= 0) return 1;
  if (n <= 5) return 2;
  if (n <= 20) return 3;
  return 4;
}

/**
 * Tailwind text-colour class for a drift level. Unknown levels fall back to
 * a neutral gray so the indicator never renders uncoloured.
 */
export function getColorClass(level: number): string {
  switch (level) {
    case 1:
      return 'text-green-500';
    case 2:
      return 'text-yellow-500';
    case 3:
      return 'text-orange-500';
    case 4:
      return 'text-red-500';
    default:
      return 'text-gray-400';
  }
}
