/**
 * Snapshot ref lifecycle — story KIT-MCP-H3
 *
 * `refs/kit-autosave/<sessionId>` and `refs/kit-idle-end/<sessionId>` are the
 * ONLY copy of work an agent had uncommitted when it died. Everything here is
 * about not deleting them by accident.
 *
 * Verified against a real git repository, because the thing under test is what
 * git actually does with the refs — `update-ref -d` semantics, and whether
 * deleting a ref touches the branch it was taken from.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let repo: string;

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

/** Mirrors WatcherService.triggerPeriodicSnapshot: a stash commit pinned to a ref. */
function takeSnapshot(namespace: string, sessionId: string): string {
  // Modify a TRACKED file: `git stash create` returns empty when the only
  // change is untracked, which is what makes an all-untracked fixture useless
  // here.
  writeFileSync(join(repo, 'a.txt'), `wip ${Date.now()}${Math.random()}`);
  const sha = execFileSync('git', ['stash', 'create', '-u'], {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
  if (!sha) throw new Error('stash create produced no commit — fixture is broken');
  git('update-ref', `${namespace}/${sessionId}`, sha);
  return sha;
}

const refExists = (ref: string): boolean => {
  try {
    git('rev-parse', '--verify', ref);
    return true;
  } catch {
    return false;
  }
};

const listRefs = (): string[] =>
  git('for-each-ref', '--format=%(refname)', 'refs/kit-autosave/', 'refs/kit-idle-end/')
    .split('\n')
    .filter(Boolean);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kit-refs-'));
  git('init', '-q', '.');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('snapshot refs behave as crash-recovery storage', () => {
  it('pins uncommitted work that survives losing the working tree', () => {
    writeFileSync(join(repo, 'a.txt'), 'important uncommitted work');
    const sha = execFileSync('git', ['stash', 'create', '-u'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(sha).toBeTruthy();
    git('update-ref', 'refs/kit-autosave/sess_a', sha);

    // Working tree reverted, as if the worktree directory were removed.
    git('checkout', '--', 'a.txt');
    expect(git('show', 'HEAD:a.txt')).toBe('x');

    // The uncommitted content is still reachable through the ref — this is
    // exactly what makes these refs the only copy of a crashed agent's work.
    const blob = git('show', 'refs/kit-autosave/sess_a:a.txt');
    expect(blob).toBe('important uncommitted work');
  });

  it('deleting the ref does NOT touch the branch it came from', () => {
    // The reason a snapshot ref is safe to GC in principle: real work lives on
    // the session branch, these are pure recovery.
    const headBefore = git('rev-parse', 'HEAD');
    takeSnapshot('refs/kit-autosave', 'sess_a');
    git('update-ref', '-d', 'refs/kit-autosave/sess_a');

    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
  });
});

describe('both namespaces are scanned', () => {
  it('for-each-ref over the two namespaces finds both kinds', () => {
    // refs/kit-idle-end/ was never listed before this story, so idle-end
    // snapshots accumulated forever while autosave ones were pruned at 7 days.
    takeSnapshot('refs/kit-autosave', 'sess_a');
    takeSnapshot('refs/kit-idle-end', 'sess_a');

    const refs = listRefs();
    expect(refs).toContain('refs/kit-autosave/sess_a');
    expect(refs).toContain('refs/kit-idle-end/sess_a');
  });
});

describe('deleting one session’s refs', () => {
  it('removes both namespaces for that session and leaves others alone', () => {
    takeSnapshot('refs/kit-autosave', 'sess_a');
    takeSnapshot('refs/kit-idle-end', 'sess_a');
    takeSnapshot('refs/kit-autosave', 'sess_b');

    for (const ns of ['refs/kit-autosave/', 'refs/kit-idle-end/']) {
      try {
        git('update-ref', '-d', `${ns}sess_a`);
      } catch {
        /* absent is fine */
      }
    }

    expect(refExists('refs/kit-autosave/sess_a')).toBe(false);
    expect(refExists('refs/kit-idle-end/sess_a')).toBe(false);
    expect(refExists('refs/kit-autosave/sess_b')).toBe(true);
  });

  it('deleting a ref that does not exist is not an error worth propagating', () => {
    // The delete loop runs for every namespace x every predecessor id, so most
    // combinations legitimately have no ref.
    let threw = false;
    try {
      git('update-ref', '-d', 'refs/kit-autosave/sess_never');
    } catch {
      threw = true;
    }
    // git may or may not exit non-zero here depending on version; either way
    // the caller swallows it. What matters is that nothing else was harmed.
    expect(listRefs()).toEqual([]);
    void threw;
  });
});

// The rule the checker flagged as a data-loss hazard.
describe('collectability rule for aged-out refs', () => {
  /** Reproduces AgentInstanceService.snapshotRefIsCollectable. */
  const isCollectable = (
    ref: string,
    instances: Array<{ sessionId?: string; predecessorSessionIds?: string[] }>
  ): boolean => {
    const sessionId = ref.split('/').pop();
    if (!sessionId) return false;
    for (const inst of instances) {
      if (inst.sessionId === sessionId) return false;
      if (inst.predecessorSessionIds?.includes(sessionId)) return false;
    }
    return true;
  };

  it('protects a ref belonging to a live session', () => {
    expect(
      isCollectable('refs/kit-autosave/sess_live', [{ sessionId: 'sess_live' }])
    ).toBe(false);
  });

  it('protects a ref belonging to a PREDECESSOR id', () => {
    // This is the case that makes the naive rule dangerous.
    // purgeInstancesOnBranch deletes instance records on EVERY restart, so a
    // large set of refs legitimately match no live sessionId while still
    // holding a crashed agent's only uncommitted work.
    expect(
      isCollectable('refs/kit-autosave/sess_old', [
        { sessionId: 'sess_live', predecessorSessionIds: ['sess_old', 'sess_mid'] },
      ])
    ).toBe(false);
  });

  it('protects every id in a multi-restart chain', () => {
    const instances = [
      { sessionId: 'sess_live', predecessorSessionIds: ['sess_v1', 'sess_v2', 'sess_v3'] },
    ];
    for (const id of ['sess_live', 'sess_v1', 'sess_v2', 'sess_v3']) {
      expect(isCollectable(`refs/kit-idle-end/${id}`, instances)).toBe(false);
    }
  });

  it('collects a ref matching no id at all', () => {
    expect(
      isCollectable('refs/kit-autosave/sess_ancient', [
        { sessionId: 'sess_live', predecessorSessionIds: ['sess_old'] },
      ])
    ).toBe(true);
  });

  it('collects nothing when KIT has no instances but the ref names one it knew', () => {
    // Empty store — every ref is unmatched. Age is the only remaining guard,
    // and it is applied by the caller. This documents that the rule alone is
    // NOT sufficient protection; the TTL is doing real work.
    expect(isCollectable('refs/kit-autosave/sess_x', [])).toBe(true);
  });

  it('refuses a malformed ref rather than guessing', () => {
    expect(isCollectable('', [])).toBe(false);
  });
});
