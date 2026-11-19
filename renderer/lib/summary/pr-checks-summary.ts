/**
 * CI checks summariser for the renderer (story KC-S1.2.2.4 AC1)
 *
 * Re-exports the pure classification logic from shared/ci-checks.ts so both
 * the renderer (badge) and electron (MergeService) use the same source of truth.
 */

export { classifyChecks, summarizeChecks, type CiChecksSummary, type CheckItem } from '../../../shared/ci-checks';
