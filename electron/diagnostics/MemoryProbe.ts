/**
 * MemoryProbe — zero-dependency main-process memory/leak diagnostics.
 *
 * Purpose: pinpoint a runaway allocation / GC storm in the Electron MAIN process
 * (e.g. the 14.7 GB footprint with the main thread pegged in young-gen GC).
 *
 * Two signals, both work on a packaged build on a user's machine:
 *
 *  1. Periodic VITALS log (every VITALS_MS) — rss/heap growth, V8 detached-context
 *     count (classic leak indicator), and a tally of active libuv handles by type.
 *     A steadily rising `Timeout`/`TCPSocketWrap` count names the leak VECTOR;
 *     a rising `detachedContexts` names a retained-window/closure leak.
 *
 *  2. On-demand HEAP SNAPSHOT via `kill -SIGUSR2 <main-pid>`. Writes a
 *     `.heapsnapshot` to the OS temp dir and logs the path. Load it in Chrome
 *     DevTools → Memory → "Load profile", sort by Retained Size to name the
 *     object class holding the GBs.
 *
 * Wire-up (one line, very early in electron/index.ts, before services start):
 *
 *     import { startMemoryProbe } from './diagnostics/MemoryProbe';
 *     startMemoryProbe();                       // always-on vitals
 *     // or gate it: if (process.env.KANVAS_DIAG) startMemoryProbe();
 *
 * You can also register app counters so each vitals line shows your own gauges:
 *
 *     startMemoryProbe({
 *       counters: () => ({
 *         watchers: watcherService.debugCount(),
 *         pendingEmits: activityService.debugPendingEmits(),
 *         sseTransports: mcpServerService.debugSessionCount(),
 *         aiStreamActive: aiService.debugStreamActive() ? 1 : 0,
 *       }),
 *     });
 */

import v8 from 'node:v8';
import os from 'node:os';
import path from 'node:path';

export interface MemoryProbeOptions {
  /** Vitals log cadence in ms. Default 30_000. */
  vitalsMs?: number;
  /** Optional app-specific gauges appended to each vitals line. */
  counters?: () => Record<string, number>;
  /** Where heap snapshots are written. Default os.tmpdir(). */
  snapshotDir?: string;
}

let started = false;

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Tally active libuv handles/requests by their constructor name. */
function activeResourceTally(): Record<string, number> {
  const tally: Record<string, number> = {};
  // getActiveResourcesInfo() exists on Node 17+ (Electron 33 → Node 20).
  const infos: string[] =
    typeof (process as any).getActiveResourcesInfo === 'function'
      ? (process as any).getActiveResourcesInfo()
      : [];
  for (const name of infos) {
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

export function startMemoryProbe(opts: MemoryProbeOptions = {}): void {
  if (started) return;
  started = true;

  const vitalsMs = opts.vitalsMs ?? 30_000;
  const snapshotDir = opts.snapshotDir ?? os.tmpdir();

  let lastRss = 0;
  let lastHeap = 0;

  const logVitals = () => {
    const mu = process.memoryUsage();
    const hs = v8.getHeapStatistics();
    const rssDelta = mu.rss - lastRss;
    const heapDelta = mu.heapUsed - lastHeap;
    lastRss = mu.rss;
    lastHeap = mu.heapUsed;

    const tally = activeResourceTally();
    const tallyStr = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');

    const extra = opts.counters ? opts.counters() : {};
    const extraStr = Object.entries(extra)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');

    // Single grep-able line. Watch rss↑ heap↑ detached↑ and which handle count climbs.
    console.log(
      `[MemoryProbe] rss=${fmtMB(mu.rss)}(${rssDelta >= 0 ? '+' : ''}${fmtMB(rssDelta)}) ` +
        `heapUsed=${fmtMB(mu.heapUsed)}(${heapDelta >= 0 ? '+' : ''}${fmtMB(heapDelta)}) ` +
        `heapTotal=${fmtMB(mu.heapTotal)} external=${fmtMB(mu.external)} ` +
        `arrayBuffers=${fmtMB(mu.arrayBuffers)} ` +
        `detachedContexts=${(hs as any).number_of_detached_contexts ?? '?'} ` +
        `nativeContexts=${(hs as any).number_of_native_contexts ?? '?'} ` +
        `| handles: ${tallyStr}` +
        (extraStr ? ` | app: ${extraStr}` : '')
    );
  };

  const timer = setInterval(logVitals, vitalsMs);
  // Don't keep the process alive just for the probe.
  if (typeof timer.unref === 'function') timer.unref();
  logVitals(); // immediate baseline

  // On-demand heap snapshot: `kill -SIGUSR2 <main-pid>`
  process.on('SIGUSR2', () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(snapshotDir, `kanvas-main-${process.pid}-${stamp}.heapsnapshot`);
      const written = v8.writeHeapSnapshot(file);
      console.log(`[MemoryProbe] Heap snapshot written: ${written}`);
    } catch (err) {
      console.error('[MemoryProbe] Heap snapshot failed:', err);
    }
  });

  console.log(
    `[MemoryProbe] started (vitals every ${vitalsMs}ms, snapshots → ${snapshotDir}). ` +
      `Trigger a heap snapshot with: kill -SIGUSR2 ${process.pid}`
  );
}
