/**
 * KIT worktree path layout — the single owner of both directions.
 *
 * ⚠️  MAIN-PROCESS ONLY. This module imports `node:path` and must not be
 *     imported from `renderer/`. Every other module under `shared/` is
 *     dependency-free precisely because the renderer bundles them; this one
 *     is the exception and is only reachable from `electron/`.
 *
 *     Why not hand-roll the string math to keep it pure? Because the whole
 *     point of the extraction is byte-identical parity with what
 *     AgentInstanceService.getWorktreeBaseDir already computes, including on
 *     Windows where the separator differs. Re-implementing `dirname`/`join`
 *     by hand is exactly the silent divergence this story exists to prevent.
 *
 * FORWARD  repoPath                              -> <parent>/KIT-DevOps-<name>
 * BACKWARD <parent>/KIT-DevOps-<name>/<branch>   -> repoPath   (derived)
 *          <repo>/local_deploy/<branch>          -> repoPath   (exact)
 *
 * The backward direction previously lived as an inlined regex pair inside
 * WatcherService.startWithPath. Three later stories need the same answer
 * (H5 ~/.claude.json unseed, H6 lock-root normalisation, A2 observer
 * detection), so it is owned here rather than copied a fourth time.
 */

import { basename, dirname, join } from 'path';

/**
 * How the repo root was obtained.
 *
 * - `exact`   — the repo root is literally a prefix of the worktree path.
 *               Only the legacy `local_deploy` layout gives this.
 * - `derived` — the repo root was RECONSTRUCTED from the directory *name*
 *               (`KIT-DevOps-<name>` -> `<parent>/<name>`). If the source repo
 *               was renamed after the worktree was created, this names a path
 *               that does not exist.
 *
 * Callers about to do something destructive must refuse `derived`. H5 deletes
 * an entry from the user's own `~/.claude.json`; a reconstructed guess is not
 * sufficient authority for that, and it must verify against the filesystem
 * (`git rev-parse --git-common-dir`) before acting.
 */
export type PathConfidence = 'exact' | 'derived';

export interface ResolvedRepoRoot {
  root: string;
  confidence: PathConfidence;
}

/** Legacy layout (<= v2.6.53): `<repo>/local_deploy/<branch>` */
const LEGACY_WORKTREE_RE = /^(.+)\/local_deploy\/[^/]+\/?$/;

/** Current layout: `<repo_parent>/KIT-DevOps-<repo_name>/<branch>` */
const CURRENT_WORKTREE_RE = /^(.+)\/KIT-DevOps-([^/]+)\/[^/]+\/?$/;

/**
 * Where KIT puts worktrees for a given repo: a sibling directory named
 * `KIT-DevOps-<repo_name>`.
 *
 * Git tracks worktrees by absolute path in `.git/worktrees/<id>/`, so this
 * layout works transparently for `git status`, `commit`, `log`, merges, etc.
 */
export function getWorktreeBaseDir(repoPath: string): string {
  const parent = dirname(repoPath);
  const name = basename(repoPath);
  return join(parent, `KIT-DevOps-${name}`);
}

/**
 * Resolve the source repo root a worktree path belongs to.
 *
 * Returns `null` when the path is not a KIT worktree — callers that want the
 * old "fall back to the path itself" behaviour should write
 * `resolveRepoRootFromWorktree(p)?.root ?? p`.
 *
 * NOTE: the two patterns are POSIX-separator only. That is a pre-existing
 * limitation carried over verbatim from WatcherService so that parity holds;
 * widening it would be a behaviour change, not an extraction, and belongs in
 * its own story.
 *
 * Legacy is tested first, matching the original call site's ordering — a path
 * that could satisfy both (a `local_deploy` worktree inside a directory that
 * happens to be named `KIT-DevOps-*`) resolves as legacy.
 */
export function resolveRepoRootFromWorktree(
  worktreePath: string
): ResolvedRepoRoot | null {
  if (!worktreePath) return null;

  const legacyMatch = worktreePath.match(LEGACY_WORKTREE_RE);
  if (legacyMatch) {
    return { root: legacyMatch[1], confidence: 'exact' };
  }

  const currentMatch = worktreePath.match(CURRENT_WORKTREE_RE);
  if (currentMatch) {
    return {
      root: `${currentMatch[1]}/${currentMatch[2]}`,
      confidence: 'derived',
    };
  }

  return null;
}

/**
 * True when the path looks like a KIT-created worktree in either layout.
 *
 * This is the guard H5 relies on before removing a `projects[<path>]` entry
 * from the user's `~/.claude.json`: only KIT's own worktrees are eligible,
 * never the user's actual repository.
 */
export function isKitWorktreePath(candidate: string): boolean {
  return resolveRepoRootFromWorktree(candidate) !== null;
}
