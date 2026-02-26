/**
 * MCP Session Binder
 * Maps MCP connections to Kanvas sessions.
 * Pure logic class - no Electron dependencies.
 */

export interface BoundSession {
  kanvasSessionId: string;
  worktreePath: string;              // Primary repo worktree (backward compat default)
  registeredAt: string;
  // Multi-repo support
  repoPaths?: Map<string, string>;   // repoName → worktreePath/submodulePath
  primaryRepoName?: string;          // Which repoName is the primary
}

export class McpSessionBinder {
  /** kanvasSessionId -> worktree path */
  private sessions = new Map<string, BoundSession>();

  /** mcpSessionId -> kanvasSessionId */
  private bindings = new Map<string, string>();

  /**
   * Register a Kanvas session so MCP tools can resolve it.
   * Called during instance creation.
   */
  registerSession(kanvasSessionId: string, worktreePath: string): void {
    this.sessions.set(kanvasSessionId, {
      kanvasSessionId,
      worktreePath,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Unregister a Kanvas session (e.g. on session close).
   */
  unregisterSession(kanvasSessionId: string): void {
    this.sessions.delete(kanvasSessionId);
    // Also remove any MCP bindings that pointed to this session
    for (const [mcpId, sessId] of this.bindings) {
      if (sessId === kanvasSessionId) {
        this.bindings.delete(mcpId);
      }
    }
  }

  /**
   * Resolve a Kanvas session ID to its worktree path.
   */
  getWorktreePath(kanvasSessionId: string): string | undefined {
    return this.sessions.get(kanvasSessionId)?.worktreePath;
  }

  /**
   * Get full session info.
   */
  getSession(kanvasSessionId: string): BoundSession | undefined {
    return this.sessions.get(kanvasSessionId);
  }

  /**
   * Bind an MCP transport session to a Kanvas session.
   */
  bind(mcpSessionId: string, kanvasSessionId: string): boolean {
    if (!this.sessions.has(kanvasSessionId)) {
      return false;
    }
    this.bindings.set(mcpSessionId, kanvasSessionId);
    return true;
  }

  /**
   * Unbind an MCP transport session.
   */
  unbind(mcpSessionId: string): void {
    this.bindings.delete(mcpSessionId);
  }

  /**
   * Resolve an MCP session to a Kanvas session ID.
   */
  resolveBinding(mcpSessionId: string): string | undefined {
    return this.bindings.get(mcpSessionId);
  }

  /**
   * Get all registered sessions.
   */
  listSessions(): BoundSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get count of active MCP bindings.
   */
  getConnectionCount(): number {
    return this.bindings.size;
  }

  // ===========================================================================
  // Multi-repo session support
  // ===========================================================================

  /**
   * Register a multi-repo session.
   * The repo marked 'primary' (or the first) becomes the default worktreePath.
   */
  registerMultiRepoSession(
    kanvasSessionId: string,
    repos: Array<{ repoName: string; worktreePath: string; role: 'primary' | 'secondary' }>
  ): void {
    const primary = repos.find(r => r.role === 'primary') || repos[0];
    const repoPaths = new Map<string, string>();
    for (const repo of repos) {
      repoPaths.set(repo.repoName, repo.worktreePath);
    }
    this.sessions.set(kanvasSessionId, {
      kanvasSessionId,
      worktreePath: primary.worktreePath,
      registeredAt: new Date().toISOString(),
      repoPaths,
      primaryRepoName: primary.repoName,
    });
  }

  /**
   * Resolve worktree path for a specific repo within a session.
   * If repoName is omitted, returns the primary repo's path.
   */
  getWorktreePathForRepo(kanvasSessionId: string, repoName?: string): string | undefined {
    const session = this.sessions.get(kanvasSessionId);
    if (!session) return undefined;
    if (!repoName || !session.repoPaths) return session.worktreePath;
    return session.repoPaths.get(repoName);
  }

  /**
   * List all repos for a session.
   * Single-repo sessions return a one-element array with repoName 'primary'.
   */
  getReposForSession(kanvasSessionId: string): Array<{ repoName: string; worktreePath: string }> {
    const session = this.sessions.get(kanvasSessionId);
    if (!session) return [];
    if (!session.repoPaths) {
      return [{ repoName: 'primary', worktreePath: session.worktreePath }];
    }
    return Array.from(session.repoPaths.entries()).map(([name, path]) => ({
      repoName: name,
      worktreePath: path,
    }));
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.sessions.clear();
    this.bindings.clear();
  }
}
