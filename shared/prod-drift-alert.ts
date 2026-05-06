/**
 * Production drift alert (Epic I / story I7).
 *
 * Pure rule that the DeploymentService consumes after each poll. Karol
 * called this S12-critical: prod must not silently fall behind merged main.
 *
 * A drift alert fires when:
 *  - the deployed SHA is NOT the same as the latest merged-main SHA, AND
 *  - main has at least one commit ahead of prod, AND
 *  - prod's last-deploy timestamp is older than `staleAfterHours` (default 24).
 */

export interface DriftSignal {
  deployedSha: string;
  /** ISO timestamp of last successful deploy. */
  lastDeployAt: string;
  mainHeadSha: string;
  /** Number of commits main is ahead of the deployed SHA. */
  commitsAhead: number;
}

export interface DriftAlertOptions {
  /** Hours of staleness before drift becomes an alert. Default 24. */
  staleAfterHours?: number;
  /** "Now" for tests. Default Date.now(). */
  now?: number;
  /** User has dismissed the alert for this drift state. */
  dismissed?: boolean;
}

export type DriftAlertKind =
  | 'no-drift-in-sync'
  | 'no-drift-just-deployed'
  | 'dismissed'
  | 'alert-stale-prod';

export interface DriftAlertDecision {
  kind: DriftAlertKind;
  shouldAlert: boolean;
  hoursBehind?: number;
  commitsAhead?: number;
  message?: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;

export function evaluateDriftAlert(
  signal: DriftSignal,
  options: DriftAlertOptions = {}
): DriftAlertDecision {
  // 1. In sync → no alert.
  if (signal.deployedSha === signal.mainHeadSha || signal.commitsAhead <= 0) {
    return { kind: 'no-drift-in-sync', shouldAlert: false };
  }

  const now = options.now ?? Date.now();
  const lastMs = Date.parse(signal.lastDeployAt);
  const hoursBehind = Number.isNaN(lastMs) ? Infinity : (now - lastMs) / MS_PER_HOUR;
  const threshold = options.staleAfterHours ?? 24;

  if (hoursBehind <= threshold) {
    return {
      kind: 'no-drift-just-deployed',
      shouldAlert: false,
      hoursBehind,
      commitsAhead: signal.commitsAhead,
    };
  }

  if (options.dismissed) {
    return {
      kind: 'dismissed',
      shouldAlert: false,
      hoursBehind,
      commitsAhead: signal.commitsAhead,
    };
  }

  return {
    kind: 'alert-stale-prod',
    shouldAlert: true,
    hoursBehind,
    commitsAhead: signal.commitsAhead,
    message:
      `Production is ${signal.commitsAhead} commit(s) behind main and last deployed ` +
      `${Math.floor(hoursBehind)}h ago. Consider redeploying.`,
  };
}
