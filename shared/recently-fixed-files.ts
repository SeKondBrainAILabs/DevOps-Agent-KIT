/**
 * Recently-fixed-files alert (Epic Q / story Q2).
 *
 * Pure rule that decides whether to warn before an agent edits a file
 * that received a "fix commit" in the last N days. Renderer surfaces the
 * warning + a confirm-to-proceed flow; user's confirmation is logged.
 */

export interface FixHistoryEntry {
  filePath: string;
  /** Most-recent fix commit timestamp on this file (ISO string). */
  lastFixAt: string;
  /** SHA of the most-recent fix on this file. */
  fixSha: string;
}

export interface RecentlyFixedAlertInputs {
  filePath: string;
  /** Set of fix-commit history entries (one per file). */
  history: ReadonlyArray<FixHistoryEntry>;
  /** Lookback window in days. Default 7. */
  windowDays?: number;
  /** "Now" — for deterministic tests. Default Date.now(). */
  now?: number;
  /** User has already acknowledged this alert (within session). */
  acknowledged?: boolean;
}

export type RecentlyFixedAlertKind =
  | 'no-fix-history'
  | 'fix-outside-window'
  | 'acknowledged'
  | 'warn-recently-fixed';

export interface RecentlyFixedAlert {
  kind: RecentlyFixedAlertKind;
  shouldWarn: boolean;
  daysSinceFix?: number;
  fixSha?: string;
  message?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function evaluateRecentlyFixedAlert(
  input: RecentlyFixedAlertInputs
): RecentlyFixedAlert {
  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? 7;

  const entry = input.history.find((h) => h.filePath === input.filePath);
  if (!entry) {
    return { kind: 'no-fix-history', shouldWarn: false };
  }

  const fixAtMs = Date.parse(entry.lastFixAt);
  if (Number.isNaN(fixAtMs)) {
    return { kind: 'no-fix-history', shouldWarn: false };
  }
  const ageDays = (now - fixAtMs) / MS_PER_DAY;
  if (ageDays > windowDays) {
    return { kind: 'fix-outside-window', shouldWarn: false, daysSinceFix: Math.floor(ageDays) };
  }
  if (input.acknowledged) {
    return {
      kind: 'acknowledged',
      shouldWarn: false,
      daysSinceFix: Math.floor(ageDays),
      fixSha: entry.fixSha,
    };
  }

  return {
    kind: 'warn-recently-fixed',
    shouldWarn: true,
    daysSinceFix: Math.floor(ageDays),
    fixSha: entry.fixSha,
    message:
      `This file received a fix in the last ${windowDays} days ` +
      `(commit ${entry.fixSha.slice(0, 7)}, ${Math.floor(ageDays)}d ago). ` +
      'Confirm before editing.',
  };
}

/** Build a quick-lookup index from a list of history entries (last-fix wins on dups). */
export function indexFixHistory(
  entries: ReadonlyArray<FixHistoryEntry>
): Map<string, FixHistoryEntry> {
  const out = new Map<string, FixHistoryEntry>();
  for (const e of entries) {
    const existing = out.get(e.filePath);
    if (!existing || Date.parse(e.lastFixAt) > Date.parse(existing.lastFixAt)) {
      out.set(e.filePath, e);
    }
  }
  return out;
}
