/**
 * One row per repository in "Recent Repositories".
 *
 * The list used to be keyed by exact path, so the same repository showed up
 * once per checkout: a KIT worktree recorded as a session's repoPath became
 * its own "repo", and a benchmark harness opening sessions in four throwaway
 * clones produced four identical "DevOps-Agent-KIT" rows that pushed real
 * repos out of the 10-item list.
 *
 * Identity, strongest first:
 *   1. the origin remote URL, normalised — same project, any clone;
 *   2. the shared git directory — worktrees of one clone with no remote;
 *   3. the path itself — when git cannot be asked (folder gone, not a repo).
 *
 * Pure: the caller resolves identities with git and passes them in.
 */

import type { RecentRepo } from './types';

export const RECENT_REPOS_LIMIT = 10;

export interface RepoIdentity {
  /** Rows with the same key are the same repository. */
  key: string;
  /** Path to show and open: the main checkout, never a linked worktree. */
  canonicalPath: string;
}

/**
 * Normalise a remote URL so ssh, https, `.git` and trailing-slash variants of
 * one repository compare equal. Host is case-insensitive; the path is not
 * lower-cased, because some hosts treat it case-sensitively.
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  if (!u) return '';
  // scp-like ssh: git@github.com:owner/repo.git
  const scp = u.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  if (scp) {
    u = `${scp[1].toLowerCase()}/${scp[2]}`;
  } else {
    const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
    if (m) u = `${m[1].toLowerCase()}/${m[2]}`;
  }
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

/** Identity from git facts. `commonDir` is `git rev-parse --git-common-dir`, absolute. */
export function identityFromGit(
  path: string,
  facts: { remoteUrl?: string | null; commonDir?: string | null }
): RepoIdentity {
  const commonDir = facts.commonDir?.replace(/\/+$/, '') || null;
  // The main checkout of a normal (non-bare) repo is the parent of its .git.
  const canonicalPath =
    commonDir && /\/\.git$/.test(commonDir) ? commonDir.slice(0, -'/.git'.length) : path;
  const remote = facts.remoteUrl ? normalizeRemoteUrl(facts.remoteUrl) : '';
  if (remote) return { key: `remote:${remote}`, canonicalPath };
  if (commonDir) return { key: `gitdir:${commonDir}`, canonicalPath };
  return { key: `path:${path}`, canonicalPath: path };
}

function basenameOf(p: string): string {
  const parts = p.replace(/\/+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Collapse rows that are the same repository. The most recently used row
 * wins and its canonical path is what the user opens; session counts add up.
 * Newest first, capped.
 */
export function mergeRecentRepos(
  repos: RecentRepo[],
  identityOf: (path: string) => RepoIdentity,
  limit = RECENT_REPOS_LIMIT
): RecentRepo[] {
  const byKey = new Map<string, RecentRepo>();
  const newestFirst = [...repos].sort(
    (a, b) => Date.parse(b.lastUsed || '') - Date.parse(a.lastUsed || '') || 0
  );
  for (const repo of newestFirst) {
    const id = identityOf(repo.path);
    const existing = byKey.get(id.key);
    if (!existing) {
      byKey.set(id.key, {
        ...repo,
        path: id.canonicalPath,
        name: basenameOf(id.canonicalPath),
        agentCount: repo.agentCount || 0,
      });
    } else {
      existing.agentCount += repo.agentCount || 0;
    }
  }
  return Array.from(byKey.values()).slice(0, limit);
}

/** True when merging changed anything, so the caller knows to persist. */
export function recentReposChanged(before: RecentRepo[], after: RecentRepo[]): boolean {
  if (before.length !== after.length) return true;
  return before.some(
    (r, i) =>
      r.path !== after[i].path ||
      r.name !== after[i].name ||
      r.agentCount !== after[i].agentCount ||
      r.lastUsed !== after[i].lastUsed
  );
}

/**
 * Only sessions a person started belong in Recent Repositories. An agent
 * fanning out (or a benchmark harness opening throwaway clones) is not "a repo
 * you used recently". Absent origin means a pre-tracking record, i.e. a human.
 */
export function countsAsRecentUse(createdBy: 'ui' | 'mcp' | 'adopted' | undefined): boolean {
  return createdBy === undefined || createdBy === 'ui';
}

/**
 * Rows recorded before agent sessions were excluded: drop one when every known
 * session on that repository was agent-created. A row with no known sessions
 * is kept — absence of evidence is not evidence of an agent.
 */
export function dropAgentOnlyRepos(
  repos: RecentRepo[],
  keyOf: (path: string) => string,
  sessions: Array<{ repoPath: string; createdBy?: 'ui' | 'mcp' | 'adopted' }>
): RecentRepo[] {
  const human = new Set<string>();
  const agent = new Set<string>();
  for (const s of sessions) {
    (countsAsRecentUse(s.createdBy) ? human : agent).add(keyOf(s.repoPath));
  }
  return repos.filter((r) => {
    const k = keyOf(r.path);
    return human.has(k) || !agent.has(k);
  });
}
