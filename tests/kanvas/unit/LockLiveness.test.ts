/**
 * The shared lock-liveness oracle.
 *
 * Both LockService and the MCP tool layer decide "may I take this lock?" by
 * calling these two functions, so this is where the policy is pinned down.
 * The cases that matter are the restart predecessor (reclaim at once) and the
 * unrecognised id (reclaim only after the grace period) — the two the layers
 * used to answer differently.
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyLockHolder,
  isHolderGone,
  STALE_LOCK_GRACE_MS,
  type LivenessInstance,
} from '../../../shared/lock-liveness';

const inst = (over: Partial<LivenessInstance> = {}): LivenessInstance =>
  ({ sessionId: 'sess_a', status: 'running', ...over }) as LivenessInstance;

describe('classifyLockHolder', () => {
  it('is live for the current session id of a non-terminal instance', () => {
    expect(classifyLockHolder('sess_a', [inst({ sessionId: 'sess_a' })])).toBe('live');
  });

  it('is superseded for an id a live instance lists as a predecessor', () => {
    const instances = [inst({ sessionId: 'sess_new', predecessorSessionIds: ['sess_old'] })];
    expect(classifyLockHolder('sess_old', instances)).toBe('superseded');
  });

  it('is unknown when nothing mentions the id', () => {
    expect(classifyLockHolder('sess_ghost', [inst({ sessionId: 'sess_a' })])).toBe('unknown');
  });

  it('is unknown for an empty instance list', () => {
    // Callers that could not look must report `live` themselves rather than
    // passing [], which is why this is safe to answer literally.
    expect(classifyLockHolder('sess_a', [])).toBe('unknown');
  });

  it('is unknown for an empty session id', () => {
    expect(classifyLockHolder('', [inst({ sessionId: '' })])).toBe('unknown');
  });

  describe('terminal instances do not keep a lock alive', () => {
    it.each(['completed', 'closed', 'failed'])('ignores a %s instance', (status) => {
      expect(classifyLockHolder('sess_a', [inst({ sessionId: 'sess_a', status })])).toBe('unknown');
    });

    it('ignores a terminal instance predecessors too', () => {
      const instances = [
        inst({ sessionId: 'sess_new', status: 'closed', predecessorSessionIds: ['sess_old'] }),
      ];
      expect(classifyLockHolder('sess_old', instances)).toBe('unknown');
    });
  });

  it('treats error and waiting as still live, matching isActiveInstance', () => {
    // `error` deliberately counts as active elsewhere in the app; a lock must
    // not be taken from a session the user still has to act on.
    expect(classifyLockHolder('sess_a', [inst({ sessionId: 'sess_a', status: 'error' })])).toBe('live');
    expect(classifyLockHolder('sess_a', [inst({ sessionId: 'sess_a', status: 'waiting' })])).toBe('live');
  });

  it('prefers live over superseded when an id is both', () => {
    // A restarted session that reused its own id: being current wins.
    const instances = [
      inst({ sessionId: 'sess_a' }),
      inst({ sessionId: 'sess_b', predecessorSessionIds: ['sess_a'] }),
    ];
    expect(classifyLockHolder('sess_a', instances)).toBe('live');
  });
});

describe('isHolderGone', () => {
  const now = 1_700_000_000_000;

  it('never takes a live holder lock, however old', () => {
    expect(isHolderGone('live', now - 10 * STALE_LOCK_GRACE_MS, now)).toBe(false);
  });

  it('takes a superseded holder lock immediately', () => {
    expect(isHolderGone('superseded', now, now)).toBe(true);
  });

  it('waits out the grace period for an unknown holder', () => {
    expect(isHolderGone('unknown', now - (STALE_LOCK_GRACE_MS - 1), now)).toBe(false);
    expect(isHolderGone('unknown', now - (STALE_LOCK_GRACE_MS + 1), now)).toBe(true);
  });

  it('leaves an unknown holder lock alone when its age cannot be read', () => {
    // Less information than the grace period already guards against, so this is
    // not grounds to take it. LockService's inactivity timeout still prunes
    // such a record, so it does not become immortal.
    expect(isHolderGone('unknown', NaN, now)).toBe(false);
  });

  it('still takes a superseded holder lock when its age cannot be read', () => {
    // The evidence there is positive and does not depend on the timestamp.
    expect(isHolderGone('superseded', NaN, now)).toBe(true);
  });

  it('honours a caller-supplied grace period', () => {
    expect(isHolderGone('unknown', now - 5_000, now, 1_000)).toBe(true);
    expect(isHolderGone('unknown', now - 5_000, now, 60_000)).toBe(false);
  });
});
