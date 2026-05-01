/**
 * Notification dedup + aggregation (Epic K / story K1).
 *
 * NotificationService receives raw events from many sources (CI, PR review,
 * stale branch, prod drift, disk threshold, agent waiting). To avoid spamming
 * the user, identical events within `dedupWindowMinutes` (default 5) collapse
 * into a single notification with a `count`.
 *
 * "Identical" means: same `type` + same `dedupKey`. Severity escalation is
 * monotonic — if a later event raises severity, the merged record carries
 * the higher severity.
 */

export type NotificationSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface RawNotification {
  /** Stable type identifier (e.g. 'ci-failure', 'pr-review-request'). */
  type: string;
  severity: NotificationSeverity;
  /** Anything in the same {type, dedupKey} bucket collapses to one entry. */
  dedupKey: string;
  /** ISO timestamp of the event. */
  at: string;
  /** Title shown in UI. */
  title: string;
  /** Optional context — last value wins when entries collapse. */
  body?: string;
  /** Optional link / source URL. */
  source?: string;
}

export interface AggregatedNotification extends RawNotification {
  /** Number of raw events folded into this entry. */
  count: number;
  /** Earliest event in the bucket. */
  firstAt: string;
  /** Latest event in the bucket. */
  lastAt: string;
}

export interface AggregateOptions {
  /** Minutes within which duplicates collapse. Default 5. */
  dedupWindowMinutes?: number;
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

function maxSeverity(a: NotificationSeverity, b: NotificationSeverity): NotificationSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Collapse a chronological event stream into a deduped, aggregated list.
 * Events outside the dedup window start a new bucket even if {type, dedupKey}
 * match. Output is sorted by lastAt descending (newest first).
 */
export function aggregateNotifications(
  events: ReadonlyArray<RawNotification>,
  options: AggregateOptions = {}
): AggregatedNotification[] {
  const windowMs = (options.dedupWindowMinutes ?? 5) * 60 * 1000;
  // Iterate in chronological order to honor the dedup window.
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  );

  // All closed/open buckets keyed by `${type}::${dedupKey}`. Each key may
  // accumulate multiple buckets when events fall outside the window.
  const all: AggregatedNotification[] = [];
  const openByKey = new Map<string, AggregatedNotification>();
  for (const e of sorted) {
    const key = `${e.type}::${e.dedupKey}`;
    const existing = openByKey.get(key);
    const eMs = Date.parse(e.at);
    if (existing && eMs - Date.parse(existing.lastAt) <= windowMs) {
      existing.count += 1;
      existing.lastAt = e.at;
      existing.severity = maxSeverity(existing.severity, e.severity);
      // Last-wins for body/source/title — most recent context is most useful.
      existing.title = e.title;
      if (e.body !== undefined) existing.body = e.body;
      if (e.source !== undefined) existing.source = e.source;
      continue;
    }
    const bucket: AggregatedNotification = {
      ...e,
      count: 1,
      firstAt: e.at,
      lastAt: e.at,
    };
    all.push(bucket);
    openByKey.set(key, bucket);
  }

  return all.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}
