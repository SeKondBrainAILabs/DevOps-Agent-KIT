/**
 * MCP Resource Handlers
 *
 * Registers 4 resources:
 * - kanvas://session/{session_id}/info
 * - kanvas://session/{session_id}/houserules
 * - kanvas://session/{session_id}/contracts
 * - kanvas://session/{session_id}/commits
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSessionBinder } from './session-binder';
import type { McpServiceDeps } from '../McpServerService';
import { KANVAS_PATHS, CONTRACTS_PATHS } from '../../../shared/agent-protocol';

/**
 * Register all MCP resources on the server instance.
 */
export function registerResources(
  server: McpServer,
  binder: McpSessionBinder,
  deps: McpServiceDeps
): void {
  // --------------------------------------------------------------------------
  // Session info resource
  // --------------------------------------------------------------------------
  server.resource(
    'session-info',
    'kanvas://session/{session_id}/info',
    { description: 'Session metadata and configuration (JSON)' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      if (!sessionId) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Invalid URI' }) }] };
      }

      const session = binder.getSession(sessionId);
      if (!session) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Unknown session' }) }] };
      }

      let extraInfo: Record<string, unknown> = {};
      if (deps.agentInstanceService) {
        const instances = deps.agentInstanceService.listInstances();
        if (instances.success && instances.data) {
          const match = instances.data.find((i: any) => i.sessionId === sessionId);
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

      const info = {
        sessionId,
        worktreePath: session.worktreePath,
        registeredAt: session.registeredAt,
        ...extraInfo,
      };

      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(info, null, 2) }] };
    }
  );

  // --------------------------------------------------------------------------
  // Houserules resource
  // --------------------------------------------------------------------------
  server.resource(
    'houserules',
    'kanvas://session/{session_id}/houserules',
    { description: 'House rules for the session repository (Markdown)' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      if (!sessionId) {
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Error\nInvalid URI' }] };
      }

      const worktree = binder.getWorktreePath(sessionId);
      if (!worktree) {
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Error\nUnknown session' }] };
      }

      // Try worktree root first, then fallback to .S9N_KIT_DevOpsAgent/houserules.md
      const worktreeRulesPath = join(worktree, 'houserules.md');
      const kanvasRulesPath = join(worktree, KANVAS_PATHS.houserules);

      let content = '';
      if (existsSync(worktreeRulesPath)) {
        content = readFileSync(worktreeRulesPath, 'utf-8');
      } else if (existsSync(kanvasRulesPath)) {
        content = readFileSync(kanvasRulesPath, 'utf-8');
      } else {
        content = '# No House Rules\n\nNo houserules.md found for this session.';
      }

      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
    }
  );

  // --------------------------------------------------------------------------
  // Contracts directory listing
  // --------------------------------------------------------------------------
  server.resource(
    'contracts',
    'kanvas://session/{session_id}/contracts',
    { description: 'Contracts directory listing for the session repository (JSON)' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      if (!sessionId) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Invalid URI' }) }] };
      }

      const worktree = binder.getWorktreePath(sessionId);
      if (!worktree) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Unknown session' }) }] };
      }

      const contractsDir = join(worktree, CONTRACTS_PATHS.baseDir);
      let files: string[] = [];

      if (existsSync(contractsDir)) {
        try {
          files = readdirSync(contractsDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
        } catch {
          // Ignore read errors
        }
      }

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ directory: CONTRACTS_PATHS.baseDir, files }, null, 2),
        }],
      };
    }
  );

  // --------------------------------------------------------------------------
  // Commit history resource
  // --------------------------------------------------------------------------
  server.resource(
    'commits',
    'kanvas://session/{session_id}/commits',
    { description: 'Recent commit history for the session branch (JSON)' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      if (!sessionId) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Invalid URI' }) }] };
      }

      const worktree = binder.getWorktreePath(sessionId);
      if (!worktree) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'Unknown session' }) }] };
      }

      let commits: unknown[] = [];
      if (deps.gitService) {
        try {
          const result = await deps.gitService.getCommitHistory(worktree, undefined, 20);
          if (result.success && result.data) {
            commits = result.data;
          }
        } catch {
          // Ignore errors
        }
      }

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ commits }, null, 2),
        }],
      };
    }
  );
}

/**
 * Extract session_id from a kanvas://session/{session_id}/... URI.
 */
function extractSessionId(uriHref: string): string | null {
  const match = uriHref.match(/kanvas:\/\/session\/([^/]+)\//);
  return match ? match[1] : null;
}
