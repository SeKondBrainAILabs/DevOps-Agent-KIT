/**
 * PR title and body generation (story KIT-PR-P2).
 *
 * Pure and dependency-free so the whole shape is table-testable, and because
 * the two things that can go wrong here are both content problems rather than
 * I/O problems: omitting commits, and letting commit text escape into markup.
 *
 * ## What this deliberately does not read
 *
 * KIT's own `commits` table already carries files_changed, additions,
 * deletions and author — the obvious source. It is NOT used. Rows are written
 * from only three places (`kit_commit`, `kit_commit_all`, and the watcher's
 * idle checkpoint), so an agent that runs `git commit` in bash produces no row.
 * A body built from that table would omit commits, and omit them most for the
 * agents least likely to follow instructions — showing an incomplete summary,
 * presented as complete, to the person deciding whether to merge.
 *
 * The commit list is passed in from `git log <base>..<head>`. Git decides what
 * is in the PR; KIT only decides what it knows about it.
 */

export interface PrCommit {
  hash: string;
  subject: string;
}

export interface PrBodyInput {
  sessionId: string;
  branchName: string;
  baseBranch: string;
  taskDescription: string;
  /** From `git log <base>..<head>`, newest first. */
  commits: PrCommit[];
}

const MAX_TITLE = 72;
/** Commits listed in full before the body starts summarising. */
export const MAX_BODY_COMMITS = 40;

const MARKER_PREFIX = '<!-- kit-session: ';

/** One line, no markup, safe to drop into a list item. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Neutralise text that would otherwise escape the context it is rendered in.
 *
 * Commit subjects are attacker-influenceable in any repository that accepts
 * contributions. Two concrete escapes matter here: `-->` terminates the session
 * marker comment early, and a leading `#` turns a subject into a heading that
 * restructures the body.
 */
function sanitiseSubject(subject: string): string {
  return flatten(subject)
    .replace(/-->/g, '--​>')
    .replace(/^#+\s*/, '');
}

export function buildPrTitle(input: PrBodyInput): string {
  const raw = flatten(input.taskDescription);
  if (!raw) return input.branchName;
  if (raw.length <= MAX_TITLE) return raw;

  // Trim on a word boundary — a title cut mid-word reads as corrupted.
  const clipped = raw.slice(0, MAX_TITLE - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > MAX_TITLE / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}

export function buildPrBody(input: PrBodyInput): string {
  const { commits, taskDescription, branchName, baseBranch, sessionId } = input;

  const shown = commits.slice(0, MAX_BODY_COMMITS);
  const omitted = commits.length - shown.length;

  const commitLines =
    commits.length === 0
      ? '_No commits on this branch yet._'
      : shown
          .map((c) => `- \`${c.hash.slice(0, 7)}\` ${sanitiseSubject(c.subject)}`)
          .join('\n') + (omitted > 0 ? `\n- …and ${omitted} more commits` : '');

  const task = flatten(taskDescription) || '_No task description recorded._';

  // No diffs and no file contents, deliberately. A PR body is public in most
  // repositories; commit subjects are already public, file contents are not.
  return `## What this is

${task}

## Commits

${commitLines}

## Session

| | |
| --- | --- |
| Branch | \`${branchName}\` |
| Base | \`${baseBranch}\` |
| Commits | ${commits.length} |

Opened by KIT for DevOps on behalf of an agent session. Commit list is
\`git log ${baseBranch}..${branchName}\`, so it reflects what is actually on the
branch rather than what any tool recorded.

${MARKER_PREFIX}${sessionId} -->`;
}

/**
 * Recover the session id from a PR body.
 *
 * Used to recognise a PR this session already opened. Tolerant of a human
 * having edited around it — people do edit PR bodies — so it searches rather
 * than expecting the marker in a fixed position.
 */
export function parseSessionMarker(body: string): string | null {
  const match = body.match(/<!--\s*kit-session:\s*([^\s>-][^\s>]*)\s*-->/);
  return match ? match[1] : null;
}
