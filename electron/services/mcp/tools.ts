/**
 * MCP Tool Handlers
 *
 * Registers 8 tools via mcpServer.tool() with Zod input schemas:
 * - kit_commit
 * - kit_commit_all (multi-repo: commit across all repos)
 * - kit_get_session_info
 * - kit_log_activity
 * - kit_lock_file
 * - kit_unlock_file
 * - kit_get_commit_history
 * - kit_request_review
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { join, basename, relative } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSessionBinder } from './session-binder';
import type { McpServiceDeps, McpCallLogEntry } from '../McpServerService';

/** Interface for the McpServerService to log calls */
interface McpCallLogger {
  addCallLogEntry(entry: McpCallLogEntry): void;
}

/**
 * Register all MCP tools on the server instance.
 *
 * NOTE: We cast `server` to `any` below to avoid extremely expensive
 * generic type inference when combining McpServer.tool() + Zod schemas.
 * TypeScript's type checker hangs (OOM) without this escape hatch.
 */
export function registerTools(
  server: McpServer,
  binder: McpSessionBinder,
  deps: McpServiceDeps,
  callLogger?: McpCallLogger
): void {
  // Cast to any to avoid TS compiler OOM from complex zod+MCP generic inference
  const srv: any = server;

  /** Wrap a tool handler to log timing and success/failure */
  function withCallLog<T extends Record<string, any>>(
    toolName: string,
    handler: (args: T) => Promise<any>
  ): (args: T) => Promise<any> {
    if (!callLogger) return handler;
    return async (args: T) => {
      const start = Date.now();
      const sessionId = (args as any).session_id || 'unknown';
      try {
        const result = await handler(args);
        callLogger.addCallLogEntry({
          timestamp: new Date().toISOString(),
          toolName,
          sessionId,
          success: true,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        callLogger.addCallLogEntry({
          timestamp: new Date().toISOString(),
          toolName,
          sessionId,
          success: false,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }

  /** Post-commit: detect contract changes and regenerate affected contracts */
  async function triggerContractCheck(sessionId: string, worktreePath: string, commitHash: string, repoPath?: string): Promise<void> {
    if (!deps.contractDetectionService || !deps.contractGenerationService || !deps.databaseService) return;

    const metaFile = join(worktreePath, '.devops-kit', '.contract-generation-meta.json');
    if (!existsSync(metaFile)) return;

    try {
      const analysisResult = await deps.contractDetectionService.analyzeCommit(worktreePath, commitHash);
      if (!analysisResult.success || !analysisResult.data?.hasContractChanges) return;

      const { changes, breakingChanges } = analysisResult.data;
      const changedFiles: string[] = changes.map((c: { file: string }) => c.file);

      const effectiveRepoPath = repoPath || worktreePath;
      const cachedFeatures: any[] = deps.databaseService.getSetting(`discovered_features:${effectiveRepoPath}`, []) || [];
      if (!cachedFeatures.length) return;

      const affectedFeatures = cachedFeatures.filter((feature: any) => {
        const relativeFeatPath = relative(effectiveRepoPath, feature.basePath);
        return changedFiles.some((f: string) => f.startsWith(relativeFeatPath + '/'));
      });

      if (affectedFeatures.length === 0) return;

      const updatedFeatures: string[] = [];
      for (const feature of affectedFeatures) {
        try {
          const result = await deps.contractGenerationService!.generateFeatureContract(worktreePath, feature);
          if (result.success) updatedFeatures.push(feature.name);
        } catch { /* non-fatal */ }
      }

      if (updatedFeatures.length > 0 && deps.activityService) {
        const displayFiles = changedFiles.map((f: string) => basename(f));
        const filesSummary = displayFiles.length > 5
          ? `${displayFiles.slice(0, 5).join(', ')} +${displayFiles.length - 5} more`
          : displayFiles.join(', ');
        deps.activityService.log(sessionId, 'info',
          `Contracts updated for ${updatedFeatures.length} feature(s): ${updatedFeatures.join(', ')} (${changedFiles.length} files: ${filesSummary})`,
          { type: 'contract-auto-update', commitHash, updatedFeatures, filesChanged: changedFiles, breakingChanges: breakingChanges.length }
        );
      }
    } catch (err) {
      console.error('[MCP] Post-commit contract check error:', err);
    }
  }

  // --------------------------------------------------------------------------
  // kit_commit — Stage + commit + record + push (optional repo for multi-repo)
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_commit',
    'Stage all changes, commit with a message, record in KIT, and optionally push. This replaces writing .devops-commit files. In multi-repo mode, specify repo to target a specific repository.',
    {
      session_id: z.string().describe('The KIT session ID'),
      message: z.string().describe('Commit message (conventional commits format preferred)'),
      push: z.boolean().optional().default(false).describe('Push to remote after commit'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_commit', async ({ session_id, message, push, repo }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      try {
        // 1. Stage + commit via gitService (pass repoName for multi-repo)
        const commitResult = await deps.gitService.commit(session_id, message, repo);
        if (!commitResult.success) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: commitResult.error?.message || 'Commit failed' }) }] };
        }

        const commitData = commitResult.data;
        const hash = commitData?.hash || commitData?.commitHash || '';
        const shortHash = commitData?.shortHash || hash.substring(0, 7);
        const filesChanged = commitData?.filesChanged || 0;

        // 2. Record in database
        if (deps.databaseService) {
          try {
            deps.databaseService.recordCommit(session_id, hash, message, filesChanged);
            deps.databaseService.recordSessionEvent(session_id, 'commit', { hash, message, filesChanged, repo });
          } catch {
            // Non-fatal: database recording
          }
        }

        // 3. Link activity
        if (deps.activityService) {
          deps.activityService.log(session_id, 'git', `Committed: ${message}`, {
            commitHash: hash,
            shortHash,
            filesChanged,
            repo,
            source: 'mcp',
          });
        }

        // 4. Optional push
        let pushed = false;
        if (push) {
          try {
            const pushResult = await deps.gitService.push(session_id, repo);
            pushed = pushResult.success === true;
          } catch {
            // Push failure is non-fatal
          }
        }

        // 5. Post-commit contract check (fire-and-forget)
        triggerContractCheck(session_id, worktree, hash).catch(() => {});

        const result = {
          commitHash: hash,
          shortHash,
          message,
          filesChanged,
          pushed,
          repo: repo || undefined,
        };

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Commit failed';
        return { content: [{ type: 'text', text: JSON.stringify({ error: errorMsg }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_commit_all — Commit across all repos in multi-repo session
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_commit_all',
    'Commit changes across all repositories in a multi-repo session. Each repo with changes gets a commit with the same message.',
    {
      session_id: z.string().describe('The KIT session ID'),
      message: z.string().describe('Commit message (conventional commits format preferred)'),
      push: z.boolean().optional().default(false).describe('Push to remote after each commit'),
    },
    withCallLog('kit_commit_all', async ({ session_id, message, push }) => {
      const repos = binder.getReposForSession(session_id);
      if (repos.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      const results: Array<{ repoName: string; commitHash?: string; filesChanged?: number; pushed?: boolean; error?: string }> = [];

      for (const repo of repos) {
        try {
          const repoName = repo.repoName === 'primary' ? undefined : repo.repoName;
          const commitResult = await deps.gitService.commit(session_id, message, repoName);

          if (!commitResult.success) {
            results.push({ repoName: repo.repoName, error: commitResult.error?.message || 'Commit failed' });
            continue;
          }

          const hash = commitResult.data?.hash || '';
          const filesChanged = commitResult.data?.filesChanged || 0;

          // Record in database
          if (deps.databaseService) {
            try {
              deps.databaseService.recordCommit(session_id, hash, message, filesChanged);
            } catch { /* non-fatal */ }
          }

          // Activity log
          if (deps.activityService) {
            deps.activityService.log(session_id, 'git', `Committed (${repo.repoName}): ${message}`, {
              commitHash: hash,
              repo: repo.repoName,
              source: 'mcp',
            });
          }

          // Optional push
          let pushed = false;
          if (push) {
            try {
              const pushResult = await deps.gitService.push(session_id, repoName);
              pushed = pushResult.success === true;
            } catch { /* non-fatal */ }
          }

          // Post-commit contract check
          triggerContractCheck(session_id, repo.worktreePath, hash).catch(() => {});

          results.push({ repoName: repo.repoName, commitHash: hash, filesChanged, pushed });
        } catch (err) {
          results.push({ repoName: repo.repoName, error: err instanceof Error ? err.message : 'Failed' });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ commits: results }) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_get_session_info — Session config and metadata
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_get_session_info',
    'Get session configuration, metadata, and working directory for a KIT session. In multi-repo mode, returns all repos.',
    {
      session_id: z.string().describe('The KIT session ID'),
    },
    withCallLog('kit_get_session_info', async ({ session_id }) => {
      const session = binder.getSession(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      // Try to get richer info from agentInstanceService
      let extraInfo: Record<string, unknown> = {};
      if (deps.agentInstanceService) {
        const instances = deps.agentInstanceService.listInstances();
        if (instances.success && instances.data) {
          const match = instances.data.find((i: any) => i.sessionId === session_id);
          if (match) {
            extraInfo = {
              agentType: match.config?.agentType,
              branchName: match.config?.branchName,
              baseBranch: match.config?.baseBranch,
              task: match.config?.taskDescription,
              repoPath: match.config?.repoPath,
              createdAt: match.createdAt,
            };
          }
        }
      }

      // Include repos list for multi-repo sessions
      const repos = binder.getReposForSession(session_id);
      const reposInfo = repos.length > 1 ? repos : undefined;

      const result = {
        sessionId: session_id,
        worktreePath: session.worktreePath,
        registeredAt: session.registeredAt,
        repos: reposInfo,
        ...extraInfo,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_log_activity — Log to KIT dashboard timeline
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_log_activity',
    'Log an activity entry to the KIT dashboard timeline. Use for progress updates, warnings, or error reports.',
    {
      session_id: z.string().describe('The KIT session ID'),
      type: z.enum(['info', 'warning', 'error', 'git']).describe('Log level/type'),
      message: z.string().describe('Activity message'),
      details: z.record(z.unknown()).optional().describe('Optional structured details'),
    },
    withCallLog('kit_log_activity', async ({ session_id, type, message, details }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (!deps.activityService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Activity service not available' }) }] };
      }

      deps.activityService.log(session_id, type, message, { ...details, source: 'mcp' });
      return { content: [{ type: 'text', text: JSON.stringify({ logged: true, type, message }) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_lock_file — Declare file edit intent (optional repo for multi-repo)
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_lock_file',
    'Declare intent to edit files. Returns conflicts if another session holds locks on the same files.',
    {
      session_id: z.string().describe('The KIT session ID'),
      files: z.array(z.string()).describe('File paths to lock (relative to worktree)'),
      reason: z.string().optional().describe('Reason for the lock'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_lock_file', async ({ session_id, files, reason, repo }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      if (!deps.lockService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Lock service not available' }) }] };
      }

      try {
        // Check for conflicts first
        const conflictResult = await deps.lockService.checkConflicts(worktree, files, session_id);
        const conflicts = conflictResult.success && conflictResult.data?.length > 0
          ? conflictResult.data
          : [];

        if (conflicts.length > 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                locked: false,
                files,
                conflicts: conflicts.map((c: any) => ({
                  file: c.file || c.filePath,
                  heldBy: c.heldBy || c.agentType || 'unknown',
                  sessionId: c.sessionId || 'unknown',
                })),
              }),
            }],
          };
        }

        // Declare locks
        await deps.lockService.declareFiles(session_id, files, 'edit');

        if (deps.activityService) {
          deps.activityService.log(session_id, 'info', `Locked files: ${files.join(', ')}`, {
            files,
            reason,
            repo,
            source: 'mcp',
          });
        }

        return { content: [{ type: 'text', text: JSON.stringify({ locked: true, files, conflicts: [] }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : 'Lock failed' }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_unlock_file — Release file locks
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_unlock_file',
    'Release file locks for this session. If no files specified, releases all locks.',
    {
      session_id: z.string().describe('The KIT session ID'),
      files: z.array(z.string()).optional().describe('Specific files to unlock. Omit to release all.'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_unlock_file', async ({ session_id, files, repo }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (!deps.lockService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Lock service not available' }) }] };
      }

      try {
        if (files && files.length > 0) {
          // Release specific files by force-releasing each
          const worktree = binder.getWorktreePathForRepo(session_id, repo)!;
          for (const file of files) {
            await deps.lockService.forceReleaseLock(worktree, file);
          }
        } else {
          // Release all locks for this session
          await deps.lockService.releaseFiles(session_id);
        }

        return { content: [{ type: 'text', text: JSON.stringify({ unlocked: true, files: files || 'all' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : 'Unlock failed' }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_get_commit_history — Recent commits for session branch
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_get_commit_history',
    'Get recent commit history for the session branch. In multi-repo mode, specify repo to get history for a specific repository.',
    {
      session_id: z.string().describe('The KIT session ID'),
      limit: z.number().optional().default(10).describe('Max number of commits to return'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_get_commit_history', async ({ session_id, limit, repo }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      try {
        const result = await deps.gitService.getCommitHistory(worktree, undefined, limit);
        if (!result.success) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: result.error?.message || 'Failed to get history' }) }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify({ commits: result.data || [], repo: repo || undefined }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : 'History fetch failed' }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_request_review — Signal work ready for review
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_request_review',
    'Signal that work is ready for review. Logs activity and emits event to KIT dashboard.',
    {
      session_id: z.string().describe('The KIT session ID'),
      summary: z.string().describe('Summary of work completed and what to review'),
    },
    withCallLog('kit_request_review', async ({ session_id, summary }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (deps.activityService) {
        deps.activityService.log(session_id, 'info', `Review requested: ${summary}`, {
          reviewRequested: true,
          summary,
          source: 'mcp',
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ logged: true, summary, sessionId: session_id }),
        }],
      };
    })
  );
}
