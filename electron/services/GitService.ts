/**
 * Git Service
 * Handles all Git operations (worktree, commit, push, merge, etc.)
 * Migrated from: worktree-manager.js
 */

import { BaseService } from './BaseService';
import { IPC } from '../../shared/ipc-channels';
import type {
  GitStatus,
  GitCommit,
  GitCommitWithFiles,
  CommitDiffDetail,
  GitFileChange,
  BranchInfo,
  FileStatus,
  IpcResult,
} from '../../shared/types';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';

// Map to track worktree paths by session ID
const worktreePaths: Map<string, { repoPath: string; worktreePath: string }> = new Map();

// Dynamic import helper for execa (ESM-only module)
// Handles various bundling scenarios with fallback patterns
let _execa: ((cmd: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string }>) | null = null;

async function getExeca() {
  if (!_execa) {
    const mod = await import('execa');
    // Try different export patterns based on how the bundler resolves the module
    if (typeof mod.execa === 'function') {
      _execa = mod.execa;
    } else if (typeof mod.default === 'function') {
      _execa = mod.default;
    } else if (typeof mod.default?.execa === 'function') {
      _execa = mod.default.execa;
    } else {
      throw new Error(`Unable to resolve execa function from module: ${JSON.stringify(Object.keys(mod))}`);
    }
  }
  return _execa;
}

export class GitService extends BaseService {
  /**
   * Execute a git command (uses dynamic import for ESM-only execa)
   */
  private async git(args: string[], cwd: string): Promise<string> {
    const execa = await getExeca();
    const { stdout } = await execa('git', args, { cwd });
    return stdout.trim();
  }

  /**
   * Register a session's worktree path
   */
  registerWorktree(sessionId: string, repoPath: string, worktreePath: string): void {
    worktreePaths.set(sessionId, { repoPath, worktreePath });
  }

  /**
   * Register a specific repo's worktree path within a multi-repo session.
   * Uses compound key: sessionId:repoName.
   * Also registers under plain sessionId if it's the first (primary) repo.
   */
  registerRepoWorktree(sessionId: string, repoName: string, repoPath: string, worktreePath: string): void {
    const key = `${sessionId}:${repoName}`;
    worktreePaths.set(key, { repoPath, worktreePath });
    // Also register under plain sessionId if not yet registered (first = primary)
    if (!worktreePaths.has(sessionId)) {
      worktreePaths.set(sessionId, { repoPath, worktreePath });
    }
  }

  /**
   * Get working directory for a session, optionally for a specific repo.
   */
  private getWorkingDir(sessionId: string, repoName?: string): string {
    if (repoName) {
      const compoundKey = `${sessionId}:${repoName}`;
      const paths = worktreePaths.get(compoundKey);
      if (paths) return paths.worktreePath;
    }
    const paths = worktreePaths.get(sessionId);
    if (!paths) {
      throw new Error(`No worktree registered for session: ${sessionId}${repoName ? `, repo: ${repoName}` : ''}`);
    }
    return paths.worktreePath;
  }

  /**
   * Get repo root for a session
   */
  private getRepoRoot(sessionId: string): string {
    const paths = worktreePaths.get(sessionId);
    if (!paths) {
      throw new Error(`No worktree registered for session: ${sessionId}`);
    }
    return paths.repoPath;
  }

  /**
   * Detect git submodules in a repository by parsing .gitmodules.
   */
  async detectSubmodules(repoPath: string): Promise<IpcResult<Array<{ name: string; path: string; url: string }>>> {
    return this.wrap(async () => {
      const gitmodulesPath = path.join(repoPath, '.gitmodules');
      if (!existsSync(gitmodulesPath)) return [];

      const content = await fs.readFile(gitmodulesPath, 'utf-8');
      const submodules: Array<{ name: string; path: string; url: string }> = [];
      let current: Partial<{ name: string; path: string; url: string }> = {};

      for (const line of content.split('\n')) {
        const nameMatch = line.match(/\[submodule\s+"(.+)"\]/);
        if (nameMatch) {
          if (current.name && current.path) {
            submodules.push({ name: current.name, path: current.path, url: current.url || '' });
          }
          current = { name: nameMatch[1] };
        }
        const pathMatch = line.match(/\s*path\s*=\s*(.+)/);
        if (pathMatch) current.path = pathMatch[1].trim();
        const urlMatch = line.match(/\s*url\s*=\s*(.+)/);
        if (urlMatch) current.url = urlMatch[1].trim();
      }
      if (current.name && current.path) {
        submodules.push({ name: current.name, path: current.path, url: current.url || '' });
      }
      return submodules;
    }, 'GIT_DETECT_SUBMODULES_FAILED');
  }

  /**
   * Create a branch in a submodule directory (branch-in-place mode).
   * The submodule stays within the primary worktree.
   */
  async checkoutSubmoduleBranch(
    submodulePath: string,
    branchName: string,
    baseBranch?: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      // Ensure submodule is initialized
      const parentDir = path.dirname(submodulePath);
      const subName = path.basename(submodulePath);
      try {
        await this.git(['submodule', 'update', '--init', subName], parentDir);
      } catch {
        // May already be initialized
      }
      // Create and checkout new branch from base
      const base = baseBranch || 'HEAD';
      await this.git(['checkout', '-b', branchName, base], submodulePath);
    }, 'GIT_SUBMODULE_BRANCH_FAILED');
  }

  /**
   * Remove all worktrees for a session (both primary and multi-repo compound keys).
   */
  async removeAllSessionWorktrees(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const keysToRemove: string[] = [];
      for (const key of worktreePaths.keys()) {
        if (key === sessionId || key.startsWith(`${sessionId}:`)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        const paths = worktreePaths.get(key);
        if (paths && existsSync(paths.worktreePath)) {
          try {
            // Only remove actual worktrees (not submodule directories)
            await this.git(['worktree', 'remove', paths.worktreePath, '--force'], paths.repoPath);
          } catch {
            // May be a submodule path, not a worktree
          }
        }
        worktreePaths.delete(key);
      }
    }, 'GIT_REMOVE_ALL_WORKTREES_FAILED');
  }

  async createWorktree(
    sessionId: string,
    branchName: string,
    worktreePath: string
  ): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      // Get repo root from worktree path
      const repoPath = path.dirname(path.dirname(worktreePath));

      // Ensure .worktrees directory exists
      const worktreesDir = path.dirname(worktreePath);
      await fs.mkdir(worktreesDir, { recursive: true });

      // Create worktree with new branch
      await this.git(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], repoPath);

      // Register the worktree
      this.registerWorktree(sessionId, repoPath, worktreePath);
    }, 'GIT_WORKTREE_CREATE_FAILED');
  }

  async removeWorktree(sessionId: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const paths = worktreePaths.get(sessionId);
      if (!paths) return;

      const { repoPath, worktreePath } = paths;

      // Remove worktree
      if (existsSync(worktreePath)) {
        await this.git(['worktree', 'remove', worktreePath, '--force'], repoPath);
      }

      // Prune worktrees
      await this.git(['worktree', 'prune'], repoPath);

      // Unregister
      worktreePaths.delete(sessionId);
    }, 'GIT_WORKTREE_REMOVE_FAILED');
  }

  async getStatus(sessionId: string): Promise<IpcResult<GitStatus>> {
    return this.wrap(async () => {
      const cwd = this.getWorkingDir(sessionId);

      // Get current branch
      const branch = await this.git(['branch', '--show-current'], cwd);

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      try {
        const tracking = await this.git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], cwd);
        const [b, a] = tracking.split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch {
        // No upstream tracking
      }

      // Get changed files
      const porcelain = await this.git(['status', '--porcelain'], cwd);
      const changes: GitFileChange[] = [];

      for (const line of porcelain.split('\n').filter(Boolean)) {
        const staged = line[0] !== ' ' && line[0] !== '?';
        const statusChar = staged ? line[0] : line[1];
        const filePath = line.substring(3);

        let status: FileStatus = 'modified';
        switch (statusChar) {
          case 'A': status = 'added'; break;
          case 'M': status = 'modified'; break;
          case 'D': status = 'deleted'; break;
          case 'R': status = 'renamed'; break;
          case '?': status = 'untracked'; break;
        }

        changes.push({ path: filePath, status, staged });
      }

      const gitStatus: GitStatus = {
        branch,
        ahead,
        behind,
        clean: changes.length === 0,
        changes,
      };

      return gitStatus;
    }, 'GIT_STATUS_FAILED');
  }

  async commit(sessionId: string, message: string, repoName?: string): Promise<IpcResult<GitCommit>> {
    return this.wrap(async () => {
      const cwd = this.getWorkingDir(sessionId, repoName);

      // Stage all changes
      await this.git(['add', '-A'], cwd);

      // Commit
      await this.git(['commit', '-m', message], cwd);

      // Get commit info
      const hash = await this.git(['rev-parse', 'HEAD'], cwd);
      const shortHash = await this.git(['rev-parse', '--short', 'HEAD'], cwd);
      const author = await this.git(['log', '-1', '--format=%an'], cwd);
      const date = await this.git(['log', '-1', '--format=%aI'], cwd);

      const commit: GitCommit = {
        hash,
        shortHash,
        message,
        author,
        date,
      };

      return commit;
    }, 'GIT_COMMIT_FAILED');
  }

  async push(sessionId: string, repoName?: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const cwd = this.getWorkingDir(sessionId, repoName);
      const branch = await this.git(['branch', '--show-current'], cwd);
      await this.git(['push', '-u', 'origin', branch], cwd);
    }, 'GIT_PUSH_FAILED');
  }

  async merge(sessionId: string, targetBranch: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const repoPath = this.getRepoRoot(sessionId);
      const cwd = this.getWorkingDir(sessionId);
      const currentBranch = await this.git(['branch', '--show-current'], cwd);

      // Switch to target branch in main repo
      await this.git(['checkout', targetBranch], repoPath);

      // Merge session branch
      await this.git(['merge', currentBranch, '-m', `Merge session: ${currentBranch}`], repoPath);

      // Push merged changes
      await this.git(['push', 'origin', targetBranch], repoPath);
    }, 'GIT_MERGE_FAILED');
  }

  async listBranches(sessionId: string): Promise<IpcResult<BranchInfo[]>> {
    return this.wrap(async () => {
      const cwd = this.getWorkingDir(sessionId);

      // Get current branch
      const current = await this.git(['branch', '--show-current'], cwd);

      // Get all branches with their remote tracking info
      const output = await this.git(['branch', '-a', '-v'], cwd);
      const branches: BranchInfo[] = [];

      for (const line of output.split('\n')) {
        if (!line.trim()) continue;

        const isCurrent = line.startsWith('*');
        const match = line.match(/^\*?\s+(\S+)\s+(\S+)/);
        if (match) {
          const [, name, lastCommit] = match;
          // Skip remotes/origin/ prefix for remote branches
          const cleanName = name.replace('remotes/origin/', '');

          branches.push({
            name: cleanName,
            current: isCurrent,
            remote: name.startsWith('remotes/') ? 'origin' : undefined,
            lastCommit,
          });
        }
      }

      return branches;
    }, 'GIT_BRANCHES_FAILED');
  }

  /**
   * Check if path is inside a git repository
   */
  async isGitRepo(repoPath: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--git-dir'], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get repository root from any path within it
   */
  async getRepoRootPath(anyPath: string): Promise<string> {
    return this.git(['rev-parse', '--show-toplevel'], anyPath);
  }

  // ==========================================================================
  // REBASE AND SYNC OPERATIONS
  // ==========================================================================

  /**
   * Fetch latest changes from remote
   */
  async fetchRemote(repoPath: string, remote = 'origin'): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      await this.git(['fetch', remote, '--prune'], repoPath);
    }, 'GIT_FETCH_FAILED');
  }

  /**
   * Check if there are remote changes to pull
   */
  async checkRemoteChanges(repoPath: string, branch: string): Promise<IpcResult<{ behind: number; ahead: number }>> {
    return this.wrap(async () => {
      // Fetch first to get latest remote state
      await this.git(['fetch', 'origin'], repoPath);

      try {
        const tracking = await this.git(
          ['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`],
          repoPath
        );
        const [behind, ahead] = tracking.split('\t').map(Number);
        return { behind: behind || 0, ahead: ahead || 0 };
      } catch {
        // No upstream tracking or remote branch doesn't exist
        return { behind: 0, ahead: 0 };
      }
    }, 'GIT_CHECK_REMOTE_FAILED');
  }

  /**
   * Stash uncommitted changes
   */
  async stash(repoPath: string, message?: string): Promise<IpcResult<boolean>> {
    return this.wrap(async () => {
      // Check if there are changes to stash
      const status = await this.git(['status', '--porcelain'], repoPath);
      if (!status.trim()) {
        return false; // Nothing to stash
      }

      const stashMsg = message || `Auto-stash before rebase ${new Date().toISOString()}`;
      await this.git(['stash', 'push', '-u', '-m', stashMsg], repoPath);
      return true;
    }, 'GIT_STASH_FAILED');
  }

  /**
   * Pop stashed changes
   */
  async stashPop(repoPath: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      await this.git(['stash', 'pop'], repoPath);
    }, 'GIT_STASH_POP_FAILED');
  }

  /**
   * Rebase current branch onto target branch
   * Returns detailed result including whether actual changes occurred
   */
  async rebase(repoPath: string, targetBranch: string): Promise<IpcResult<{
    success: boolean;
    message: string;
    commitsAdded: number;
    beforeHead: string;
    afterHead: string;
  }>> {
    return this.wrap(async () => {
      // Get HEAD before rebase to verify changes actually occurred
      const beforeHead = await this.git(['rev-parse', 'HEAD'], repoPath);
      const beforeCommitCount = await this.git(['rev-list', '--count', 'HEAD'], repoPath);

      console.log(`[GitService] Rebase starting - HEAD before: ${beforeHead.substring(0, 8)}, commits: ${beforeCommitCount}`);

      try {
        // Check how many commits we're behind
        let commitsBehind = 0;
        try {
          const tracking = await this.git(
            ['rev-list', '--count', `HEAD..origin/${targetBranch}`],
            repoPath
          );
          commitsBehind = parseInt(tracking, 10) || 0;
          console.log(`[GitService] Commits behind origin/${targetBranch}: ${commitsBehind}`);
        } catch {
          console.log(`[GitService] Could not determine commits behind (branch might not track remote)`);
        }

        // Perform the rebase
        const output = await this.git(['pull', '--rebase', 'origin', targetBranch], repoPath);
        console.log(`[GitService] Git pull --rebase output: ${output}`);

        // Get HEAD after rebase to verify changes
        const afterHead = await this.git(['rev-parse', 'HEAD'], repoPath);
        const afterCommitCount = await this.git(['rev-list', '--count', 'HEAD'], repoPath);

        const commitsAdded = parseInt(afterCommitCount, 10) - parseInt(beforeCommitCount, 10);
        const headChanged = beforeHead !== afterHead;

        console.log(`[GitService] Rebase completed - HEAD after: ${afterHead.substring(0, 8)}, commits: ${afterCommitCount}, added: ${commitsAdded}`);

        // Determine appropriate message based on what actually happened
        let message: string;
        if (!headChanged && commitsAdded === 0) {
          message = 'Already up to date - no changes from remote';
          console.log(`[GitService] WARNING: Rebase completed but no changes detected!`);
        } else if (commitsAdded > 0) {
          message = `Rebased successfully - added ${commitsAdded} commit(s) from ${targetBranch}`;
        } else if (headChanged) {
          message = `Rebased successfully onto ${targetBranch}`;
        } else {
          message = 'Rebase completed';
        }

        return {
          success: true,
          message,
          commitsAdded,
          beforeHead,
          afterHead,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[GitService] Rebase failed:`, errorMsg);

        // Abort the rebase to clean up
        try {
          await this.git(['rebase', '--abort'], repoPath);
          console.log(`[GitService] Rebase aborted successfully`);
        } catch {
          // Ignore abort errors
        }

        // Provide user-friendly error messages
        let userMessage = 'Rebase failed';
        if (errorMsg.includes('CONFLICT') || errorMsg.includes('conflict')) {
          userMessage = 'Rebase failed due to merge conflicts. Please resolve manually.';
        } else if (errorMsg.includes('exit code')) {
          userMessage = 'Rebase failed - there may be conflicts or the branch is out of sync.';
        } else {
          userMessage = `Rebase failed: ${errorMsg}`;
        }

        return {
          success: false,
          message: userMessage,
          commitsAdded: 0,
          beforeHead: beforeHead,
          afterHead: beforeHead, // Same as before since rebase failed
        };
      }
    }, 'GIT_REBASE_FAILED');
  }

  /**
   * Perform a full rebase operation with stash handling
   * Returns detailed information about what actually changed
   */
  async performRebase(repoPath: string, baseBranch: string): Promise<IpcResult<{
    success: boolean;
    message: string;
    hadChanges: boolean;
    commitsAdded?: number;
    beforeHead?: string;
    afterHead?: string;
  }>> {
    return this.wrap(async () => {
      console.log(`[GitService] ========== REBASE OPERATION START ==========`);
      console.log(`[GitService] Repository: ${repoPath}`);
      console.log(`[GitService] Base branch: ${baseBranch}`);

      // 1. Fetch latest - with better error handling
      try {
        await this.git(['fetch', 'origin', baseBranch], repoPath);
      } catch (fetchError) {
        const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.error(`[GitService] Fetch failed:`, errorMsg);

        // Check if branch exists on remote
        try {
          await this.git(['ls-remote', '--exit-code', '--heads', 'origin', baseBranch], repoPath);
        } catch {
          return {
            success: false,
            message: `Branch '${baseBranch}' not found on remote. Check your base branch setting.`,
            hadChanges: false,
          };
        }

        // Branch exists but fetch failed for another reason
        return {
          success: false,
          message: `Failed to fetch from origin: ${errorMsg.includes('exit code') ? 'Git error - check your network connection and credentials' : errorMsg}`,
          hadChanges: false,
        };
      }

      // 2. Stash any uncommitted changes
      const stashResult = await this.stash(repoPath, `Auto-stash before rebase onto ${baseBranch}`);
      const hadChanges = stashResult.success && stashResult.data === true;

      // 3. Perform rebase
      const rebaseResult = await this.rebase(repoPath, baseBranch);

      if (!rebaseResult.success || !rebaseResult.data?.success) {
        // Rebase failed - try to pop stash if we stashed
        if (hadChanges) {
          try {
            await this.git(['stash', 'pop'], repoPath);
          } catch {
            console.warn('[GitService] Could not pop stash after failed rebase');
          }
        }
        return {
          success: false,
          message: rebaseResult.data?.message || 'Rebase failed',
          hadChanges,
        };
      }

      // 4. Pop stash if we stashed
      if (hadChanges) {
        try {
          await this.git(['stash', 'pop'], repoPath);
          console.log(`[GitService] Stash pop successful`);
        } catch (error) {
          console.warn('[GitService] Stash pop had conflicts:', error);
          console.log(`[GitService] ========== REBASE COMPLETED WITH STASH CONFLICTS ==========`);
          return {
            success: true,
            message: 'Rebase successful but stash pop had conflicts. Please resolve manually.',
            hadChanges,
            commitsAdded: rebaseResult.data?.commitsAdded,
            beforeHead: rebaseResult.data?.beforeHead,
            afterHead: rebaseResult.data?.afterHead,
          };
        }
      }

      // Use detailed message from rebase result
      const finalMessage = rebaseResult.data?.message || 'Rebase successful';

      console.log(`[GitService] ========== REBASE OPERATION COMPLETE ==========`);
      console.log(`[GitService] Result: ${finalMessage}`);
      console.log(`[GitService] Commits added: ${rebaseResult.data?.commitsAdded || 0}`);

      return {
        success: true,
        message: finalMessage,
        hadChanges,
        commitsAdded: rebaseResult.data?.commitsAdded,
        beforeHead: rebaseResult.data?.beforeHead,
        afterHead: rebaseResult.data?.afterHead,
      };
    }, 'GIT_PERFORM_REBASE_FAILED');
  }

  /**
   * Perform rebase with AI-powered conflict resolution
   * This method uses MergeConflictService to automatically resolve conflicts
   */
  async performRebaseWithAI(
    repoPath: string,
    baseBranch: string,
    mergeConflictService: import('./MergeConflictService').MergeConflictService
  ): Promise<IpcResult<{
    success: boolean;
    message: string;
    hadChanges: boolean;
    conflictsResolved?: number;
    conflictsFailed?: number;
    resolutions?: import('./MergeConflictService').ResolutionResult[];
  }>> {
    return this.wrap(async () => {
      console.log(`[GitService] Starting AI-powered rebase of ${repoPath} onto ${baseBranch}`);

      // 1. Fetch latest
      try {
        await this.git(['fetch', 'origin', baseBranch], repoPath);
      } catch (fetchError) {
        const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.error(`[GitService] Fetch failed:`, errorMsg);

        try {
          await this.git(['ls-remote', '--exit-code', '--heads', 'origin', baseBranch], repoPath);
        } catch {
          return {
            success: false,
            message: `Branch '${baseBranch}' not found on remote.`,
            hadChanges: false,
          };
        }

        return {
          success: false,
          message: `Failed to fetch from origin: ${errorMsg}`,
          hadChanges: false,
        };
      }

      // 2. Stash any uncommitted changes
      const stashResult = await this.stash(repoPath, `Auto-stash before AI rebase onto ${baseBranch}`);
      const hadChanges = stashResult.success && stashResult.data === true;

      // 3. Use MergeConflictService for rebase with AI resolution
      const rebaseResult = await mergeConflictService.rebaseWithResolution(repoPath, baseBranch);

      if (!rebaseResult.success || !rebaseResult.data?.success) {
        // Rebase failed - try to pop stash if we stashed
        if (hadChanges) {
          try {
            await this.git(['stash', 'pop'], repoPath);
          } catch {
            console.warn('[GitService] Could not pop stash after failed rebase');
          }
        }
        return {
          success: false,
          message: rebaseResult.data?.message || 'AI rebase failed',
          hadChanges,
          conflictsResolved: rebaseResult.data?.conflictsResolved || 0,
          conflictsFailed: rebaseResult.data?.conflictsFailed || 0,
          resolutions: rebaseResult.data?.resolutions || [],
        };
      }

      // 4. Pop stash if we stashed
      if (hadChanges) {
        try {
          await this.git(['stash', 'pop'], repoPath);
        } catch (error) {
          console.warn('[GitService] Stash pop had conflicts:', error);
          return {
            success: true,
            message: 'Rebase successful but stash pop had conflicts',
            hadChanges,
            conflictsResolved: rebaseResult.data.conflictsResolved,
            conflictsFailed: rebaseResult.data.conflictsFailed,
            resolutions: rebaseResult.data.resolutions,
          };
        }
      }

      console.log(`[GitService] AI-powered rebase completed. Resolved ${rebaseResult.data.conflictsResolved} conflicts.`);
      return {
        success: true,
        message: rebaseResult.data.message,
        hadChanges,
        conflictsResolved: rebaseResult.data.conflictsResolved,
        conflictsFailed: rebaseResult.data.conflictsFailed,
        resolutions: rebaseResult.data.resolutions,
      };
    }, 'GIT_PERFORM_REBASE_AI_FAILED');
  }

  // ==========================================================================
  // WORKTREE AND CLEANUP OPERATIONS
  // ==========================================================================

  /**
   * List all worktrees in a repository
   */
  async listWorktrees(repoPath: string): Promise<IpcResult<Array<{
    path: string;
    branch: string;
    head: string;
    bare: boolean;
  }>>> {
    return this.wrap(async () => {
      const output = await this.git(['worktree', 'list', '--porcelain'], repoPath);
      const worktrees: Array<{ path: string; branch: string; head: string; bare: boolean }> = [];

      let current: Partial<{ path: string; branch: string; head: string; bare: boolean }> = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) {
            worktrees.push(current as { path: string; branch: string; head: string; bare: boolean });
          }
          current = { path: line.replace('worktree ', ''), bare: false };
        } else if (line.startsWith('HEAD ')) {
          current.head = line.replace('HEAD ', '');
        } else if (line.startsWith('branch ')) {
          current.branch = line.replace('branch refs/heads/', '');
        } else if (line === 'bare') {
          current.bare = true;
        }
      }

      if (current.path) {
        worktrees.push(current as { path: string; branch: string; head: string; bare: boolean });
      }

      return worktrees;
    }, 'GIT_LIST_WORKTREES_FAILED');
  }

  /**
   * Prune stale worktree references
   */
  async pruneWorktrees(repoPath: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      await this.git(['worktree', 'prune'], repoPath);
    }, 'GIT_PRUNE_WORKTREES_FAILED');
  }

  /**
   * Delete a branch (local and optionally remote)
   */
  async deleteBranch(repoPath: string, branchName: string, deleteRemote = false): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      // Delete local branch
      await this.git(['branch', '-D', branchName], repoPath);

      // Optionally delete remote branch
      if (deleteRemote) {
        try {
          await this.git(['push', 'origin', '--delete', branchName], repoPath);
        } catch {
          // Remote branch might not exist
        }
      }
    }, 'GIT_DELETE_BRANCH_FAILED');
  }

  /**
   * Get list of merged branches that can be cleaned up
   */
  async getMergedBranches(repoPath: string, baseBranch = 'main'): Promise<IpcResult<string[]>> {
    return this.wrap(async () => {
      const output = await this.git(['branch', '--merged', baseBranch], repoPath);
      const branches = output
        .split('\n')
        .map(b => b.replace('*', '').trim())
        .filter(b => b && b !== baseBranch && b !== 'master' && b !== 'main' && b !== 'development');
      return branches;
    }, 'GIT_MERGED_BRANCHES_FAILED');
  }

  /**
   * Get list of changed files between current branch and base branch
   * Used by FilesTab to show what files have been modified
   */
  async getChangedFiles(repoPath: string, baseBranch = 'main'): Promise<IpcResult<Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>>> {
    return this.wrap(async () => {
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);

      // Get list of changed files with their status
      // Use diff against the merge-base to see what's changed since branching
      let mergeBase: string;
      try {
        mergeBase = await this.git(['merge-base', `origin/${baseBranch}`, currentBranch], repoPath);
      } catch {
        // If merge-base fails, try comparing against local baseBranch
        try {
          mergeBase = await this.git(['merge-base', baseBranch, currentBranch], repoPath);
        } catch {
          // If that fails too, compare against HEAD~10 or just show uncommitted changes
          mergeBase = 'HEAD~10';
        }
      }

      // Get numstat for additions/deletions
      const numstat = await this.git(['diff', '--numstat', mergeBase], repoPath);
      const nameStatus = await this.git(['diff', '--name-status', mergeBase], repoPath);

      const fileStats = new Map<string, { additions: number; deletions: number }>();
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t'); // Handle paths with tabs
        fileStats.set(filePath, {
          additions: add === '-' ? 0 : parseInt(add, 10),
          deletions: del === '-' ? 0 : parseInt(del, 10),
        });
      }

      const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
      for (const line of nameStatus.split('\n').filter(Boolean)) {
        const [statusChar, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');

        let status = 'modified';
        switch (statusChar[0]) {
          case 'A': status = 'added'; break;
          case 'M': status = 'modified'; break;
          case 'D': status = 'deleted'; break;
          case 'R': status = 'renamed'; break;
          case 'C': status = 'copied'; break;
        }

        const stats = fileStats.get(filePath) || { additions: 0, deletions: 0 };
        files.push({
          path: filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
        });
      }

      return files;
    }, 'GIT_GET_CHANGED_FILES_FAILED');
  }

  /**
   * Get detailed file status including git state and last commit info
   * Returns files with: uncommitted (staged/unstaged), committed (with hash)
   */
  async getFilesWithStatus(repoPath: string, baseBranch = 'main'): Promise<IpcResult<Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    gitState: 'staged' | 'unstaged' | 'committed' | 'untracked';
    commitHash?: string;
    commitShortHash?: string;
    commitMessage?: string;
  }>>> {
    return this.wrap(async () => {
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);

      // Get current uncommitted changes from git status
      const porcelain = await this.git(['status', '--porcelain'], repoPath);
      const uncommittedFiles = new Map<string, { staged: boolean; status: string }>();

      for (const line of porcelain.split('\n').filter(Boolean)) {
        const indexStatus = line[0];
        const worktreeStatus = line[1];
        const filePath = line.substring(3);

        let status = 'modified';
        let staged = false;

        if (indexStatus !== ' ' && indexStatus !== '?') {
          // File is staged
          staged = true;
          switch (indexStatus) {
            case 'A': status = 'added'; break;
            case 'M': status = 'modified'; break;
            case 'D': status = 'deleted'; break;
            case 'R': status = 'renamed'; break;
          }
        } else if (worktreeStatus !== ' ') {
          // File has unstaged changes
          staged = false;
          switch (worktreeStatus) {
            case 'M': status = 'modified'; break;
            case 'D': status = 'deleted'; break;
            case '?': status = 'untracked'; break;
          }
        }

        uncommittedFiles.set(filePath, { staged, status });
      }

      // Get all files changed since branching (committed files)
      let mergeBase: string;
      try {
        mergeBase = await this.git(['merge-base', `origin/${baseBranch}`, currentBranch], repoPath);
      } catch {
        try {
          mergeBase = await this.git(['merge-base', baseBranch, currentBranch], repoPath);
        } catch {
          mergeBase = 'HEAD~10';
        }
      }

      // Get committed files with their last commit info
      const logOutput = await this.git([
        'log',
        '--name-status',
        '--pretty=format:%H|%h|%s',
        `${mergeBase}..HEAD`
      ], repoPath);

      // Parse git log to get last commit per file
      const fileCommits = new Map<string, { hash: string; shortHash: string; message: string }>();
      let currentCommit: { hash: string; shortHash: string; message: string } | null = null;

      for (const line of logOutput.split('\n')) {
        if (!line.trim()) continue;

        if (line.includes('|')) {
          // This is a commit line
          const [hash, shortHash, message] = line.split('|');
          currentCommit = { hash, shortHash, message };
        } else if (currentCommit) {
          // This is a file line
          const [, ...pathParts] = line.split('\t');
          const filePath = pathParts.join('\t');
          if (filePath && !fileCommits.has(filePath)) {
            // Only store the first (most recent) commit for each file
            fileCommits.set(filePath, currentCommit);
          }
        }
      }

      // Get numstat for additions/deletions
      const numstat = await this.git(['diff', '--numstat', mergeBase], repoPath);
      const fileStats = new Map<string, { additions: number; deletions: number }>();
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        fileStats.set(filePath, {
          additions: add === '-' ? 0 : parseInt(add, 10),
          deletions: del === '-' ? 0 : parseInt(del, 10),
        });
      }

      // Combine all files: uncommitted + committed
      const allFiles = new Map<string, {
        path: string;
        status: string;
        additions: number;
        deletions: number;
        gitState: 'staged' | 'unstaged' | 'committed' | 'untracked';
        commitHash?: string;
        commitShortHash?: string;
        commitMessage?: string;
      }>();

      // Add uncommitted files first (they take priority)
      for (const [filePath, info] of uncommittedFiles) {
        const stats = fileStats.get(filePath) || { additions: 0, deletions: 0 };
        allFiles.set(filePath, {
          path: filePath,
          status: info.status,
          additions: stats.additions,
          deletions: stats.deletions,
          gitState: info.status === 'untracked' ? 'untracked' : (info.staged ? 'staged' : 'unstaged'),
        });
      }

      // Add committed files (only if not already in uncommitted)
      for (const [filePath, commitInfo] of fileCommits) {
        if (!allFiles.has(filePath)) {
          const stats = fileStats.get(filePath) || { additions: 0, deletions: 0 };
          allFiles.set(filePath, {
            path: filePath,
            status: 'modified', // Committed files are considered modified from base
            additions: stats.additions,
            deletions: stats.deletions,
            gitState: 'committed',
            commitHash: commitInfo.hash,
            commitShortHash: commitInfo.shortHash,
            commitMessage: commitInfo.message,
          });
        } else {
          // File has uncommitted changes but also has commits - add commit info
          const existing = allFiles.get(filePath)!;
          existing.commitHash = commitInfo.hash;
          existing.commitShortHash = commitInfo.shortHash;
          existing.commitMessage = commitInfo.message;
        }
      }

      return Array.from(allFiles.values());
    }, 'GIT_GET_FILES_WITH_STATUS_FAILED');
  }

  /**
   * Get diff summary for commit message generation
   * Returns structured diff info with actual code changes
   */
  async getDiffSummaryForCommit(repoPath: string): Promise<IpcResult<{
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
    filesByType: Record<string, number>;
    summary: string;
    files: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      diff: string; // Truncated diff content
    }>;
  }>> {
    return this.wrap(async () => {
      // Get staged and unstaged changes
      const porcelain = await this.git(['status', '--porcelain'], repoPath);
      const files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        diff: string;
      }> = [];

      let totalAdditions = 0;
      let totalDeletions = 0;
      const filesByType: Record<string, number> = {};

      for (const line of porcelain.split('\n').filter(Boolean)) {
        const indexStatus = line[0];
        const worktreeStatus = line[1];
        const filePath = line.substring(3);

        let status = 'modified';
        if (indexStatus === 'A' || worktreeStatus === '?') status = 'added';
        else if (indexStatus === 'D' || worktreeStatus === 'D') status = 'deleted';
        else if (indexStatus === 'R') status = 'renamed';

        // Get file extension for grouping
        const ext = path.extname(filePath).toLowerCase() || 'other';
        filesByType[ext] = (filesByType[ext] || 0) + 1;

        // Get diff stats for this file
        let additions = 0;
        let deletions = 0;
        let diffContent = '';

        try {
          // Get numstat for this file
          const numstatOutput = await this.git(['diff', '--numstat', '--', filePath], repoPath);
          if (numstatOutput) {
            const [add, del] = numstatOutput.split('\t');
            additions = add === '-' ? 0 : parseInt(add, 10) || 0;
            deletions = del === '-' ? 0 : parseInt(del, 10) || 0;
          }

          // Also check staged changes
          const stagedNumstat = await this.git(['diff', '--cached', '--numstat', '--', filePath], repoPath);
          if (stagedNumstat) {
            const [add, del] = stagedNumstat.split('\t');
            additions += add === '-' ? 0 : parseInt(add, 10) || 0;
            deletions += del === '-' ? 0 : parseInt(del, 10) || 0;
          }

          // Get actual diff content (truncated for large files)
          if (status !== 'deleted') {
            try {
              // For untracked files, show the content
              if (worktreeStatus === '?') {
                diffContent = await this.git(['diff', '--no-index', '/dev/null', filePath], repoPath).catch(() => '');
              } else {
                // Get both staged and unstaged changes
                const stagedDiff = await this.git(['diff', '--cached', '--', filePath], repoPath).catch(() => '');
                const unstagedDiff = await this.git(['diff', '--', filePath], repoPath).catch(() => '');
                diffContent = (stagedDiff + '\n' + unstagedDiff).trim();
              }

              // Truncate to 2000 chars per file for better AI analysis
              if (diffContent.length > 2000) {
                diffContent = diffContent.substring(0, 2000) + '\n... (truncated)';
              }
            } catch {
              diffContent = '(binary or large file)';
            }
          }
        } catch {
          // Ignore diff errors for individual files
        }

        totalAdditions += additions;
        totalDeletions += deletions;

        files.push({
          path: filePath,
          status,
          additions,
          deletions,
          diff: diffContent,
        });
      }

      // Build a human-readable summary
      const summaryParts: string[] = [];

      // Categorize changes
      const addedFiles = files.filter(f => f.status === 'added');
      const modifiedFiles = files.filter(f => f.status === 'modified');
      const deletedFiles = files.filter(f => f.status === 'deleted');

      if (addedFiles.length > 0) {
        summaryParts.push(`Added ${addedFiles.length} file(s): ${addedFiles.slice(0, 3).map(f => path.basename(f.path)).join(', ')}${addedFiles.length > 3 ? '...' : ''}`);
      }
      if (modifiedFiles.length > 0) {
        summaryParts.push(`Modified ${modifiedFiles.length} file(s): ${modifiedFiles.slice(0, 3).map(f => path.basename(f.path)).join(', ')}${modifiedFiles.length > 3 ? '...' : ''}`);
      }
      if (deletedFiles.length > 0) {
        summaryParts.push(`Deleted ${deletedFiles.length} file(s): ${deletedFiles.slice(0, 3).map(f => path.basename(f.path)).join(', ')}${deletedFiles.length > 3 ? '...' : ''}`);
      }

      // Add type breakdown
      const typeBreakdown = Object.entries(filesByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ext, count]) => `${ext}: ${count}`)
        .join(', ');

      if (typeBreakdown) {
        summaryParts.push(`File types: ${typeBreakdown}`);
      }

      return {
        totalFiles: files.length,
        totalAdditions,
        totalDeletions,
        filesByType,
        summary: summaryParts.join('\n'),
        files,
      };
    }, 'GIT_GET_DIFF_SUMMARY_FAILED');
  }

  // ==========================================================================
  // COMMIT HISTORY OPERATIONS
  // ==========================================================================

  /**
   * Get commit history for a branch since divergence from base branch
   * Used by CommitsTab to show all commits in a session
   */
  async getCommitHistory(
    repoPath: string,
    baseBranch = 'main',
    limit = 50,
    branchName?: string
  ): Promise<IpcResult<GitCommitWithFiles[]>> {
    return this.wrap(async () => {
      const logFormat = '%H|%h|%s|%an|%aI';

      // Helper to run git log and parse output
      const runGitLog = async (args: string[]): Promise<string> => {
        return this.git([
          'log',
          ...args,
          `--format=${logFormat}`,
          '--shortstat',
          `-${limit}`,
        ], repoPath);
      };

      // If branchName is provided, scope commits to only those on this branch since baseBranch
      // This filters to session-specific commits instead of entire repo history
      let logOutput: string;
      if (branchName) {
        try {
          // Show only commits on branchName that are not on baseBranch
          logOutput = await runGitLog([`${baseBranch}..${branchName}`]);
        } catch {
          // Fallback: if baseBranch doesn't exist or range fails, get commits from branchName HEAD
          logOutput = await runGitLog([branchName]);
        }
      } else {
        // No branch specified — get recent commits from HEAD (legacy behavior)
        logOutput = await runGitLog([]);
      }

      const commits: GitCommitWithFiles[] = [];
      const lines = logOutput.split('\n');

      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) {
          i++;
          continue;
        }

        // Check if line contains commit info (has | separators)
        if (line.includes('|')) {
          const [hash, shortHash, message, author, date] = line.split('|');

          const commit: GitCommitWithFiles = {
            hash,
            shortHash,
            message,
            author,
            date,
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          };

          // Next lines might be stats (git adds blank line before stats)
          i++;
          // Skip blank lines to find stats
          while (i < lines.length && !lines[i].trim()) {
            i++;
          }
          if (i < lines.length) {
            const statsLine = lines[i].trim();
            // Parse: "3 files changed, 120 insertions(+), 30 deletions(-)"
            // Also handles: "1 file changed, 22 insertions(+)"
            const filesMatch = statsLine.match(/(\d+) files? changed/);
            const addMatch = statsLine.match(/(\d+) insertions?\(\+\)/);
            const delMatch = statsLine.match(/(\d+) deletions?\(-\)/);

            if (filesMatch || addMatch || delMatch) {
              commit.filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
              commit.additions = addMatch ? parseInt(addMatch[1], 10) : 0;
              commit.deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
              i++;
            }
          }

          commits.push(commit);
        } else {
          i++;
        }
      }

      return commits;
    }, 'GIT_GET_COMMIT_HISTORY_FAILED');
  }

  /**
   * Get detailed diff for a specific commit
   * Used when user expands a commit to see file-by-file changes
   */
  async getCommitDiff(repoPath: string, commitHash: string): Promise<IpcResult<CommitDiffDetail>> {
    return this.wrap(async () => {
      // Get commit info
      const logOutput = await this.git([
        'log',
        '-1',
        '--format=%H|%h|%s|%an|%aI',
        '--shortstat',
        commitHash,
      ], repoPath);

      const lines = logOutput.split('\n');
      const [hash, shortHash, message, author, date] = lines[0].split('|');

      let filesChanged = 0;
      let additions = 0;
      let deletions = 0;

      if (lines[1]) {
        const statsLine = lines[1].trim();
        const filesMatch = statsLine.match(/(\d+) files? changed/);
        const addMatch = statsLine.match(/(\d+) insertions?\(\+\)/);
        const delMatch = statsLine.match(/(\d+) deletions?\(-\)/);
        filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
        additions = addMatch ? parseInt(addMatch[1], 10) : 0;
        deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
      }

      const commit: GitCommitWithFiles = {
        hash,
        shortHash,
        message,
        author,
        date,
        filesChanged,
        additions,
        deletions,
      };

      // Get list of files changed in commit with their stats
      const numstatOutput = await this.git([
        'diff-tree',
        '--no-commit-id',
        '--numstat',
        '-r',
        commitHash,
      ], repoPath);

      const nameStatusOutput = await this.git([
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        commitHash,
      ], repoPath);

      // Build file stats map
      const fileStats = new Map<string, { additions: number; deletions: number }>();
      for (const line of numstatOutput.split('\n').filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        fileStats.set(filePath, {
          additions: add === '-' ? 0 : parseInt(add, 10),
          deletions: del === '-' ? 0 : parseInt(del, 10),
        });
      }

      // Build file status map
      const fileStatusMap = new Map<string, string>();
      for (const line of nameStatusOutput.split('\n').filter(Boolean)) {
        const [statusChar, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        let status = 'modified';
        switch (statusChar[0]) {
          case 'A': status = 'added'; break;
          case 'M': status = 'modified'; break;
          case 'D': status = 'deleted'; break;
          case 'R': status = 'renamed'; break;
          case 'C': status = 'copied'; break;
        }
        fileStatusMap.set(filePath, status);
      }

      // Get diffs for each file
      const files: CommitDiffDetail['files'] = [];

      for (const [filePath, stats] of fileStats) {
        const status = fileStatusMap.get(filePath) || 'modified';

        // Get the actual diff for this file
        let diff = '';
        try {
          diff = await this.git([
            'diff',
            `${commitHash}^..${commitHash}`,
            '--',
            filePath,
          ], repoPath);
        } catch {
          // Might fail for first commit, try without parent
          try {
            diff = await this.git([
              'show',
              commitHash,
              '--',
              filePath,
            ], repoPath);
          } catch {
            diff = '(diff not available)';
          }
        }

        // Truncate large diffs
        const maxDiffLength = 5000;
        if (diff.length > maxDiffLength) {
          diff = diff.substring(0, maxDiffLength) + '\n... (diff truncated, ' + (diff.length - maxDiffLength) + ' more characters)';
        }

        // Detect language from extension
        const ext = path.extname(filePath).toLowerCase();
        const languageMap: Record<string, string> = {
          '.ts': 'typescript',
          '.tsx': 'typescript',
          '.js': 'javascript',
          '.jsx': 'javascript',
          '.json': 'json',
          '.md': 'markdown',
          '.css': 'css',
          '.scss': 'scss',
          '.html': 'html',
          '.yaml': 'yaml',
          '.yml': 'yaml',
          '.py': 'python',
          '.go': 'go',
          '.rs': 'rust',
          '.java': 'java',
          '.sql': 'sql',
        };

        files.push({
          path: filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          diff,
          language: languageMap[ext] || 'text',
        });
      }

      // Also populate files array on commit
      commit.files = files.map(f => ({
        path: f.path,
        status: f.status as 'added' | 'modified' | 'deleted' | 'renamed',
        additions: f.additions,
        deletions: f.deletions,
      }));

      return { commit, files };
    }, 'GIT_GET_COMMIT_DIFF_FAILED');
  }
}
