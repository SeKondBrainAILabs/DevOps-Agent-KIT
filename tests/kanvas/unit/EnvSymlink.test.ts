/**
 * Unit Tests for C6 — .env symlink to worktree on session start
 *
 * Tests the pure planner. fs execution is the service's job.
 */

import { describe, it, expect } from '@jest/globals';
import {
  planEnvSymlink,
  MISSING_ENV_ERROR_CODE,
} from '../../../shared/env-symlink-plan';

describe('planEnvSymlink (C6)', () => {
  const baseRepo = '/repos/foo';
  const baseTree = '/repos/foo/local_deploy/feat-x';

  it('skips when in-place mode (worktreePath === repoPath)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseRepo,
      repoEnvExists: true,
      worktreeEnvExists: false,
    });
    expect(action.kind).toBe('skip-in-place');
  });

  it('skips when worktree already has its own .env (no overwrite)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: true,
      worktreeEnvExists: true,
    });
    expect(action.kind).toBe('skip-already-exists');
  });

  it('blocks session start when main repo has no .env (default behavior)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: false,
      worktreeEnvExists: false,
    });
    expect(action.kind).toBe('block-missing-env');
    if (action.kind === 'block-missing-env') {
      expect(action.error.code).toBe(MISSING_ENV_ERROR_CODE);
      expect(action.error.message).toMatch(/No \.env file/);
    }
  });

  it('honors allowMissingEnv override when main repo has no .env', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: false,
      worktreeEnvExists: false,
      allowMissingEnv: true,
    });
    expect(action.kind).toBe('allow-missing-env-override');
  });

  it('plans a symlink from repo .env → worktree .env (happy path)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: true,
      worktreeEnvExists: false,
    });
    expect(action.kind).toBe('create-symlink');
    if (action.kind === 'create-symlink') {
      expect(action.from).toBe('/repos/foo/.env');
      expect(action.to).toBe('/repos/foo/local_deploy/feat-x/.env');
    }
  });

  it('block-missing-env wins over allowMissingEnv=false (explicit)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: false,
      worktreeEnvExists: false,
      allowMissingEnv: false,
    });
    expect(action.kind).toBe('block-missing-env');
  });

  it('skip-already-exists wins over missing-repo-env (we do not block on a worktree with its own .env)', () => {
    const action = planEnvSymlink({
      repoPath: baseRepo,
      worktreePath: baseTree,
      repoEnvExists: false,
      worktreeEnvExists: true,
    });
    expect(action.kind).toBe('skip-already-exists');
  });
});
