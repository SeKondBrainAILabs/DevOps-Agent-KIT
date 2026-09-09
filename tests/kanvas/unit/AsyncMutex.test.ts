/**
 * Unit Tests for shared/async-mutex.ts (story KIT-MCP-H0)
 *
 * A promise-chain mutex keyed by an arbitrary string. Three consumers in this
 * epic need it, and each needs a different key:
 *
 *   G1  — serialises the session ADMISSION decision. Today the single-session
 *         guard reads the instance map at one await point and the reservation
 *         writes it at a later one, so two concurrent createInstance() calls
 *         both pass the guard and both create.
 *   G1  — separately serialises `git worktree add` PER SOURCE REPO. Every
 *         worktree add writes the shared worktree registry through
 *         .git/config.lock, and no call site retries on lock contention.
 *   H5  — serialises read-modify-write on the user's ~/.claude.json. Atomic
 *         rename does not help: the read and the write are separate steps, so
 *         concurrent closes lose each other's edits.
 *
 * The contract that matters for all three: a body that throws must still
 * release, or one failed session create wedges the whole app.
 */

import { describe, it, expect } from '@jest/globals';
import { KeyedMutex } from '../../../shared/async-mutex';

/** Resolves on the next macrotask — a real yield, not a microtask tick. */
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

describe('KeyedMutex', () => {
  describe('serialisation on a single key', () => {
    it('runs 100 concurrent tasks one at a time, in call order', async () => {
      const mutex = new KeyedMutex();
      const order: number[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 100 }, (_, i) =>
        mutex.runExclusive('repo-a', async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await yieldToEventLoop();
          order.push(i);
          concurrent -= 1;
        })
      );

      await Promise.all(tasks);

      expect(maxConcurrent).toBe(1);
      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    it('guards a read-then-write critical section against interleaving', async () => {
      // This is the G1 race in miniature: read, yield, write-back.
      const mutex = new KeyedMutex();
      let shared = 0;

      await Promise.all(
        Array.from({ length: 50 }, () =>
          mutex.runExclusive('counter', async () => {
            const seen = shared;
            await yieldToEventLoop();
            shared = seen + 1;
          })
        )
      );

      // Without the mutex this lands well under 50 (lost updates).
      expect(shared).toBe(50);
    });

    it('returns each task’s own resolved value to its own caller', async () => {
      const mutex = new KeyedMutex();
      const results = await Promise.all([
        mutex.runExclusive('k', async () => 'first'),
        mutex.runExclusive('k', async () => 'second'),
        mutex.runExclusive('k', () => 'sync-third'),
      ]);
      expect(results).toEqual(['first', 'second', 'sync-third']);
    });
  });

  describe('independent keys', () => {
    it('lets different keys run concurrently', async () => {
      const mutex = new KeyedMutex();
      let concurrent = 0;
      let maxConcurrent = 0;

      await Promise.all(
        ['repo-a', 'repo-b', 'repo-c'].map((key) =>
          mutex.runExclusive(key, async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await yieldToEventLoop();
            concurrent -= 1;
          })
        )
      );

      // The whole point of keying: 8 sessions across 3 repos must not
      // serialise into one queue.
      expect(maxConcurrent).toBe(3);
    });

    it('does not let one key’s rejection disturb another key', async () => {
      const mutex = new KeyedMutex();
      const [a, b] = await Promise.allSettled([
        mutex.runExclusive('a', async () => {
          throw new Error('boom');
        }),
        mutex.runExclusive('b', async () => 'fine'),
      ]);
      expect(a.status).toBe('rejected');
      expect(b).toEqual({ status: 'fulfilled', value: 'fine' });
    });
  });

  describe('release on failure', () => {
    it('releases when the body throws, so the next waiter still runs', async () => {
      const mutex = new KeyedMutex();
      const ran: string[] = [];

      const failing = mutex
        .runExclusive('k', async () => {
          ran.push('failing');
          throw new Error('boom');
        })
        .catch((e: unknown) => (e as Error).message);

      const following = mutex.runExclusive('k', async () => {
        ran.push('following');
        return 'ok';
      });

      expect(await failing).toBe('boom');
      expect(await following).toBe('ok');
      expect(ran).toEqual(['failing', 'following']);
    });

    it('propagates the original error, not a wrapped one', async () => {
      const mutex = new KeyedMutex();
      const sentinel = new Error('original');
      await expect(
        mutex.runExclusive('k', async () => {
          throw sentinel;
        })
      ).rejects.toBe(sentinel);
    });

    it('releases when a SYNCHRONOUS body throws', async () => {
      const mutex = new KeyedMutex();
      await expect(
        mutex.runExclusive('k', () => {
          throw new Error('sync boom');
        })
      ).rejects.toThrow('sync boom');

      // Not wedged.
      await expect(mutex.runExclusive('k', () => 'ok')).resolves.toBe('ok');
    });
  });

  describe('key lifecycle', () => {
    it('reports a key as locked only while it is held', async () => {
      const mutex = new KeyedMutex();
      expect(mutex.isLocked('k')).toBe(false);

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const running = mutex.runExclusive('k', () => gate);

      expect(mutex.isLocked('k')).toBe(true);
      release();
      await running;
      expect(mutex.isLocked('k')).toBe(false);
    });

    it('drops the key once the queue drains, so the map cannot grow forever', async () => {
      // At fan-out this is keyed by repo path; without cleanup the map would
      // retain an entry per repo ever touched for the life of the process.
      const mutex = new KeyedMutex();
      expect(mutex.activeKeyCount()).toBe(0);

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          mutex.runExclusive(`repo-${i}`, async () => {
            await yieldToEventLoop();
          })
        )
      );

      expect(mutex.activeKeyCount()).toBe(0);
    });

    it('drops the key after a rejected body too', async () => {
      const mutex = new KeyedMutex();
      await mutex
        .runExclusive('k', async () => {
          throw new Error('boom');
        })
        .catch(() => undefined);
      expect(mutex.activeKeyCount()).toBe(0);
      expect(mutex.isLocked('k')).toBe(false);
    });

    it('does not drop a key that a later waiter has already queued behind', async () => {
      // Guards the classic bug: the releasing task deletes the map entry while
      // a successor is still chained to it, so the successor runs unguarded.
      const mutex = new KeyedMutex();
      let concurrent = 0;
      let maxConcurrent = 0;

      const body = async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await yieldToEventLoop();
        concurrent -= 1;
      };

      const first = mutex.runExclusive('k', body);
      const second = mutex.runExclusive('k', body);
      const third = mutex.runExclusive('k', body);

      await Promise.all([first, second, third]);

      expect(maxConcurrent).toBe(1);
      expect(mutex.activeKeyCount()).toBe(0);
    });
  });
});
