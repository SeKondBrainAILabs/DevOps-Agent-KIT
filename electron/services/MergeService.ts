/**
 * Merge Service
 * Handles merge preview and execution for the merge workflow modal
 */

import { BaseService } from './BaseService';
import type { IpcResult, MergePreview, MergeResult } from '../../shared/types';
import { promises as fs } from 'fs';
import path from 'path';

// Dynamic import helper for execa (ESM-only module)
// Handles various bundling scenarios with fallback patterns
let _execa: ((cmd: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string; exitCode?: number }>) | null = null;

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

export class MergeService extends BaseService {
  // Dependency references (set via setters after construction)
  private mergeConflictService: any = null;
  private rebaseWatcher: any = null;
  private agentInstanceService: any = null;
  private lockService: any = null;

  setMergeConflictService(service: any): void {
    this.mergeConflictService = service;
  }

  setRebaseWatcher(service: any): void {
    this.rebaseWatcher = service;
  }

  setAgentInstanceService(service: any): void {
    this.agentInstanceService = service;
  }

  setLockService(service: any): void {
    this.lockService = service;
  }

  /**
   * Execute a git command (uses dynamic import for ESM-only execa)
   */
  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const execa = await getExeca();
      const result = await execa('git', args, { cwd, reject: false });
      return { stdout: result.stdout.trim(), stderr: (result.stderr || '').trim(), exitCode: result.exitCode ?? 0 };
    } catch (error) {
      return { stdout: '', stderr: error instanceof Error ? error.message : '', exitCode: 1 };
    }
  }

  /**
   * Parse "untracked working tree files would be overwritten" error from git stderr.
   * Returns the list of blocking files, or null if not this type of error.
   */
  private parseUntrackedBlockingFiles(stderr: string): string[] | null {
    if (!stderr.includes('untracked working tree files would be overwritten')) {
      return null;
    }
    // Git error format:
    // error: The following untracked working tree files would be overwritten by merge:
    //     path/to/file1
    //     path/to/file2
    // Please move or remove them before you merge.
    const lines = stderr.split('\n');
    const blockingFiles: string[] = [];
    let capturing = false;
    for (const line of lines) {
      if (line.includes('untracked working tree files would be overwritten')) {
        capturing = true;
        continue;
      }
      if (capturing) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Please ') || trimmed === 'Aborting' || trimmed === '') {
          capturing = false;
          continue;
        }
        if (trimmed) {
          blockingFiles.push(trimmed);
        }
      }
    }
    return blockingFiles.length > 0 ? blockingFiles : null;
  }

  /**
   * Stash untracked files that are blocking a merge, then attempt the merge.
   * Uses `git stash --include-untracked` to safely preserve the files.
   * After merge, user can pop the stash if needed.
   *
   * Flow:
   * 1. Stage the blocking untracked files
   * 2. Stash them with a descriptive message
   * 3. Return stash info so UI can show what happened
   */
  async cleanUntrackedBlockingFiles(
    repoPath: string,
    blockingFiles: string[]
  ): Promise<IpcResult<{ stashed: string[]; failed: string[]; stashRef: string }>> {
    return this.wrap(async () => {
      const stashed: string[] = [];
      const failed: string[] = [];

      // First, stage each blocking untracked file individually
      for (const file of blockingFiles) {
        const fullPath = path.join(repoPath, file);
        try {
          await fs.access(fullPath);
          const { exitCode } = await this.git(['add', file], repoPath);
          if (exitCode === 0) {
            stashed.push(file);
            console.log(`[MergeService] Staged blocking file for stash: ${file}`);
          } else {
            failed.push(file);
          }
        } catch {
          // File doesn't exist, skip
          console.warn(`[MergeService] Blocking file not found, skipping: ${file}`);
        }
      }

      if (stashed.length === 0) {
        return { stashed: [], failed: blockingFiles, stashRef: '' };
      }

      // Stash the staged files with a descriptive message
      const stashMsg = `[Kanvas] Pre-merge stash: ${stashed.length} untracked file(s) blocking merge`;
      const { exitCode: stashExit } = await this.git(['stash', 'push', '-m', stashMsg], repoPath);

      if (stashExit !== 0) {
        // Unstage and fail
        await this.git(['reset', 'HEAD', '--', ...stashed], repoPath);
        return { stashed: [], failed: blockingFiles, stashRef: '' };
      }

      // Get the stash ref
      const { stdout: stashRef } = await this.git(['stash', 'list', '--max-count=1'], repoPath);
      console.log(`[MergeService] Stashed ${stashed.length} blocking files: ${stashRef}`);

      return { stashed, failed, stashRef };
    }, 'CLEAN_UNTRACKED_FAILED');
  }

  /**
   * Pop a pre-merge stash after successful merge.
   * If stash pop has conflicts, attempts LLM resolution then graceful degradation.
   */
  private async popStashAfterMerge(
    repoPath: string
  ): Promise<{ stashRecovered: boolean; stashConflictFiles?: string[] }> {
    // Check for a Kanvas pre-merge stash entry
    const { stdout: stashList } = await this.git(['stash', 'list', '--max-count=1'], repoPath);
    if (!stashList.includes('[Kanvas] Pre-merge stash')) {
      return { stashRecovered: true }; // Nothing to pop
    }

    console.log(`[MergeService] Found pre-merge stash, attempting pop...`);

    // Attempt stash pop
    const { exitCode: popExit } = await this.git(['stash', 'pop'], repoPath);
    if (popExit === 0) {
      console.log(`[MergeService] Stash pop succeeded`);
      return { stashRecovered: true };
    }

    // Stash pop had conflicts — try to resolve them
    console.log(`[MergeService] Stash pop had conflicts, attempting resolution...`);
    const { stdout: conflictOutput } = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
    const conflictFiles = conflictOutput.split('\n').filter(Boolean);

    if (conflictFiles.length === 0) {
      // No actual conflicts reported, stash pop might have succeeded partially
      return { stashRecovered: true };
    }

    // Protected files that we skip AI resolution for
    const protectedPatterns = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.env'];
    const resolvableFiles = conflictFiles.filter(
      (f) => !protectedPatterns.some((p) => f.endsWith(p))
    );
    const unresolved: string[] = [...conflictFiles.filter(
      (f) => protectedPatterns.some((p) => f.endsWith(p))
    )];

    // Try LLM resolution for each non-protected conflict file
    if (this.mergeConflictService && resolvableFiles.length > 0) {
      for (const file of resolvableFiles) {
        try {
          const result = await this.mergeConflictService.resolveFileConflict(
            repoPath, file, 'HEAD', 'stash'
          );
          if (result.success && result.data?.resolved) {
            await this.git(['add', file], repoPath);
            console.log(`[MergeService] LLM resolved stash conflict: ${file}`);
          } else {
            unresolved.push(file);
          }
        } catch {
          unresolved.push(file);
        }
      }
    } else {
      unresolved.push(...resolvableFiles);
    }

    // Check if all conflicts are resolved
    const { stdout: remaining } = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
    const remainingConflicts = remaining.split('\n').filter(Boolean);

    if (remainingConflicts.length === 0) {
      console.log(`[MergeService] All stash conflicts resolved`);
      return { stashRecovered: true };
    }

    // Unresolvable: prefer merged version, drop stash
    console.warn(`[MergeService] ${remainingConflicts.length} stash conflicts unresolvable, using merged version`);
    await this.git(['checkout', '--theirs', '.'], repoPath);
    await this.git(['add', '.'], repoPath);
    await this.git(['stash', 'drop'], repoPath);

    return { stashRecovered: false, stashConflictFiles: remainingConflicts };
  }

  /**
   * Preview a merge without actually executing it
   */
  async previewMerge(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<IpcResult<MergePreview>> {
    return this.wrap(async () => {
      // Fetch latest from remote
      await this.git(['fetch', 'origin'], repoPath);

      // Get current branch
      const { stdout: currentBranch } = await this.git(['branch', '--show-current'], repoPath);

      // Check if we need to checkout target branch first
      const needsCheckout = currentBranch !== targetBranch;

      // Get ahead/behind counts
      const { stdout: revList } = await this.git(
        ['rev-list', '--left-right', '--count', `${targetBranch}...${sourceBranch}`],
        repoPath
      );
      const [behindBy, aheadBy] = revList.split('\t').map(Number);

      // Get commit count between branches
      const { stdout: commitCountStr } = await this.git(
        ['rev-list', '--count', `${targetBranch}..${sourceBranch}`],
        repoPath
      );
      const commitCount = parseInt(commitCountStr, 10) || 0;

      // Get files that would be changed
      const { stdout: diffOutput } = await this.git(
        ['diff', '--numstat', `${targetBranch}...${sourceBranch}`],
        repoPath
      );

      const filesChanged = diffOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, path] = line.split('\t');
          return {
            path,
            additions: parseInt(additions, 10) || 0,
            deletions: parseInt(deletions, 10) || 0,
            status: 'modified' as const,
          };
        });

      // Check for conflicts by doing a dry-run merge
      let hasConflicts = false;
      let conflictingFiles: string[] = [];
      let canMerge = true;
      let untrackedBlockingFiles: string[] | undefined;
      let blockingError: string | undefined;

      // Save current state
      const { stdout: currentHead } = await this.git(['rev-parse', 'HEAD'], repoPath);

      try {
        // Attempt merge without committing
        const { exitCode, stderr } = await this.git(
          ['merge', '--no-commit', '--no-ff', sourceBranch],
          repoPath
        );

        if (exitCode !== 0) {
          // Check if this is an untracked files blocking error
          const blockingFiles = this.parseUntrackedBlockingFiles(stderr);
          if (blockingFiles) {
            hasConflicts = true;
            canMerge = false;
            untrackedBlockingFiles = blockingFiles;
            blockingError = 'Untracked files would be overwritten by merge. These can be auto-cleaned.';
            console.log(`[MergeService] Untracked files blocking merge: ${blockingFiles.join(', ')}`);
          } else {
            hasConflicts = true;
            canMerge = false;

            // Get conflicting files (real code-level conflicts)
            const { stdout: conflictOutput } = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
            conflictingFiles = conflictOutput.split('\n').filter(Boolean);
          }
        }
      } catch {
        hasConflicts = true;
        canMerge = false;
      } finally {
        // Always abort the test merge
        await this.git(['merge', '--abort'], repoPath);
        // Reset to original state
        await this.git(['reset', '--hard', currentHead], repoPath);
      }

      // Check for cross-session file overlaps (Phase 3B)
      let crossSessionOverlaps: Array<{ file: string; sessionId: string }> | undefined;
      if (this.lockService && filesChanged.length > 0) {
        try {
          const locksResult = await this.lockService.getRepoLocks(repoPath);
          if (locksResult.success && locksResult.data) {
            const { locksBySession } = locksResult.data;
            const overlaps: Array<{ file: string; sessionId: string }> = [];
            const changedPaths = filesChanged.map((f: { path: string }) => f.path);
            for (const [sid, lockedFiles] of Object.entries(locksBySession) as [string, string[]][]) {
              for (const lockedFile of lockedFiles) {
                if (changedPaths.includes(lockedFile)) {
                  overlaps.push({ file: lockedFile, sessionId: sid });
                }
              }
            }
            if (overlaps.length > 0) {
              crossSessionOverlaps = overlaps;
              console.log(`[MergeService] Cross-session overlaps detected: ${overlaps.length} file(s)`);
            }
          }
        } catch {
          // Non-fatal: overlap detection is informational only
        }
      }

      return {
        sourceBranch,
        targetBranch,
        canMerge,
        hasConflicts,
        conflictingFiles,
        filesChanged,
        commitCount,
        aheadBy: aheadBy || 0,
        behindBy: behindBy || 0,
        untrackedBlockingFiles,
        blockingError,
        crossSessionOverlaps,
      };
    }, 'MERGE_PREVIEW_FAILED');
  }

  /**
   * Execute a merge
   */
  async executeMerge(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options: {
      deleteWorktree?: boolean;
      deleteLocalBranch?: boolean;
      deleteRemoteBranch?: boolean;
      worktreePath?: string;
    } = {}
  ): Promise<IpcResult<MergeResult>> {
    return this.wrap(async () => {
      let didStash = false;

      // Ensure .S9N_KIT_DevOpsAgent/ is in .gitignore of the target repo
      // This prevents agent artifacts from blocking merges
      await this.ensureAgentArtifactsIgnored(repoPath);

      // CRITICAL: If worktreePath provided, commit any uncommitted changes first!
      // This prevents data loss when user has uncommitted changes in the worktree.
      if (options.worktreePath) {
        console.log(`[MergeService] Checking for uncommitted changes in worktree: ${options.worktreePath}`);
        try {
          const { stdout: statusOutput } = await this.git(['status', '--porcelain'], options.worktreePath);
          if (statusOutput.trim()) {
            console.log(`[MergeService] Found uncommitted changes, committing before merge...`);

            // Stage all changes
            await this.git(['add', '-A'], options.worktreePath);

            // Commit with auto-commit message
            await this.git(
              ['commit', '-m', '[Kanvas] Auto-commit uncommitted changes before merge'],
              options.worktreePath
            );

            // Push to ensure source branch has all changes before merge
            console.log(`[MergeService] Pushing committed changes to origin/${sourceBranch}...`);
            await this.git(['push', 'origin', sourceBranch], options.worktreePath);

            console.log(`[MergeService] Successfully committed and pushed uncommitted changes`);
          } else {
            console.log(`[MergeService] No uncommitted changes in worktree`);
          }
        } catch (commitError) {
          const errorMsg = commitError instanceof Error ? commitError.message : String(commitError);
          console.error(`[MergeService] Failed to commit uncommitted changes: ${errorMsg}`);
          // Don't fail the merge - just warn. User may have already committed.
          if (!errorMsg.includes('nothing to commit')) {
            console.warn(`[MergeService] Proceeding with merge despite commit error`);
          }
        }
      }

      // Get current branch
      const { stdout: currentBranch } = await this.git(['branch', '--show-current'], repoPath);

      // Checkout target branch if needed
      if (currentBranch !== targetBranch) {
        const { exitCode } = await this.git(['checkout', targetBranch], repoPath);
        if (exitCode !== 0) {
          throw new Error(`Failed to checkout ${targetBranch}`);
        }
      }

      // Pull latest changes
      await this.git(['pull', 'origin', targetBranch], repoPath);

      // Perform the merge
      let mergeResult = await this.git(
        ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch}`],
        repoPath
      );

      // Handle untracked files blocking the merge - stash and retry
      if (mergeResult.exitCode !== 0) {
        const blockingFiles = this.parseUntrackedBlockingFiles(mergeResult.stderr);
        if (blockingFiles && blockingFiles.length > 0) {
          console.log(`[MergeService] Untracked files blocking merge, stashing: ${blockingFiles.join(', ')}`);

          const cleanResult = await this.cleanUntrackedBlockingFiles(repoPath, blockingFiles);
          if (cleanResult.success && cleanResult.data && cleanResult.data.failed.length === 0) {
            didStash = true;
            console.log(`[MergeService] Stashed ${cleanResult.data.stashed.length} blocking files (${cleanResult.data.stashRef}), retrying merge...`);

            // Retry the merge after stashing
            mergeResult = await this.git(
              ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch}`],
              repoPath
            );
          } else {
            // Could not stash all blocking files
            const failedFiles = cleanResult.data?.failed || blockingFiles;
            return {
              success: false,
              message: `Untracked files blocking merge could not be stashed: ${failedFiles.join(', ')}. Please move or remove them manually.`,
              conflictingFiles: blockingFiles,
            };
          }
        }
      }

      if (mergeResult.exitCode !== 0) {
        // Get conflicting files
        const { stdout: conflictOutput } = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
        const conflictingFiles = conflictOutput.split('\n').filter(Boolean);

        // Abort the merge
        await this.git(['merge', '--abort'], repoPath);

        return {
          success: false,
          message: 'Merge failed due to conflicts',
          conflictingFiles,
        };
      }

      // Get merge commit hash
      const { stdout: mergeCommitHash } = await this.git(['rev-parse', 'HEAD'], repoPath);

      // Get files changed count
      const { stdout: diffStatOutput } = await this.git(
        ['diff', '--stat', `${targetBranch}@{1}..HEAD`],
        repoPath
      );
      const filesChangedMatch = diffStatOutput.match(/(\d+) files? changed/);
      const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0;

      // Push merged changes
      await this.git(['push', 'origin', targetBranch], repoPath);

      // Auto-pop stash if we stashed files before merge
      let stashRecovered: boolean | undefined;
      let stashConflictFiles: string[] | undefined;
      if (didStash) {
        try {
          const stashResult = await this.popStashAfterMerge(repoPath);
          stashRecovered = stashResult.stashRecovered;
          stashConflictFiles = stashResult.stashConflictFiles;
        } catch (err) {
          console.warn(`[MergeService] Stash pop failed:`, err);
          stashRecovered = false;
        }
      }

      // Trigger rebase checks for sibling sessions (Phase 3A)
      if (this.rebaseWatcher && this.agentInstanceService) {
        try {
          const instances = this.agentInstanceService.listInstances();
          if (instances.success && instances.data) {
            const siblings = instances.data.filter((inst: any) => {
              const config = inst.config;
              return (
                config &&
                config.repoPath === repoPath &&
                config.baseBranch === targetBranch &&
                config.branchName !== sourceBranch &&
                inst.status === 'active'
              );
            });
            for (const sibling of siblings) {
              try {
                await this.rebaseWatcher.forceCheck(sibling.sessionId);
                console.log(`[MergeService] Triggered rebase check for sibling session: ${sibling.sessionId}`);
              } catch {
                // Non-fatal: sibling may not be in rebase watcher
              }
            }
          }
        } catch (err) {
          console.warn(`[MergeService] Sibling rebase trigger failed:`, err);
        }
      }

      // Cleanup: Delete worktree if requested
      if (options.deleteWorktree && options.worktreePath) {
        await this.git(['worktree', 'remove', options.worktreePath, '--force'], repoPath);
        await this.git(['worktree', 'prune'], repoPath);
      }

      // Cleanup: Delete local branch if requested
      if (options.deleteLocalBranch) {
        await this.git(['branch', '-D', sourceBranch], repoPath);
      }

      // Cleanup: Delete remote branch if requested
      if (options.deleteRemoteBranch) {
        await this.git(['push', 'origin', '--delete', sourceBranch], repoPath);
      }

      return {
        success: true,
        message: `Successfully merged ${sourceBranch} into ${targetBranch}`,
        mergeCommitHash,
        filesChanged,
        stashRecovered,
        stashConflictFiles,
      };
    }, 'MERGE_EXECUTE_FAILED');
  }

  /**
   * Ensure agent artifacts (.S9N_KIT_DevOpsAgent/) are in the repo's .gitignore.
   * This prevents untracked agent files from blocking git merge/checkout operations.
   */
  private async ensureAgentArtifactsIgnored(repoPath: string): Promise<void> {
    const gitignorePath = path.join(repoPath, '.gitignore');
    const agentDir = '.S9N_KIT_DevOpsAgent';

    try {
      let content = '';
      try {
        content = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist yet
      }

      if (!content.includes(agentDir)) {
        content += `\n# DevOps Agent Kit (local runtime data - do not commit)\n${agentDir}/\n`;
        await fs.writeFile(gitignorePath, content, 'utf-8');
        console.log(`[MergeService] Added ${agentDir}/ to .gitignore in ${repoPath}`);
      }
    } catch (err) {
      console.warn(`[MergeService] Could not update .gitignore: ${err}`);
    }
  }

  /**
   * Resolve the actual active branch inside a worktree or repo path.
   * This is critical because the session's branchName may differ from the
   * branch the developer actually switched to inside the worktree.
   */
  async resolveActiveBranch(dirPath: string): Promise<IpcResult<string>> {
    return this.wrap(async () => {
      const { stdout: branch, exitCode } = await this.git(['branch', '--show-current'], dirPath);
      if (exitCode !== 0 || !branch) {
        throw new Error(`Could not resolve active branch in ${dirPath}`);
      }
      console.log(`[MergeService] Resolved active branch in ${dirPath}: ${branch}`);
      return branch;
    }, 'RESOLVE_BRANCH_FAILED');
  }

  /**
   * Abort an in-progress merge
   */
  async abortMerge(repoPath: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      await this.git(['merge', '--abort'], repoPath);
    }, 'MERGE_ABORT_FAILED');
  }
}
