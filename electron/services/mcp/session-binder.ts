/**
 * MCP Session Binder
 * Maps MCP connections to KIT sessions.
 * Pure logic class - no Electron dependencies.
 */

export interface BoundSession {
  kitSessionId: string;
  worktreePath: string;              // Primary repo worktree (backward compat default)
  registeredAt: string;
  // Multi-repo support
  repoPaths?: Map<string, string>;   // repoName → worktreePath/submodulePath
  primaryRepoName?: string;          // Which repoName is the primary
}

export class McpSessionBinder {
  /** kitSessionId -> worktree path */
  private sessions = new Map<string, BoundSession>();

  /** mcpSessionId -> kitSessionId */
  private bindings = new Map<string, string>();

  /**
   * Register a KIT session so MCP tools can resolve it.
   * Called during instance creation.
   */
  registerSession(kitSessionId: string, worktreePath: string): void {
    this.sessions.set(kitSessionId, {
      kitSessionId,
      worktreePath,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Unregister a KIT session (e.g. on session close).
   */
  unregisterSession(kitSessionId: string): void {
    this.sessions.delete(kitSessionId);
    // Also remove any MCP bindings that pointed to this session
    for (const [mcpId, sessId] of this.bindings) {
      if (sessId === kitSessionId) {
        this.bindings.delete(mcpId);
      }
    }
  }

  /**
   * Resolve a KIT session ID to its worktree path.
   */
  getWorktreePath(kitSessionId: string): string | undefined {
    return this.sessions.get(kitSessionId)?.worktreePath;
  }

  /**
   * Get full session info.
   */
  getSession(kitSessionId: string): BoundSession | undefined {
    return this.sessions.get(kitSessionId);
  }

  /**
   * Bind an MCP transport session to a KIT session.
   */
  bind(mcpSessionId: string, kitSessionId: string): boolean {
    if (!this.sessions.has(kitSessionId)) {
      return false;
    }
    this.bindings.set(mcpSessionId, kitSessionId);
    return true;
  }

  /**
   * Unbind an MCP transport session.
   */
  unbind(mcpSessionId: string): void {
    this.bindings.delete(mcpSessionId);
  }

  /**
   * Resolve an MCP session to a KIT session ID.
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
    kitSessionId: string,
    repos: Array<{ repoName: string; worktreePath: string; role: 'primary' | 'secondary' }>
  ): void {
    const primary = repos.find(r => r.role === 'primary') || repos[0];
    const repoPaths = new Map<string, string>();
    for (const repo of repos) {
      repoPaths.set(repo.repoName, repo.worktreePath);
    }
    this.sessions.set(kitSessionId, {
      kitSessionId,
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
  getWorktreePathForRepo(kitSessionId: string, repoName?: string): string | undefined {
    const session = this.sessions.get(kitSessionId);
    if (!session) return undefined;
    if (!repoName || !session.repoPaths) return session.worktreePath;
    return session.repoPaths.get(repoName);
  }

  /**
   * List all repos for a session.
   * Single-repo sessions return a one-element array with repoName 'primary'.
   */
  getReposForSession(kitSessionId: string): Array<{ repoName: string; worktreePath: string }> {
    const session = this.sessions.get(kitSessionId);
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
   * Check if a repo is a secondary (non-primary) repo in a multi-repo session.
   * Returns the primary repo name if so, or undefined for single-repo / primary.
   */
  getPrimaryRepoNameIfSecondary(kitSessionId: string, repoName?: string): string | undefined {
    const session = this.sessions.get(kitSessionId);
    if (!session || !session.repoPaths || !session.primaryRepoName) return undefined;
    // No repo specified or repo is the primary → not secondary
    if (!repoName || repoName === session.primaryRepoName) return undefined;
    return session.primaryRepoName;
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.sessions.clear();
    this.bindings.clear();
  }
}
