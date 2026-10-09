/**
 * Unit Tests for shared/session-start-ref.ts
 *
 * A new session used to branch from LOCAL <base> without fetching, so it
 * started on stale code whenever origin had moved on. These pin which commit
 * a session starts from for every way local and remote can relate.
 */

import { describe, it, expect } from '@jest/globals';
import {
  chooseNewBranchStart,
  existingBranchWarning,
  shouldFastForward,
  type RefRelation,
} from '../../../shared/session-start-ref';

describe('chooseNewBranchStart', () => {
  it('starts from origin/<base> when origin is ahead — the reported bug', () => {
    expect(chooseNewBranchStart('main', 'remote-ahead')).toEqual({ ref: 'origin/main' });
  });

  it('starts from origin/<base> when there is no local base branch', () => {
    expect(chooseNewBranchStart('development', 'no-local').ref).toBe('origin/development');
  });

  it('keeps local <base> when it has unpushed commits, so they are not dropped', () => {
    expect(chooseNewBranchStart('main', 'local-ahead')).toEqual({ ref: 'main' });
  });

  it('keeps local <base> when they are the same commit', () => {
    expect(chooseNewBranchStart('main', 'equal')).toEqual({ ref: 'main' });
  });

  it('keeps local on divergence, and says what the session is missing', () => {
    const c = chooseNewBranchStart('main', 'diverged');
    expect(c.ref).toBe('main');
    expect(c.warning).toMatch(/diverged/);
    expect(c.warning).toMatch(/origin\/main/);
  });

  it('falls back to local when the remote cannot be compared, with a warning', () => {
    const c = chooseNewBranchStart('main', 'no-remote');
    expect(c.ref).toBe('main');
    expect(c.warning).toMatch(/stale/);
  });

  it('honours a non-origin remote name', () => {
    expect(chooseNewBranchStart('main', 'remote-ahead', 'upstream').ref).toBe('upstream/main');
  });
});

describe('existing session branch', () => {
  const all: RefRelation[] = ['equal', 'remote-ahead', 'local-ahead', 'diverged', 'no-remote', 'no-local'];

  it.each(all)('fast-forwards only when the remote is strictly ahead (%s)', (rel) => {
    expect(shouldFastForward(rel)).toBe(rel === 'remote-ahead');
  });

  it('warns on divergence and nowhere else', () => {
    for (const rel of all) {
      const w = existingBranchWarning('feat-x', rel);
      if (rel === 'diverged') expect(w).toMatch(/origin\/feat-x/);
      else expect(w).toBeUndefined();
    }
  });
});
