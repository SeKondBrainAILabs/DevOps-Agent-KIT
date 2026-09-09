/**
 * Pure helpers for WorkspaceService (Epic A / story A1).
 *
 * Anything fs- or electron-store-dependent stays in the service; the rules
 * for naming, defaults, validation, dedup, and update-merging live here so
 * they can be unit-tested without booting Electron.
 */

import type { Workspace, WorkspaceCreateInput, WorkspaceUpdateInput } from './types';

/** Default skip globs honored by the recursive scanner (A2). */
export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'build',
];

export const DEFAULT_SCAN_DEPTH = 2;

export const WORKSPACE_ERRORS = {
  EMPTY_PATH: 'WORKSPACE_PATH_EMPTY',
  DUPLICATE_PATH: 'WORKSPACE_DUPLICATE_PATH',
  NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  INVALID_DEPTH: 'WORKSPACE_INVALID_DEPTH',
} as const;

/** Normalize a filesystem path: trim trailing slashes (except root), trim whitespace. */
export function normalizeWorkspacePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, '');
}

/** Pick the basename — last segment of the path — as a default name. */
export function defaultWorkspaceName(p: string): string {
  const norm = normalizeWorkspacePath(p);
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : norm;
}

/** Generate a stable workspace ID. */
export function generateWorkspaceId(now: () => number = Date.now): string {
  return `ws_${now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Validation: returns null on success, or `{code, message}` on failure. */
export function validateWorkspaceCreate(
  input: WorkspaceCreateInput,
  existing: ReadonlyArray<Workspace>
): { code: string; message: string } | null {
  const path = normalizeWorkspacePath(input.path ?? '');
  if (!path) {
    return { code: WORKSPACE_ERRORS.EMPTY_PATH, message: 'Workspace path cannot be empty.' };
  }
  if (existing.some((w) => normalizeWorkspacePath(w.path) === path)) {
    return {
      code: WORKSPACE_ERRORS.DUPLICATE_PATH,
      message: `A workspace already exists for "${path}".`,
    };
  }
  if (input.scanDepth !== undefined && (!Number.isInteger(input.scanDepth) || input.scanDepth < 0 || input.scanDepth > 10)) {
    return {
      code: WORKSPACE_ERRORS.INVALID_DEPTH,
      message: 'scanDepth must be an integer between 0 and 10.',
    };
  }
  return null;
}

/** Build a fully-defaulted workspace from create input. */
export function buildWorkspace(
  input: WorkspaceCreateInput,
  opts: { id?: string; createdAt?: string } = {}
): Workspace {
  const path = normalizeWorkspacePath(input.path);
  return {
    id: opts.id ?? generateWorkspaceId(),
    name: (input.name && input.name.trim()) || defaultWorkspaceName(path),
    path,
    scanDepth: input.scanDepth ?? DEFAULT_SCAN_DEPTH,
    ignoreGlobs:
      input.ignoreGlobs && input.ignoreGlobs.length > 0
        ? input.ignoreGlobs
        : [...DEFAULT_IGNORE_GLOBS],
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** Apply an update patch in-place-ish (returns a new object). */
export function applyWorkspaceUpdate(ws: Workspace, patch: WorkspaceUpdateInput): Workspace {
  return {
    ...ws,
    name: patch.name?.trim() || ws.name,
    scanDepth: patch.scanDepth !== undefined ? patch.scanDepth : ws.scanDepth,
    ignoreGlobs: patch.ignoreGlobs ?? ws.ignoreGlobs,
  };
}
