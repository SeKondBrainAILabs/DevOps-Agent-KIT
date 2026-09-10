/**
 * node_modules provisioning for new worktrees (story KIT-MCP-A5).
 *
 * `git worktree add` is fast — measured at roughly 1.5s. The unmodelled cost of
 * a session is `node_modules`, which KIT has never installed, copied or linked:
 * a fresh worktree simply has none, and the agent discovers that when its first
 * build fails.
 *
 * This is the pure decision half. It picks a strategy from the platform, the
 * filesystem, and what the source directory actually is. The filesystem half
 * lives in AgentInstanceService.
 *
 * ## Why copy-on-write and not a warm pool
 *
 * A pool fights the branch-per-session identity model: the worktree directory
 * is named after the branch, and `createWorktreeIfNeeded`'s reuse,
 * `BRANCH_IN_USE`, and the watcher's repo-derivation regex all key on that
 * name. Claiming a pooled worktree means either a misnamed directory (breaking
 * all four) or renaming it (breaking git's absolute-path worktree registry).
 * Recycling is also strictly more dangerous than deleting — `git reset --hard`
 * inside a directory a previous agent may still have live processes in, and KIT
 * has no process-ownership tracking to make that safe.
 *
 * ## The hazard that shapes the ladder
 *
 * Rungs that SHARE one directory (symlink, junction) mean `npm install <pkg>`
 * in a session mutates the USER'S OWN repository. That is why they are last
 * resorts and why `shared: true` is surfaced — the agent has to be told.
 */

export type NodeModulesStrategy =
  /** Copy-on-write clone. Near-zero disk, fully isolated. */
  | 'clone'
  /** Symlink to the source. Zero disk, SHARED and therefore mutable. */
  | 'symlink'
  /** Windows directory junction. Zero disk, SHARED. */
  | 'junction'
  /** Source has no node_modules (or Yarn PnP). Nothing to do. */
  | 'none'
  /** Deliberately not provisioned; the agent installs its own. */
  | 'skipped';

/** What the user asked for. 'auto' walks the ladder. */
export type NodeModulesSetting = 'auto' | 'clone' | 'symlink' | 'skip';

export interface NodeModulesPlanInput {
  setting: NodeModulesSetting;
  platform: NodeJS.Platform;
  /** Does <repo>/node_modules exist at all? */
  sourceExists: boolean;
  /** Is it itself a symlink? (This repo's own situation.) */
  sourceIsSymlink: boolean;
  /** Where that symlink points, when it is one. */
  sourceSymlinkTarget?: string;
  /** False when the worktree lives on a different volume from the repo. */
  sameFilesystem: boolean;
  /** True when the filesystem supports CoW (APFS, btrfs, xfs, ReFS). */
  supportsCow: boolean;
}

export interface NodeModulesPlan {
  strategy: NodeModulesStrategy;
  /**
   * True when the worktree ends up sharing ONE directory with the source repo,
   * so anything the agent installs mutates the user's own checkout.
   */
  shared: boolean;
  /** argv for the copy, when the strategy needs one. */
  command?: string[];
  /** Why this rung was chosen — surfaced in logs and the session warnings. */
  reason: string;
  /** Extra line for the agent's instructions when the result needs care. */
  agentWarning?: string;
}

const SHARED_WARNING =
  'node_modules is SHARED with the main checkout — do not install packages in ' +
  'this session; ask the orchestrator instead. Installing here would modify the ' +
  "user's own repository.";

/**
 * Choose how to provision node_modules for a new worktree.
 *
 * The ladder, in order, each rung falling through to the next:
 *
 *   1. no source            -> 'none'   (also covers Yarn PnP, which has none)
 *   2. source is a symlink  -> recreate the identical symlink
 *   3. CoW available        -> clone    (macOS clonefile / Linux reflink)
 *   4. Windows              -> junction (SHARED)
 *   5. POSIX                -> symlink  (SHARED)
 *   6. otherwise            -> 'skipped'
 */
export function planNodeModules(input: NodeModulesPlanInput): NodeModulesPlan {
  const {
    setting,
    platform,
    sourceExists,
    sourceIsSymlink,
    sourceSymlinkTarget,
    sameFilesystem,
    supportsCow,
  } = input;

  if (setting === 'skip') {
    return {
      strategy: 'skipped',
      shared: false,
      reason: 'Disabled by the worktree.node_modules_strategy setting.',
    };
  }

  // 1. Nothing to copy. Yarn PnP repos land here too, correctly.
  if (!sourceExists) {
    return {
      strategy: 'none',
      shared: false,
      reason: 'The source repository has no node_modules directory.',
    };
  }

  // 2. The source is itself a symlink — this repo's own situation. Recreating
  //    it is one syscall, zero bytes, and semantically identical to what the
  //    user already has. It IS shared, but it was already shared before KIT
  //    touched anything.
  if (sourceIsSymlink && sourceSymlinkTarget) {
    return {
      strategy: 'symlink',
      shared: true,
      reason: `The source node_modules is itself a symlink to ${sourceSymlinkTarget}; recreating it.`,
      agentWarning: SHARED_WARNING,
    };
  }

  const wantsClone = setting === 'auto' || setting === 'clone';

  // 3. Copy-on-write. The only rung that is both cheap AND isolated.
  if (wantsClone && sameFilesystem && supportsCow) {
    if (platform === 'darwin') {
      return {
        strategy: 'clone',
        shared: false,
        // -c is clonefile(2). It ERRORS on a non-APFS volume rather than
        // silently falling back to a byte copy, which is the behaviour we want:
        // a silent multi-GB copy per session is the cost being eliminated.
        command: ['cp', '-c', '-R'],
        reason: 'APFS copy-on-write clone.',
      };
    }
    if (platform === 'linux') {
      return {
        strategy: 'clone',
        shared: false,
        // --reflink=always, never =auto. `auto` silently performs a full byte
        // copy when the filesystem cannot reflink — exactly the multi-GB,
        // tens-of-seconds-per-session cost this exists to avoid.
        command: ['cp', '-a', '--reflink=always'],
        reason: 'Filesystem copy-on-write clone (reflink).',
      };
    }
  }

  if (setting === 'clone') {
    // Explicitly asked for a clone and it is not available. Skipping is more
    // honest than silently sharing the user's directory.
    return {
      strategy: 'skipped',
      shared: false,
      reason: !sameFilesystem
        ? 'Clone requested, but the worktree is on a different filesystem from the repo.'
        : 'Clone requested, but this filesystem does not support copy-on-write.',
    };
  }

  // 4/5. Shared fallbacks. Zero disk, but the agent can mutate the user's repo.
  if (platform === 'win32') {
    return {
      strategy: 'junction',
      shared: true,
      // A junction, not a symlink: junctions need no Developer Mode or admin
      // rights on Windows, symlinks do.
      reason: 'Windows directory junction (no copy-on-write available).',
      agentWarning: SHARED_WARNING,
    };
  }

  return {
    strategy: 'symlink',
    shared: true,
    reason: !sameFilesystem
      ? 'Worktree is on a different filesystem; linking instead of copying.'
      : 'No copy-on-write support on this filesystem; linking instead of copying.',
    agentWarning: SHARED_WARNING,
  };
}

/**
 * Whether the cloned node_modules is stale for this worktree's lockfile.
 *
 * Deliberately does NOT trigger an install. KIT has never had install
 * semantics, an install is minutes of CPU, and at eight-way fan-out that is a
 * machine-killer. The agent is told instead.
 */
export function lockfileStaleWarning(
  sourceLockHash: string | undefined,
  worktreeLockHash: string | undefined,
  baseBranch: string
): string | undefined {
  if (!sourceLockHash || !worktreeLockHash) return undefined;
  if (sourceLockHash === worktreeLockHash) return undefined;
  return (
    `node_modules was provisioned from ${baseBranch}, whose lockfile differs ` +
    'from this branch. Run `npm ci` (or your package manager equivalent) before ' +
    'building.'
  );
}
