/**
 * WorkspaceService (Epic A / story A1)
 *
 * CRUD + persistence for user-defined workspace folders. Scanning (A2),
 * filesystem watching (A3), and the renderer UI (A4/A5) layer on top.
 *
 * Persistence is its own electron-store (`kanvas-workspaces`) so the schema
 * is isolated from existing app config.
 */

import Store from 'electron-store';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { BaseService } from './BaseService';
import type {
  Workspace,
  WorkspaceCreateInput,
  WorkspaceUpdateInput,
  WorkspaceScanResult,
  DiscoveredRepo,
  IpcResult,
} from '../../shared/types';
import {
  applyWorkspaceUpdate,
  buildWorkspace,
  validateWorkspaceCreate,
  WORKSPACE_ERRORS,
} from '../../shared/workspace-helpers';
import { scanForRepos, type DirChild } from '../../shared/repo-scanner';

interface StoreSchema {
  workspaces: Workspace[];
  /** id of the currently-active workspace (UI). */
  activeWorkspaceId: string | null;
}

export class WorkspaceService extends BaseService {
  private store: Store<StoreSchema>;

  constructor() {
    super();
    this.store = new Store<StoreSchema>({
      name: 'kanvas-workspaces',
      defaults: {
        workspaces: [],
        activeWorkspaceId: null,
      },
    });
  }

  list(): IpcResult<Workspace[]> {
    return this.success(this.store.get('workspaces'));
  }

  get(id: string): IpcResult<Workspace> {
    const ws = this.store.get('workspaces').find((w) => w.id === id);
    if (!ws) {
      return this.error(WORKSPACE_ERRORS.NOT_FOUND, `Workspace ${id} not found`);
    }
    return this.success(ws);
  }

  add(input: WorkspaceCreateInput): IpcResult<Workspace> {
    const existing = this.store.get('workspaces');
    const violation = validateWorkspaceCreate(input, existing);
    if (violation) return this.error(violation.code, violation.message);

    const ws = buildWorkspace(input);
    this.store.set('workspaces', [...existing, ws]);

    // First workspace ever? Make it active.
    if (this.store.get('activeWorkspaceId') === null) {
      this.store.set('activeWorkspaceId', ws.id);
    }
    return this.success(ws);
  }

  update(id: string, patch: WorkspaceUpdateInput): IpcResult<Workspace> {
    const repos = this.store.get('workspaces');
    const idx = repos.findIndex((w) => w.id === id);
    if (idx === -1) {
      return this.error(WORKSPACE_ERRORS.NOT_FOUND, `Workspace ${id} not found`);
    }
    if (patch.scanDepth !== undefined && (!Number.isInteger(patch.scanDepth) || patch.scanDepth < 0 || patch.scanDepth > 10)) {
      return this.error(WORKSPACE_ERRORS.INVALID_DEPTH, 'scanDepth must be an integer between 0 and 10.');
    }
    const updated = applyWorkspaceUpdate(repos[idx], patch);
    const next = [...repos];
    next[idx] = updated;
    this.store.set('workspaces', next);
    return this.success(updated);
  }

  remove(id: string): IpcResult<void> {
    const repos = this.store.get('workspaces');
    if (!repos.some((w) => w.id === id)) {
      return this.error(WORKSPACE_ERRORS.NOT_FOUND, `Workspace ${id} not found`);
    }
    this.store.set('workspaces', repos.filter((w) => w.id !== id));

    // If we just removed the active one, pick another (or null).
    if (this.store.get('activeWorkspaceId') === id) {
      const remaining = this.store.get('workspaces');
      this.store.set('activeWorkspaceId', remaining[0]?.id ?? null);
    }
    return this.success(undefined);
  }

  getActive(): IpcResult<Workspace | null> {
    const id = this.store.get('activeWorkspaceId');
    if (!id) return this.success(null);
    const ws = this.store.get('workspaces').find((w) => w.id === id) ?? null;
    return this.success(ws);
  }

  setActive(id: string | null): IpcResult<void> {
    if (id !== null) {
      const exists = this.store.get('workspaces').some((w) => w.id === id);
      if (!exists) return this.error(WORKSPACE_ERRORS.NOT_FOUND, `Workspace ${id} not found`);
    }
    this.store.set('activeWorkspaceId', id);
    return this.success(undefined);
  }

  /** Internal: record the most-recent successful scan timestamp. Used by A2. */
  markScanned(id: string): void {
    const repos = this.store.get('workspaces');
    const idx = repos.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const next = [...repos];
    next[idx] = { ...next[idx], lastScannedAt: new Date().toISOString() };
    this.store.set('workspaces', next);
  }

  /**
   * Recursively scan a workspace for Git repositories.
   * (Epic A / story A2.)
   *
   * Honors the workspace's `scanDepth` and `ignoreGlobs`. Found repos are
   * returned and the workspace's `lastScannedAt` is bumped.
   */
  async scan(id: string): Promise<IpcResult<WorkspaceScanResult>> {
    const list = this.store.get('workspaces');
    const ws = list.find((w) => w.id === id);
    if (!ws) return this.error(WORKSPACE_ERRORS.NOT_FOUND, `Workspace ${id} not found`);

    const start = Date.now();
    const found = await scanForRepos({
      root: ws.path,
      maxDepth: ws.scanDepth,
      ignoreGlobs: ws.ignoreGlobs,
      listChildren: async (absDir: string): Promise<DirChild[]> => {
        try {
          const entries = await readdir(absDir, { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch {
          return [];
        }
      },
      joinPath: join,
    });
    const scannedAt = new Date().toISOString();
    const durationMs = Date.now() - start;
    this.markScanned(id);

    const repos: DiscoveredRepo[] = found.map((r) => ({
      workspaceId: id,
      path: r.path,
      name: r.name,
      depth: r.depth,
      discoveredAt: scannedAt,
    }));

    return this.success({
      workspaceId: id,
      scannedAt,
      durationMs,
      repoCount: repos.length,
      repos,
    });
  }
}
