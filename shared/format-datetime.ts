/**
 * Shared date/time formatting helpers.
 *
 * Rationale: many surfaces (MCP call log, activity feed, status bar) formatted
 * timestamps with `toLocaleTimeString()` — time only, no date. When a log entry
 * is more than a few minutes old you can't tell WHEN it happened. These helpers
 * always include the date so a timestamp is unambiguous on its own.
 */

/** Parse an ISO string / epoch ms into a Date, or null if unparseable. */
function toDate(ts: string | number | Date): Date | null {
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Compact date + time, e.g. "Aug 8, 14:32:07".
 * Includes seconds — used for log/event streams where ordering within a minute
 * matters (MCP call log, activity feed).
 */
export function formatDateTime(ts: string | number | Date): string {
  const d = toDate(ts);
  if (!d) return typeof ts === 'string' ? ts : String(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Compact date + time without seconds, e.g. "Aug 8, 14:32".
 * For summary surfaces (status bar "up since", settings) where seconds are noise.
 */
export function formatDateTimeShort(ts: string | number | Date): string {
  const d = toDate(ts);
  if (!d) return typeof ts === 'string' ? ts : String(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
