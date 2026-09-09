/**
 * Unit Tests for F1 — Project Group entity + helpers + IPC contract
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  PROJECT_GROUP_ERRORS,
  buildProjectGroup,
  generateProjectGroupId,
  normalizeRepoPaths,
  reposSharedAcrossGroups,
  validateProjectGroupCreate,
} from '../../../shared/project-group-helpers';
import type { ProjectGroup } from '../../../shared/types';
import { mockApi } from '../setup';

describe('normalizeRepoPaths (F1)', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeRepoPaths(['  /a/b  ', '/c/d/'])).toEqual(['/a/b', '/c/d']);
  });
  it('dedupes (after normalization), preserves first-occurrence order', () => {
    expect(normalizeRepoPaths(['/a', '/b', '/a/', ' /b ', '/c'])).toEqual(['/a', '/b', '/c']);
  });
  it('drops empty strings', () => {
    expect(normalizeRepoPaths(['', '   ', '/a'])).toEqual(['/a']);
  });
});

describe('generateProjectGroupId (F1)', () => {
  it('produces pg_-prefixed unique ids', () => {
    const ids = new Set([generateProjectGroupId(), generateProjectGroupId(), generateProjectGroupId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.startsWith('pg_')).toBe(true);
  });
});

describe('validateProjectGroupCreate (F1)', () => {
  it('rejects empty name', () => {
    expect(validateProjectGroupCreate({ name: '   ', repoPaths: ['/a'] }, [])?.code).toBe(
      PROJECT_GROUP_ERRORS.EMPTY_NAME
    );
  });

  it('rejects empty repo list (after normalization)', () => {
    expect(validateProjectGroupCreate({ name: 'Core', repoPaths: ['', '   '] }, [])?.code).toBe(
      PROJECT_GROUP_ERRORS.EMPTY_REPOS
    );
  });

  it('rejects duplicate name (case-insensitive)', () => {
    const existing: ProjectGroup[] = [buildProjectGroup({ name: 'Core', repoPaths: ['/a'] })];
    expect(
      validateProjectGroupCreate({ name: 'core', repoPaths: ['/b'] }, existing)?.code
    ).toBe(PROJECT_GROUP_ERRORS.DUPLICATE_NAME);
  });

  it('passes for a valid input', () => {
    expect(validateProjectGroupCreate({ name: 'Core', repoPaths: ['/a', '/b'] }, [])).toBeNull();
  });
});

describe('buildProjectGroup (F1)', () => {
  it('normalizes paths + sets timestamps', () => {
    const g = buildProjectGroup({
      name: '  Core ',
      repoPaths: ['/a/', '/a', '/b'],
      color: '#abc',
    });
    expect(g.name).toBe('Core');
    expect(g.repoPaths).toEqual(['/a', '/b']);
    expect(g.color).toBe('#abc');
    expect(g.id.startsWith('pg_')).toBe(true);
    expect(g.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(g.updatedAt).toBe(g.createdAt);
  });
});

describe('reposSharedAcrossGroups (F1)', () => {
  it('returns repos that appear in 2+ groups', () => {
    const groups: ProjectGroup[] = [
      buildProjectGroup({ name: 'A', repoPaths: ['/x', '/y'] }),
      buildProjectGroup({ name: 'B', repoPaths: ['/y', '/z'] }),
      buildProjectGroup({ name: 'C', repoPaths: ['/x', '/z'] }),
    ];
    expect(reposSharedAcrossGroups(groups)).toEqual(['/x', '/y', '/z']);
  });

  it('returns nothing when all groups are disjoint', () => {
    const groups: ProjectGroup[] = [
      buildProjectGroup({ name: 'A', repoPaths: ['/x'] }),
      buildProjectGroup({ name: 'B', repoPaths: ['/y'] }),
    ];
    expect(reposSharedAcrossGroups(groups)).toEqual([]);
  });
});

describe('window.api.projectGroup — IPC contract (F1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes the full CRUD surface', () => {
    expect(window.api.projectGroup).toBeDefined();
    for (const fn of ['list', 'get', 'add', 'update', 'remove'] as const) {
      expect(typeof window.api.projectGroup[fn]).toBe('function');
    }
  });

  it('add() forwards the payload', async () => {
    await window.api.projectGroup.add({ name: 'Core', repoPaths: ['/a', '/b'] });
    expect(mockApi.projectGroup.add).toHaveBeenCalledWith({ name: 'Core', repoPaths: ['/a', '/b'] });
  });

  it('update() forwards id + patch', async () => {
    await window.api.projectGroup.update('pg_1', { name: 'Renamed' });
    expect(mockApi.projectGroup.update).toHaveBeenCalledWith('pg_1', { name: 'Renamed' });
  });

  it('remove() forwards the id', async () => {
    await window.api.projectGroup.remove('pg_2');
    expect(mockApi.projectGroup.remove).toHaveBeenCalledWith('pg_2');
  });
});
