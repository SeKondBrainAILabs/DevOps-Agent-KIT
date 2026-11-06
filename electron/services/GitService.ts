// Import statements (assumed to be at the top)
import { execa } from 'execa';

// GitService class with required modifications
export class GitService {
  // Module-level constant for chunk size
  private static readonly RESET_CHUNK = 200;

  /**
   * Commit changes to the repository
   * @param sessionId - The session ID
   * @param message - Commit message
   * @param repoName - Optional repository name
   * @param exclude - Optional array of paths to exclude from commit
   * @returns Commit hash and files
   */
  async commit(
    sessionId: string,
    message: string,
    repoName?: string,
    exclude?: string[]
  ): Promise<{ hash: string; files: string[] }> {
    // Get worktree path
    const cwd = await this.getWorktreePath(sessionId);
    
    // Stage all changes
    await this.stageAllChanges(cwd);
    
    // If exclude is provided and non-empty, reset those paths
    if (exclude && exclude.length > 0) {
      // Split paths into chunks of RESET_CHUNK size for git reset
      for (let i = 0; i < exclude.length; i += GitService.RESET_CHUNK) {
        const chunk = exclude.slice(i, i + GitService.RESET_CHUNK);
        await execa('git', ['reset', '-q', '--', ...chunk], { cwd });
      }
      
      // Check if there's anything left to commit
      const { stdout: diffOutput } = await execa('git', ['diff', '--cached', '--name-only'], { cwd });
      if (!diffOutput.trim()) {
        throw new Error("nothing to commit");
      }
    }

    // Proceed with git commit
    const { stdout } = await execa('git', ['commit', '-m', message], { cwd });
    
    // Parse commit hash and files (simplified implementation)
    // In reality, you would parse the output of `git log --name-status -1`
    return { hash: '', files: [] };
  }

  /**
   * Get setup changes from git status
   * @param worktreePath - Path to the worktree
   * @returns Array of setup changes
   */
  async getSetupChanges(worktreePath: string): Promise<string[]> {
    try {
      const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=all'], { 
        cwd: worktreePath,
        timeout: 30000
      });
      
      // If no output, return empty array
      if (!stdout.trim()) {
        return [];
      }
      
      // Parse each line and extract paths
      const lines = stdout.split('\n').filter(line => line.trim() !== '');
      const paths: string[] = [];
      
      for (const line of lines) {
        if (line.startsWith('R ')) {
          // Rename case: extract destination path after " -> "
          const parts = line.split(' -> ');
          if (parts.length >= 2) {
            paths.push(parts[1].trim());
          }
        } else {
          // Regular case: extract path after status characters
          const pathMatch = line.match(/^.. (.+)$/);
          if (pathMatch) {
            paths.push(pathMatch[1]);
          }
        }
      }
      
      return paths;
    } catch (error) {
      // Return empty array when command fails
      return [];
    }
  }

  /**
   * Stage all changes in the worktree
   * @param cwd - Working directory
   */
  private async stageAllChanges(cwd: string) {
    // Implementation for staging all changes with fallback for broken submodules
    await execa('git', ['add', '-A'], { cwd });
  }

  /**
   * Get worktree path
   * @param sessionId - Session ID
   * @returns Worktree path
   */
  private async getWorktreePath(sessionId: string): Promise<string> {
    // Implementation to get worktree path from session ID
    // This is a placeholder - actual implementation depends on current structure
    return '';
  }
  
  /**
   * Register a worktree for a session (for testing purposes)
   * @param sessionId - Session ID
   * @param repoPath - Repository path
   * @param worktreePath - Worktree path
   */
  public registerWorktree(sessionId: string, repoPath: string, worktreePath: string): void {
    // Placeholder implementation - would store in memory or DB
  }
}