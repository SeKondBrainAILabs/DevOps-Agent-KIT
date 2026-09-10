/**
 * Unit Tests for shared/worktree-path.ts (story KIT-MCP-H0)
 *
 * One pure module owning both directions of the KIT worktree layout:
 *   forward  — repoPath            -> <parent>/KIT-DevOps-<name>
 *   backward — <worktree>          -> source repo root
 *
 * The backward direction previously lived as an inlined regex pair in
 * WatcherService.startWithPath, and the forward direction as a module-scope
 * function on AgentInstanceService. Three later stories (H5 ~/.claude.json
 * unseed, H6 lock-root normalisation, A2 observer detection) all need the same
 * answer, so it is extracted once here.
 *
 * The `confidence` field is the load-bearing part. The CURRENT layout does not
 * contain the repo root as a prefix — it RECONSTRUCTS it from the directory
 * NAME (`KIT-DevOps-<name>` -> `<parent>/<name>`). If the source repo was
 * renamed after the worktree was created, that reconstruction names a path
 * that does not exist. The LEGACY layout has no such problem: the repo root is
 * literally a prefix of the worktree path. Callers that are about to do
 * something destructive (H5 deletes an entry from the user's ~/.claude.json)
 * must refuse anything that is merely 'derived'.
 */

import { describe, it, expect } from '@jest/globals';
import {
  getWorktreeBaseDir,
  resolveRepoRootFromWorktree,
  isKitWorktreePath,
} from '../../../shared/worktree-path';

// ─── Forward: repo -> worktree base dir ──────────────────────────────────────
describe('getWorktreeBaseDir', () => {
  it('places the base dir as a sibling of the repo, named KIT-DevOps-<repo>', () => {
    expect(getWorktreeBaseDir('/Users/x/Repos/MyApp')).toBe(
      '/Users/x/Repos/KIT-DevOps-MyApp'
    );
  });

  it('handles a repo directly under root', () => {
    expect(getWorktreeBaseDir('/MyApp')).toBe('/KIT-DevOps-MyApp');
  });

  it('tolerates a trailing slash on the repo path', () => {
    expect(getWorktreeBaseDir('/Users/x/Repos/MyApp/')).toBe(
      '/Users/x/Repos/KIT-DevOps-MyApp'
    );
  });

  it('preserves repo names containing dots and dashes', () => {
    expect(getWorktreeBaseDir('/Users/x/Repos/DevOps-Agent-KIT')).toBe(
      '/Users/x/Repos/KIT-DevOps-DevOps-Agent-KIT'
    );
    expect(getWorktreeBaseDir('/Users/x/Repos/my.app')).toBe(
      '/Users/x/Repos/KIT-DevOps-my.app'
    );
  });
});

// ─── Backward: worktree -> repo root ─────────────────────────────────────────
describe('resolveRepoRootFromWorktree', () => {
  describe('current layout: <parent>/KIT-DevOps-<name>/<branch>', () => {
    it('reconstructs the repo root and marks it DERIVED', () => {
      const r = resolveRepoRootFromWorktree(
        '/Users/x/Repos/KIT-DevOps-MyApp/claude-session-20260829-a1b2'
      );
      expect(r).toEqual({ root: '/Users/x/Repos/MyApp', confidence: 'derived' });
    });

    it('tolerates a trailing slash', () => {
      const r = resolveRepoRootFromWorktree(
        '/Users/x/Repos/KIT-DevOps-MyApp/some-branch/'
      );
      expect(r?.root).toBe('/Users/x/Repos/MyApp');
    });

    it('handles a repo name that itself contains dashes', () => {
      const r = resolveRepoRootFromWorktree(
        '/Volumes/DataDrive/Repos/sekond/KIT-DevOps-DevOps-Agent-KIT/feat-x'
      );
      expect(r).toEqual({
        root: '/Volumes/DataDrive/Repos/sekond/DevOps-Agent-KIT',
        confidence: 'derived',
      });
    });

    it('is DERIVED even when the reconstructed root would not exist — purity is the point', () => {
      // The module never touches the filesystem. A caller that needs certainty
      // must verify (e.g. `git rev-parse --git-common-dir`) and may not treat
      // 'derived' as authorisation for a destructive write.
      const r = resolveRepoRootFromWorktree(
        '/nonexistent/KIT-DevOps-Renamed/branch'
      );
      expect(r?.confidence).toBe('derived');
    });
  });

  describe('legacy layout: <repo>/local_deploy/<branch>', () => {
    it('extracts the repo root as a prefix and marks it EXACT', () => {
      const r = resolveRepoRootFromWorktree(
        '/Users/x/Repos/MyApp/local_deploy/feature-branch'
      );
      expect(r).toEqual({ root: '/Users/x/Repos/MyApp', confidence: 'exact' });
    });

    it('tolerates a trailing slash', () => {
      const r = resolveRepoRootFromWorktree(
        '/Users/x/Repos/MyApp/local_deploy/feature-branch/'
      );
      expect(r).toEqual({ root: '/Users/x/Repos/MyApp', confidence: 'exact' });
    });

    it('wins over the current layout when a path could match both', () => {
      // Matches the order WatcherService.startWithPath used: legacy first.
      const r = resolveRepoRootFromWorktree(
        '/Users/x/KIT-DevOps-Outer/local_deploy/branch'
      );
      expect(r).toEqual({
        root: '/Users/x/KIT-DevOps-Outer',
        confidence: 'exact',
      });
    });
  });

  describe('non-worktree paths', () => {
    it('returns null for a plain repo path', () => {
      expect(resolveRepoRootFromWorktree('/Users/x/Repos/MyApp')).toBeNull();
    });

    it('returns null for the base dir itself with no branch segment', () => {
      expect(
        resolveRepoRootFromWorktree('/Users/x/Repos/KIT-DevOps-MyApp')
      ).toBeNull();
    });

    it('returns null for local_deploy with no branch segment', () => {
      expect(
        resolveRepoRootFromWorktree('/Users/x/Repos/MyApp/local_deploy')
      ).toBeNull();
    });

    it('returns null for the empty string', () => {
      expect(resolveRepoRootFromWorktree('')).toBeNull();
    });

    it('does not match a directory merely CONTAINING the marker text', () => {
      expect(
        resolveRepoRootFromWorktree('/Users/x/my-KIT-DevOps-notes/file')
      ).toBeNull();
    });
  });

  // ─── Parity with the two call sites being migrated ─────────────────────────
  describe('parity with the pre-extraction inline implementations', () => {
    // Reproduces WatcherService.startWithPath as it stood before this story.
    const legacyWatcherDerivation = (worktreePath: string): string => {
      let repoPath = worktreePath;
      const legacyMatch = worktreePath.match(/^(.+)\/local_deploy\/[^/]+\/?$/);
      const newMatch = worktreePath.match(
        /^(.+)\/KIT-DevOps-([^/]+)\/[^/]+\/?$/
      );
      if (legacyMatch) {
        repoPath = legacyMatch[1];
      } else if (newMatch) {
        repoPath = `${newMatch[1]}/${newMatch[2]}`;
      }
      return repoPath;
    };

    const cases = [
      '/Users/x/Repos/KIT-DevOps-MyApp/branch',
      '/Users/x/Repos/KIT-DevOps-MyApp/branch/',
      '/Users/x/Repos/MyApp/local_deploy/branch',
      '/Users/x/Repos/MyApp/local_deploy/branch/',
      '/Users/x/Repos/MyApp',
      '/Volumes/DataDrive/Repos/sekond/KIT-DevOps-DevOps-Agent-KIT/feat-x',
      '',
    ];

    it.each(cases)(
      'produces a byte-identical repo root for %p (with the caller-side fallback)',
      (input) => {
        // The call site keeps its "fall back to the worktree path itself"
        // behaviour, so parity is asserted on the composed expression.
        const migrated = resolveRepoRootFromWorktree(input)?.root ?? input;
        expect(migrated).toBe(legacyWatcherDerivation(input));
      }
    );
  });
});

// ─── isKitWorktreePath ───────────────────────────────────────────────────────
describe('isKitWorktreePath', () => {
  it('is true for both supported layouts', () => {
    expect(
      isKitWorktreePath('/Users/x/Repos/KIT-DevOps-MyApp/branch')
    ).toBe(true);
    expect(
      isKitWorktreePath('/Users/x/Repos/MyApp/local_deploy/branch')
    ).toBe(true);
  });

  it('is false for a plain repo path — the guard H5 relies on', () => {
    // H5 deletes projects[<path>] from the user's ~/.claude.json. It must never
    // fire for the user's own repo, only for a KIT-created worktree beneath it.
    expect(isKitWorktreePath('/Users/x/Repos/MyApp')).toBe(false);
  });

  it('is false for an unrelated path', () => {
    expect(isKitWorktreePath('/tmp/whatever')).toBe(false);
    expect(isKitWorktreePath('')).toBe(false);
  });

  it('agrees with resolveRepoRootFromWorktree on every input', () => {
    const inputs = [
      '/Users/x/Repos/KIT-DevOps-MyApp/branch',
      '/Users/x/Repos/MyApp/local_deploy/branch',
      '/Users/x/Repos/MyApp',
      '/Users/x/Repos/KIT-DevOps-MyApp',
      '',
    ];
    for (const p of inputs) {
      expect(isKitWorktreePath(p)).toBe(resolveRepoRootFromWorktree(p) !== null);
    }
  });
});
