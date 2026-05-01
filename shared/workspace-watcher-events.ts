/**
 * Workspace filesystem-watcher event classifier (Epic A / story A3).
 *
 * The watcher fires on many events; only those that change a repo's `.git`
 * presence matter. This pure classifier maps a raw watcher event to one of:
 *
 *   - repo-added     — a new `.git` directory appeared under the workspace
 *   - repo-removed   — a `.git` directory was removed
 *   - irrelevant     — anything else (filtered out before notifying renderers)
 *
 * The `repoPath` returned is the parent directory of `.git`, i.e. the repo
 * root the renderer should care about.
 */

export type WatcherRawEventType = 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change';

export interface WatcherEventClassification {
  kind: 'repo-added' | 'repo-removed' | 'irrelevant';
  repoPath?: string;
  /** Depth of repoPath relative to the workspace root, when known. */
  depth?: number;
}

/**
 * Extract the repo root from a `.git` path, or `null` if the path doesn't
 * involve `.git`.
 *
 * Examples:
 *   /work/foo/.git           → /work/foo
 *   /work/foo/.git/HEAD      → /work/foo
 *   /work/foo/src/index.ts   → null
 */
export function repoRootFromGitPath(absPath: string): string | null {
  const stripped = absPath.replace(/\/+$/, '');
  // Match either path ENDING in /.git or path with /.git/ in middle
  const endMatch = stripped.match(/^(.*)\/\.git$/);
  if (endMatch) return endMatch[1];
  const midMatch = stripped.match(/^(.*)\/\.git\//);
  if (midMatch) return midMatch[1];
  return null;
}

/** Compute depth of a path relative to a workspace root (number of `/` after root). */
export function depthFromRoot(workspaceRoot: string, repoPath: string): number {
  const root = workspaceRoot.replace(/\/+$/, '');
  if (!repoPath.startsWith(root + '/')) return -1;
  const tail = repoPath.slice(root.length + 1);
  if (!tail) return 0;
  return tail.split('/').length;
}

export interface ClassifyOptions {
  workspaceRoot: string;
  maxDepth: number;
}

export function classifyWatcherEvent(
  eventType: WatcherRawEventType,
  absPath: string,
  options: ClassifyOptions
): WatcherEventClassification {
  // Only `.git`-touching events matter.
  const repoPath = repoRootFromGitPath(absPath);
  if (!repoPath) return { kind: 'irrelevant' };

  // Don't fire for events deep inside `.git/...` after the repo is established —
  // only the directory itself or its initial creation. We treat any
  // `.git`-pathed event as a signal *that the repo exists/no-longer-exists*,
  // but we filter on event type to avoid floods from inner-`.git` writes:
  //   - add/addDir: repo appeared
  //   - unlinkDir:  repo disappeared
  //   - unlink/change inside .git: ignore (noise)
  const depth = depthFromRoot(options.workspaceRoot, repoPath);
  if (depth < 0 || depth > options.maxDepth) return { kind: 'irrelevant' };

  if (eventType === 'addDir' || eventType === 'add') {
    return { kind: 'repo-added', repoPath, depth };
  }
  if (eventType === 'unlinkDir') {
    return { kind: 'repo-removed', repoPath, depth };
  }
  return { kind: 'irrelevant' };
}
