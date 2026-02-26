/**
 * Multi-Repo Support Unit Tests
 *
 * Tests the multi-repo types, session binder, GitService compound keys,
 * and MCP tool routing with `repo` parameter.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { generateSecondaryBranchName } from '../../../shared/types';
import type { RepoEntry, MultiRepoConfig } from '../../../shared/types';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// ==========================================================================
// generateSecondaryBranchName
// ==========================================================================
describe('generateSecondaryBranchName', () => {
  it('should generate branch name in correct format', () => {
    const date = new Date(2026, 1, 26); // Feb 26, 2026
    const result = generateSecondaryBranchName('DevOpsAgent', date);
    expect(result).toBe('From_DevOpsAgent_260226');
  });

  it('should pad single-digit day and month', () => {
    const date = new Date(2026, 0, 5); // Jan 5, 2026
    const result = generateSecondaryBranchName('MyApp', date);
    expect(result).toBe('From_MyApp_050126');
  });

  it('should use current date when no date provided', () => {
    const result = generateSecondaryBranchName('Repo');
    expect(result).toMatch(/^From_Repo_\d{6}$/);
  });

  it('should handle repo names with special characters', () => {
    const date = new Date(2026, 5, 15);
    const result = generateSecondaryBranchName('my-awesome-lib', date);
    expect(result).toBe('From_my-awesome-lib_150626');
  });
});

// ==========================================================================
// MultiRepoConfig type structure
// ==========================================================================
describe('MultiRepoConfig type', () => {
  it('should construct a valid MultiRepoConfig', () => {
    const primary: RepoEntry = {
      repoPath: '/repos/main-app',
      repoName: 'main-app',
      branchName: 'feat/my-feature',
      baseBranch: 'main',
      worktreePath: '/repos/main-app/local_deploy/feat/my-feature',
      role: 'primary',
      isSubmodule: false,
    };

    const secondary: RepoEntry = {
      repoPath: 'libs/shared',
      repoName: 'shared',
      branchName: 'From_main-app_260226',
      baseBranch: 'main',
      worktreePath: '/repos/main-app/local_deploy/feat/my-feature/libs/shared',
      role: 'secondary',
      isSubmodule: true,
    };

    const config: MultiRepoConfig = {
      primaryRepo: primary,
      secondaryRepos: [secondary],
      commitScope: 'all',
    };

    expect(config.primaryRepo.role).toBe('primary');
    expect(config.secondaryRepos).toHaveLength(1);
    expect(config.secondaryRepos[0].isSubmodule).toBe(true);
    expect(config.commitScope).toBe('all');
  });
});

// ==========================================================================
// Session Binder multi-repo resolution
// ==========================================================================
describe('Session Binder multi-repo resolution', () => {
  let binder: McpSessionBinder;

  beforeEach(() => {
    binder = new McpSessionBinder();
  });

  it('should register multi-repo session and resolve paths', () => {
    binder.registerMultiRepoSession('sess_multi', [
      { repoName: 'app', worktreePath: '/wt/app', role: 'primary' },
      { repoName: 'lib', worktreePath: '/wt/app/libs/lib', role: 'secondary' },
    ]);

    // Default (no repo) returns primary
    expect(binder.getWorktreePathForRepo('sess_multi')).toBe('/wt/app');
    // Specific repo resolves correctly
    expect(binder.getWorktreePathForRepo('sess_multi', 'app')).toBe('/wt/app');
    expect(binder.getWorktreePathForRepo('sess_multi', 'lib')).toBe('/wt/app/libs/lib');
  });

  it('should return undefined for unknown repo name', () => {
    binder.registerMultiRepoSession('sess_multi', [
      { repoName: 'app', worktreePath: '/wt/app', role: 'primary' },
    ]);

    expect(binder.getWorktreePathForRepo('sess_multi', 'nonexistent')).toBeUndefined();
  });

  it('should return undefined for unknown session', () => {
    expect(binder.getWorktreePathForRepo('unknown_sess')).toBeUndefined();
    expect(binder.getWorktreePathForRepo('unknown_sess', 'repo')).toBeUndefined();
  });

  it('should list all repos for a multi-repo session', () => {
    binder.registerMultiRepoSession('sess_multi', [
      { repoName: 'app', worktreePath: '/wt/app', role: 'primary' },
      { repoName: 'lib-a', worktreePath: '/wt/app/libs/a', role: 'secondary' },
      { repoName: 'lib-b', worktreePath: '/wt/app/libs/b', role: 'secondary' },
    ]);

    const repos = binder.getReposForSession('sess_multi');
    expect(repos).toHaveLength(3);
    expect(repos.map(r => r.repoName)).toEqual(['app', 'lib-a', 'lib-b']);
  });

  it('should return single-element array for single-repo sessions', () => {
    binder.registerSession('sess_single', '/wt/single');

    const repos = binder.getReposForSession('sess_single');
    expect(repos).toHaveLength(1);
    expect(repos[0].repoName).toBe('primary');
  });

  it('should return empty array for unknown session', () => {
    expect(binder.getReposForSession('unknown')).toEqual([]);
  });

  it('should maintain backward compat - single-repo getWorktreePath still works', () => {
    binder.registerSession('sess_single', '/wt/single');

    expect(binder.getWorktreePath('sess_single')).toBe('/wt/single');
    expect(binder.getWorktreePathForRepo('sess_single')).toBe('/wt/single');
    expect(binder.getWorktreePathForRepo('sess_single', undefined)).toBe('/wt/single');
  });

  it('should clear multi-repo sessions on clear()', () => {
    binder.registerMultiRepoSession('sess_multi', [
      { repoName: 'app', worktreePath: '/wt/app', role: 'primary' },
    ]);

    binder.clear();
    expect(binder.getSession('sess_multi')).toBeUndefined();
    expect(binder.getReposForSession('sess_multi')).toEqual([]);
  });
});

// ==========================================================================
// Cross-repo isolation
// ==========================================================================
describe('Multi-repo session isolation', () => {
  let binder: McpSessionBinder;

  beforeEach(() => {
    binder = new McpSessionBinder();
  });

  it('should keep sessions independent', () => {
    binder.registerMultiRepoSession('sess_a', [
      { repoName: 'app', worktreePath: '/wt-a/app', role: 'primary' },
      { repoName: 'lib', worktreePath: '/wt-a/lib', role: 'secondary' },
    ]);

    binder.registerMultiRepoSession('sess_b', [
      { repoName: 'app', worktreePath: '/wt-b/app', role: 'primary' },
    ]);

    // Same repo name, different sessions = different paths
    expect(binder.getWorktreePathForRepo('sess_a', 'app')).toBe('/wt-a/app');
    expect(binder.getWorktreePathForRepo('sess_b', 'app')).toBe('/wt-b/app');

    // Session A has 'lib', Session B doesn't
    expect(binder.getWorktreePathForRepo('sess_a', 'lib')).toBe('/wt-a/lib');
    expect(binder.getWorktreePathForRepo('sess_b', 'lib')).toBeUndefined();
  });

  it('should unregister only the target session', () => {
    binder.registerMultiRepoSession('sess_a', [
      { repoName: 'app', worktreePath: '/wt-a/app', role: 'primary' },
    ]);
    binder.registerMultiRepoSession('sess_b', [
      { repoName: 'app', worktreePath: '/wt-b/app', role: 'primary' },
    ]);

    binder.unregisterSession('sess_a');

    expect(binder.getSession('sess_a')).toBeUndefined();
    expect(binder.getSession('sess_b')).toBeDefined();
    expect(binder.getWorktreePathForRepo('sess_b', 'app')).toBe('/wt-b/app');
  });
});
