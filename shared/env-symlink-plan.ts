/**
 * `.env` symlink planner (Epic C / story C6).
 *
 * Pure decision logic for whether — and how — to expose the main repo's
 * `.env` file inside an agent worktree. fs operations live in the service
 * layer (AgentInstanceService); this module is the testable rule set.
 *
 * Cases:
 *  - In-place mode (worktreePath === repoPath): nothing to do, the agent is
 *    already running in the main repo.
 *  - Worktree mode but main repo has no `.env`: by default we BLOCK session
 *    start with an explanatory error (per AC). The user can override with
 *    `allowMissingEnv: true` to bypass.
 *  - Worktree already has its own `.env` (regular file or pre-existing
 *    symlink): leave it alone — never overwrite a user's existing file.
 *  - Otherwise: create a symlink `<worktree>/.env → <repo>/.env`.
 */

export interface EnvSymlinkInputs {
  repoPath: string;
  worktreePath: string;
  /** Does `<repoPath>/.env` exist? */
  repoEnvExists: boolean;
  /** Does `<worktreePath>/.env` already exist (file OR symlink)? */
  worktreeEnvExists: boolean;
  /** User opt-out — start the session even when main repo has no `.env`. */
  allowMissingEnv?: boolean;
}

export type EnvSymlinkAction =
  | { kind: 'skip-in-place'; reason: string }
  | { kind: 'skip-already-exists'; reason: string }
  | { kind: 'block-missing-env'; error: { code: string; message: string } }
  | { kind: 'allow-missing-env-override'; reason: string }
  | { kind: 'create-symlink'; from: string; to: string };

export const MISSING_ENV_ERROR_CODE = 'MISSING_ENV_FILE';

export function planEnvSymlink(input: EnvSymlinkInputs): EnvSymlinkAction {
  if (input.worktreePath === input.repoPath) {
    return {
      kind: 'skip-in-place',
      reason: 'In-place mode — agent runs in the main repo; no symlink needed.',
    };
  }

  if (input.worktreeEnvExists) {
    return {
      kind: 'skip-already-exists',
      reason: 'Worktree already has a .env — refusing to overwrite.',
    };
  }

  if (!input.repoEnvExists) {
    if (input.allowMissingEnv) {
      return {
        kind: 'allow-missing-env-override',
        reason: 'No .env in main repo and user opted to start anyway.',
      };
    }
    return {
      kind: 'block-missing-env',
      error: {
        code: MISSING_ENV_ERROR_CODE,
        message:
          'No .env file found in the main repo. Worktree sessions inherit ' +
          'environment variables from the main repo. Add a .env file or ' +
          'set allowMissingEnv to start without one.',
      },
    };
  }

  return {
    kind: 'create-symlink',
    from: `${input.repoPath}/.env`,
    to: `${input.worktreePath}/.env`,
  };
}
