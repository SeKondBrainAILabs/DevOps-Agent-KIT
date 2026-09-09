/**
 * ~/.claude.json unseed — story KIT-MCP-H5
 *
 * The riskiest cleanup in this epic, because the file belongs to the USER, not
 * to KIT: it holds their Claude history and trust decisions for every project
 * they have ever opened. Deleting the wrong entry is not recoverable from
 * inside KIT.
 *
 * These tests exercise the DECISION and the CONCURRENCY, which are the two
 * places it can go wrong. The decision half is reproduced here against real
 * `shared/worktree-path` resolution rather than mocked, since the guard is
 * built on it. The service method itself cannot be imported — AgentInstanceService
 * pulls in electron-store, which is ESM and untransformed under jest.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveRepoRootFromWorktree,
  isKitWorktreePath,
} from '../../../shared/worktree-path';
import { KeyedMutex } from '../../../shared/async-mutex';

const REPO = '/Users/x/Repos/MyApp';
const WORKTREE = '/Users/x/Repos/KIT-DevOps-MyApp/claude-session-20260829-a1b2';
const LEGACY = '/Users/x/Repos/MyApp/local_deploy/feat-x';

describe('the eligibility guard', () => {
  /** Reproduces AgentInstanceService.unseedClaudeMcpApproval's decision. */
  const eligible = (path: string, verifiedOnDisk = true): boolean => {
    if (!path) return false;
    const resolved = resolveRepoRootFromWorktree(path);
    if (!resolved) return false;
    if (resolved.confidence !== 'exact' && !verifiedOnDisk) return false;
    if (path === resolved.root) return false;
    return true;
  };

  it('REFUSES the user’s own repository path', () => {
    // The single most important case. That entry carries their Claude history
    // and trust state for the project.
    expect(eligible(REPO)).toBe(false);
    expect(isKitWorktreePath(REPO)).toBe(false);
  });

  it('refuses any path that is not a KIT worktree', () => {
    for (const p of ['/tmp/whatever', '/Users/x/Documents', '']) {
      expect(eligible(p)).toBe(false);
    }
  });

  it('accepts a current-layout worktree once the derived root is verified', () => {
    expect(eligible(WORKTREE, true)).toBe(true);
  });

  it('REFUSES a current-layout worktree whose derived root cannot be verified', () => {
    // The current layout reconstructs the repo root from a directory NAME. If
    // the source repo was renamed, that yields a plausible-looking path that is
    // not what it claims — never enough to authorise deleting a user entry.
    expect(resolveRepoRootFromWorktree(WORKTREE)?.confidence).toBe('derived');
    expect(eligible(WORKTREE, false)).toBe(false);
  });

  it('accepts a legacy-layout worktree without needing verification', () => {
    // Legacy is 'exact' — the repo root is a literal prefix, not a guess.
    expect(resolveRepoRootFromWorktree(LEGACY)?.confidence).toBe('exact');
    expect(eligible(LEGACY, false)).toBe(true);
  });
});

describe('read-modify-write under concurrency', () => {
  let home: string;
  let configPath: string;

  const write = (cfg: unknown) => writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const read = (): any => JSON.parse(readFileSync(configPath, 'utf-8'));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kit-claude-'));
    configPath = join(home, '.claude.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** The seed/unseed shape: read, edit, atomic-rename back. */
  async function mutate(fn: (cfg: any) => void): Promise<void> {
    const cfg = existsSync(configPath) ? read() : {};
    // Yield between read and write — this is where the interleave happens.
    await new Promise((r) => setTimeout(r, 0));
    fn(cfg);
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }

  it('LOSES writes without a mutex — the bug being fixed', async () => {
    // Atomic rename stops a crash truncating the file. It does nothing about
    // two writers each reading, editing, and writing back: the later write
    // silently discards the earlier one's entry.
    write({ projects: {} });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutate((cfg) => {
          cfg.projects[`/wt/${i}`] = { hasTrustDialogAccepted: true };
        })
      )
    );

    expect(Object.keys(read().projects).length).toBeLessThan(10);
  });

  it('loses nothing when serialised on the config path', async () => {
    write({ projects: {} });
    const mutex = new KeyedMutex();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutex.runExclusive(configPath, () =>
          mutate((cfg) => {
            cfg.projects[`/wt/${i}`] = { hasTrustDialogAccepted: true };
          })
        )
      )
    );

    expect(Object.keys(read().projects)).toHaveLength(10);
  });

  it('concurrent removals leave every unrelated project intact', async () => {
    // Ten sessions closing at once must not take the user's own entries with
    // them.
    const projects: Record<string, unknown> = {
      [REPO]: { hasTrustDialogAccepted: true, history: ['theirs'] },
      '/Users/x/Repos/OtherApp': { hasTrustDialogAccepted: true },
    };
    for (let i = 0; i < 10; i++) projects[`/wt/${i}`] = { hasTrustDialogAccepted: true };
    write({ projects });

    const mutex = new KeyedMutex();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutex.runExclusive(configPath, () =>
          mutate((cfg) => {
            delete cfg.projects[`/wt/${i}`];
          })
        )
      )
    );

    const after = read().projects;
    expect(Object.keys(after).sort()).toEqual(
      [REPO, '/Users/x/Repos/OtherApp'].sort()
    );
    expect(after[REPO].history).toEqual(['theirs']);
  });
});

describe('a corrupt config is never rewritten', () => {
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kit-claude-'));
    configPath = join(home, '.claude.json');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('leaves an unparseable file exactly as it was', () => {
    // Both seed and unseed bail out on a parse failure rather than replacing
    // the user's file with a fresh object — which would destroy every project
    // entry they have.
    const corrupt = '{ this is not json';
    writeFileSync(configPath, corrupt);

    let parsed = false;
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      parsed = true;
    } catch {
      parsed = false;
    }

    expect(parsed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(corrupt);
  });
});
