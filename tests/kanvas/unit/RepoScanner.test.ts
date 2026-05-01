/**
 * Unit Tests for A2 — Recursive repo scanner
 *
 * `scanForRepos` is pure: the caller injects `listChildren`, so we test the
 * walk semantics (depth, skip globs, repo detection) without touching disk.
 */

import { describe, it, expect } from '@jest/globals';
import { scanForRepos, shouldSkipDir, type DirChild, type ScanInputs } from '../../../shared/repo-scanner';

/** Build a `listChildren` callback from a flat `path → children[]` map. */
function fakeFs(tree: Record<string, DirChild[]>): ScanInputs['listChildren'] {
  return async (dir: string) => tree[dir] ?? [];
}

const dir = (name: string): DirChild => ({ name, isDirectory: true });
const file = (name: string): DirChild => ({ name, isDirectory: false });

describe('shouldSkipDir (A2)', () => {
  it('skips exact-match basenames', () => {
    expect(shouldSkipDir('node_modules', ['node_modules', '.git'])).toBe(true);
    expect(shouldSkipDir('src', ['node_modules'])).toBe(false);
  });
});

describe('scanForRepos (A2)', () => {
  it('finds a single repo at the workspace root (depth 0)', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 2,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [file('.git'), dir('src')],
      }),
    });
    expect(found).toEqual([{ path: '/work', name: 'work', depth: 0 }]);
  });

  it('does not recurse into a found repo', async () => {
    // /work is a repo. /work/sub is also a repo — but we should NOT find it,
    // because we stop descent once a repo is identified.
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 5,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [file('.git'), dir('sub')],
        '/work/sub': [file('.git')],
      }),
    });
    expect(found.map((r) => r.path)).toEqual(['/work']);
  });

  it('respects maxDepth (default 2 in A1)', async () => {
    // /work/a/b/c is a repo at depth 3 — outside maxDepth=2.
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 2,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [dir('a')],
        '/work/a': [dir('b')],
        '/work/a/b': [dir('c')],
        '/work/a/b/c': [file('.git')],
      }),
    });
    expect(found).toEqual([]);
  });

  it('finds repos at intermediate depths', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 3,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [dir('repo-a'), dir('repo-b')],
        '/work/repo-a': [file('.git')],
        '/work/repo-b': [file('.git')],
      }),
    });
    expect(found.map((r) => r.path).sort()).toEqual(['/work/repo-a', '/work/repo-b']);
    expect(found.every((r) => r.depth === 1)).toBe(true);
  });

  it('skips ignored directories (node_modules, .worktrees, etc.)', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 3,
      ignoreGlobs: ['node_modules', '.worktrees'],
      listChildren: fakeFs({
        '/work': [dir('node_modules'), dir('.worktrees'), dir('mine')],
        '/work/node_modules': [dir('faker'), file('.git')], // would match if not skipped
        '/work/.worktrees': [dir('feat-x'), file('.git')],
        '/work/mine': [file('.git')],
      }),
    });
    expect(found.map((r) => r.path)).toEqual(['/work/mine']);
  });

  it('handles permission errors / unreadable dirs gracefully (no throw)', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 2,
      ignoreGlobs: [],
      listChildren: async (path: string) => {
        if (path === '/work/secret') throw new Error('EACCES');
        if (path === '/work') return [dir('secret'), dir('open')];
        if (path === '/work/open') return [file('.git')];
        return [];
      },
    });
    expect(found.map((r) => r.path)).toEqual(['/work/open']);
  });

  it('returns results sorted by depth then path', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 4,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [dir('z'), dir('a')],
        '/work/z': [file('.git')],
        '/work/a': [dir('inner')],
        '/work/a/inner': [file('.git')],
      }),
    });
    // depth 1 entries come before depth 2; alphabetical within same depth
    expect(found).toEqual([
      { path: '/work/z', name: 'z', depth: 1 },
      { path: '/work/a/inner', name: 'inner', depth: 2 },
    ]);
  });

  it('returns no repos when the workspace is empty', async () => {
    const found = await scanForRepos({
      root: '/empty',
      maxDepth: 2,
      ignoreGlobs: [],
      listChildren: fakeFs({}),
    });
    expect(found).toEqual([]);
  });

  it('does not consider regular files as directories to traverse', async () => {
    const found = await scanForRepos({
      root: '/work',
      maxDepth: 3,
      ignoreGlobs: [],
      listChildren: fakeFs({
        '/work': [file('README.md'), dir('repo')],
        '/work/repo': [file('.git')],
      }),
    });
    expect(found.map((r) => r.path)).toEqual(['/work/repo']);
  });
});
