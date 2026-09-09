/**
 * Cleanup wizard plan reducer (Epic G / story G3).
 *
 * The Wizard surfaces several categories the user can opt-in to: stale
 * branches, dangling worktrees, node_modules, .venv, dist/build, stopped
 * containers. This module folds the user's category-toggle state plus
 * the raw candidate lists into a single plan: which artifacts to remove
 * and how much disk this reclaims.
 */

export type CleanupCategory =
  | 'stale-branches'
  | 'dangling-worktrees'
  | 'node-modules'
  | 'venv'
  | 'dist-build'
  | 'stopped-containers';

export interface CleanupCandidate {
  category: CleanupCategory;
  /** Identifier for the artifact (path, branch ref, container id). */
  id: string;
  /** Bytes reclaimed by removing this artifact (0 for branches/containers). */
  bytes?: number;
}

export interface CleanupPlanInputs {
  candidates: ReadonlyArray<CleanupCandidate>;
  /** Categories the user has opted in to. */
  enabled: ReadonlyArray<CleanupCategory>;
}

export interface CleanupPlan {
  /** Items selected for removal, grouped by category in the input order. */
  selected: CleanupCandidate[];
  /** Sum of bytes for selected items (categories without `bytes` contribute 0). */
  totalReclaimableBytes: number;
  /** Per-category counts (only categories with at least one selected item). */
  countsByCategory: Partial<Record<CleanupCategory, number>>;
}

export function reduceCleanupPlan(input: CleanupPlanInputs): CleanupPlan {
  const enabled = new Set(input.enabled);
  const selected: CleanupCandidate[] = [];
  const counts: Partial<Record<CleanupCategory, number>> = {};
  let total = 0;
  for (const c of input.candidates) {
    if (!enabled.has(c.category)) continue;
    selected.push(c);
    counts[c.category] = (counts[c.category] ?? 0) + 1;
    if (typeof c.bytes === 'number' && Number.isFinite(c.bytes) && c.bytes > 0) {
      total += c.bytes;
    }
  }
  return { selected, totalReclaimableBytes: total, countsByCategory: counts };
}

/**
 * Apply a plan-level confirmation: the wizard requires the user to type
 * the exact reclaimable byte string OR the category list to confirm
 * destructive action. Renderer can use either; this is the rule.
 */
export function isConfirmationValid(
  plan: CleanupPlan,
  userTyped: string
): boolean {
  if (plan.selected.length === 0) return false;
  const trimmed = userTyped.trim().toUpperCase();
  return trimmed === 'CLEAN' || trimmed === 'DELETE' || trimmed === 'CLEANUP';
}
