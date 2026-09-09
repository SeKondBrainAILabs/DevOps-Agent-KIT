/**
 * Unit Tests for O5 Telemetry opt-in/out
 *
 * `shouldSendTelemetry` is the single gate that any telemetry-emitting code
 * should consult. Default behavior MUST be off until user explicitly opts in.
 */

import { describe, it, expect } from '@jest/globals';
import { shouldSendTelemetry } from '../../../shared/telemetry-gate';

describe('shouldSendTelemetry (O5)', () => {
  it('returns false when telemetryOptIn is undefined (default off)', () => {
    expect(shouldSendTelemetry({})).toBe(false);
  });

  it('returns false when telemetryOptIn is explicitly false', () => {
    expect(shouldSendTelemetry({ telemetryOptIn: false })).toBe(false);
  });

  it('returns true ONLY when telemetryOptIn is explicitly true', () => {
    expect(shouldSendTelemetry({ telemetryOptIn: true })).toBe(true);
  });

  it('forceOff overrides an opted-in user (e.g. CI / E2E test runs)', () => {
    expect(shouldSendTelemetry({ telemetryOptIn: true, forceOff: true })).toBe(false);
  });

  it('rejects truthy non-boolean values — only literal true counts', () => {
    expect(shouldSendTelemetry({ telemetryOptIn: 'yes' as unknown as boolean })).toBe(false);
    expect(shouldSendTelemetry({ telemetryOptIn: 1 as unknown as boolean })).toBe(false);
  });
});
