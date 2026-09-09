/**
 * Distinct commit-message format for the periodic auto-saver so a rebase
 * todo can never mistake a WIP for a real feature commit.
 *
 * Old subject: "WIP: periodic auto-save (2026-07-22 12:18)"
 * New subject: "[wip-autosave] 2026-07-22 12:18"
 *
 * The `[wip-autosave]` prefix is deliberately un-conventional-commits so
 * that any lint / hook that expects `feat|fix|chore|...` will REJECT it if
 * someone tries to push it standalone. It's also greppable and human-obvious.
 *
 * Callers may also append the `Git-Meta: kanvas-wip` trailer, which some
 * teams can auto-squash in rebase todos via `git rebase --autosquash`.
 * (True `fixup!` semantics would require squashing onto a specific target
 * commit — this is a lighter-weight signal.)
 */

export const WIP_SUBJECT_PREFIX = '[wip-autosave]';
export const WIP_TRAILER_KEY = 'Git-Meta';
export const WIP_TRAILER_VALUE = 'kanvas-wip';
export const WIP_TRAILER_LINE = `${WIP_TRAILER_KEY}: ${WIP_TRAILER_VALUE}`;

export interface FormatWipOptions {
  /** ISO-ish timestamp string, defaults to now (minute precision). */
  stamp?: string;
  /** Optional "[Upgrade From <repo>]" style prefix (multi-repo sessions). */
  scopePrefix?: string;
  /** Append the Git-Meta trailer. Default true. */
  withTrailer?: boolean;
}

export function formatWipCommitMessage(options: FormatWipOptions = {}): string {
  const stamp =
    options.stamp ??
    new Date().toISOString().slice(0, 16).replace('T', ' ');
  const subject = options.scopePrefix
    ? `${options.scopePrefix} ${WIP_SUBJECT_PREFIX} ${stamp}`
    : `${WIP_SUBJECT_PREFIX} ${stamp}`;
  if (options.withTrailer === false) return subject;
  // Blank line then trailer — standard git trailer format.
  return `${subject}\n\n${WIP_TRAILER_LINE}`;
}

/** True when a commit subject is an auto-save (new OR legacy format). */
export function isWipAutoSaveSubject(subject: string): boolean {
  if (!subject) return false;
  const s = subject.trim();
  return (
    s.startsWith(WIP_SUBJECT_PREFIX) ||
    // Legacy format the incident bug matched against — keep detecting it so
    // callers can migrate + still identify old commits already in history.
    /^\[?[^\]]*\]?\s*WIP:\s*periodic auto-save/i.test(s) ||
    /^WIP:\s*periodic auto-save/i.test(s)
  );
}

/** True when a commit message body contains our trailer. */
export function hasWipTrailer(fullMessage: string): boolean {
  if (!fullMessage) return false;
  return new RegExp(
    `^${WIP_TRAILER_KEY}:\\s*${WIP_TRAILER_VALUE}\\s*$`,
    'im'
  ).test(fullMessage);
}
