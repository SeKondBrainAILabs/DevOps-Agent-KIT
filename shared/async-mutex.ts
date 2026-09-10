/**
 * KeyedMutex — a promise-chain mutex keyed by an arbitrary string.
 *
 * Pure, dependency-free, safe to import from anywhere including the renderer.
 *
 * Three consumers in the MCP session-lifecycle epic, each with a different key:
 *
 *   G1  key = <global>    Serialises the session ADMISSION decision. Today the
 *                         single-session guard reads the instance map at one
 *                         await point and the reservation writes it at a later
 *                         one, so two concurrent createInstance() calls both
 *                         pass the guard and both create. MCP fan-out makes
 *                         that the normal case, not an edge case.
 *
 *   G1  key = repoPath    Serialises `git worktree add` per source repo. Every
 *                         worktree add writes the shared worktree registry via
 *                         `.git/config.lock`, and no call site retries on lock
 *                         contention — eight concurrent creates against one
 *                         repo otherwise fail roughly half the fan-out.
 *
 *   H5  key = configPath  Serialises read-modify-write on the user's
 *                         `~/.claude.json`. Atomic rename does not help here:
 *                         the read and the write are separate steps, so
 *                         concurrent closes silently drop each other's edits.
 *
 * Two properties the callers depend on:
 *
 *   1. A body that throws still releases. One failed session create must not
 *      wedge every subsequent create for the life of the process.
 *   2. The key is dropped once its queue drains, so a map keyed by repo path
 *      does not retain an entry for every repo ever touched.
 */

export class KeyedMutex {
  /**
   * Tail of the promise chain per key. Each new task chains onto the current
   * tail, so bodies on the same key run strictly in call order.
   */
  private tails = new Map<string, Promise<void>>();

  /**
   * How many tasks are holding or queued on each key.
   *
   * This is what makes cleanup safe. Deleting the tail unconditionally when a
   * body finishes would let a successor that is already chained to it start a
   * fresh, unguarded chain — two bodies running at once. The counter is
   * incremented synchronously at call time, before any await, so a task that
   * queues while another is running is always visible to that other task's
   * cleanup.
   */
  private depth = new Map<string, number>();

  /**
   * Run `fn` with exclusive access to `key`.
   *
   * Tasks on the same key run one at a time, in call order. Tasks on different
   * keys are independent and run concurrently. The resolved value — or the
   * thrown error — of `fn` passes through to the caller unchanged.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Both of these happen synchronously, before the first await, so ordering
    // is fixed at call time rather than at resume time.
    this.tails.set(
      key,
      previous.then(() => current)
    );
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);

    // Wait our turn. A predecessor that rejected must not reject us — it has
    // already delivered its own error to its own caller.
    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();

      const remaining = (this.depth.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.depth.delete(key);
        this.tails.delete(key);
      } else {
        this.depth.set(key, remaining);
      }
    }
  }

  /** True while `key` is held or has tasks queued on it. */
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys currently held or queued. Zero once everything drains. */
  activeKeyCount(): number {
    return this.tails.size;
  }
}
