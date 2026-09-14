/**
 * Unit Tests for shared/stage-changes.ts (story KIT-GIT-S1)
 *
 * `git add -A` fails WHOLESALE when any submodule in the tree has a dangling
 * gitdir — one broken pointer and nothing stages, including files nowhere near
 * the submodule.
 *
 * Reported from a real repository: five submodules whose `.git` files still
 * pointed at a linked-worktree layout that no longer existed, so
 *
 *   fatal: not a git repository: .../.git/modules/lib/ai-backend/worktrees/ai-backend
 *
 * blocked a commit of four unrelated files in .vscode/ and QA/. Verified there
 * that `git add -- <explicit paths>` succeeds on the same tree.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  parseBrokenSubmodulePath,
  planStaging,
  type StatusEntry,
} from '../../../shared/stage-changes';

describe('parseBrokenSubmodulePath', () => {
  it('extracts the gitdir from the real failure', () => {
    const stderr =
      'fatal: not a git repository: /Volumes/DataDrive/Repos/piggybank/SA-Piggy-Bank/' +
      'SA-Piggy-Bank/.git/modules/lib/ai-backend/worktrees/ai-backend';
    expect(parseBrokenSubmodulePath(stderr)).toBe(
      '/Volumes/DataDrive/Repos/piggybank/SA-Piggy-Bank/SA-Piggy-Bank/.git/modules/lib/ai-backend/worktrees/ai-backend'
    );
  });

  it('handles the relative form git emits for linked worktrees', () => {
    const stderr =
      'fatal: not a git repository: lib/concept-engine/../../../../SA-Piggy-Bank/.git/' +
      'worktrees/codex-session-20260910-conv/modules/lib/concept-engine';
    expect(parseBrokenSubmodulePath(stderr)).toContain('lib/concept-engine');
  });

  it('returns null for an unrelated failure', () => {
    // A genuine error must NOT be mistaken for a broken submodule and retried.
    expect(parseBrokenSubmodulePath('fatal: pathspec did not match any files')).toBeNull();
    expect(parseBrokenSubmodulePath('')).toBeNull();
  });
});

const entry = (status: string, path: string): StatusEntry => ({ status, path });

describe('planStaging', () => {
  it('stages every changed path explicitly', () => {
    const plan = planStaging([
      entry(' M', '.vscode/settings.json'),
      entry('??', 'QA/featurebus_coverage.json'),
    ]);
    expect(plan.paths).toEqual(['.vscode/settings.json', 'QA/featurebus_coverage.json']);
  });

  it('EXCLUDES submodule gitlinks', () => {
    // Staging a gitlink is what re-enters the broken submodule and reproduces
    // the original failure. The whole point of the fallback is to skip them.
    const plan = planStaging([
      entry(' M', 'src/app.ts'),
      entry(' M', 'lib/ai-backend'),
    ], new Set(['lib/ai-backend']));
    expect(plan.paths).toEqual(['src/app.ts']);
    expect(plan.skippedSubmodules).toEqual(['lib/ai-backend']);
  });

  it('excludes a path INSIDE a broken submodule', () => {
    const plan = planStaging([
      entry(' M', 'lib/ai-backend/src/index.ts'),
      entry(' M', 'README.md'),
    ], new Set(['lib/ai-backend']));
    expect(plan.paths).toEqual(['README.md']);
  });

  it('does not exclude a path that merely shares a prefix', () => {
    // `lib/ai-backend-utils` is a different directory from `lib/ai-backend`.
    const plan = planStaging([
      entry(' M', 'lib/ai-backend-utils/x.ts'),
    ], new Set(['lib/ai-backend']));
    expect(plan.paths).toEqual(['lib/ai-backend-utils/x.ts']);
  });

  it('handles renames, which git reports as "old -> new"', () => {
    const plan = planStaging([entry('R ', 'old/name.ts -> new/name.ts')]);
    // Both sides must be staged or the rename is recorded as a delete.
    expect(plan.paths).toContain('old/name.ts');
    expect(plan.paths).toContain('new/name.ts');
  });

  it('handles quoted paths with spaces', () => {
    const plan = planStaging([entry('??', '"my file.txt"')]);
    expect(plan.paths).toEqual(['my file.txt']);
  });

  it('reports nothing to stage for an empty status', () => {
    const plan = planStaging([]);
    expect(plan.paths).toEqual([]);
    expect(plan.empty).toBe(true);
  });

  it('deduplicates', () => {
    const plan = planStaging([entry(' M', 'a.ts'), entry('??', 'a.ts')]);
    expect(plan.paths).toEqual(['a.ts']);
  });
});
