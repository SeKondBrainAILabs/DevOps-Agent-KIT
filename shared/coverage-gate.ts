/**
 * Coverage merge-gate consumer (Epic Q / story Q4).
 *
 * The QA Agent owns coverage MEASUREMENT and publishes a signal:
 *   { coverage: number, baseCoverage: number, repoPath, branch }
 *
 * DevOps Agent owns the GATE: should this PR be allowed to merge?
 * The decision is pure logic that takes the QA signal + per-repo policy.
 *
 * Rules:
 *  - If policy disabled → allowed.
 *  - If signal missing → allowed but flagged ('signal-missing').
 *  - If absoluteFloor is set and coverage < absoluteFloor → blocked.
 *  - If maxDropPp is set and (baseCoverage - coverage) > maxDropPp → blocked.
 *  - Otherwise → allowed.
 *
 * Override (with reason) flips a block to 'allowed-override' and records the
 * reason for audit, mirroring M3.
 */

export interface CoverageSignal {
  /** New PR's coverage (0..1 fraction). */
  coverage: number;
  /** Base branch coverage at merge-base (0..1 fraction). */
  baseCoverage: number;
  /** ISO timestamp when the signal was emitted. */
  emittedAt: string;
}

export interface CoverageGatePolicy {
  enabled: boolean;
  /** Absolute floor — coverage must be ≥ this. e.g. 0.7 = 70%. */
  absoluteFloor?: number;
  /** Max allowed drop from base in percentage points. e.g. 1 = 1pp. */
  maxDropPp?: number;
  /** Max signal age in minutes; older signals are treated as missing. */
  maxSignalAgeMinutes?: number;
}

export interface CoverageGateInputs {
  signal?: CoverageSignal;
  policy: CoverageGatePolicy;
  override?: boolean;
  overrideReason?: string;
  /** "Now" for tests. Default Date.now(). */
  now?: number;
}

export type CoverageGateKind =
  | 'allowed-policy-disabled'
  | 'allowed-signal-missing'
  | 'allowed-passed'
  | 'allowed-override'
  | 'blocked-below-floor'
  | 'blocked-drop-exceeded'
  | 'blocked-override-without-reason';

export interface CoverageGateDecision {
  allowed: boolean;
  kind: CoverageGateKind;
  message?: string;
  /** Computed delta in percentage points (positive = drop). */
  dropPp?: number;
  overrideMetadata?: { reason: string };
}

export function evaluateCoverageGate(input: CoverageGateInputs): CoverageGateDecision {
  if (!input.policy.enabled) {
    return { allowed: true, kind: 'allowed-policy-disabled' };
  }

  // Resolve signal staleness
  const signal = input.signal;
  if (!signal) {
    return {
      allowed: true,
      kind: 'allowed-signal-missing',
      message: 'No coverage signal available. PR allowed; ask QA Agent for a fresh report.',
    };
  }
  if (input.policy.maxSignalAgeMinutes) {
    const now = input.now ?? Date.now();
    const ageMs = now - Date.parse(signal.emittedAt);
    if (Number.isFinite(ageMs) && ageMs > input.policy.maxSignalAgeMinutes * 60 * 1000) {
      return {
        allowed: true,
        kind: 'allowed-signal-missing',
        message: 'Coverage signal is stale; ask QA Agent for a fresh report.',
      };
    }
  }

  const dropPp = (signal.baseCoverage - signal.coverage) * 100;

  // Override path
  if (input.override) {
    const reason = (input.overrideReason ?? '').trim();
    if (!reason) {
      return {
        allowed: false,
        kind: 'blocked-override-without-reason',
        dropPp,
        message: 'Override requires a non-empty reason explaining why the gate may be bypassed.',
      };
    }
    return {
      allowed: true,
      kind: 'allowed-override',
      dropPp,
      overrideMetadata: { reason },
    };
  }

  if (input.policy.absoluteFloor !== undefined && signal.coverage < input.policy.absoluteFloor) {
    const floorPct = (input.policy.absoluteFloor * 100).toFixed(1);
    const covPct = (signal.coverage * 100).toFixed(1);
    return {
      allowed: false,
      kind: 'blocked-below-floor',
      dropPp,
      message: `Coverage ${covPct}% is below the absolute floor of ${floorPct}%.`,
    };
  }

  if (input.policy.maxDropPp !== undefined && dropPp > input.policy.maxDropPp) {
    return {
      allowed: false,
      kind: 'blocked-drop-exceeded',
      dropPp,
      message:
        `Coverage dropped ${dropPp.toFixed(1)}pp (from ` +
        `${(signal.baseCoverage * 100).toFixed(1)}% to ${(signal.coverage * 100).toFixed(1)}%); ` +
        `policy allows at most ${input.policy.maxDropPp}pp.`,
    };
  }

  return { allowed: true, kind: 'allowed-passed', dropPp };
}
