/**
 * Unit Tests for A1 — WorkspaceService backend
 *
 * Tests the pure helpers + the renderer-facing IPC contract. Service
 * internals depend on electron-store, which doesn't compile cleanly under
 * ts-jest in this project — so we verify the rules where they're written
 * (helpers) and the API surface where the renderer consumes it (mockApi).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  applyWorkspaceUpdate,
  buildWorkspace,
  defaultWorkspaceName,
  generateWorkspaceId,
  normalizeWorkspacePath,
  validateWorkspaceCreate,
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_SCAN_DEPTH,
  WORKSPACE_ERRORS,
} from '../../../shared/workspace-helpers';
import type { Workspace } from '../../../shared/types';
import { mockApi } from '../setup';

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('normalizeWorkspacePath (A1)', () => {
  it('trims trailing slashes', () => {
    expect(normalizeWorkspacePath('/a/b/')).toBe('/a/b');
    expect(normalizeWorkspacePath('/a/b///')).toBe('/a/b');
  });
  it('preserves root', () => {
    expect(normalizeWorkspacePath('/')).toBe('/');
  });
  it('trims whitespace', () => {
    expect(normalizeWorkspacePath('  /a/b  ')).toBe('/a/b');
  });
});

describe('defaultWorkspaceName (A1)', () => {
  it('uses the basename', () => {
    expect(defaultWorkspaceName('/users/x/work')).toBe('work');
    expect(defaultWorkspaceName('/users/x/work/')).toBe('work');
  });
  it('falls back to the path itself for root-like inputs', () => {
    expect(defaultWorkspaceName('/')).toBe('/');
  });
});

describe('generateWorkspaceId (A1)', () => {
  it('produces ws_-prefixed ids', () => {
    const id = generateWorkspaceId();
    expect(id.startsWith('ws_')).toBe(true);
  });
  it('produces unique ids on consecutive calls', () => {
    const ids = new Set([generateWorkspaceId(), generateWorkspaceId(), generateWorkspaceId()]);
    expect(ids.size).toBe(3);
  });
});

describe('validateWorkspaceCreate (A1)', () => {
  const existing: Workspace[] = [];

  it('rejects empty path', () => {
    expect(validateWorkspaceCreate({ path: '' }, existing)?.code).toBe(WORKSPACE_ERRORS.EMPTY_PATH);
    expect(validateWorkspaceCreate({ path: '   ' }, existing)?.code).toBe(WORKSPACE_ERRORS.EMPTY_PATH);
  });

  it('rejects duplicate path (after normalization)', () => {
    const ws: Workspace[] = [
      buildWorkspace({ path: '/users/x/work' }),
    ];
    const err = validateWorkspaceCreate({ path: '/users/x/work/' }, ws);
    expect(err?.code).toBe(WORKSPACE_ERRORS.DUPLICATE_PATH);
  });

  it('rejects out-of-range scanDepth', () => {
    expect(validateWorkspaceCreate({ path: '/a', scanDepth: -1 }, existing)?.code).toBe(WORKSPACE_ERRORS.INVALID_DEPTH);
    expect(validateWorkspaceCreate({ path: '/a', scanDepth: 11 }, existing)?.code).toBe(WORKSPACE_ERRORS.INVALID_DEPTH);
    expect(validateWorkspaceCreate({ path: '/a', scanDepth: 1.5 }, existing)?.code).toBe(WORKSPACE_ERRORS.INVALID_DEPTH);
  });

  it('passes for a valid input', () => {
    expect(validateWorkspaceCreate({ path: '/a', scanDepth: 2 }, existing)).toBeNull();
  });
});

describe('buildWorkspace (A1)', () => {
  it('applies defaults: scanDepth, ignoreGlobs, name from basename', () => {
    const ws = buildWorkspace({ path: '/users/x/work' });
    expect(ws.path).toBe('/users/x/work');
    expect(ws.name).toBe('work');
    expect(ws.scanDepth).toBe(DEFAULT_SCAN_DEPTH);
    expect(ws.ignoreGlobs).toEqual([...DEFAULT_IGNORE_GLOBS]);
    expect(ws.id.startsWith('ws_')).toBe(true);
    expect(ws.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honors overrides', () => {
    const ws = buildWorkspace({
      path: '/work/',
      name: 'My Stuff',
      scanDepth: 4,
      ignoreGlobs: ['custom-skip'],
    });
    expect(ws.path).toBe('/work');
    expect(ws.name).toBe('My Stuff');
    expect(ws.scanDepth).toBe(4);
    expect(ws.ignoreGlobs).toEqual(['custom-skip']);
  });

  it('falls back to basename for empty/whitespace name override', () => {
    const ws = buildWorkspace({ path: '/work/personal', name: '   ' });
    expect(ws.name).toBe('personal');
  });
});

describe('applyWorkspaceUpdate (A1)', () => {
  let base: Workspace;
  beforeEach(() => {
    base = buildWorkspace({ path: '/work' });
  });

  it('updates name when patch.name is non-empty', () => {
    expect(applyWorkspaceUpdate(base, { name: 'Renamed' }).name).toBe('Renamed');
  });

  it('keeps existing name when patch.name is empty/whitespace', () => {
    expect(applyWorkspaceUpdate(base, { name: '   ' }).name).toBe(base.name);
  });

  it('updates scanDepth and ignoreGlobs independently', () => {
    const updated = applyWorkspaceUpdate(base, { scanDepth: 5 });
    expect(updated.scanDepth).toBe(5);
    expect(updated.ignoreGlobs).toBe(base.ignoreGlobs);
  });

  it('does not mutate the original', () => {
    applyWorkspaceUpdate(base, { name: 'X', scanDepth: 9 });
    expect(base.name).toBe('work');
    expect(base.scanDepth).toBe(DEFAULT_SCAN_DEPTH);
  });
});

// ─── Renderer IPC contract ───────────────────────────────────────────────────

describe('window.api.workspace — IPC contract (A1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes the full CRUD + active surface', () => {
    expect(window.api.workspace).toBeDefined();
    for (const fn of ['list', 'get', 'add', 'update', 'remove', 'getActive', 'setActive'] as const) {
      expect(typeof window.api.workspace[fn]).toBe('function');
    }
  });

  it('add() forwards the input payload', async () => {
    await window.api.workspace.add({ path: '/work', name: 'Work' });
    expect(mockApi.workspace.add).toHaveBeenCalledWith({ path: '/work', name: 'Work' });
  });

  it('update() forwards id + patch', async () => {
    await window.api.workspace.update('ws_1', { name: 'X', scanDepth: 3 });
    expect(mockApi.workspace.update).toHaveBeenCalledWith('ws_1', { name: 'X', scanDepth: 3 });
  });

  it('remove() forwards the id', async () => {
    await window.api.workspace.remove('ws_2');
    expect(mockApi.workspace.remove).toHaveBeenCalledWith('ws_2');
  });

  it('setActive() accepts null to clear', async () => {
    await window.api.workspace.setActive(null);
    expect(mockApi.workspace.setActive).toHaveBeenCalledWith(null);
  });
});
