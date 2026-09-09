/**
 * Unit Tests for shared/node-modules-plan.ts (story KIT-MCP-A5)
 *
 * The platform × filesystem × source-kind matrix, tested exhaustively because
 * the wrong rung is expensive in two opposite directions: a silent full byte
 * copy costs tens of seconds and gigabytes per session, and a silent share lets
 * an agent's `npm install` mutate the user's own repository.
 */

import { describe, it, expect } from '@jest/globals';
import {
  planNodeModules,
  lockfileStaleWarning,
  type NodeModulesPlanInput,
} from '../../../shared/node-modules-plan';

const input = (over: Partial<NodeModulesPlanInput> = {}): NodeModulesPlanInput => ({
  setting: 'auto',
  platform: 'darwin',
  sourceExists: true,
  sourceIsSymlink: false,
  sameFilesystem: true,
  supportsCow: true,
  ...over,
});

describe('the setting wins outright', () => {
  it('skip means skip, whatever the platform offers', () => {
    const p = planNodeModules(input({ setting: 'skip' }));
    expect(p.strategy).toBe('skipped');
    expect(p.shared).toBe(false);
  });
});

describe('nothing to provision', () => {
  it('reports none when the source has no node_modules', () => {
    const p = planNodeModules(input({ sourceExists: false }));
    expect(p.strategy).toBe('none');
    expect(p.shared).toBe(false);
  });

  it('covers Yarn PnP, which legitimately has no node_modules', () => {
    // Not a failure — nothing to do is the correct answer.
    expect(planNodeModules(input({ sourceExists: false })).strategy).toBe('none');
  });
});

describe('a symlinked source is recreated, not copied', () => {
  // This repo's own situation: node_modules is a symlink to another volume.
  const p = planNodeModules(
    input({ sourceIsSymlink: true, sourceSymlinkTarget: '/Volumes/Other/node_modules' })
  );

  it('recreates the symlink', () => {
    expect(p.strategy).toBe('symlink');
    expect(p.reason).toContain('/Volumes/Other/node_modules');
  });

  it('reports it as shared and warns the agent', () => {
    // It was already shared before KIT touched anything, but the agent still
    // must not install into it.
    expect(p.shared).toBe(true);
    expect(p.agentWarning).toMatch(/do not install packages/i);
  });

  it('takes precedence over cloning', () => {
    expect(
      planNodeModules(
        input({
          sourceIsSymlink: true,
          sourceSymlinkTarget: '/x',
          supportsCow: true,
          setting: 'clone',
        })
      ).strategy
    ).toBe('symlink');
  });
});

describe('copy-on-write — the only cheap AND isolated rung', () => {
  it('uses clonefile on macOS', () => {
    const p = planNodeModules(input({ platform: 'darwin' }));
    expect(p.strategy).toBe('clone');
    expect(p.shared).toBe(false);
    expect(p.command).toEqual(['cp', '-c', '-R']);
  });

  it('uses reflink=ALWAYS on Linux, never auto', () => {
    // `--reflink=auto` silently performs a full byte copy when the filesystem
    // cannot reflink — exactly the multi-GB per-session cost being eliminated.
    // Failing loudly and falling through is the point.
    const p = planNodeModules(input({ platform: 'linux' }));
    expect(p.command).toEqual(['cp', '-a', '--reflink=always']);
    expect(p.command).not.toContain('--reflink=auto');
  });

  it('is not shared, so an agent can install freely', () => {
    expect(planNodeModules(input()).shared).toBe(false);
    expect(planNodeModules(input()).agentWarning).toBeUndefined();
  });
});

describe('falling back off copy-on-write', () => {
  it('links on a non-CoW filesystem', () => {
    const p = planNodeModules(input({ supportsCow: false }));
    expect(p.strategy).toBe('symlink');
    expect(p.shared).toBe(true);
    expect(p.reason).toMatch(/copy-on-write/i);
  });

  it('links across filesystems', () => {
    const p = planNodeModules(input({ sameFilesystem: false }));
    expect(p.strategy).toBe('symlink');
    expect(p.reason).toMatch(/different filesystem/i);
  });

  it('uses a junction on Windows, not a symlink', () => {
    // Junctions need no Developer Mode or admin rights; symlinks do.
    const p = planNodeModules(input({ platform: 'win32', supportsCow: false }));
    expect(p.strategy).toBe('junction');
    expect(p.shared).toBe(true);
  });

  it('warns on every shared rung', () => {
    for (const over of [
      { supportsCow: false },
      { sameFilesystem: false },
      { platform: 'win32' as NodeJS.Platform, supportsCow: false },
    ]) {
      const p = planNodeModules(input(over));
      expect(p.shared).toBe(true);
      expect(p.agentWarning).toBeTruthy();
    }
  });
});

describe('an explicit clone request never silently shares', () => {
  it('skips rather than linking when CoW is unavailable', () => {
    // Asking for isolation and silently getting a shared directory is worse
    // than getting nothing: the agent would install into the user's repo.
    const p = planNodeModules(input({ setting: 'clone', supportsCow: false }));
    expect(p.strategy).toBe('skipped');
    expect(p.shared).toBe(false);
  });

  it('skips rather than linking across filesystems', () => {
    const p = planNodeModules(input({ setting: 'clone', sameFilesystem: false }));
    expect(p.strategy).toBe('skipped');
    expect(p.reason).toMatch(/different filesystem/i);
  });
});

describe('never fails the session', () => {
  it('always returns a usable strategy for every combination', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32', 'freebsd'];
    const settings = ['auto', 'clone', 'symlink', 'skip'] as const;

    for (const platform of platforms) {
      for (const setting of settings) {
        for (const supportsCow of [true, false]) {
          for (const sameFilesystem of [true, false]) {
            for (const sourceExists of [true, false]) {
              const p = planNodeModules(
                input({ platform, setting, supportsCow, sameFilesystem, sourceExists })
              );
              // Provisioning is never allowed to be the thing that fails a
              // session — worst case it declines and says why.
              expect(p.strategy).toBeTruthy();
              expect(p.reason).toBeTruthy();
              if (p.shared) expect(p.agentWarning).toBeTruthy();
            }
          }
        }
      }
    }
  });
});

describe('lockfileStaleWarning', () => {
  it('warns when the lockfiles differ', () => {
    const w = lockfileStaleWarning('aaa', 'bbb', 'development');
    expect(w).toMatch(/npm ci/);
    expect(w).toContain('development');
  });

  it('says nothing when they match', () => {
    expect(lockfileStaleWarning('aaa', 'aaa', 'main')).toBeUndefined();
  });

  it('says nothing when either hash is unavailable', () => {
    expect(lockfileStaleWarning(undefined, 'bbb', 'main')).toBeUndefined();
    expect(lockfileStaleWarning('aaa', undefined, 'main')).toBeUndefined();
  });

  it('never triggers an install itself', () => {
    // KIT has never had install semantics. An install is minutes of CPU, and
    // at eight-way fan-out that is a machine-killer — so the agent is told
    // rather than pre-empted.
    const w = lockfileStaleWarning('a', 'b', 'main')!;
    expect(w).toMatch(/before building/i);
  });
});
