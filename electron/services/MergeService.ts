/**
 * Merge Service
 * Handles merge preview and execution for the merge workflow modal
 */

import { BaseService } from './BaseService';
import type { IpcResult, MergePreview, MergeResult } from '../../shared/types';
import { promises as fs } from 'fs';
import path from 'path';
import {
  acquireHistoryRewriteLock,
  evaluateAutoCommitGuardForWorktree,
  releaseHistoryRewriteLock,
} from './GitRewriteGuardIO';
import { evaluateRebaseTipGuard } from '../../shared/rebase-tip-guard';

// Parse the porcelain output of `git worktree list --porcelain` and return
// the worktree path that currently has `branch` checked out, or null if no
// worktree holds it. The porcelain format is blank-line-separated records of:
//   worktree /path/to/dir
//   HEAD <sha>
//   branch refs/heads/<branch-name>
// (Some records have `detached` or `bare` instead of branch.)
function parseWorktreeHoldingBranch(porcelain: string, branch: string): string | null {
  const records = porcelain.split('\n\n');
  for (const record of records) {
    const lines = record.split('\n');
    let worktree: string | null = null;
    let onBranch: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) onBranch = line.slice('branch '.length).trim();
    }
    if (worktree && onBranch === `refs/heads/${branch}`) return worktree;
  }
  return null;
}

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
  private activityService: any = null;
  private debugLog: { warn: (source: string, message: string, details?: unknown) => void } | null = null;

  setDebugLog(debugLog: { warn: (source: string, message: string, details?: unknown) => void }): void {
    this.debugLog = debugLog;
  }

  setMergeConflictService(service: any): void {
    this.mergeConflictService = service;
  }

  setRebaseWatcher(service: any): void {
    this.rebaseWatcher = service;
  }

  setAgentInstanceService(service: any): void {
    this.agentInstanceService = service;
  }

  setActivityService(service: any): void {
    this.activityService = service;
  }

  /**
   * Look up the live AgentInstance whose config matches (repoPath, sourceBranch),
   * so we can attribute merge activity to its sessionId. Returns the matching
   * sessionId if found, otherwise `undefined` — the caller should skip logging
   * rather than logging to an unknown session.
   */
  private findSourceSessionId(repoPath: string, sourceBranch: string): string | undefined {
    if (!this.agentInstanceService) return undefined;
    try {
      const result = this.agentInstanceService.listInstances();
      if (!result?.success || !Array.isArray(result.data)) return undefined;
      for (const inst of result.data) {
        const cfg = inst?.config;
        if (
          cfg?.repoPath === repoPath &&
          cfg?.branchName === sourceBranch &&
          inst.status !== 'completed' &&
          inst.status !== 'failed' &&
          inst.status !== 'closed' &&
          inst.sessionId
        ) {
          return inst.sessionId as string;
        }
      }
    } catch {
      // Non-fatal — skip attribution.
    }
    return undefined;
  }

  /**
   * Convenience: write a merge-related entry to the activity feed if we can
   * figure out which session owns the source branch. No-op if we can't (e.g.
   * merge initiated from the workspace browser with no live agent on that
   * branch).
   */
  private logActivity(
    repoPath: string,
    sourceBranch: string,
    type: string,
    message: string,
    details?: unknown
  ): void {
    if (!this.activityService) return;
    const sid = this.findSourceSessionId(repoPath, sourceBranch);
    if (!sid) return;
    try {
      this.activityService.log(sid, type, message, details);
    } catch {
      // Non-fatal.
    }
  }

  setLockService(service: any): void {
    this.lockService = service;
  }

  /**
   * Execute a git command (uses dynamic import for ESM-only execa)
   */
  /**
   * Replace KIT-bookkeeping files on the source branch with target's versions
   * before the merge runs, so they can never produce conflicts. Only touches
   * files whose blob actually differs between target and source — no-op
   * commit when the files are already in sync. Uses `git fetch` + `git
   * checkout origin/<target> -- <file>` (or local target ref if no remote).
   *
   * Safe by construction: only modifies KIT_BOOKKEEPING_FILES, which carry
   * per-worktree identifiers that have no business propagating into shared
   * branches. If any file in the list isn't tracked, it's silently skipped.
   */
  /**
   * S9N-6394 pre-merge gate for protected targets (main/master/production/
   * release). Blocks the merge when either:
   *
   *   (a) `gh pr checks` on the source branch reports any FAILURE / PENDING /
   *       ERROR / CANCELLED / TIMED_OUT check — or the tool is unavailable.
   *       Uses --required so informational-only workflows don't false-fail;
   *       falls back to `gh run list --branch --limit 5` when the branch has
   *       no PR (still catches broken workflow runs).
   *   (b) The source-branch commits contain a WIP:/[Kanvas]/[Kanvas Restart]
   *       auto-checkpoint tip. These were the exact class of commit
   *       (a mid-write file, "WIP: pre-sync commit") that broke Core_Kora_
   *       ChromeExt main in the incident that spawned the ticket.
   *
   * Both are recoverable via options.skipCiGate=true, which the UI surfaces
   * as an explicit "Merge without CI check" affordance. The default path
   * refuses so agent-driven merges cannot ship a red or mid-write state.
   */
  private async checkMergeGate(
    worktreePath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<{ ok: true } | { ok: false; message: string; reason: 'CI_RED' | 'CI_PENDING' | 'WIP_COMMITS' | 'GH_UNAVAILABLE' | 'CI_UNKNOWN'; details?: unknown }> {
    // (b) — cheap, no subprocess: scan commit messages between source and
    // target. Do this first so a WIP tip fails fast before we spend the
    // gh-CLI round-trip.
    try {
      const range = `origin/${targetBranch}..${sourceBranch}`;
      const { stdout: log } = await this.git(['log', range, '--format=%H%x09%s'], worktreePath);
      const wipHits: Array<{ sha: string; subject: string }> = [];
      for (const line of log.split('\n')) {
        if (!line) continue;
        const [sha, ...rest] = line.split('\t');
        const subject = rest.join('\t');
        if (/^WIP:/.test(subject) ||
            /^\[Kanvas\]/.test(subject) ||
            /^\[Kanvas Restart\]/.test(subject) ||
            /pre-sync commit/i.test(subject)) {
          wipHits.push({ sha: sha.slice(0, 8), subject });
        }
      }
      if (wipHits.length > 0) {
        const list = wipHits.slice(0, 4).map(h => `  ${h.sha} ${h.subject}`).join('\n');
        const more = wipHits.length > 4 ? `\n  ...and ${wipHits.length - 4} more` : '';
        return {
          ok: false,
          reason: 'WIP_COMMITS',
          message:
            `Refused merge into '${targetBranch}': source '${sourceBranch}' has ${wipHits.length} ` +
            `WIP / Kanvas auto-checkpoint commit${wipHits.length > 1 ? 's' : ''} that must not reach a protected branch.\n\n` +
            `${list}${more}\n\n` +
            `Interactive-rebase to squash them (\`git rebase -i origin/${targetBranch}\`), or ` +
            `use "Merge without CI check" if you're sure the tips are safe.`,
          details: { wipCommits: wipHits },
        };
      }
    } catch {
      // Non-fatal — if we can't inspect the range (branch not pushed, etc.)
      // fall through to the CI check.
    }

    // (a) — gh CLI. Missing gh isn't a hard fail, but we still refuse the
    // merge with a clear message so the user installs it or overrides.
    const runGh = async (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> => {
      try {
        const mod: any = await import('execa');
        const execa = typeof mod.execa === 'function' ? mod.execa
          : typeof mod.default === 'function' ? mod.default
          : mod.default?.execa;
        const r = await execa('gh', args, { cwd: worktreePath, timeout: 30_000, reject: false });
        return { ok: r.exitCode === 0, stdout: r.stdout || '', stderr: r.stderr || '', code: r.exitCode ?? -1 };
      } catch (err: any) {
        return { ok: false, stdout: '', stderr: err?.message || String(err), code: -1 };
      }
    };

    // Prefer PR-level checks (matches how the team gates in GitHub).
    const prChecks = await runGh(['pr', 'checks', sourceBranch, '--required', '--json', 'name,state,bucket']);
    if (prChecks.code === -1 && /command not found|ENOENT/i.test(prChecks.stderr)) {
      return {
        ok: false,
        reason: 'GH_UNAVAILABLE',
        message:
          `Refused merge into '${targetBranch}': gh CLI not installed. Install \`gh\` ` +
          `and authenticate (\`gh auth login\`) so KIT can verify CI is green, or override ` +
          `with "Merge without CI check" if you've verified manually.`,
      };
    }
    if (prChecks.ok && prChecks.stdout.trim()) {
      try {
        const checks = JSON.parse(prChecks.stdout) as Array<{ name: string; state: string; bucket?: string }>;
        const bad = checks.filter(c => {
          const state = (c.state || '').toUpperCase();
          const bucket = (c.bucket || '').toLowerCase();
          return state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT'
            || bucket === 'fail' || bucket === 'cancel';
        });
        const pending = checks.filter(c => {
          const state = (c.state || '').toUpperCase();
          const bucket = (c.bucket || '').toLowerCase();
          return state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED'
            || bucket === 'pending';
        });
        if (bad.length > 0) {
          const list = bad.slice(0, 5).map(c => `  ${c.name}: ${c.state}`).join('\n');
          return {
            ok: false,
            reason: 'CI_RED',
            message:
              `Refused merge into '${targetBranch}': ${bad.length} required CI check${bad.length > 1 ? 's are' : ' is'} failing on '${sourceBranch}'.\n\n${list}\n\n` +
              `Fix the failing check${bad.length > 1 ? 's' : ''} and rerun, or override with "Merge without CI check" if this is expected.`,
            details: { failing: bad },
          };
        }
        if (pending.length > 0) {
          const list = pending.slice(0, 5).map(c => `  ${c.name}: ${c.state}`).join('\n');
          return {
            ok: false,
            reason: 'CI_PENDING',
            message:
              `Refused merge into '${targetBranch}': ${pending.length} required CI check${pending.length > 1 ? 's are' : ' is'} still running on '${sourceBranch}'.\n\n${list}\n\n` +
              `Wait for green — or override with "Merge without CI check" if you must.`,
            details: { pending },
          };
        }
        return { ok: true };
      } catch {
        // Fall through to branch-level check
      }
    }

    // Fallback: no PR (or gh pr checks returned nothing) → check latest run on the branch.
    const runList = await runGh(['run', 'list', '--branch', sourceBranch, '--limit', '5', '--json', 'status,conclusion,name,url']);
    if (runList.ok && runList.stdout.trim()) {
      try {
        const runs = JSON.parse(runList.stdout) as Array<{ status: string; conclusion: string | null; name: string; url: string }>;
        if (runs.length === 0) {
          return {
            ok: false,
            reason: 'CI_UNKNOWN',
            message:
              `Refused merge into '${targetBranch}': no CI workflow runs found for '${sourceBranch}'. ` +
              `Push a commit to trigger CI, open a PR, or override with "Merge without CI check".`,
          };
        }
        const bad = runs.filter(r => r.conclusion && !['success', 'skipped', 'neutral'].includes(r.conclusion.toLowerCase()));
        const running = runs.filter(r => (r.status || '').toLowerCase() !== 'completed');
        if (bad.length > 0) {
          const list = bad.slice(0, 5).map(r => `  ${r.name}: ${r.conclusion}`).join('\n');
          return {
            ok: false,
            reason: 'CI_RED',
            message:
              `Refused merge into '${targetBranch}': ${bad.length} workflow run${bad.length > 1 ? 's' : ''} not green on '${sourceBranch}'.\n\n${list}\n\n` +
              `Fix and retrigger, or override with "Merge without CI check".`,
            details: { failing: bad },
          };
        }
        if (running.length > 0) {
          return {
            ok: false,
            reason: 'CI_PENDING',
            message:
              `Refused merge into '${targetBranch}': ${running.length} CI run${running.length > 1 ? 's are' : ' is'} still in progress on '${sourceBranch}'. Wait for completion or override.`,
            details: { running },
          };
        }
        return { ok: true };
      } catch { /* fall through */ }
    }

    // If we got here we couldn't determine CI status at all. Fail closed —
    // safer to refuse and prompt the user than silently ship.
    return {
      ok: false,
      reason: 'CI_UNKNOWN',
      message:
        `Refused merge into '${targetBranch}': unable to determine CI status for '${sourceBranch}'. ` +
        `gh CLI is available but returned no usable data. Verify with \`gh pr checks ${sourceBranch}\` or ` +
        `override with "Merge without CI check".`,
    };
  }

  private async sanitizeKitBookkeepingForMerge(worktreePath: string, targetBranch: string): Promise<void> {
    const KIT_BOOKKEEPING_FILES = [
      '.S9N_KIT_DevOpsAgent/config.json',
      '.vscode/settings.json',
    ];
    try {
      // Make sure we have an up-to-date target ref to compare against. Best-
      // effort — if fetch fails (offline, missing remote), fall back to the
      // local target ref below.
      await this.git(['fetch', 'origin', targetBranch], worktreePath).catch(() => {});

      // Try origin/<target> first (most up-to-date), then local <target>.
      let refToUse = `origin/${targetBranch}`;
      const verifyRemote = await this.git(['rev-parse', '--verify', refToUse], worktreePath);
      if (verifyRemote.exitCode !== 0) {
        refToUse = targetBranch;
        const verifyLocal = await this.git(['rev-parse', '--verify', refToUse], worktreePath);
        if (verifyLocal.exitCode !== 0) return; // can't find target — bail out
      }

      const filesToReset: string[] = [];
      for (const file of KIT_BOOKKEEPING_FILES) {
        // Skip if the source branch doesn't track this file.
        const lsSrc = await this.git(['ls-files', '--error-unmatch', file], worktreePath);
        if (lsSrc.exitCode !== 0) continue;
        // Skip if it's identical between source HEAD and target ref.
        // `git diff --quiet` exits 0 if there's no diff, 1 if there is.
        const diff = await this.git(['diff', '--quiet', refToUse, 'HEAD', '--', file], worktreePath);
        if (diff.exitCode === 0) continue;
        // Reset this file to target's version.
        const checkout = await this.git(['checkout', refToUse, '--', file], worktreePath);
        if (checkout.exitCode === 0) filesToReset.push(file);
      }

      if (filesToReset.length === 0) return;

      // Commit on the source branch.
      const addResult = await this.git(['add', '--', ...filesToReset], worktreePath);
      if (addResult.exitCode !== 0) return;
      await this.git(
        [
          'commit',
          '-m',
          `[KIT] reset session bookkeeping to ${targetBranch} before merge\n\n` +
            `Files: ${filesToReset.join(', ')}`,
          '--',
          ...filesToReset,
        ],
        worktreePath
      );

      // Push the cleanup commit so the merge sees it on origin too. Best-effort.
      const currentBranch = (await this.git(['branch', '--show-current'], worktreePath)).stdout.trim();
      if (currentBranch) {
        await this.git(['push', 'origin', currentBranch], worktreePath).catch(() => {});
      }

      console.log(
        `[MergeService] Sanitized ${filesToReset.length} KIT bookkeeping file(s) on source before merge: ${filesToReset.join(', ')}`
      );
    } catch (err) {
      console.warn('[MergeService] sanitizeKitBookkeepingForMerge non-fatal failure:', err);
    }
  }

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
   * Parse "Your local changes to the following files would be overwritten by merge"
   * error from git stderr. This fires when the target branch has tracked (committed)
   * changes to files that also have uncommitted local modifications.
   * Returns the list of blocking files, or null if not this type of error.
   */
  private parseTrackedDirtyFiles(stderr: string): string[] | null {
    if (!stderr.includes('Your local changes to the following files would be overwritten')) {
      return null;
    }
    // Git error format:
    // error: Your local changes to the following files would be overwritten by merge:
    //     path/to/file1
    //     path/to/file2
    // Please commit your changes or stash them before you merge.
    // Aborting
    const lines = stderr.split('\n');
    const blockingFiles: string[] = [];
    let capturing = false;
    for (const line of lines) {
      if (line.includes('Your local changes to the following files would be overwritten')) {
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
   * Stash tracked files that have uncommitted local changes blocking a merge.
   * Uses a pathspec stash so only the blocking files are stashed — any other
   * dirty files the user has stay put. Message prefix matches the untracked
   * flow so popStashAfterMerge auto-recovers it after a successful merge.
   */
  private async stashTrackedDirtyFiles(
    repoPath: string,
    blockingFiles: string[]
  ): Promise<{ stashed: string[]; stashRef: string } | null> {
    const stashMsg = `[Kanvas] Pre-merge stash: ${blockingFiles.length} tracked file(s) blocking merge`;
    const { exitCode: stashExit, stderr } = await this.git(
      ['stash', 'push', '-m', stashMsg, '--', ...blockingFiles],
      repoPath
    );
    if (stashExit !== 0) {
      console.warn(`[MergeService] Failed to stash tracked blocking files: ${stderr}`);
      return null;
    }
    const { stdout: stashRef } = await this.git(['stash', 'list', '--max-count=1'], repoPath);
    console.log(`[MergeService] Stashed ${blockingFiles.length} tracked blocking files: ${stashRef}`);
    return { stashed: blockingFiles, stashRef };
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
      // Strip 'origin/' prefix — branch names may be stored as 'origin/main'
      // from the branch picker dropdown which lists remote tracking branches.
      targetBranch = targetBranch.replace(/^origin\//, '');

      // Fetch latest from remote
      await this.git(['fetch', 'origin'], repoPath);

      // Verify target branch exists on remote — gives a clear error instead of
      // cryptic rev-list failures when the repo uses a different default branch name.
      const { exitCode: lsExit, stdout: remoteRefs } = await this.git(
        ['ls-remote', '--heads', 'origin', targetBranch],
        repoPath
      );
      if (lsExit !== 0 || !remoteRefs.trim()) {
        const { stdout: remoteHead } = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'], repoPath);
        const defaultBranchMatch = remoteHead.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
        const hint = defaultBranchMatch
          ? ` The remote default branch is '${defaultBranchMatch[1]}'. Update the session's base branch setting.`
          : '';
        throw new Error(`Remote branch 'origin/${targetBranch}' does not exist.${hint}`);
      }

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
        // Still try to get conflicting files from the index
        try {
          const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
          conflictingFiles = stdout.split('\n').filter(Boolean);
        } catch { /* ignore */ }
      } finally {
        // Always abort the test merge
        await this.git(['merge', '--abort'], repoPath).catch(() => {});
        // Reset to original state
        await this.git(['reset', '--hard', currentHead], repoPath).catch(() => {});
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
      /** S9N-6394 override — allow merging a protected target (main/master/
       *  production/release) even when CI is red/pending OR the source branch
       *  carries WIP/[Kanvas] auto-checkpoint commits. Surfaced in the UI as
       *  an explicit "Merge without CI check" secondary button. */
      skipCiGate?: boolean;
    } = {}
  ): Promise<IpcResult<MergeResult>> {
    return this.wrap(async () => {
      // Strip 'origin/' prefix — branch names may be stored as 'origin/main'
      // from the branch picker dropdown which lists remote tracking branches.
      targetBranch = targetBranch.replace(/^origin\//, '');
      const normalizedSource = sourceBranch.replace(/^origin\//, '');

      // Guard: source and target are the same branch. This happens when a session
      // worktree is sitting on the target branch itself (e.g. checked out on
      // `main`) rather than its own session branch — the branch auto-resolve then
      // reports the target as the "active" branch. A branch can't be merged into
      // itself, and in a worktree setup all worktrees share the same refs, so the
      // commits already live on `main`. Fail fast with a clear message instead of
      // attempting a checkout git will reject ("'main' is already used by worktree…").
      if (normalizedSource === targetBranch) {
        return {
          success: false,
          message:
            `Source and target are the same branch ('${targetBranch}'). This session's ` +
            `worktree is checked out on '${targetBranch}' rather than its own session branch, ` +
            `so its commits are already on '${targetBranch}' — there is nothing to merge. ` +
            `If you intended to keep this work separate, switch the worktree to a session branch first.`,
        };
      }

      // S9N-6394 gate: refuse to advance a protected target unless CI is
      // green AND the source doesn't carry WIP/auto-checkpoint tips.
      // Only applies to main/master/production — feature-branch merges are
      // unaffected. Users can override by passing options.skipCiGate=true,
      // which the UI surfaces as an explicit "merge without CI check" button.
      const isProtectedTarget = ['main', 'master', 'production', 'release'].includes(targetBranch);
      if (isProtectedTarget && !options.skipCiGate) {
        const gateResult = await this.checkMergeGate(
          options.worktreePath || repoPath,
          normalizedSource,
          targetBranch
        );
        if (!gateResult.ok) {
          return {
            success: false,
            message: gateResult.message,
            gateReason: gateResult.reason,
            gateDetails: gateResult.details,
          } as MergeResult;
        }
      }

      let didStash = false;

      // Activity feed: announce the merge so the session timeline reflects it.
      this.logActivity(repoPath, normalizedSource, 'git', `Merging ${normalizedSource} → ${targetBranch}`, {
        sourceBranch: normalizedSource,
        targetBranch,
      });

      // Ensure .S9N_KIT_DevOpsAgent/ is in .gitignore of the target repo
      // This prevents agent artifacts from blocking merges
      await this.ensureAgentArtifactsIgnored(repoPath);

      // Preemptively replace KIT-bookkeeping files on the source branch with
      // the target's versions so they can't conflict during the merge. These
      // files (.S9N_KIT_DevOpsAgent/config.json and .vscode/settings.json)
      // carry per-worktree values — repoPath, init timestamp, window-title
      // session number — and the right answer when merging into main is
      // always "main's version wins". v2.6.64's MergeConflictService
      // resolver only helped after the user clicked "Auto-Fix with AI" on
      // the failure dialog; this runs BEFORE the merge attempt so the dialog
      // never appears.
      if (options.worktreePath) {
        await this.sanitizeKitBookkeepingForMerge(options.worktreePath, targetBranch);
      }

      // If the target branch is checked out in another worktree, route the
      // merge there instead of trying to `git checkout` it in the main repo
      // (git refuses with "fatal: '<branch>' is already used by worktree at …").
      // The holding worktree is already on the target branch — we just need to
      // pull + merge there. All subsequent target-branch git ops use
      // `mergeWorkdir`; main-repo housekeeping (worktree pruning, branch
      // deletion) still uses `repoPath`.
      let mergeWorkdir = repoPath;
      try {
        const { stdout: worktreeList } = await this.git(
          ['worktree', 'list', '--porcelain'],
          repoPath
        );
        const holdingWorktree = parseWorktreeHoldingBranch(worktreeList, targetBranch);
        if (holdingWorktree && holdingWorktree !== repoPath) {
          console.log(
            `[MergeService] Target '${targetBranch}' is held by worktree ${holdingWorktree}; routing merge there`
          );
          mergeWorkdir = holdingWorktree;
        }
      } catch (err) {
        // Non-fatal: fall through to the in-repo checkout path, which already
        // surfaces a clear error if the branch is held elsewhere.
        console.warn('[MergeService] worktree list failed; using main repo as merge workdir:', err);
      }

      // CRITICAL: If worktreePath provided, commit any uncommitted changes first!
      // This prevents data loss when user has uncommitted changes in the worktree.
      if (options.worktreePath) {
        console.log(`[MergeService] Checking for uncommitted changes in worktree: ${options.worktreePath}`);
        try {
          const { stdout: statusOutput } = await this.git(['status', '--porcelain'], options.worktreePath);
          if (statusOutput.trim()) {
            const dirtyFileCount = statusOutput.trim().split('\n').length;
            console.log(`[MergeService] Found ${dirtyFileCount} uncommitted change(s), committing before merge...`);

            // Stage ALL changes (tracked, modified, untracked, deleted)
            const addResult = await this.git(['add', '-A'], options.worktreePath);
            if (addResult.exitCode !== 0) {
              throw new Error(`git add -A failed (exit ${addResult.exitCode}): ${addResult.stderr}`);
            }

            // Unstage known Kanvas session/runtime files that should never land on main.
            // These may be tracked from a previous commit (gitignore only blocks untracked files).
            const sessionPatterns = [
              '.claude-session-*.md',
              '.codex-session-*.md',
              '.devops-commit-*.msg',
              '.mcp.json',
              '.claude/settings.json',
              '.S9N_KIT_DevOpsAgent/config.json',
            ];
            await this.git(['restore', '--staged', ...sessionPatterns], options.worktreePath).catch(() => {
              // restore --staged is a no-op if files aren't staged — ignore errors
            });

            // Verify everything was staged — nothing should remain unstaged
            const { stdout: postAddStatus } = await this.git(['status', '--porcelain'], options.worktreePath);
            const unstaged = postAddStatus.trim().split('\n').filter((line) => {
              // After `git add -A`, any remaining porcelain line that is NOT index-only
              // indicates a file that failed to stage. Index-staged lines have a
              // non-space first char and space second char (e.g. "A ", "M ", "D ").
              // Unstaged entries have a non-space second char (e.g. " M", "??", "UU").
              return (line.length >= 2 && line[0] === ' ') || line.startsWith('??');
            });
            if (unstaged.length > 0) {
              console.error(`[MergeService] Files failed to stage after git add -A:\n${unstaged.join('\n')}`);
              throw new Error(
                `${unstaged.length} file(s) could not be staged. Aborting merge to prevent data loss.`
              );
            }

            // SAFETY: refuse to auto-commit if the worktree is mid-rebase /
            // mid-merge / detached. Committing then is what caused the
            // KIT auto-commit + rebase-race incident (silently orphaned
            // ~15 real commits).
            const preCommitGuard = evaluateAutoCommitGuardForWorktree(options.worktreePath);
            if (!preCommitGuard.allowed) {
              throw new Error(
                `Pre-merge auto-commit refused: ${preCommitGuard.message}`
              );
            }

            // Commit with auto-commit message
            const commitResult = await this.git(
              ['commit', '-m', '[Kanvas] Auto-commit uncommitted changes before merge'],
              options.worktreePath
            );
            if (commitResult.exitCode !== 0 && !commitResult.stderr.includes('nothing to commit')) {
              throw new Error(`git commit failed (exit ${commitResult.exitCode}): ${commitResult.stderr}`);
            }

            // Final safety check: ensure worktree is clean after commit
            const { stdout: postCommitStatus } = await this.git(['status', '--porcelain'], options.worktreePath);
            if (postCommitStatus.trim()) {
              const remainingFiles = postCommitStatus.trim().split('\n');
              console.error(`[MergeService] Worktree still dirty after auto-commit (${remainingFiles.length} file(s)):\n${postCommitStatus}`);
              throw new Error(
                `Worktree still has ${remainingFiles.length} uncommitted file(s) after auto-commit. Aborting merge to prevent data loss.`
              );
            }

            // Push to ensure source branch has all changes before merge
            console.log(`[MergeService] Pushing committed changes to origin/${sourceBranch}...`);
            await this.git(['push', 'origin', sourceBranch], options.worktreePath);

            console.log(`[MergeService] Successfully committed and pushed all ${dirtyFileCount} file(s)`);
          } else {
            console.log(`[MergeService] No uncommitted changes in worktree`);
          }
        } catch (commitError) {
          const errorMsg = commitError instanceof Error ? commitError.message : String(commitError);
          console.error(`[MergeService] Failed to commit uncommitted changes: ${errorMsg}`);
          if (errorMsg.includes('nothing to commit')) {
            // Safe to proceed — worktree was already clean
            console.log(`[MergeService] Nothing to commit, proceeding with merge`);
          } else {
            // Abort merge to prevent data loss
            throw new Error(
              `Pre-merge auto-commit failed: ${errorMsg}. Merge aborted to prevent data loss.`
            );
          }
        }
      }

      // Clean up any stale merge state from a previous interrupted attempt.
      // This runs inside mergeWorkdir because merge state (MERGE_HEAD) is
      // per-worktree, not shared across worktrees.
      const { stdout: mergeHead } = await this.git(['rev-parse', '--verify', 'MERGE_HEAD'], mergeWorkdir);
      if (mergeHead) {
        console.log(`[MergeService] Cleaning up stale merge-in-progress before starting new merge`);
        await this.git(['merge', '--abort'], mergeWorkdir);
      }

      // Get current branch (in the workdir we'll merge in)
      const { stdout: currentBranch } = await this.git(['branch', '--show-current'], mergeWorkdir);

      // Verify target branch exists on remote before checking out.
      // Repos may use 'master', 'development', or another name instead of 'main'.
      const { exitCode: lsRemoteExit } = await this.git(
        ['ls-remote', '--exit-code', '--heads', 'origin', targetBranch],
        repoPath
      );
      if (lsRemoteExit !== 0) {
        // Try to find the actual default branch from the remote
        const { stdout: remoteHead } = await this.git(
          ['ls-remote', '--symref', 'origin', 'HEAD'],
          repoPath
        );
        const defaultBranchMatch = remoteHead.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
        const suggestion = defaultBranchMatch
          ? ` The remote default branch appears to be '${defaultBranchMatch[1]}'. Update the session's base branch setting.`
          : ` Check that '${targetBranch}' exists on the remote.`;
        return {
          success: false,
          message: `Cannot merge: remote branch 'origin/${targetBranch}' does not exist.${suggestion}`,
        };
      }

      // Checkout target branch if needed. We only need to checkout when the
      // workdir isn't already on the target branch — and when mergeWorkdir was
      // routed to a holding worktree above, it's already on targetBranch, so
      // currentBranch === targetBranch and this whole block is a no-op.
      if (currentBranch !== targetBranch) {
        const checkoutResult = await this.git(['checkout', targetBranch], mergeWorkdir);
        if (checkoutResult.exitCode !== 0) {
          const stderr = checkoutResult.stderr || '';
          // A branch can only be checked out in one worktree at a time. If the
          // target is held by a session worktree we couldn't locate above (e.g.
          // worktree list was unreadable), surface the actionable fallback.
          const heldBy = stderr.match(/already used by worktree at '?([^'\n]+)'?/i);
          if (heldBy) {
            return {
              success: false,
              message:
                `Cannot merge into '${targetBranch}': it is currently checked out in another ` +
                `worktree (${heldBy[1].trim()}). Switch that session off '${targetBranch}' ` +
                `(or close it) so the branch is free, then retry the merge.`,
            };
          }
          throw new Error(`Failed to checkout ${targetBranch}: ${stderr}`);
        }
      }

      // Sync target with origin via fetch + fast-forward-only.
      // Plain `git pull` inherits the user's pull.rebase/pull.ff config — if
      // unset, git 2.27+ refuses with a "Need to specify how to reconcile
      // divergent branches" wall of text. Worse, with pull.rebase=true it
      // would silently rebase the user's local target onto origin, which can
      // lose unpushed work. fetch + --ff-only is the safe path: it advances
      // the target when behind, no-ops when up-to-date, fails cleanly with
      // an actionable message when truly diverged.
      const fetchResult = await this.git(['fetch', 'origin', targetBranch], mergeWorkdir);
      if (fetchResult.exitCode !== 0) {
        console.error(`[MergeService] Fetch failed:`, fetchResult.stderr);
        if (currentBranch !== targetBranch) {
          await this.git(['checkout', currentBranch], mergeWorkdir);
        }
        return {
          success: false,
          message: `Failed to fetch latest ${targetBranch}: ${fetchResult.stderr || 'unknown error'}. Please try again.`,
        };
      }
      const ffResult = await this.git(['merge', '--ff-only', `origin/${targetBranch}`], mergeWorkdir);
      if (ffResult.exitCode !== 0) {
        const isDiverged =
          /not possible to fast-forward/i.test(ffResult.stderr) ||
          /diverged|divergent/i.test(ffResult.stderr);
        console.error(`[MergeService] Fast-forward failed:`, ffResult.stderr);
        if (currentBranch !== targetBranch) {
          await this.git(['checkout', currentBranch], mergeWorkdir);
        }
        return {
          success: false,
          message: isDiverged
            ? `Local '${targetBranch}' has diverged from origin/${targetBranch} — local commits exist that aren't on the remote. Resolve manually (rebase your local '${targetBranch}' onto origin/${targetBranch}, or reset it if the local commits aren't needed) before retrying the merge.`
            : `Failed to update ${targetBranch} from origin: ${ffResult.stderr || 'unknown error'}. Please try again.`,
        };
      }

      // Perform the merge
      let mergeResult = await this.git(
        ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch}`],
        mergeWorkdir
      );

      // Handle untracked files blocking the merge - stash and retry
      if (mergeResult.exitCode !== 0) {
        const blockingFiles = this.parseUntrackedBlockingFiles(mergeResult.stderr);
        if (blockingFiles && blockingFiles.length > 0) {
          console.log(`[MergeService] Untracked files blocking merge, stashing: ${blockingFiles.join(', ')}`);

          const cleanResult = await this.cleanUntrackedBlockingFiles(mergeWorkdir, blockingFiles);
          if (cleanResult.success && cleanResult.data && cleanResult.data.failed.length === 0) {
            didStash = true;
            console.log(`[MergeService] Stashed ${cleanResult.data.stashed.length} blocking files (${cleanResult.data.stashRef}), retrying merge...`);

            // Retry the merge after stashing
            mergeResult = await this.git(
              ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch}`],
              mergeWorkdir
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

      // Handle tracked dirty files blocking the merge - stash those specific paths and retry.
      // Mirrors the untracked-blocking path above: identical user outcome (merge just works),
      // and popStashAfterMerge later auto-recovers the user's local edits.
      if (mergeResult.exitCode !== 0) {
        const trackedBlockers = this.parseTrackedDirtyFiles(mergeResult.stderr);
        if (trackedBlockers && trackedBlockers.length > 0) {
          console.log(`[MergeService] Tracked dirty files blocking merge, stashing: ${trackedBlockers.join(', ')}`);

          const stashResult = await this.stashTrackedDirtyFiles(mergeWorkdir, trackedBlockers);
          if (stashResult) {
            didStash = true;
            mergeResult = await this.git(
              ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch}`],
              mergeWorkdir
            );
          } else {
            return {
              success: false,
              message: `Local changes to ${trackedBlockers.join(', ')} would be overwritten by merge and could not be auto-stashed. Please commit or stash them manually.`,
              conflictingFiles: trackedBlockers,
            };
          }
        }
      }

      if (mergeResult.exitCode !== 0) {
        // Capture conflict file list before aborting the merge
        const { stdout: conflictOutput } = await this.git(['diff', '--name-only', '--diff-filter=U'], mergeWorkdir);
        const conflictingFiles = conflictOutput.split('\n').filter(Boolean);

        // Abort the failed merge — working tree must be clean before we try rebase
        await this.git(['merge', '--abort'], mergeWorkdir);
        console.log(`[MergeService] Merge had conflicts (${conflictingFiles.length} file(s)) — trying rebase strategy`);

        // ── Rebase fallback ──────────────────────────────────────────────────
        // Switch to the source branch (agent's session branch) and rebase it
        // onto the target (main/development). If the rebase succeeds cleanly,
        // the branches are now linearly related and the subsequent merge will
        // be a clean fast-forward with no conflict.
        let rebasedSuccessfully = false;
        let rebaseConflictFiles: string[] = [];
        const worktreePath = options.worktreePath;

        // SAFETY: acquire per-worktree history-rewrite lock so the KIT
        // periodic auto-saver + Kanvas auto-commit skip while this
        // rebase is running (fix for the KIT rebase-race incident that
        // orphaned ~15 real commits).
        const rebaseWorkdir = worktreePath || repoPath;
        await acquireHistoryRewriteLock(
          rebaseWorkdir,
          `rebase ${sourceBranch} onto origin/${targetBranch}`
        );

        // Capture pre-rebase commit count so we can detect tip inversion
        // (the signature of the rebase-race bug).
        let preRebaseCount = 0;
        try {
          const { stdout } = await this.git(['rev-list', '--count', 'HEAD'], rebaseWorkdir);
          preRebaseCount = Number(stdout.trim()) || 0;
        } catch {
          preRebaseCount = 0;
        }

        try {
          // Checkout the source branch in the worktree (or main repo)
          const checkoutSrc = await this.git(['checkout', sourceBranch], rebaseWorkdir);
          if (checkoutSrc.exitCode !== 0) {
            throw new Error(`Could not checkout source branch for rebase: ${checkoutSrc.stderr}`);
          }

          // Fetch latest target branch so we rebase onto the freshest state
          await this.git(['fetch', 'origin', targetBranch], rebaseWorkdir).catch(() => {});

          // Rebase source branch onto origin/targetBranch
          const rebaseResult = await this.git(['rebase', `origin/${targetBranch}`], rebaseWorkdir);

          if (rebaseResult.exitCode === 0) {
            // TIP-COUNT SAFETY: verify we didn't drop commits. If the
            // post-rebase tip is behind the pre-rebase tip, treat as fatal
            // and reset --hard ORIG_HEAD to recover.
            let postRebaseCount = preRebaseCount;
            try {
              const { stdout } = await this.git(['rev-list', '--count', 'HEAD'], rebaseWorkdir);
              postRebaseCount = Number(stdout.trim()) || 0;
            } catch {
              // Non-fatal — fall through to permissive.
            }
            const tipGuard = evaluateRebaseTipGuard({
              preRebaseCommitCount: preRebaseCount,
              postRebaseCommitCount: postRebaseCount,
              branchName: sourceBranch,
            });
            if (!tipGuard.safe) {
              console.error(`[MergeService] ${tipGuard.message}`);
              await this.git(['reset', '--hard', 'ORIG_HEAD'], rebaseWorkdir).catch(() => {});
              throw new Error(tipGuard.message);
            }

            rebasedSuccessfully = true;
            console.log(`[MergeService] Rebase fallback succeeded — source branch is now linear with ${targetBranch}`);

            // Push the rebased source branch so targetBranch can be merged via fast-forward
            await this.git(['push', 'origin', sourceBranch, '--force-with-lease'], rebaseWorkdir).catch(() => {
              // Non-fatal — we can still proceed with the local ff-merge
            });
          } else {
            // Rebase also conflicted — abort it and collect conflict files
            const { stdout: rebaseConflicts } = await this.git(
              ['diff', '--name-only', '--diff-filter=U'],
              rebaseWorkdir
            ).catch(() => ({ stdout: '' }));
            rebaseConflictFiles = rebaseConflicts.split('\n').filter(Boolean);
            await this.git(['rebase', '--abort'], rebaseWorkdir).catch(() => {});
            console.log(`[MergeService] Rebase fallback also conflicted (${rebaseConflictFiles.length} file(s))`);
          }
        } catch (rebaseErr) {
          const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
          console.warn(`[MergeService] Rebase fallback threw:`, msg);
          // Make sure we leave the source branch in a clean state
          await this.git(['rebase', '--abort'], rebaseWorkdir).catch(() => {});
        } finally {
          // Always release the lock, even if the rebase threw / conflicted.
          await releaseHistoryRewriteLock(rebaseWorkdir);
        }

        if (rebasedSuccessfully) {
          // Now do the merge on the target branch — should be conflict-free.
          // If mergeWorkdir is the holding worktree, it's already on target;
          // only the main-repo path needs the explicit checkout.
          if (mergeWorkdir === repoPath) {
            const checkoutTarget = await this.git(['checkout', targetBranch], mergeWorkdir);
            if (checkoutTarget.exitCode !== 0) {
              return {
                success: false,
                message: `Rebase succeeded but could not re-checkout ${targetBranch}: ${checkoutTarget.stderr}`,
                conflictingFiles,
              };
            }
          }

          // Pull to pick up any remote changes that happened in the interim
          await this.git(['pull', 'origin', targetBranch], mergeWorkdir).catch(() => {});

          mergeResult = await this.git(
            ['merge', sourceBranch, '--ff-only', '-m', `Merge branch '${sourceBranch}' into ${targetBranch} (via rebase)`],
            mergeWorkdir
          );

          if (mergeResult.exitCode !== 0) {
            // ff-only failed — fall back to regular merge (should be rare after a clean rebase)
            mergeResult = await this.git(
              ['merge', sourceBranch, '-m', `Merge branch '${sourceBranch}' into ${targetBranch} (via rebase)`],
              mergeWorkdir
            );
          }

          if (mergeResult.exitCode !== 0) {
            // Still failing — give up and restore original branch
            await this.git(['merge', '--abort'], mergeWorkdir).catch(() => {});
            if (currentBranch !== targetBranch) {
              await this.git(['checkout', currentBranch], mergeWorkdir).catch(() => {});
            }
            return {
              success: false,
              message: 'Merge failed even after rebase — manual resolution required',
              conflictingFiles,
            };
          }
        } else {
          // Both merge and rebase failed — give up
          // Switch back to original branch so repo isn't left on targetBranch
          if (currentBranch !== targetBranch) {
            await this.git(['checkout', currentBranch], mergeWorkdir).catch(() => {});
          }

          const allConflictFiles = [
            ...new Set([...conflictingFiles, ...rebaseConflictFiles]),
          ];
          this.logActivity(
            repoPath,
            normalizedSource,
            'warning',
            `Merge ${normalizedSource} → ${targetBranch} failed (${allConflictFiles.length} conflict${allConflictFiles.length === 1 ? '' : 's'})`,
            { conflictingFiles: allConflictFiles }
          );
          return {
            success: false,
            message: 'Merge failed due to conflicts (rebase fallback also conflicted)',
            conflictingFiles: allConflictFiles,
          };
        }
      }

      // Get merge commit hash
      const { stdout: mergeCommitHash } = await this.git(['rev-parse', 'HEAD'], mergeWorkdir);

      // Get files changed count
      const { stdout: diffStatOutput } = await this.git(
        ['diff', '--stat', `${targetBranch}@{1}..HEAD`],
        mergeWorkdir
      );
      const filesChangedMatch = diffStatOutput.match(/(\d+) files? changed/);
      const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0;

      // Push merged changes
      await this.git(['push', 'origin', targetBranch], mergeWorkdir);

      // Auto-pop stash if we stashed files before merge
      let stashRecovered: boolean | undefined;
      let stashConflictFiles: string[] | undefined;
      if (didStash) {
        try {
          const stashResult = await this.popStashAfterMerge(mergeWorkdir);
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
        const stack = (new Error().stack || '').split('\n').slice(2, 7).map(s => s.trim()).join(' <- ');
        console.warn(`[MergeService] WORKTREE REMOVE (post-merge cleanup): ${options.worktreePath}\n  caller: ${stack}`);
        this.debugLog?.warn?.('MergeService', 'Worktree removed (post-merge deleteWorktree)', { worktreePath: options.worktreePath, repoPath, caller: stack });
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

      // Activity feed: announce the successful merge.
      this.logActivity(
        repoPath,
        normalizedSource,
        'success',
        `Merged ${normalizedSource} → ${targetBranch}${filesChanged ? ` (${filesChanged} file${filesChanged === 1 ? '' : 's'} changed)` : ''}`,
        { mergeCommitHash, filesChanged, stashRecovered }
      );

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
   * Ensure Kanvas session artifacts are in the repo's .gitignore.
   * This prevents agent runtime files from being committed or blocking merges.
   */
  private async ensureAgentArtifactsIgnored(repoPath: string): Promise<void> {
    const gitignorePath = path.join(repoPath, '.gitignore');

    // Patterns to ensure are gitignored (checked by substring presence)
    const patternsToAdd: Array<{ check: string; line: string }> = [
      { check: '.S9N_KIT_DevOpsAgent', line: '.S9N_KIT_DevOpsAgent/' },
      { check: '.claude-session-', line: '.claude-session-*.md' },
      { check: '.codex-session-', line: '.codex-session-*.md' },
      { check: '.devops-commit-', line: '.devops-commit-*.msg' },
      { check: '.mcp.json', line: '.mcp.json' },
      { check: '.claude/settings.json', line: '.claude/settings.json' },
      { check: '.file-coordination/', line: '.file-coordination/' },
    ];

    try {
      let content = '';
      try {
        content = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist yet
      }

      const missing = patternsToAdd.filter(p => !content.includes(p.check));
      if (missing.length > 0) {
        content += `\n# KIT DevOps Agent — session/runtime files (do not commit)\n`;
        content += missing.map(p => p.line).join('\n') + '\n';
        await fs.writeFile(gitignorePath, content, 'utf-8');
        console.log(`[MergeService] Added ${missing.length} KIT pattern(s) to .gitignore in ${repoPath}`);
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
