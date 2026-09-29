/**
 * KC-S2.1.4 AC1: a run's events stream in order; when a poll fails the hook
 * reconnects with backoff, resumes from its cursor, and a full replay from the
 * harness never duplicates an event.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react';
import { useHarnessRunEvents } from '../../../renderer/hooks/useHarness';
import { EVENTS_DONE, installHarnessApi } from '../fixtures/harness/mockHarness';

describe('useHarnessRunEvents (KC-S2.1.4 AC1)', () => {
  it('streams in order, reconnects after a failure and ignores replayed frames', async () => {
    const all = EVENTS_DONE.frames.filter((f) => f.event === 'feature_bus');
    // Each poll waits until the test answers it, so every intermediate state is observable.
    const pending: Array<(value: unknown) => void> = [];
    const events = jest.fn(() => new Promise((resolve) => pending.push(resolve))) as any;
    installHarnessApi({ events });
    const answer = async (value: unknown) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!(value);
    };

    const { result } = renderHook(() => useHarnessRunEvents('r', { pollMs: 5, maxBackoffMs: 20 }));
    await answer({ success: true, data: { run_id: 'r', resumed_after: null, frames: all.slice(0, 10), cursor: all[9].event_id } });
    await waitFor(() => expect(result.current.frames).toHaveLength(10));
    expect(result.current.connected).toBe(true);

    await answer({ success: false, error: { code: 'HARNESS_OFFLINE', message: 'KIT Harness unreachable' } });
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.error).toMatch(/unreachable/);
    expect(result.current.frames).toHaveLength(10); // nothing lost while offline

    // After a harness restart the cursor may be unknown: it replays everything.
    await answer({ success: true, data: { run_id: 'r', resumed_after: all[9].event_id, frames: EVENTS_DONE.frames, cursor: EVENTS_DONE.cursor } });
    await waitFor(() => expect(result.current.finished).toBe(true));
    expect(result.current.connected).toBe(true);
    expect(result.current.frames.map((f) => f.event_id)).toEqual(EVENTS_DONE.frames.map((f) => f.event_id));

    // Each poll passed the last cursor it had: none, then the 10th event, twice.
    expect(events.mock.calls.slice(0, 3)).toEqual([['r', null], ['r', all[9].event_id], ['r', all[9].event_id]]);
  });

  it('starts over when the run changes', async () => {
    installHarnessApi();
    const { result, rerender } = renderHook(({ id }) => useHarnessRunEvents(id, { pollMs: 5 }), { initialProps: { id: 'a' as string | null } });
    await waitFor(() => expect(result.current.frames.length).toBeGreaterThan(0));
    rerender({ id: null });
    await waitFor(() => expect(result.current.frames).toHaveLength(0));
  });
});
