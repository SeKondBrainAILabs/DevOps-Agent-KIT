/**
 * Hooks for the Kanvas Coding tab (KC-S2.1.x): KIT Harness runs, a run's live
 * event stream and cluster health, all polled through window.api.harness.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HARNESS_ERRORS,
  lastCursor,
  mergeFrames,
  type HarnessClusterStatus,
  type HarnessFrame,
  type HarnessRun,
} from '../../shared/harness-types';

export type HarnessLoadState = 'loading' | 'ready' | 'offline' | 'unconfigured' | 'unauthorized';

export function loadStateFor(code: string | undefined): HarnessLoadState {
  if (code === HARNESS_ERRORS.NOT_CONFIGURED) return 'unconfigured';
  if (code === HARNESS_ERRORS.UNAUTHORIZED) return 'unauthorized';
  return 'offline';
}

function harnessApi() {
  return (window as any).api?.harness as Window['api']['harness'] | undefined;
}

/** Recent runs with their stories, re-read every pollMs. Keeps the last good runs while offline. */
export function useHarnessRuns(pollMs = 5000, maxRuns = 20) {
  const [state, setState] = useState<{ status: HarnessLoadState; error?: string; runs: HarnessRun[] }>({
    status: 'loading',
    runs: [],
  });
  const alive = useRef(true);

  const load = useCallback(async () => {
    const api = harnessApi();
    if (!api) {
      setState({ status: 'unconfigured', error: 'KIT Harness client is not available', runs: [] });
      return;
    }
    const list = await api.listRuns();
    if (!alive.current) return;
    if (!list.success) {
      const error = list.error?.message;
      setState((s) => ({ status: loadStateFor(list.error?.code), error, runs: s.runs }));
      return;
    }
    const recent = (list.data ?? []).slice(-maxRuns);
    const details = await Promise.all(recent.map((r) => api.getRun(r.run_id)));
    if (!alive.current) return;
    const runs = details.filter((r) => r.success && r.data).map((r) => r.data as HarnessRun);
    setState({ status: 'ready', runs });
  }, [maxRuns]);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs]);

  return { ...state, refresh: load };
}

/**
 * A run's events, in order, from GET /runs/<id>/events. Each poll passes the
 * last cursor; a failed poll backs off and retries (reconnect), and frames
 * already seen are dropped, so a replay after a reconnect never duplicates.
 */
export function useHarnessRunEvents(
  runId: string | null,
  { pollMs = 1500, maxBackoffMs = 15000 }: { pollMs?: number; maxBackoffMs?: number } = {},
) {
  const [frames, setFrames] = useState<HarnessFrame[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const framesRef = useRef<HarnessFrame[]>([]);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    framesRef.current = [];
    cursorRef.current = null;
    setFrames([]);
    setFinished(false);
    setConnected(false);
    setError(null);
    if (!runId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = pollMs;

    const poll = async () => {
      const api = harnessApi();
      const res = api ? await api.events(runId, cursorRef.current) : null;
      if (stopped) return;
      let done = false;
      if (res?.success && res.data) {
        const merged = mergeFrames(framesRef.current, res.data.frames);
        framesRef.current = merged;
        cursorRef.current = res.data.cursor ?? lastCursor(merged);
        setFrames(merged);
        setConnected(true);
        setError(null);
        done = merged.some((f) => f.event === 'terminal');
        setFinished(done);
        delay = pollMs;
      } else {
        setConnected(false);
        setError(res?.error?.message ?? 'KIT Harness client is not available');
        delay = Math.min(delay * 2, maxBackoffMs);
      }
      // A finished run has nothing more to say; keep checking slowly in case it is resumed.
      timer = setTimeout(poll, done ? Math.max(pollMs * 10, 10000) : delay);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, pollMs, maxBackoffMs]);

  return { frames, connected, error, finished };
}

/** harness_cluster_status, polled slowly for the lanes header. */
export function useClusterStatus(pollMs = 30000) {
  const [state, setState] = useState<{ status: HarnessLoadState; data: HarnessClusterStatus | null; error?: string }>({
    status: 'loading',
    data: null,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const api = harnessApi();
      if (!api) {
        setState({ status: 'unconfigured', data: null });
        return;
      }
      const res = await api.clusterStatus();
      if (!alive) return;
      if (res.success) setState({ status: 'ready', data: res.data ?? null });
      else setState({ status: loadStateFor(res.error?.code), data: null, error: res.error?.message });
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  return state;
}
