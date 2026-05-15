/**
 * Recursive repo scanner — pure logic (Epic A / story A2).
 *
 * `scanForRepos` walks a directory tree (provided by the caller via the
 * `listChildren` callback) up to `maxDepth`, skipping any folder whose
 * basename matches one of the `ignoreGlobs` (treated as exact-match basenames
 * — full glob support is intentionally out of scope for the MVP).
 *
 * A directory containing a `.git` child entry is treated as a Git repository
 * and recorded. The scanner does NOT recurse into found repos — once a repo
 * is found, its subdirectories are skipped.
 */

export interface DirChild {
  name: string;
  /** True if this child is a directory. */
  isDirectory: boolean;
}

export interface ScanInputs {
  root: string;
  maxDepth: number;
  ignoreGlobs: ReadonlyArray<string>;
  /** Resolves the children of an absolute directory path. */
  listChildren: (absDir: string) => Promise<DirChild[]>;
  /** Optional path-join (defaults to POSIX-style join). */
  joinPath?: (a: string, b: string) => string;
}

export interface ScannedRepo {
  path: string;
  name: string;
  depth: number;
}

const defaultJoin = (a: string, b: string): string => {
  if (!a) return b;
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`;
};

export function shouldSkipDir(name: string, ignoreGlobs: ReadonlyArray<string>): boolean {
  return ignoreGlobs.includes(name);
}

export async function scanForRepos(input: ScanInputs): Promise<ScannedRepo[]> {
  const join = input.joinPath ?? defaultJoin;
  const found: ScannedRepo[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > input.maxDepth) return;

    let children: DirChild[];
    try {
      children = await input.listChildren(dir);
    } catch {
      return; // Permission errors etc. — skip silently.
    }

    // Is this directory itself a Git repo? (`.git` child present)
    const hasGit = children.some((c) => c.name === '.git');
    if (hasGit) {
      const segments = dir.replace(/\/+$/, '').split('/').filter(Boolean);
      const name = segments.length > 0 ? segments[segments.length - 1] : dir;
      found.push({ path: dir, name, depth });
      return; // Do NOT recurse into a found repo.
    }

    if (depth === input.maxDepth) return;

    for (const c of children) {
      if (!c.isDirectory) continue;
      if (shouldSkipDir(c.name, input.ignoreGlobs)) continue;
      await walk(join(dir, c.name), depth + 1);
    }
  }

  await walk(input.root, 0);

  // Stable sort: by depth then path so test assertions are deterministic.
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return found;
}
