/**
 * Ticket-ID extraction + commit-message prepending (Epic D / story D3).
 *
 * Used by:
 *  - D2 / D3: Commit Composer auto-prepends `[TICKET-123]` to messages
 *  - M3: ticket-required commit policy gates on the same predicate
 *
 * The default regex matches conventional branch names like
 * `feat/PROJ-123-foo` or `bugfix/ABC-9999-thing` — extracting the
 * `PROJ-123` segment. Configurable so teams using Linear / Jira /
 * custom prefixes can swap the pattern.
 */

/**
 * Default extractor: ALPHA-DIGIT segment somewhere in the input,
 * preceded by a non-alphanumeric or start-of-string boundary.
 * Examples that match: `feat/PROJ-123-foo`, `PROJ-123`, `chore/ABC-9-x`.
 * Examples that DO NOT match: `release-2025`, `proj-123` (lowercase prefix).
 */
export const DEFAULT_TICKET_REGEX = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]*-\d+)/;

export interface ExtractTicketIdOptions {
  /** Override the regex used for matching. Must capture the ticket id in group 1. */
  regex?: RegExp;
}

/** Extract a ticket ID from a branch name (or any string). Returns null if none. */
export function extractTicketId(
  input: string | null | undefined,
  options: ExtractTicketIdOptions = {}
): string | null {
  if (!input) return null;
  const re = options.regex ?? DEFAULT_TICKET_REGEX;
  const m = input.match(re);
  return m && m[1] ? m[1] : null;
}

/** Build a `[TICKET-123]` prefix string from an extracted id. */
export function formatTicketPrefix(ticketId: string): string {
  return `[${ticketId}]`;
}

export interface PrependTicketOptions {
  /** Force-add even if a different ticket prefix is already present. */
  replaceExistingPrefix?: boolean;
}

/**
 * Prepend a ticket prefix to a commit message.
 *
 * Behavior:
 *  - If the message already starts with `[TICKET-123]` (any ticket), return
 *    the message unchanged unless `replaceExistingPrefix` is true.
 *  - Otherwise prepend `[TICKET-123] ` to the message subject.
 *  - Empty / whitespace-only input is returned as just the prefix.
 */
export function prependTicketPrefix(
  message: string,
  ticketId: string,
  options: PrependTicketOptions = {}
): string {
  const trimmed = message ?? '';
  const prefix = formatTicketPrefix(ticketId);

  if (trimmed.trim().length === 0) {
    return `${prefix} `;
  }

  // Already prefixed?
  const existing = trimmed.match(/^\[([A-Z][A-Z0-9]*-\d+)\]\s*/);
  if (existing) {
    if (existing[1] === ticketId) return trimmed; // Same ticket — leave alone.
    if (!options.replaceExistingPrefix) return trimmed;
    return `${prefix} ${trimmed.slice(existing[0].length)}`;
  }

  return `${prefix} ${trimmed}`;
}

/** True when `message` starts with any `[ALPHA-NUM]` ticket prefix. */
export function messageHasTicketPrefix(message: string): boolean {
  return /^\[[A-Z][A-Z0-9]*-\d+\]/.test(message ?? '');
}
