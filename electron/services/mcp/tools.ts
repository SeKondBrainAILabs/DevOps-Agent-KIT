// This file contains the Zod schemas and handlers for the KIT MCP tools
import { z } from 'zod';

// Other tool schemas...

export const kit_commit = z.object({
  session_id: z.string(),
  message: z.string(),
  cwd: z.string(),
  push: z.boolean().optional(),
  repo: z.string().optional(),
  force: z.boolean().optional(),
  exclude: z.array(z.string()).optional().describe('paths relative to the worktree that stay on disk and are left out of this commit')
});

// Example handler function for kit_commit (simplified representation)
export const kit_commit_handler = async (params: z.infer<typeof kit_commit>, deps: any) => {
  const { session_id, message, repo, exclude } = params;
  
  // Pass exclude parameter to gitService.commit
  return await deps.gitService.commit(session_id, message, repo, exclude);
};

// kit_start_session schema modification (assuming it exists)
export const kit_start_session_response = z.object({
  ok: z.boolean(),
  session_id: z.string(),
  worktree_path: z.string().nullable(),
  branch: z.string(),
  base_branch: z.string(),
  setup_changes: z.array(z.string()) // NEW: array of paths from initial git status
});

// kit_start_session handler (simplified example)
export const kit_start_session_handler = async (params: any, deps: any) => {
  // ... existing logic ...
  
  // Handle worktree path determination for setup_changes
  let worktreePath = null;
  let setup_changes: string[] = [];
  
  // In a real implementation, we would determine the worktree path
  // and check for observer session vs regular session
  if (worktreePath) {
    setup_changes = await deps.gitService.getSetupChanges(worktreePath);
  }
  
  // Return the actual implementation with setup_changes
  return {
    ok: true,
    session_id: 'test_session',
    worktree_path: worktreePath,
    branch: 'main',
    base_branch: 'main',
    setup_changes: setup_changes // NEW: include setup_changes
  };
};