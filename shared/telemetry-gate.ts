/**
 * Telemetry gate (Epic O / story O5).
 *
 * Pure helper used by any code that wants to emit a telemetry event.
 * Returns `true` ONLY when the user has explicitly opted in. Defaults to
 * `false` so a missing or unknown setting suppresses telemetry — fail closed.
 */

export function shouldSendTelemetry(opts: {
  telemetryOptIn?: boolean;
  /** Optional override (e.g. CI / test env) that forces telemetry off. */
  forceOff?: boolean;
}): boolean {
  if (opts.forceOff) return false;
  return opts.telemetryOptIn === true;
}
