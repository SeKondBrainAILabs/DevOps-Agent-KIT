/**
 * Configurable default landing view (Epic L / story L4).
 *
 * Three options:
 *  - 'morning-check'     → opens to U29 Morning Check (overnight CI failures,
 *                          PRs awaiting review, stack health, drift alerts)
 *  - 'workspace-browser' → opens to U2 Workspace Browser (grid of repo cards)
 *  - 'last-visited'      → restores the user's most recent route on launch
 *
 * Default ships as 'last-visited' so existing users don't get unexpectedly
 * relocated on next launch.
 */

export type LandingView = 'morning-check' | 'workspace-browser' | 'last-visited';

export const DEFAULT_LANDING_VIEW: LandingView = 'last-visited';

export const LANDING_VIEW_OPTIONS: ReadonlyArray<{
  value: LandingView;
  label: string;
  description: string;
}> = [
  {
    value: 'morning-check',
    label: 'Morning Check',
    description: 'Overnight CI failures, PRs awaiting review, stack health, drift alerts.',
  },
  {
    value: 'workspace-browser',
    label: 'Workspace Browser',
    description: 'Grid of repo status cards for the active workspace.',
  },
  {
    value: 'last-visited',
    label: 'Last visited',
    description: 'Restore the route you were on when you last quit Kanvas.',
  },
];

export function isValidLandingView(value: unknown): value is LandingView {
  return value === 'morning-check' || value === 'workspace-browser' || value === 'last-visited';
}

/** Resolve which view should actually be shown on launch. */
export function resolveLandingView(input: {
  configured: LandingView;
  lastVisitedRoute?: string;
}): { view: LandingView; route?: string } {
  if (input.configured === 'last-visited' && input.lastVisitedRoute) {
    return { view: 'last-visited', route: input.lastVisitedRoute };
  }
  if (input.configured === 'last-visited' && !input.lastVisitedRoute) {
    // First launch — fall through to workspace browser as the safer default.
    return { view: 'workspace-browser' };
  }
  return { view: input.configured };
}
