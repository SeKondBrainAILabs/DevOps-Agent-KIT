/**
 * Pure parsers for `git status --porcelain=v2 -b` output (Day 1.5).
 *
 * Used by GitService.getRepoStatus(). Lives in shared/ so it's testable
 * without spawning git.
 *
 * Reference for the v2 format:
 *   https://git-scm.com/docs/git-status#_porcelain_format_version_2
 *
 * Header lines we care about:
 *   # branch.oid <sha>            — current commit
 *   # branch.head <name>          — current branch (or '(detached)')
 *   # branch.upstream <name>      — tracking branch (optional)
 *   # branch.ab +<ahead> -<behind> — ahead/behind counts (optional, only when upstream exists)
 *
 * Per-file lines:
 *   1 XY ... <path>   — ordinary changed entry; X=staged, Y=unstaged
 *   2 XY ... <orig>\t<path>  — renamed/copied entry (we just count it)
 *   u XY ...          — unmerged entry
 *   ? <path>          — untracked
 *   ! <path>          — ignored (we skip)
 */

export interface PorcelainV2Status {
  currentBranch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Files with a non-`.` staged status (X column). */
  stagedCount: number;
  /** Files with a non-`.` unstaged status (Y column). */
  modifiedCount: number;
  untrackedCount: number;
  unmergedCount: number;
}

const DEFAULT_BRANCH_NAME = '(detached)';

/** Parse the full output of `git status --porcelain=v2 -b`. */
export function parsePorcelainV2(output: string): PorcelainV2Status {
  const lines = output.split('\n');
  let currentBranch = DEFAULT_BRANCH_NAME;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;
  let unmergedCount = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      currentBranch = line.slice('# branch.head '.length).trim() || DEFAULT_BRANCH_NAME;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith('# ')) continue; // any other header — ignore

    const kind = line[0];
    if (kind === '1' || kind === '2') {
      // Per the spec, columns 3 and 4 are the X and Y status codes after a single space.
      // Format: "1 XY ..." → first space at index 1, X at 2, Y at 3.
      const x = line[2] ?? '.';
      const y = line[3] ?? '.';
      if (x !== '.' && x !== ' ') stagedCount += 1;
      if (y !== '.' && y !== ' ') modifiedCount += 1;
    } else if (kind === 'u') {
      unmergedCount += 1;
    } else if (kind === '?') {
      untrackedCount += 1;
    }
    // '!' (ignored) is skipped on purpose.
  }

  return {
    currentBranch,
    upstream,
    ahead,
    behind,
    stagedCount,
    modifiedCount,
    untrackedCount,
    unmergedCount,
  };
}

/** Count non-blank lines — used for `git stash list` output. */
export function countNonBlankLines(output: string): number {
  if (!output) return 0;
  return output.split('\n').filter((l) => l.trim().length > 0).length;
}

/** Count `worktree ` headers in `git worktree list --porcelain` output. */
export function countWorktreeListPorcelain(output: string): number {
  if (!output) return 0;
  return output.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

/**
 * Parse a single `git log -1 --format=%H|%h|%s|%aI` line into a commit.
 * Returns null on empty / malformed input.
 */
export interface ParsedLastCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authoredAt: string;
}

export function parseLastCommit(output: string): ParsedLastCommit | null {
  const line = output.trim().split('\n')[0];
  if (!line) return null;
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const [sha, shortSha, subject, authoredAt] = parts;
  if (!sha) return null;
  return {
    sha,
    shortSha,
    // Subject may contain pipes — re-join everything between shortSha and the
    // last segment in case the message had `|` in it.
    subject: parts.slice(2, parts.length - 1).join('|') || subject,
    authoredAt,
  };
}
