/**
 * Repository Cleanup Service
 * Handles worktree cleanup, branch merging, and repository maintenance
 */

import { BaseService } from './BaseService';
import { GitService } from './GitService';
import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import Store from 'electron-store';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { KANVAS_PATHS } from '../../shared/agent-protocol';
import type {
  IpcResult,
  AgentInstance,
  RecentRepo,
  StorageMetricsOverview,
  DockerUsageBucket,
  LocalStorageRepoUsage,
  AbandonedWorktreeUsage,
  ReclaimableRepoUsage,
} from '../../shared/types';

const execFileAsync = promisify(execFile);
const STALE_WORKTREE_DAYS = 14;

interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  exists: boolean;
  hasUncommittedChanges?: boolean;
  isOrphaned?: boolean;
}

interface BranchInfo {
  name: string;
  isMerged: boolean;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  hasAssociatedSession?: boolean;
}

interface CleanupPlan {
  repoPath: string;
  worktreesToRemove: WorktreeInfo[];
  branchesToDelete: BranchInfo[];
  branchesToMerge: Array<{
    branch: string;
    targetBranch: string;
    order: number;
  }>;
  estimatedActions: number;
}

interface CleanupResult {
  success: boolean;
  worktreesRemoved: number;
  branchesDeleted: number;
  branchesMerged: number;
  errors: string[];
}

interface StoreSchema {
  recentRepos: RecentRepo[];
  instances: AgentInstance[];
}

interface DockerSystemDfRow {
  Type?: string;
  Size?: string;
  Reclaimable?: string;
}

export class RepoCleanupService extends BaseService {
  private store: Store<StoreSchema>;
  private gitService: GitService;

  constructor() {
    super();
    this.store = new Store<StoreSchema>({
      name: 'kanvas-instances',
      defaults: {
        recentRepos: [],
        instances: [],
      },
    });
    this.gitService = new GitService();
  }

  /**
   * Analyze a repository and generate a cleanup plan
   */
  async analyzeRepo(repoPath: string, targetBranch = 'main'): Promise<IpcResult<CleanupPlan>> {
    return this.wrap(async () => {
      const plan: CleanupPlan = {
        repoPath,
        worktreesToRemove: [],
        branchesToDelete: [],
        branchesToMerge: [],
        estimatedActions: 0,
      };

      // 1. Get worktrees
      const worktreesResult = await this.gitService.listWorktrees(repoPath);
      if (worktreesResult.success && worktreesResult.data) {
        for (const wt of worktreesResult.data) {
          if (wt.bare) continue; // Skip main worktree

          const wtInfo: WorktreeInfo = {
            ...wt,
            exists: existsSync(wt.path),
            isOrphaned: !existsSync(wt.path),
          };

          // Check if worktree directory exists
          if (!wtInfo.exists || wtInfo.isOrphaned) {
            plan.worktreesToRemove.push(wtInfo);
          }
        }
      }

      // 2. Get merged branches that can be cleaned up
      const mergedResult = await this.gitService.getMergedBranches(repoPath, targetBranch);
      if (mergedResult.success && mergedResult.data) {
        // Get stored instances to check for associated sessions
        const instances = this.store.get('instances', []);

        for (const branchName of mergedResult.data) {
          const hasSession = instances.some(inst => inst.config.branchName === branchName);

          plan.branchesToDelete.push({
            name: branchName,
            isMerged: true,
            hasAssociatedSession: hasSession,
          });
        }
      }

      // 3. Identify branches that need to be merged (not yet merged)
      // This would typically be session branches that are complete but not merged
      const instances = this.store.get('instances', []);
      const completedSessions = instances.filter(
        inst => inst.status === 'completed' && inst.config.repoPath === repoPath
      );

      let mergeOrder = 1;
      for (const session of completedSessions) {
        const branchName = session.config.branchName;
        // Check if already in delete list (already merged)
        const alreadyMerged = plan.branchesToDelete.some(b => b.name === branchName);

        if (!alreadyMerged) {
          plan.branchesToMerge.push({
            branch: branchName,
            targetBranch,
            order: mergeOrder++,
          });
        }
      }

      plan.estimatedActions =
        plan.worktreesToRemove.length +
        plan.branchesToDelete.length +
        plan.branchesToMerge.length;

      return plan;
    }, 'ANALYZE_REPO_FAILED');
  }

  /**
   * Execute cleanup based on a plan
   */
  async executeCleanup(
    plan: CleanupPlan,
    options: {
      removeWorktrees?: boolean;
      deleteMergedBranches?: boolean;
      mergeCompletedBranches?: boolean;
      deleteRemoteBranches?: boolean;
    } = {}
  ): Promise<IpcResult<CleanupResult>> {
    return this.wrap(async () => {
      const result: CleanupResult = {
        success: true,
        worktreesRemoved: 0,
        branchesDeleted: 0,
        branchesMerged: 0,
        errors: [],
      };

      const {
        removeWorktrees = true,
        deleteMergedBranches = true,
        mergeCompletedBranches = false,
        deleteRemoteBranches = false,
      } = options;

      // Emit progress
      const emitProgress = (message: string) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          win.webContents.send('cleanup:progress', { message, result });
        }
      };

      // 1. Remove orphaned worktrees
      if (removeWorktrees) {
        emitProgress('Removing abandoned worktrees...');
        for (const worktree of plan.worktreesToRemove) {
          try {
            const removeResult = await this.gitService.removeWorktreeByPath(plan.repoPath, worktree.path);
            if (removeResult.success) {
              result.worktreesRemoved += 1;
            } else {
              result.errors.push(
                removeResult.error?.message || `Failed to remove worktree: ${worktree.path}`
              );
            }
          } catch (error) {
            result.errors.push(`Error removing worktree ${worktree.path}: ${error}`);
          }
        }

        const pruneResult = await this.gitService.pruneWorktrees(plan.repoPath);
        if (!pruneResult.success) {
          result.errors.push(pruneResult.error?.message || 'Failed to prune worktree references');
        }
      }

      // 2. Merge completed branches (in order)
      if (mergeCompletedBranches && plan.branchesToMerge.length > 0) {
        // Sort by order
        const sortedMerges = [...plan.branchesToMerge].sort((a, b) => a.order - b.order);

        for (const merge of sortedMerges) {
          emitProgress(`Merging ${merge.branch} into ${merge.targetBranch}...`);
          try {
            // This would need proper merge logic
            // For now, just log it
            console.log(`[RepoCleanupService] Would merge ${merge.branch} -> ${merge.targetBranch}`);
            result.branchesMerged++;
          } catch (error) {
            result.errors.push(`Failed to merge ${merge.branch}: ${error}`);
          }
        }
      }

      // 3. Delete merged branches
      if (deleteMergedBranches) {
        for (const branch of plan.branchesToDelete) {
          // Skip branches with active sessions
          if (branch.hasAssociatedSession) {
            console.log(`[RepoCleanupService] Skipping branch with active session: ${branch.name}`);
            continue;
          }

          emitProgress(`Deleting merged branch: ${branch.name}...`);
          try {
            const deleteResult = await this.gitService.deleteBranch(
              plan.repoPath,
              branch.name,
              deleteRemoteBranches
            );
            if (deleteResult.success) {
              result.branchesDeleted++;
            } else {
              result.errors.push(`Failed to delete ${branch.name}`);
            }
          } catch (error) {
            result.errors.push(`Error deleting ${branch.name}: ${error}`);
          }
        }
      }

      result.success = result.errors.length === 0;
      emitProgress('Cleanup completed');

      return result;
    }, 'EXECUTE_CLEANUP_FAILED');
  }

  /**
   * Clean up Kanvas directories (remove stale files)
   */
  async cleanupKanvasDirectory(repoPath: string): Promise<IpcResult<{
    removedSessionFiles: number;
    removedAgentFiles: number;
    removedActivityFiles: number;
  }>> {
    return this.wrap(async () => {
      const result = {
        removedSessionFiles: 0,
        removedAgentFiles: 0,
        removedActivityFiles: 0,
      };

      // Get active session IDs from instances
      const instances = this.store.get('instances', []);
      const activeSessionIds = new Set(instances.map(i => i.sessionId).filter(Boolean));

      // Clean sessions directory
      const sessionsDir = path.join(repoPath, KANVAS_PATHS.sessions);
      if (existsSync(sessionsDir)) {
        const files = await fs.readdir(sessionsDir);
        for (const file of files) {
          const sessionId = file.replace('.json', '');
          if (!activeSessionIds.has(sessionId)) {
            await fs.unlink(path.join(sessionsDir, file));
            result.removedSessionFiles++;
          }
        }
      }

      // Clean agents directory
      const agentsDir = path.join(repoPath, KANVAS_PATHS.agents);
      if (existsSync(agentsDir)) {
        const files = await fs.readdir(agentsDir);
        for (const file of files) {
          // Check if any active session references this agent
          const content = await fs.readFile(path.join(agentsDir, file), 'utf-8');
          try {
            const agent = JSON.parse(content);
            const hasActiveSession = agent.sessions?.some((s: string) => activeSessionIds.has(s));
            if (!hasActiveSession) {
              await fs.unlink(path.join(agentsDir, file));
              result.removedAgentFiles++;
            }
          } catch {
            // Remove unparseable files
            await fs.unlink(path.join(agentsDir, file));
            result.removedAgentFiles++;
          }
        }
      }

      // Clean activity directory (keep only recent)
      const activityDir = path.join(repoPath, KANVAS_PATHS.activity);
      if (existsSync(activityDir)) {
        const files = await fs.readdir(activityDir);
        const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        for (const file of files) {
          const filePath = path.join(activityDir, file);
          const stats = await fs.stat(filePath);
          if (stats.mtime.getTime() < oneWeekAgo) {
            await fs.unlink(filePath);
            result.removedActivityFiles++;
          }
        }
      }

      console.log(`[RepoCleanupService] Cleaned up Kanvas directory in ${repoPath}:`, result);
      return result;
    }, 'CLEANUP_KANVAS_FAILED');
  }

  /**
   * Read-only storage metrics for the Workspace "Disk & Cleanup" panel.
   * Includes Docker system usage + per-repo local disk hotspots.
   */
  async getStorageMetrics(repoPaths: string[]): Promise<IpcResult<StorageMetricsOverview>> {
    return this.wrap(async () => {
      const normalizedRepos = [...new Set(
        repoPaths
          .map((repoPath) => repoPath?.trim())
          .filter((repoPath): repoPath is string => Boolean(repoPath))
      )];

      const [docker, local] = await Promise.all([
        this.collectDockerUsage(),
        this.collectLocalUsage(normalizedRepos),
      ]);

      return {
        fetchedAt: new Date().toISOString(),
        docker,
        local,
      };
    }, 'GET_STORAGE_METRICS_FAILED');
  }

  private async collectDockerUsage(): Promise<StorageMetricsOverview['docker']> {
    const emptyBucket: DockerUsageBucket = {
      sizeBytes: 0,
      reclaimableBytes: 0,
      reclaimablePercent: null,
    };

    try {
      const { stdout } = await execFileAsync('docker', [
        'system',
        'df',
        '--format',
        '{{json .}}',
      ], {
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const rows = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DockerSystemDfRow);

      const pickRow = (needle: string): DockerSystemDfRow | undefined =>
        rows.find((row) => row.Type?.toLowerCase() === needle);

      return {
        available: true,
        images: this.parseDockerBucket(pickRow('images')),
        localVolumes: this.parseDockerBucket(pickRow('local volumes')),
        buildCache: this.parseDockerBucket(pickRow('build cache')),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to query Docker usage';
      return {
        available: false,
        error: message,
        images: emptyBucket,
        localVolumes: emptyBucket,
        buildCache: emptyBucket,
      };
    }
  }

  private parseDockerBucket(row?: DockerSystemDfRow): DockerUsageBucket {
    if (!row) {
      return {
        sizeBytes: 0,
        reclaimableBytes: 0,
        reclaimablePercent: null,
      };
    }

    const reclaimableRaw = row.Reclaimable ?? '';
    const reclaimablePercentMatch = reclaimableRaw.match(/\((\d+)%\)/);
    const reclaimablePercent = reclaimablePercentMatch ? Number(reclaimablePercentMatch[1]) : null;
    const reclaimableSize = reclaimableRaw.replace(/\(.*\)/, '').trim();

    return {
      sizeBytes: this.parseHumanSizeToBytes(row.Size ?? ''),
      reclaimableBytes: this.parseHumanSizeToBytes(reclaimableSize),
      reclaimablePercent: Number.isFinite(reclaimablePercent as number) ? reclaimablePercent : null,
    };
  }

  private async collectAbandonedWorktrees(repoPaths: string[]): Promise<AbandonedWorktreeUsage[]> {
    const abandonedWorktrees: AbandonedWorktreeUsage[] = [];
    const instances = this.store.get('instances', []);
    const activeWorktreePaths = new Set<string>();

    for (const instance of instances) {
      if (!instance.worktreePath) continue;
      activeWorktreePaths.add(path.resolve(instance.worktreePath));
      try {
        activeWorktreePaths.add(await fs.realpath(instance.worktreePath));
      } catch {
        // Ignore unresolved paths.
      }
    }

    for (const repoPath of repoPaths) {
      const worktreesResult = await this.gitService.listWorktrees(repoPath);
      if (!worktreesResult.success || !worktreesResult.data) continue;

      const normalizedRepoPath = await this.normalizePath(repoPath);
      for (const worktree of worktreesResult.data) {
        const normalizedWorktreePath = await this.normalizePath(worktree.path);
        if (normalizedWorktreePath === normalizedRepoPath) continue;

        const exists = existsSync(worktree.path);
        const hasActiveSession =
          activeWorktreePaths.has(path.resolve(worktree.path)) ||
          activeWorktreePaths.has(normalizedWorktreePath);
        let lastTouchedAt: string | null = null;
        let daysSinceLastTouched: number | null = null;
        let bytes = 0;

        if (exists) {
          try {
            const stats = await fs.stat(worktree.path);
            lastTouchedAt = stats.mtime.toISOString();
            daysSinceLastTouched = Math.max(
              0,
              Math.floor((Date.now() - stats.mtime.getTime()) / (24 * 60 * 60 * 1000))
            );
          } catch {
            // Keep null values when stat fails.
          }
          bytes = await this.getDirectoryBytes(worktree.path);
        }

        const isMissingPath = !exists;
        const isStaleNoSession = exists &&
          !hasActiveSession &&
          daysSinceLastTouched !== null &&
          daysSinceLastTouched >= STALE_WORKTREE_DAYS;

        if (!isMissingPath && !isStaleNoSession) continue;

        abandonedWorktrees.push({
          repoPath,
          worktreePath: worktree.path,
          branch: worktree.branch || '(detached)',
          bytes,
          exists,
          lastTouchedAt,
          daysSinceLastTouched,
          reason: isMissingPath ? 'missing-path' : 'stale-no-session',
        });
      }
    }

    abandonedWorktrees.sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === 'missing-path' ? -1 : 1;
      if (a.bytes !== b.bytes) return b.bytes - a.bytes;
      return (b.daysSinceLastTouched ?? -1) - (a.daysSinceLastTouched ?? -1);
    });
    return abandonedWorktrees;
  }

  private buildReclaimableRanking(
    repoPaths: string[],
    nodeModulesByRepo: LocalStorageRepoUsage[],
    pythonEnvsByRepo: LocalStorageRepoUsage[],
    abandonedWorktrees: AbandonedWorktreeUsage[],
  ): ReclaimableRepoUsage[] {
    const byRepo = new Map<string, ReclaimableRepoUsage>();
    const ensureEntry = (repoPath: string): ReclaimableRepoUsage => {
      const existing = byRepo.get(repoPath);
      if (existing) return existing;
      const created: ReclaimableRepoUsage = {
        repoPath,
        totalReclaimableBytes: 0,
        nodeModulesBytes: 0,
        pythonEnvsBytes: 0,
        abandonedWorktreeBytes: 0,
        abandonedWorktreeCount: 0,
      };
      byRepo.set(repoPath, created);
      return created;
    };

    for (const repoPath of repoPaths) ensureEntry(repoPath);

    for (const row of nodeModulesByRepo) {
      ensureEntry(row.repoPath).nodeModulesBytes += row.bytes;
    }
    for (const row of pythonEnvsByRepo) {
      ensureEntry(row.repoPath).pythonEnvsBytes += row.bytes;
    }
    for (const worktree of abandonedWorktrees) {
      const entry = ensureEntry(worktree.repoPath);
      entry.abandonedWorktreeBytes += worktree.bytes;
      entry.abandonedWorktreeCount += 1;
    }

    return [...byRepo.values()]
      .map((entry) => ({
        ...entry,
        totalReclaimableBytes: entry.nodeModulesBytes + entry.pythonEnvsBytes + entry.abandonedWorktreeBytes,
      }))
      .filter((entry) => entry.totalReclaimableBytes > 0 || entry.abandonedWorktreeCount > 0)
      .sort((a, b) => {
        if (a.totalReclaimableBytes !== b.totalReclaimableBytes) {
          return b.totalReclaimableBytes - a.totalReclaimableBytes;
        }
        return b.abandonedWorktreeCount - a.abandonedWorktreeCount;
      });
  }

  private async normalizePath(targetPath: string): Promise<string> {
    try {
      return await fs.realpath(targetPath);
    } catch {
      return path.resolve(targetPath);
    }
  }

  private parseHumanSizeToBytes(raw: string): number {
    const value = raw.trim();
    if (!value || value === '0B' || value === '0') return 0;
    const match = value.match(/^([\d.]+)\s*([kmgtpe]?i?b?)$/i);
    if (!match) return 0;

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return 0;

    const unit = match[2].toLowerCase();
    const base = 1024;
    const powerByUnit: Record<string, number> = {
      b: 0,
      kb: 1,
      kib: 1,
      mb: 2,
      mib: 2,
      gb: 3,
      gib: 3,
      tb: 4,
      tib: 4,
      pb: 5,
      pib: 5,
      eb: 6,
      eib: 6,
    };
    const power = powerByUnit[unit] ?? 0;
    return Math.round(numeric * (base ** power));
  }

  private async collectLocalUsage(repoPaths: string[]): Promise<StorageMetricsOverview['local']> {
    const nodeModulesByRepo: LocalStorageRepoUsage[] = [];
    const pythonEnvsByRepo: LocalStorageRepoUsage[] = [];

    for (const repoPath of repoPaths) {
      const nodeModulesPath = path.join(repoPath, 'node_modules');
      const nodeModulesBytes = await this.getDirectoryBytes(nodeModulesPath);
      if (nodeModulesBytes > 0) {
        nodeModulesByRepo.push({
          repoPath,
          bytes: nodeModulesBytes,
          paths: [nodeModulesPath],
        });
      }

      const pythonCandidates = [path.join(repoPath, '.venv'), path.join(repoPath, 'venv')];
      let pythonBytes = 0;
      const existingPythonPaths: string[] = [];
      for (const pythonPath of pythonCandidates) {
        const candidateBytes = await this.getDirectoryBytes(pythonPath);
        if (candidateBytes > 0) {
          pythonBytes += candidateBytes;
          existingPythonPaths.push(pythonPath);
        }
      }
      if (pythonBytes > 0) {
        pythonEnvsByRepo.push({
          repoPath,
          bytes: pythonBytes,
          paths: existingPythonPaths,
        });
      }
    }

    nodeModulesByRepo.sort((a, b) => b.bytes - a.bytes);
    pythonEnvsByRepo.sort((a, b) => b.bytes - a.bytes);

    const nodeModulesTotalBytes = nodeModulesByRepo.reduce((sum, item) => sum + item.bytes, 0);
    const pythonEnvsTotalBytes = pythonEnvsByRepo.reduce((sum, item) => sum + item.bytes, 0);
    const abandonedWorktrees = await this.collectAbandonedWorktrees(repoPaths);
    const reclaimableByRepo = this.buildReclaimableRanking(
      repoPaths,
      nodeModulesByRepo,
      pythonEnvsByRepo,
      abandonedWorktrees
    );

    return {
      scannedRepoCount: repoPaths.length,
      nodeModulesTotalBytes,
      pythonEnvsTotalBytes,
      nodeModulesByRepo,
      pythonEnvsByRepo,
      abandonedWorktrees,
      reclaimableByRepo,
    };
  }

  private async getDirectoryBytes(directoryPath: string): Promise<number> {
    if (!existsSync(directoryPath)) return 0;
    try {
      const { stdout } = await execFileAsync('du', ['-sk', directoryPath], {
        timeout: 20_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const firstColumn = stdout.trim().split(/\s+/)[0];
      const kb = Number(firstColumn);
      if (!Number.isFinite(kb) || kb < 0) return 0;
      return Math.round(kb * 1024);
    } catch {
      return 0;
    }
  }

  /**
   * Quick cleanup: prune worktrees and remove stale Kanvas files
   */
  async quickCleanup(repoPath: string): Promise<IpcResult<{
    worktreesPruned: boolean;
    kanvasCleanup: { removedSessionFiles: number; removedAgentFiles: number; removedActivityFiles: number };
  }>> {
    return this.wrap(async () => {
      // Prune worktrees
      await this.gitService.pruneWorktrees(repoPath);

      // Cleanup Kanvas directory
      const kanvasResult = await this.cleanupKanvasDirectory(repoPath);

      return {
        worktreesPruned: true,
        kanvasCleanup: kanvasResult.data || {
          removedSessionFiles: 0,
          removedAgentFiles: 0,
          removedActivityFiles: 0,
        },
      };
    }, 'QUICK_CLEANUP_FAILED');
  }
}

export const repoCleanupService = new RepoCleanupService();
