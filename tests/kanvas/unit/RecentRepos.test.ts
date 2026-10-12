/**
 * Unit Tests for shared/recent-repos.ts
 *
 * "Recent Repositories" was keyed by exact path, so one repository showed up
 * once per checkout — four benchmark clones became four identical rows, and
 * KIT worktrees were listed as repos of their own.
 */

import { describe, it, expect } from '@jest/globals';
import {
  identityFromGit,
  mergeRecentRepos,
  normalizeRemoteUrl,
  recentReposChanged,
  countsAsRecentUse,
  dropAgentOnlyRepos,
  type RepoIdentity,
} from '../../../shared/recent-repos';
import type { RecentRepo } from '../../../shared/types';

describe('normalizeRemoteUrl', () => {
  it.each([
    'git@github.com:Acme/Widgets.git',
    'https://github.com/Acme/Widgets.git',
    'https://github.com/Acme/Widgets',
    'https://user:tok@GitHub.com/Acme/Widgets.git/',
    'ssh://git@github.com/Acme/Widgets.git',
  ])('treats %s as github.com/Acme/Widgets', (url) => {
    expect(normalizeRemoteUrl(url)).toBe('github.com/Acme/Widgets');
  });

  it('keeps local-path remotes comparable', () => {
    expect(normalizeRemoteUrl('/Users/me/kit/bench-remotes/DevOps-Agent-KIT.git')).toBe(
      '/Users/me/kit/bench-remotes/DevOps-Agent-KIT'
    );
  });
});

describe('identityFromGit', () => {
  it('maps a linked worktree to its main checkout', () => {
    const id = identityFromGit('/r/KIT-DevOps-Core/codex/feat', {
      commonDir: '/r/Core/Core/.git',
      remoteUrl: 'https://github.com/acme/core.git',
    });
    expect(id).toEqual({ key: 'remote:github.com/acme/core', canonicalPath: '/r/Core/Core' });
  });

  it('falls back to the shared git dir with no remote', () => {
    expect(identityFromGit('/r/a', { commonDir: '/r/a/.git', remoteUrl: null }).key).toBe(
      'gitdir:/r/a/.git'
    );
  });

  it('falls back to the path when git cannot answer', () => {
    expect(identityFromGit('/gone', {})).toEqual({ key: 'path:/gone', canonicalPath: '/gone' });
  });
});

const row = (path: string, lastUsed: string, agentCount = 0): RecentRepo => ({
  path,
  name: path.split('/').pop()!,
  lastUsed,
  agentCount,
});

describe('mergeRecentRepos', () => {
  const ids: Record<string, RepoIdentity> = {
    '/bench/pi/KIT': { key: 'remote:bench/KIT', canonicalPath: '/bench/pi/KIT' },
    '/bench/oc/KIT': { key: 'remote:bench/KIT', canonicalPath: '/bench/oc/KIT' },
    '/bench/oc-large/KIT': { key: 'remote:bench/KIT', canonicalPath: '/bench/oc-large/KIT' },
    '/r/Core/Core': { key: 'remote:gh/core', canonicalPath: '/r/Core/Core' },
    '/r/KIT-DevOps-Core/codex-sharing': { key: 'remote:gh/core', canonicalPath: '/r/Core/Core' },
    '/r/basanti': { key: 'remote:gh/basanti', canonicalPath: '/r/basanti' },
  };
  const identityOf = (p: string) => ids[p] ?? { key: `path:${p}`, canonicalPath: p };

  it('shows each repository once — the reported screenshot', () => {
    const merged = mergeRecentRepos(
      [
        row('/bench/pi/KIT', '2026-10-10T10:00:00Z'),
        row('/bench/oc/KIT', '2026-10-10T11:00:00Z'),
        row('/bench/oc-large/KIT', '2026-10-10T09:00:00Z'),
        row('/r/basanti', '2026-10-01T00:00:00Z', 2),
        row('/r/Core/Core', '2026-09-30T00:00:00Z', 1),
        row('/r/KIT-DevOps-Core/codex-sharing', '2026-09-30T05:00:00Z'),
      ],
      identityOf
    );
    expect(merged.map((r) => r.path)).toEqual(['/bench/oc/KIT', '/r/basanti', '/r/Core/Core']);
  });

  it('keeps the most recently used checkout, and adds up session counts', () => {
    const [core] = mergeRecentRepos(
      [row('/r/Core/Core', '2026-09-01T00:00:00Z', 1), row('/r/KIT-DevOps-Core/codex-sharing', '2026-09-02T00:00:00Z', 2)],
      identityOf
    );
    expect(core).toMatchObject({ path: '/r/Core/Core', name: 'Core', agentCount: 3, lastUsed: '2026-09-02T00:00:00Z' });
  });

  it('never shows a worktree path, even when it was the only row', () => {
    const [only] = mergeRecentRepos([row('/r/KIT-DevOps-Core/codex-sharing', '2026-09-02T00:00:00Z')], identityOf);
    expect(only.path).toBe('/r/Core/Core');
    expect(only.name).toBe('Core');
  });

  it('caps the list after merging, so duplicates no longer crowd repos out', () => {
    const many = Array.from({ length: 14 }, (_, i) => row(`/r/repo${i}`, `2026-09-${String(i + 10).padStart(2, '0')}T00:00:00Z`));
    expect(mergeRecentRepos(many, identityOf)).toHaveLength(10);
  });

  it('leaves distinct repositories alone', () => {
    const rows = [row('/r/a', '2026-09-02T00:00:00Z'), row('/r/b', '2026-09-01T00:00:00Z')];
    const merged = mergeRecentRepos(rows, identityOf);
    expect(recentReposChanged(rows, merged)).toBe(false);
  });
});

describe('agent sessions stay out of Recent Repositories', () => {
  it('counts only sessions a person started', () => {
    expect(countsAsRecentUse('ui')).toBe(true);
    expect(countsAsRecentUse(undefined)).toBe(true); // pre-tracking record = human
    expect(countsAsRecentUse('mcp')).toBe(false);
    expect(countsAsRecentUse('adopted')).toBe(false);
  });

  const keyOf = (p: string) => (p.startsWith('/bench/') ? 'remote:bench/KIT' : `path:${p}`);
  const rows = [row('/bench/oc/KIT', '2026-10-10T11:00:00Z'), row('/r/basanti', '2026-10-01T00:00:00Z'), row('/r/new', '2026-09-01T00:00:00Z')];

  it('drops a row only agents ever used — the benchmark clones', () => {
    const kept = dropAgentOnlyRepos(rows, keyOf, [
      { repoPath: '/bench/pi/KIT', createdBy: 'mcp' },
      { repoPath: '/bench/oc/KIT', createdBy: 'mcp' },
      { repoPath: '/r/basanti', createdBy: 'ui' },
    ]);
    expect(kept.map((r) => r.path)).toEqual(['/r/basanti', '/r/new']);
  });

  it('keeps a row a person also used, even if agents used it more', () => {
    const kept = dropAgentOnlyRepos(rows, keyOf, [
      { repoPath: '/bench/oc/KIT', createdBy: 'mcp' },
      { repoPath: '/bench/pi/KIT', createdBy: 'ui' },
    ]);
    expect(kept.map((r) => r.path)).toContain('/bench/oc/KIT');
  });

  it('keeps a row with no known sessions at all', () => {
    expect(dropAgentOnlyRepos(rows, keyOf, [])).toHaveLength(3);
  });
});
