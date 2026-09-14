/**
 * Staging that survives a broken submodule (story KIT-GIT-S1).
 *
 * `git add -A` fails WHOLESALE when any submodule in the tree has a dangling
 * gitdir. One broken pointer and nothing stages — including files nowhere near
 * the submodule.
 *
 * Seen on a real repository: five submodules whose `.git` files still pointed at
 * a linked-worktree layout that no longer existed, so
 *
 *   fatal: not a git repository: .../.git/modules/lib/ai-backend/worktrees/ai-backend
 *
 * blocked a commit of four unrelated files in `.vscode/` and `QA/`. `git add`
 * with explicit paths succeeds on the same tree, which is what the fallback
 * uses.
 *
 * Pure so the parsing and path logic are testable without a repository.
 */

export interface StatusEntry {
  /** The two-character porcelain status, e.g. ' M', '??', 'R '. */
  status: string;
  /** The path as porcelain reports it — possibly quoted, possibly 'a -> b'. */
  path: string;
}

export interface StagingPlan {
  paths: string[];
  skippedSubmodules: string[];
  empty: boolean;
}

/**
 * The gitdir git could not open, or null when this is not that failure.
 *
 * Returning null for an unrelated error matters: a genuine failure must not be
 * mistaken for a broken submodule and silently retried with a weaker command.
 */
export function parseBrokenSubmodulePath(stderr: string): string | null {
  const m = /fatal:\s*not a git repository:\s*(.+?)\s*$/m.exec(stderr || '');
  return m ? m[1].trim() : null;
}

/** Porcelain quotes paths containing spaces or non-ASCII. */
function unquote(p: string): string {
  const t = p.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

function isInside(path: string, dir: string): boolean {
  // Prefix match on a path BOUNDARY. `lib/ai-backend-utils` is not inside
  // `lib/ai-backend`, and a plain startsWith would say it was.
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Which paths to stage explicitly, given porcelain status and the submodules
 * known to be broken.
 *
 * Submodule gitlinks are excluded: staging one is what re-enters the broken
 * submodule and reproduces the original failure.
 */
export function planStaging(
  entries: StatusEntry[],
  brokenSubmodules: ReadonlySet<string> = new Set()
): StagingPlan {
  const paths: string[] = [];
  const seen = new Set<string>();
  const skipped = new Set<string>();

  const add = (raw: string): void => {
    const p = unquote(raw);
    if (!p) return;
    for (const sm of brokenSubmodules) {
      if (isInside(p, sm)) {
        skipped.add(sm);
        return;
      }
    }
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };

  for (const e of entries) {
    // Renames are reported as 'old -> new'. Both sides must be staged, or the
    // rename records as a delete with an untracked file beside it.
    const arrow = e.path.indexOf(' -> ');
    if (arrow !== -1) {
      add(e.path.slice(0, arrow));
      add(e.path.slice(arrow + 4));
    } else {
      add(e.path);
    }
  }

  return { paths, skippedSubmodules: [...skipped], empty: paths.length === 0 };
}

/** Parse `git status --porcelain` output into entries. */
export function parsePorcelain(output: string): StatusEntry[] {
  return (output || '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
}
