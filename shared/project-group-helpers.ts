/**
 * Pure helpers for ProjectGroupService (Epic F / story F1).
 */

import type { ProjectGroup, ProjectGroupCreateInput } from './types';

export const PROJECT_GROUP_ERRORS = {
  EMPTY_NAME: 'PROJECT_GROUP_EMPTY_NAME',
  EMPTY_REPOS: 'PROJECT_GROUP_EMPTY_REPOS',
  DUPLICATE_NAME: 'PROJECT_GROUP_DUPLICATE_NAME',
  NOT_FOUND: 'PROJECT_GROUP_NOT_FOUND',
} as const;

export function generateProjectGroupId(now: () => number = Date.now): string {
  return `pg_${now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Trim whitespace and dedupe member paths (preserving first-occurrence order). */
export function normalizeRepoPaths(paths: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function validateProjectGroupCreate(
  input: ProjectGroupCreateInput,
  existing: ReadonlyArray<ProjectGroup>
): { code: string; message: string } | null {
  const name = input.name?.trim() ?? '';
  if (!name) {
    return { code: PROJECT_GROUP_ERRORS.EMPTY_NAME, message: 'Project group name is required.' };
  }
  const paths = normalizeRepoPaths(input.repoPaths ?? []);
  if (paths.length === 0) {
    return {
      code: PROJECT_GROUP_ERRORS.EMPTY_REPOS,
      message: 'A project group must contain at least one repo.',
    };
  }
  const dupe = existing.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (dupe) {
    return {
      code: PROJECT_GROUP_ERRORS.DUPLICATE_NAME,
      message: `A project group named "${dupe.name}" already exists.`,
    };
  }
  return null;
}

export function buildProjectGroup(
  input: ProjectGroupCreateInput,
  opts: { id?: string; now?: string } = {}
): ProjectGroup {
  const now = opts.now ?? new Date().toISOString();
  return {
    id: opts.id ?? generateProjectGroupId(),
    name: input.name.trim(),
    repoPaths: normalizeRepoPaths(input.repoPaths),
    color: input.color,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Repos that appear in MULTIPLE project groups — useful for the renderer
 * to flag overlapping membership.
 */
export function reposSharedAcrossGroups(groups: ReadonlyArray<ProjectGroup>): string[] {
  const counts = new Map<string, number>();
  for (const g of groups) {
    for (const p of g.repoPaths) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([p]) => p)
    .sort();
}
