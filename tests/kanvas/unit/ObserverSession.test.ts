/**
 * Unit Tests for shared/observer-session.ts (story KIT-MCP-A2)
 *
 * An observer borrows a directory and owns nothing. The failure mode if that
 * is wrong is not a bad error message — it is `git worktree remove --force`
 * running against another session's working directory.
 */

import { describe, it, expect } from '@jest/globals';
import {
  deriveObserverConfig,
  isObserverSession,
  refuseDestructiveForObserver,
  observerCannotSpawn,
  OBSERVER_ERRORS,
  OBSERVER_BRANCH_PREFIX,
} from '../../../shared/observer-session';

const WORKTREE = '/Users/x/Repos/KIT-DevOps-MyApp/claude-session-20260829-a1b2';
const REPO = '/Users/x/Repos/MyApp';

describe('deriveObserverConfig — borrowing a session worktree', () => {
  const result = deriveObserverConfig({
    observedPath: WORKTREE,
    ownerSessionId: 'sess_owner',
    sessionKey: 'abcd1234',
  });

  it('succeeds', () => {
    expect(result.ok).toBe(true);
  });

  it('points repoPath at the SOURCE repo, not the borrowed directory', () => {
    // createSessionFile and initializeKanvasDirectory both write under
    // config.repoPath. Pointing it at the borrowed path would put KIT's own
    // bookkeeping inside a directory the observer must not write to.
    expect(result.config?.repoPath).toBe(REPO);
    expect(result.config?.repoPath).not.toBe(WORKTREE);
  });

  it('keeps the borrowed path separately', () => {
    expect(result.config?.observedPath).toBe(WORKTREE);
  });

  it('records the owner', () => {
    expect(result.config?.observerOfSessionId).toBe('sess_owner');
  });

  it('mints a synthetic branch name that is never a real session branch', () => {
    // Deliberately NOT the `<agent>-session-` shape, so the base-branch picker
    // can never offer it and nothing mistakes it for a branch to cut from.
    expect(result.config?.branchName).toBe(`${OBSERVER_BRANCH_PREFIX}abcd1234`);
    expect(result.config?.branchName).not.toMatch(/-session-/);
  });

  it('never produces a worktreePath', () => {
    // The rule everything else hangs off. deleteInstanceWithCleanup feeds a
    // non-null worktreePath to `git worktree remove --force`, so an observer
    // carrying the borrowed path there would destroy the OWNER's worktree.
    expect(result.config).not.toHaveProperty('worktreePath');
  });
});

describe('deriveObserverConfig — borrowing a plain checkout', () => {
  it('works without an owner session', () => {
    // The more common orchestrator need: a read-only inspector over the user's
    // own checkout, not over a sibling session.
    const r = deriveObserverConfig({ observedPath: REPO, sessionKey: 'ffff0000' });
    expect(r.ok).toBe(true);
    expect(r.config?.repoPath).toBe(REPO);
    expect(r.config?.observedPath).toBe(REPO);
    expect(r.config?.observerOfSessionId).toBeUndefined();
  });
});

describe('deriveObserverConfig — refusals', () => {
  it('refuses without a path to borrow', () => {
    const r = deriveObserverConfig({});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(OBSERVER_ERRORS.MISSING_PATH);
  });

  it('refuses to observe another observer', () => {
    // Chaining would make the borrowed path ambiguous — an observer owns
    // nothing to observe.
    const r = deriveObserverConfig({
      observedPath: WORKTREE,
      ownerSessionId: 'sess_other_observer',
      ownerIsObserver: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(OBSERVER_ERRORS.NESTED);
    expect(r.error?.instruction).toMatch(/underlying worktree/i);
  });

  it('refuses nesting before it resolves anything', () => {
    const r = deriveObserverConfig({ observedPath: WORKTREE, ownerIsObserver: true });
    expect(r.config).toBeUndefined();
  });
});

describe('isObserverSession', () => {
  it('is true only for isolation observer', () => {
    expect(isObserverSession({ isolation: 'observer' })).toBe(true);
    expect(isObserverSession({ isolation: 'worktree' })).toBe(false);
  });

  it('treats an absent isolation as a normal worktree session', () => {
    // Every pre-upgrade record has no isolation field. Reading those as
    // observers would make them undeletable.
    expect(isObserverSession({})).toBe(false);
    expect(isObserverSession(undefined)).toBe(false);
    expect(isObserverSession(null)).toBe(false);
  });
});

describe('refuseDestructiveForObserver', () => {
  it('refuses for an observer', () => {
    expect(refuseDestructiveForObserver({ isolation: 'observer' })).toBe(true);
  });

  it('permits for a normal session', () => {
    expect(refuseDestructiveForObserver({ isolation: 'worktree' })).toBe(false);
    expect(refuseDestructiveForObserver({})).toBe(false);
  });

  it('is an explicit check, not a path-equality accident', () => {
    // An observer with no worktreePath happens to survive the existing
    // path-equality guard in deleteInstanceWithCleanup. That is a coincidence,
    // not a safety property — several other sites read
    // `worktreePath || config.repoPath` and would hand back the borrowed
    // directory. This predicate is what those sites check.
    expect(refuseDestructiveForObserver({ isolation: 'observer' })).toBe(true);
  });
});

describe('observerCannotSpawn', () => {
  it('explains the refusal and where to go instead', () => {
    const e = observerCannotSpawn();
    expect(e.code).toBe(OBSERVER_ERRORS.CANNOT_SPAWN);
    expect(e.message).toMatch(/read-only/i);
    expect(e.instruction).toMatch(/orchestrator/i);
  });
});
