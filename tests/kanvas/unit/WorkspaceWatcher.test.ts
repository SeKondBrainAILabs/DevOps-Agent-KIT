/**
 * Unit Tests for A3 — Workspace filesystem watcher event classifier
 *
 * The pure classifier decides whether a chokidar raw event should produce
 * a `repo-added` / `repo-removed` notification. Service-level chokidar
 * wiring is integration territory; these tests cover the rule logic.
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyWatcherEvent,
  depthFromRoot,
  repoRootFromGitPath,
} from '../../../shared/workspace-watcher-events';

describe('repoRootFromGitPath (A3)', () => {
  it('returns parent when path ends in /.git', () => {
    expect(repoRootFromGitPath('/work/foo/.git')).toBe('/work/foo');
  });
  it('returns parent when path is inside /.git/...', () => {
    expect(repoRootFromGitPath('/work/foo/.git/HEAD')).toBe('/work/foo');
    expect(repoRootFromGitPath('/work/foo/.git/refs/heads/main')).toBe('/work/foo');
  });
  it('returns null when path does not involve .git', () => {
    expect(repoRootFromGitPath('/work/foo/src/index.ts')).toBe(null);
    expect(repoRootFromGitPath('/work/foo/.gitignore')).toBe(null);
  });
});

describe('depthFromRoot (A3)', () => {
  it('returns 0 for the workspace root itself', () => {
    expect(depthFromRoot('/work', '/work')).toBe(-1); // not a child
    expect(depthFromRoot('/work', '/work/foo')).toBe(1);
    expect(depthFromRoot('/work', '/work/foo/bar')).toBe(2);
  });
  it('handles trailing slashes on the root', () => {
    expect(depthFromRoot('/work/', '/work/foo')).toBe(1);
  });
  it('returns -1 when path is outside the root', () => {
    expect(depthFromRoot('/work', '/elsewhere/foo')).toBe(-1);
  });
});

describe('classifyWatcherEvent (A3)', () => {
  const opts = { workspaceRoot: '/work', maxDepth: 2 };

  it('repo-added on addDir of /work/repo/.git', () => {
    const r = classifyWatcherEvent('addDir', '/work/repo/.git', opts);
    expect(r.kind).toBe('repo-added');
    expect(r.repoPath).toBe('/work/repo');
    expect(r.depth).toBe(1);
  });

  it('repo-added on add of /work/repo/.git/HEAD (initial git init signal)', () => {
    const r = classifyWatcherEvent('add', '/work/repo/.git/HEAD', opts);
    expect(r.kind).toBe('repo-added');
    expect(r.repoPath).toBe('/work/repo');
  });

  it('repo-removed on unlinkDir of /work/repo/.git', () => {
    const r = classifyWatcherEvent('unlinkDir', '/work/repo/.git', opts);
    expect(r.kind).toBe('repo-removed');
    expect(r.repoPath).toBe('/work/repo');
  });

  it('irrelevant on change inside .git/ (avoid event floods)', () => {
    const r = classifyWatcherEvent('change', '/work/repo/.git/HEAD', opts);
    expect(r.kind).toBe('irrelevant');
  });

  it('irrelevant on unlink of single file inside .git', () => {
    const r = classifyWatcherEvent('unlink', '/work/repo/.git/index.lock', opts);
    expect(r.kind).toBe('irrelevant');
  });

  it('irrelevant on add of a non-.git path', () => {
    const r = classifyWatcherEvent('add', '/work/repo/src/index.ts', opts);
    expect(r.kind).toBe('irrelevant');
  });

  it('irrelevant when repo is outside the workspace root', () => {
    const r = classifyWatcherEvent('addDir', '/elsewhere/repo/.git', opts);
    expect(r.kind).toBe('irrelevant');
  });

  it('irrelevant when repo is deeper than maxDepth', () => {
    const r = classifyWatcherEvent('addDir', '/work/a/b/c/.git', opts);
    expect(r.kind).toBe('irrelevant'); // depth=3, maxDepth=2
  });

  it('respects a deeper maxDepth', () => {
    const r = classifyWatcherEvent('addDir', '/work/a/b/c/.git', {
      workspaceRoot: '/work',
      maxDepth: 3,
    });
    expect(r.kind).toBe('repo-added');
    expect(r.repoPath).toBe('/work/a/b/c');
  });
});
