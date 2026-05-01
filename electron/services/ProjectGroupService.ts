/**
 * ProjectGroupService (Epic F / story F1)
 *
 * CRUD + persistence for user-defined cross-repo Project Groups
 * (e.g. "Core Stack" = Kora + Backend + Kanvas + AI_Backend).
 */

import Store from 'electron-store';
import { BaseService } from './BaseService';
import type {
  IpcResult,
  ProjectGroup,
  ProjectGroupCreateInput,
  ProjectGroupUpdateInput,
} from '../../shared/types';
import {
  buildProjectGroup,
  normalizeRepoPaths,
  PROJECT_GROUP_ERRORS,
  validateProjectGroupCreate,
} from '../../shared/project-group-helpers';

interface StoreSchema {
  groups: ProjectGroup[];
}

export class ProjectGroupService extends BaseService {
  private store: Store<StoreSchema>;

  constructor() {
    super();
    this.store = new Store<StoreSchema>({
      name: 'kanvas-project-groups',
      defaults: { groups: [] },
    });
  }

  list(): IpcResult<ProjectGroup[]> {
    return this.success(this.store.get('groups'));
  }

  get(id: string): IpcResult<ProjectGroup> {
    const g = this.store.get('groups').find((x) => x.id === id);
    if (!g) return this.error(PROJECT_GROUP_ERRORS.NOT_FOUND, `Project group ${id} not found`);
    return this.success(g);
  }

  add(input: ProjectGroupCreateInput): IpcResult<ProjectGroup> {
    const existing = this.store.get('groups');
    const violation = validateProjectGroupCreate(input, existing);
    if (violation) return this.error(violation.code, violation.message);
    const g = buildProjectGroup(input);
    this.store.set('groups', [...existing, g]);
    return this.success(g);
  }

  update(id: string, patch: ProjectGroupUpdateInput): IpcResult<ProjectGroup> {
    const groups = this.store.get('groups');
    const idx = groups.findIndex((g) => g.id === id);
    if (idx === -1) return this.error(PROJECT_GROUP_ERRORS.NOT_FOUND, `Project group ${id} not found`);

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) return this.error(PROJECT_GROUP_ERRORS.EMPTY_NAME, 'Project group name is required.');
      const conflict = groups.find(
        (g) => g.id !== id && g.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (conflict) {
        return this.error(
          PROJECT_GROUP_ERRORS.DUPLICATE_NAME,
          `A project group named "${conflict.name}" already exists.`
        );
      }
    }

    let normalizedPaths: string[] | undefined;
    if (patch.repoPaths !== undefined) {
      normalizedPaths = normalizeRepoPaths(patch.repoPaths);
      if (normalizedPaths.length === 0) {
        return this.error(
          PROJECT_GROUP_ERRORS.EMPTY_REPOS,
          'A project group must contain at least one repo.'
        );
      }
    }

    const next: ProjectGroup = {
      ...groups[idx],
      name: patch.name?.trim() || groups[idx].name,
      repoPaths: normalizedPaths ?? groups[idx].repoPaths,
      color: patch.color !== undefined ? patch.color : groups[idx].color,
      updatedAt: new Date().toISOString(),
    };
    const arr = [...groups];
    arr[idx] = next;
    this.store.set('groups', arr);
    return this.success(next);
  }

  remove(id: string): IpcResult<void> {
    const groups = this.store.get('groups');
    if (!groups.some((g) => g.id === id)) {
      return this.error(PROJECT_GROUP_ERRORS.NOT_FOUND, `Project group ${id} not found`);
    }
    this.store.set('groups', groups.filter((g) => g.id !== id));
    return this.success(undefined);
  }
}
