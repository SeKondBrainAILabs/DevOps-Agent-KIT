/**
 * AgentInstanceService
 *
 * Manages creation of agent instances from Kanvas dashboard.
 * Handles repository validation, .S9N_KIT_DevOpsAgent directory initialization,
 * and instruction generation for different agent types.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, readdir, stat, access } from 'fs/promises';
import { existsSync, constants } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { BaseService } from './BaseService';
import { databaseService } from './DatabaseService';

// Dynamic import helper for execa (ESM-only module)
// Handles various bundling scenarios with fallback patterns
let _execa: ((cmd: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string }>) | null = null;

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

async function execaCmd(cmd: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const execa = await getExeca();
  return execa(cmd, args, {
    ...options,
    timeout: options?.timeout ?? 30_000, // 30s default timeout to prevent hanging
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',   // Never prompt for credentials
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
    },
  });
}
import { KANVAS_PATHS, FILE_COORDINATION_PATHS, DEVOPS_KIT_DIR } from '../../shared/agent-protocol';
import { getAgentInstructions, generateClaudePrompt, generateCodexPrompt, InstructionVars } from '../../shared/agent-instructions';
import { resolveUnpushedCount } from '../../shared/unpushed-count';
import type {
  AgentType,
  AgentInstance,
  AgentInstanceConfig,
  RepoValidation,
  RecentRepo,
  KanvasConfig,
  IpcResult,
  RepoEntry,
  RepoRole,
} from '../../shared/types';

function generateAgentPrompt(agentType: AgentType, vars: InstructionVars): string | undefined {
  if (agentType === 'claude') return generateClaudePrompt(vars);
  if (agentType === 'codex') return generateCodexPrompt(vars);
  return undefined;
}
import { generateSecondaryBranchName } from '../../shared/types';
import { evaluateSingleSessionGuard } from '../../shared/single-session-guard';
import { isActiveInstance, isRunningInstance } from '../../shared/instance-status';
import { planEnvSymlink } from '../../shared/env-symlink-plan';
import { symlink, lstat } from 'fs/promises';
import type { TerminalLogService } from './TerminalLogService';
import type { ConfigService } from './ConfigService';
import { MCP_CONFIG_FILE, CONTRACTS_PATHS } from '../../shared/agent-protocol';

/**
 * Compute the worktree base dir for a repo. Worktrees live OUTSIDE the source
 * repo (sibling of the repo dir) so external `rm -rf .git`, `git clean -fdx`,
 * or session-manager prune passes can't silently wipe them.
 *
 *   <repo_parent>/<repo_name>           ← source repo
 *   <repo_parent>/KIT-DevOps-<repo_name>/<branchName>   ← worktrees go here
 *
 * Git tracks worktrees by absolute path in `.git/worktrees/<id>/`, so this
 * layout works transparently for `git status`, `commit`, `log`, merges, etc.
 * Exported (module-scope `function`) so other modules can reproduce the path.
 */
export function getWorktreeBaseDir(repoPath: string): string {
  const parent = dirname(repoPath);
  const name = basename(repoPath);
  return join(parent, `KIT-DevOps-${name}`);
}

interface SessionState {
  sessionId: string;
  lastProcessedCommit: string | null;
  lastProcessedAt: string | null;
  contractChangesCount: number;
  breakingChangesCount: number;
}

interface StoreSchema {
  recentRepos: RecentRepo[];
  instances: AgentInstance[];
  sessionStates: Record<string, SessionState>;
}

export class AgentInstanceService extends BaseService {
  private store: Store<StoreSchema>;
  private instances: Map<string, AgentInstance> = new Map();
  private terminalLogService: TerminalLogService | null = null;
  private mcpServerUrl: string | null = null;
  private rpcServerUrl: string | null = null;
  private configService: ConfigService | null = null;

  // Deferred session-state flush — avoids synchronous writeFileSync on every commit.
  // electron-store uses fs.writeFileSync internally which blocks the main thread.
  private sessionStatesCache: Record<string, SessionState> | null = null;
  private sessionStatesFlushTimer: NodeJS.Timeout | null = null;

  /**
   * Callback invoked after a single-repo session is created.
   * Used by index.ts to register the session with MCP session binder.
   */
  onSessionCreated?: (sessionId: string, worktreePath: string) => void;

  /**
   * Callback invoked after multi-repo session is created.
   * Used by index.ts to register repos with MCP session binder.
   */
  onMultiRepoSessionCreated?: (
    sessionId: string,
    repos: Array<{ repoName: string; worktreePath: string; role: RepoRole }>
  ) => void;

  /**
   * Set the terminal log service for logging restart operations
   */
  setTerminalLogService(terminalLog: TerminalLogService): void {
    this.terminalLogService = terminalLog;
  }

  /**
   * Set the MCP server URL so agents can be configured to use it
   */
  setMcpServerUrl(url: string | null): void {
    this.mcpServerUrl = url;
  }

  /**
   * Set the stateless JSON-RPC URL (/rpc) for Codex / type:"http" clients
   */
  setRpcServerUrl(url: string | null): void {
    this.rpcServerUrl = url;
  }

  /**
   * Inject ConfigService so we can read per-repo worktree-mode settings.
   * Used to enforce Single-Session Mode (Epic C, story C5).
   */
  setConfigService(svc: ConfigService): void {
    this.configService = svc;
    console.log('[AgentInstanceService] ConfigService configured');
  }

  /**
   * Return all sessions for a given repo that are currently active
   * (i.e. not 'completed' or 'closed'). Used by Single-Session Mode
   * checks and by the renderer to power session-count badges.
   */
  getActiveSessionsForRepo(repoPath: string): AgentInstance[] {
    return Array.from(this.instances.values()).filter(
      (inst) => inst.config.repoPath === repoPath && isActiveInstance(inst)
    );
  }

  /**
   * IPC-friendly count of lifecycle-active sessions for a repo.
   * Used by the Single-Session Mode guard (a `waiting` session has claimed
   * the slot and a second one would conflict) — must include statuses the
   * user-facing "running" badge excludes.
   */
  getActiveSessionCountForRepo(repoPath: string): IpcResult<number> {
    return { success: true, data: this.getActiveSessionsForRepo(repoPath).length };
  }

  /**
   * Count of truly-running sessions (an agent is attached and working) for a
   * repo. Distinct from `getActiveSessionCountForRepo` which includes
   * `waiting`/`pending`/`initializing` — the broader set the SSM guard needs.
   * The repo card surfaces THIS number as "N active" because users read it
   * as "N agents actually working", not "N session records on disk".
   * Without this distinction, agent_memory_vault showed "6 active" when 5
   * of those were waiting-but-never-connected and only 1 had a live agent.
   */
  getRunningSessionCountForRepo(repoPath: string): IpcResult<number> {
    const runningCount = Array.from(this.instances.values()).filter(
      (inst) => inst.config.repoPath === repoPath && isRunningInstance(inst)
    ).length;
    return { success: true, data: runningCount };
  }

  constructor() {
    super();
    this.store = new Store<StoreSchema>({
      name: 'kanvas-instances',
      defaults: {
        recentRepos: [],
        instances: [],
        sessionStates: {},
      },
    });

    // Load existing instances — normalize baseBranch at read time to strip any
    // legacy 'origin/' prefix (stored before v2.6.22 fix).
    const savedInstances = this.store.get('instances', []);
    for (const instance of savedInstances) {
      if (instance.config?.baseBranch) {
        instance.config.baseBranch = instance.config.baseBranch.replace(/^origin\//, '');
      }
      this.instances.set(instance.id, instance);
    }

    // Fix stale agent counts in recent repos on startup
    this.recalculateRepoAgentCounts();
  }

  /**
   * Validate a repository path
   */
  async validateRepository(repoPath: string): Promise<IpcResult<RepoValidation>> {
    try {
      // Check if path exists
      try {
        await access(repoPath, constants.R_OK);
      } catch {
        return {
          success: true,
          data: {
            isValid: false,
            isGitRepo: false,
            repoName: '',
            currentBranch: '',
            hasKanvasDir: false,
            branches: [],
            error: 'Path does not exist or is not accessible',
          },
        };
      }

      // Check if it's a directory
      const stats = await stat(repoPath);
      if (!stats.isDirectory()) {
        return {
          success: true,
          data: {
            isValid: false,
            isGitRepo: false,
            repoName: '',
            currentBranch: '',
            hasKanvasDir: false,
            branches: [],
            error: 'Path is not a directory',
          },
        };
      }

      // Check if it's a git repository
      const gitDir = join(repoPath, '.git');
      const isGitRepo = existsSync(gitDir);

      if (!isGitRepo) {
        return {
          success: true,
          data: {
            isValid: false,
            isGitRepo: false,
            repoName: basename(repoPath),
            currentBranch: '',
            hasKanvasDir: false,
            branches: [],
            error: 'Not a Git repository',
          },
        };
      }

      // Get repository info using git commands

      // Get current branch
      const branchResult = await execaCmd('git', ['branch', '--show-current'], { cwd: repoPath });
      const currentBranch = branchResult.stdout.trim() || 'HEAD';

      // Branch candidates for the base-branch picker. We include BOTH local heads
      // and remote branches (with the remote prefix stripped) so that primaries like
      // main/development are always offerable — even when the local checkout is in a
      // detached HEAD state or simply lacks a local main (only origin/main exists).
      // `git branch -b <new> origin/main` works fine, so these are valid bases.
      const localResult = await execaCmd('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath });
      const localBranches = localResult.stdout.split('\n').map(s => s.trim()).filter(Boolean);

      let remoteBranches: string[] = [];
      try {
        const remoteBranchResult = await execaCmd('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: repoPath });
        remoteBranches = remoteBranchResult.stdout.split('\n').map(s => s.trim()).filter(Boolean)
          .filter(b => !b.includes('HEAD'))        // skip the 'origin/HEAD -> origin/main' pointer
          .map(b => b.replace(/^[^/]+\//, ''));     // strip the remote name (origin/) prefix
      } catch {
        // No remote configured — local branches only.
      }

      // Merge, drop detached-HEAD pseudo-entries (e.g. "(HEAD detached at <tag>)"),
      // and de-duplicate. The picker stores a plain branch name as the base.
      const branches = Array.from(new Set(
        [...localBranches, ...remoteBranches].filter(b => b && !b.startsWith('(') && !b.includes('HEAD detached'))
      ));

      // Get remote URL
      let remoteUrl: string | undefined;
      try {
        const remoteResult = await execaCmd('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
        remoteUrl = remoteResult.stdout.trim();
      } catch {
        // No remote configured
      }

      // Check if DevOps Kit directory exists
      const devopsKitDir = join(repoPath, KANVAS_PATHS.baseDir);
      const hasKanvasDir = existsSync(devopsKitDir);

      return {
        success: true,
        data: {
          isValid: true,
          isGitRepo: true,
          repoName: basename(repoPath),
          currentBranch,
          remoteUrl,
          hasKanvasDir,
          branches,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Failed to validate repository',
        },
      };
    }
  }

  /**
   * Initialize .S9N_KIT_DevOpsAgent directory in a repository
   * This is the per-repo installation directory for the DevOps Agent
   */
  async initializeKanvasDirectory(repoPath: string): Promise<IpcResult<void>> {
    try {
      const devopsKitDir = join(repoPath, KANVAS_PATHS.baseDir);

      // Create all required directories
      const dirs = [
        // DevOps Agent Kit directories
        KANVAS_PATHS.baseDir,
        KANVAS_PATHS.agents,
        KANVAS_PATHS.sessions,
        KANVAS_PATHS.activity,
        KANVAS_PATHS.commands,
        KANVAS_PATHS.heartbeats,
        // File coordination directories (for multi-agent file locking)
        FILE_COORDINATION_PATHS.baseDir,
        FILE_COORDINATION_PATHS.activeEdits,
        FILE_COORDINATION_PATHS.completedEdits,
      ];

      for (const dir of dirs) {
        const fullPath = join(repoPath, dir);
        if (!existsSync(fullPath)) {
          await mkdir(fullPath, { recursive: true });
        }
      }

      // Create config file
      const config: KanvasConfig = {
        version: '1.0.0',
        repoPath,
        initialized: new Date().toISOString(),
        settings: {
          autoCommit: true,
          commitInterval: 30000,
          watchPatterns: ['**/*'],
          ignorePatterns: ['node_modules/**', '.git/**', `${DEVOPS_KIT_DIR}/**`],
        },
      };

      const configPath = join(devopsKitDir, 'config.json');
      await writeFile(configPath, JSON.stringify(config, null, 2));

      // Create houserules.md at repo root (single source of truth — teams can commit this)
      const houserulesPath = join(repoPath, 'houserules.md');
      if (!existsSync(houserulesPath)) {
        const houserulesContent = `# House Rules for DevOps Agent

This file defines team-specific rules and guidelines for AI agents working in this repository.
You can commit this file to share rules with your team.

## Code Style
- Follow existing patterns in the codebase
- Use TypeScript strict mode

## Git Workflow
- Create feature branches from main
- Use conventional commit messages

## Testing
- Write tests for new features
- Ensure existing tests pass before committing

---
*This file was auto-generated. Feel free to customize it for your team.*
`;
        await writeFile(houserulesPath, houserulesContent);
      }

      // Create FOLDER_STRUCTURE.md at repo root (separate from houserules)
      const folderStructurePath = join(repoPath, 'FOLDER_STRUCTURE.md');
      if (!existsSync(folderStructurePath)) {
        const folderStructureContent = `# Folder Structure

This document outlines the standard folder structure for this project.
All files **MUST** be placed in their respective folders as described below.
You may create new module and feature subfolders following the established patterns,
but **MUST** update this document when doing so.

## Project Layout
\`\`\`
├── houserules.md                  # Team coding rules and conventions
├── FOLDER_STRUCTURE.md            # This file — folder layout reference
├── House_Rules_Contracts/         # Contract documentation
│   ├── API_CONTRACT.md            # API endpoints and interfaces
│   ├── DATABASE_SCHEMA_CONTRACT.md # Database schema definitions
│   ├── EVENTS_CONTRACT.md         # Event system documentation
│   ├── FEATURES_CONTRACT.md       # Feature specifications
│   ├── INFRA_CONTRACT.md          # Infrastructure documentation
│   ├── THIRD_PARTY_INTEGRATIONS.md # External service integrations
│   ├── ADMIN_CONTRACT.md          # Admin panel contracts
│   ├── SQL_CONTRACT.md            # SQL queries and migrations
│   ├── CSS_CONTRACT.md            # Styling conventions
│   ├── PROMPTS_CONTRACT.md        # AI prompt templates
│   ├── E2E_TESTS_CONTRACT.md      # End-to-end test contracts
│   ├── UNIT_TESTS_CONTRACT.md     # Unit test contracts
│   ├── INTEGRATION_TESTS_CONTRACT.md # Integration test contracts
│   └── FIXTURES_CONTRACT.md       # Test fixtures contracts
├── .S9N_KIT_DevOpsAgent/          # DevOps agent runtime data (gitignored)
│   ├── agents/                    # Agent registration files
│   ├── sessions/                  # Session status files
│   ├── activity/                  # Activity logs
│   ├── commands/                  # Kanvas → Agent commands
│   ├── heartbeats/                # Agent heartbeat files
│   ├── coordination/              # File locking/coordination
│   │   ├── active-edits/
│   │   └── completed-edits/
│   └── config.json                # Repo-specific config
├── .mcp.json                      # MCP server config (auto-generated)
└── .agent-config                  # Agent session config (auto-generated)
\`\`\`

## Rules
- Do not create new top-level directories without updating this file
- Follow existing module/feature sub-folder patterns
- Keep runtime/generated files gitignored

---
*This file was auto-generated. Feel free to customize it for your project.*
`;
        await writeFile(folderStructurePath, folderStructureContent);
      }

      // Add .S9N_KIT_DevOpsAgent to .gitignore
      const gitignorePath = join(repoPath, '.gitignore');
      try {
        let gitignore = '';
        if (existsSync(gitignorePath)) {
          gitignore = await readFile(gitignorePath, 'utf-8');
        }

        // Add DevOps Kit directory (all runtime data — gitignored)
        if (!gitignore.includes(DEVOPS_KIT_DIR)) {
          gitignore += `
# DevOps Agent Kit (local runtime data - do not commit)
${DEVOPS_KIT_DIR}/
`;
        }
        if (!gitignore.includes('.devops-commit-')) {
          gitignore += '\n# DevOps commit message files\n.devops-commit-*.msg\n';
        }
        if (!gitignore.includes('local_deploy/')) {
          gitignore += '\n# Local worktrees for isolated development\nlocal_deploy/\n';
        }
        if (!gitignore.includes('.agent-config')) {
          gitignore += '\n# Agent session config (auto-generated per session)\n.agent-config\n';
        }
        if (!gitignore.includes(MCP_CONFIG_FILE)) {
          gitignore += `\n# MCP server config (auto-generated per session)\n${MCP_CONFIG_FILE}\n`;
        }
        if (!gitignore.includes('.claude/settings.json')) {
          gitignore += '\n# Claude Code project settings (auto-generated per session)\n.claude/settings.json\n';
        }
        await writeFile(gitignorePath, gitignore);
      } catch {
        // Ignore gitignore errors
      }

      console.log(`[AgentInstanceService] Initialized ${DEVOPS_KIT_DIR} directory in ${repoPath}`);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INIT_ERROR',
          message: error instanceof Error ? error.message : 'Failed to initialize DevOps Kit directory',
        },
      };
    }
  }

  /**
   * Create a new agent instance
   */
  async createInstance(config: AgentInstanceConfig): Promise<IpcResult<AgentInstance>> {
    try {
      // Normalize baseBranch — strip any remote-tracking prefix so git ops never
      // double up (e.g. 'origin/main' → 'main').
      config = { ...config, baseBranch: (config.baseBranch || 'main').replace(/^origin\//, '') };

      // Validate repository first
      const validation = await this.validateRepository(config.repoPath);
      if (!validation.success || !validation.data?.isValid) {
        return {
          success: false,
          error: {
            code: 'INVALID_REPO',
            message: validation.data?.error || 'Invalid repository',
          },
        };
      }

      // Initialize .kanvas directory if needed
      if (!validation.data.hasKanvasDir) {
        const initResult = await this.initializeKanvasDirectory(config.repoPath);
        if (!initResult.success) {
          return initResult as IpcResult<AgentInstance>;
        }
      }

      // Check if branch name is already in use by an active session
      const existingSession = Array.from(this.instances.values()).find(
        inst => inst.config.branchName === config.branchName &&
                inst.config.repoPath === config.repoPath &&
                inst.status !== 'completed' &&
                inst.status !== 'closed'
      );
      if (existingSession) {
        return {
          success: false,
          error: {
            code: 'BRANCH_IN_USE',
            message: `Branch "${config.branchName}" is already in use by an active session. Please use a different branch name.`,
          },
        };
      }

      // Single-Session Mode guard (Epic C / C5):
      // when this repo has worktrees disabled, only ONE active session is allowed.
      if (this.configService) {
        const mode = this.configService.getRepoWorktreeMode(config.repoPath);
        const activeCount = this.getActiveSessionsForRepo(config.repoPath).length;
        const guard = evaluateSingleSessionGuard(mode, activeCount);
        if (guard.blocked && guard.error) {
          return { success: false, error: guard.error };
        }
      }

      // Generate unique ID
      const id = `inst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Generate instructions
      const instructionVars: InstructionVars = {
        repoPath: config.repoPath,
        repoName: basename(config.repoPath),
        branchName: config.branchName,
        sessionId,
        taskDescription: config.taskDescription,
        systemPrompt: config.systemPrompt || '',
        contextPreservation: config.contextPreservation || '',
        rebaseFrequency: config.rebaseFrequency || 'never',
      };

      const instructions = getAgentInstructions(config.agentType, instructionVars);

      // Generate the standalone prompt for easy copying (agent-specific)
      const prompt = generateAgentPrompt(config.agentType, instructionVars);

      // Create instance
      const instance: AgentInstance = {
        id,
        config,
        status: 'waiting',
        createdAt: new Date().toISOString(),
        instructions,
        prompt,
        sessionId,
      };

      // Save instance
      this.instances.set(id, instance);
      this.saveInstances();

      // Add to recent repos
      await this.addRecentRepo({
        path: config.repoPath,
        name: basename(config.repoPath),
        lastUsed: new Date().toISOString(),
        agentCount: 1,
      });

      // Create worktree for isolated development. createWorktreeIfNeeded
      // handles branch creation atomically via `git worktree add -b <branch>
      // <path> <base>` — no need to pre-create the branch by touching the
      // source repo's HEAD. The old createBranchIfNeeded path did
      // `git checkout -b` + `git checkout -` in config.repoPath, which
      // switched the user's source-repo branch out from under any work they
      // had open (and could leave them stuck on the session branch if the
      // return checkout failed).
      const worktreePath = await this.createWorktreeIfNeeded(config);

      // Update instance with worktree path
      instance.worktreePath = worktreePath;

      // ALWAYS regenerate instructions with the actual working directory (worktree path)
      // This ensures the agent works in the isolated worktree, not the main repo
      const workingDirectory = worktreePath; // The agent should work HERE
      console.log(`[AgentInstanceService] Working directory for agent: ${workingDirectory}`);
      console.log(`[AgentInstanceService] Main repo path: ${config.repoPath}`);
      console.log(`[AgentInstanceService] Worktree created: ${worktreePath !== config.repoPath}`);

      const finalInstructionVars: InstructionVars = {
        ...instructionVars,
        repoPath: workingDirectory, // CRITICAL: Use worktree path, not main repo
        baseBranch: config.baseBranch,
        mcpUrl: this.mcpServerUrl || undefined,
        rpcUrl: this.rpcServerUrl || undefined,
        customMcpEnabled: config.customMcpEnabled,
      };
      instance.instructions = getAgentInstructions(config.agentType, finalInstructionVars);
      instance.prompt = generateAgentPrompt(config.agentType, finalInstructionVars);

      // Save instance with updated instructions
      this.instances.set(id, instance);
      this.saveInstances();

      // Create session file so it appears in the dashboard (use worktree path)
      await this.createSessionFile({ ...config, repoPath: config.repoPath }, sessionId, worktreePath);

      // Emit status change event
      this.emitStatusChange(instance);

      console.log(`[AgentInstanceService] Created agent instance ${id} for ${config.agentType}`);
      console.log(`[AgentInstanceService] Agent should work in: ${workingDirectory}`);

      // Setup agent environment (.agent-config, .vscode/settings.json)
      await this.setupAgentEnvironment(id);

      // Register single-repo session with MCP binder so tools recognize it
      if (!config.multiRepo && this.onSessionCreated) {
        this.onSessionCreated(sessionId, worktreePath);
        console.log(`[AgentInstanceService] Session ${sessionId} registered with MCP binder (worktree: ${worktreePath})`);
      }

      // Multi-repo: create secondary repo environments after primary is ready
      if (config.multiRepo) {
        try {
          const repoEntries = await this.createMultiRepoEnvironment(config, sessionId, worktreePath);
          instance.multiRepoEntries = repoEntries;

          // Re-generate instructions with multi-repo context
          const multiRepoVars: InstructionVars = {
            ...finalInstructionVars,
            multiRepoEntries: repoEntries,
            commitScope: config.multiRepo.commitScope,
          };
          instance.instructions = getAgentInstructions(config.agentType, multiRepoVars);
          instance.prompt = generateAgentPrompt(config.agentType, multiRepoVars);

          this.instances.set(id, instance);
          this.saveInstances();

          // Notify via callback so MCP session binder can register all repos
          if (this.onMultiRepoSessionCreated) {
            this.onMultiRepoSessionCreated(
              sessionId,
              repoEntries.map(r => ({
                repoName: r.repoName,
                worktreePath: r.worktreePath,
                role: r.role,
              }))
            );
          }

          console.log(`[AgentInstanceService] Multi-repo environment created with ${repoEntries.length} repos`);
        } catch (error) {
          console.warn(`[AgentInstanceService] Multi-repo setup failed (primary still works): ${error}`);
        }
      }

      return { success: true, data: instance };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'CREATE_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create agent instance',
        },
      };
    }
  }

  /**
   * Create session file in .kanvas/sessions/ so it appears in dashboard
   */
  private async createSessionFile(config: AgentInstanceConfig, sessionId: string, worktreePath?: string): Promise<void> {
    try {
      const sessionsDir = join(config.repoPath, KANVAS_PATHS.sessions);

      // Ensure sessions directory exists
      if (!existsSync(sessionsDir)) {
        await mkdir(sessionsDir, { recursive: true });
      }

      const agentId = `kanvas-${config.agentType}-${sessionId.slice(-8)}`;
      const now = new Date().toISOString();

      // Create session report
      const sessionReport = {
        sessionId,
        agentId,
        agentType: config.agentType,
        task: config.taskDescription || `${config.agentType} session`,
        branchName: config.branchName,
        baseBranch: config.baseBranch, // The branch this session was created from (merge target)
        worktreePath: worktreePath || config.repoPath,
        repoPath: config.repoPath,
        status: 'idle' as const,
        created: now,
        updated: now,
        commitCount: 0,
      };

      // Write session file
      const sessionFile = join(sessionsDir, `${sessionId}.json`);
      await writeFile(sessionFile, JSON.stringify(sessionReport, null, 2));

      // Also create an agent registration so the session shows up properly
      const agentsDir = join(config.repoPath, KANVAS_PATHS.agents);
      if (!existsSync(agentsDir)) {
        await mkdir(agentsDir, { recursive: true });
      }

      const agentInfo = {
        agentId,
        agentType: config.agentType,
        agentName: `${config.agentType.charAt(0).toUpperCase()}${config.agentType.slice(1)} (${basename(config.repoPath)})`,
        version: '1.0.0',
        pid: process.pid,
        startedAt: now,
        repoPath: config.repoPath,
        capabilities: ['code-generation', 'file-editing'],
        sessions: [sessionId],
      };

      const agentFile = join(agentsDir, `${agentId}.json`);
      await writeFile(agentFile, JSON.stringify(agentInfo, null, 2));

      // Emit session and agent to renderer so they show up immediately
      const windows = BrowserWindow.getAllWindows();
      console.log(`[AgentInstanceService] Emitting session to ${windows.length} windows:`, sessionReport.sessionId);
      for (const win of windows) {
        win.webContents.send('session:reported', sessionReport);
        win.webContents.send('agent:registered', {
          ...agentInfo,
          lastHeartbeat: now,
          isAlive: true,
        });
      }

      console.log(`[AgentInstanceService] Created session file: ${sessionFile}`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create session file: ${error}`);
      // Don't fail the whole operation if session file creation fails
    }
  }

  /**
   * Create worktree for isolated development.
   *
   * **Layout change (v2.6.54):** worktrees live OUTSIDE the source repo, at
   *   `<repo_parent>/KIT-DevOps-<repo_name>/<branchName>/`
   * (a sibling of the repo dir). The old layout, `<repo>/local_deploy/...`,
   * sat inside the source tree, which meant any external `rm -rf .git`,
   * `git clean -fdx`, or session-manager prune (e.g. a Codex coordinator
   * scanning `local_deploy/codex-session-*`) would silently wipe the
   * worktree directory. The new path is on the same disk as the repo so
   * `git worktree add` doesn't need a `--no-checkout-link` workaround, and
   * git tracks the worktree by absolute path so every git op continues to
   * work normally.
   *
   * If a worktree already exists at the LEGACY `local_deploy/...` location,
   * we honor it (backward compat). Only newly-created worktrees go to the
   * new location.
   */
  private async createWorktreeIfNeeded(config: AgentInstanceConfig): Promise<string> {
    try {
      const legacyDir = join(config.repoPath, 'local_deploy', config.branchName);
      const newWorktreeBaseDir = getWorktreeBaseDir(config.repoPath);
      const worktreeDir = join(newWorktreeBaseDir, config.branchName);

      // Honor an existing legacy worktree (created before v2.6.54) rather than
      // making a duplicate. Same for the new path.
      if (existsSync(legacyDir)) {
        console.log(`[AgentInstanceService] Worktree already exists at legacy path ${legacyDir} — honoring it`);
        return legacyDir;
      }
      if (existsSync(worktreeDir)) {
        console.log(`[AgentInstanceService] Worktree already exists at ${worktreeDir}`);
        return worktreeDir;
      }

      // Ensure the sibling base dir exists (e.g. `.../KIT-DevOps-<repo_name>/`).
      if (!existsSync(newWorktreeBaseDir)) {
        await mkdir(newWorktreeBaseDir, { recursive: true });
      }

      // Create worktree — CRITICAL: branch safety.
      // `git worktree add <dir> <ref>` resolves <ref> as ANY ref (branch, tag, or
      // commit). If the session branch doesn't exist yet, git would silently check
      // out a same-named tag/commit and land in DETACHED HEAD — auto-commits then
      // attach to no branch and can be lost. To prevent this we explicitly branch:
      //   - branch exists  → `git worktree add <dir> <branchName>` (checks it out)
      //   - branch missing → `git worktree add -b <branchName> <dir> <baseBranch>`
      //     (atomically creates the session branch from the base and checks it out)
      const baseBranch = (config.baseBranch || 'main').replace(/^origin\//, '');
      const branchListed = await execaCmd('git', ['branch', '--list', config.branchName], { cwd: config.repoPath });
      const branchExists = Boolean(branchListed.stdout.trim());

      if (branchExists) {
        await execaCmd('git', ['worktree', 'add', worktreeDir, config.branchName], { cwd: config.repoPath });
      } else {
        await execaCmd('git', ['worktree', 'add', '-b', config.branchName, worktreeDir, baseBranch], { cwd: config.repoPath });
      }

      // Safety net: verify the worktree landed on the expected branch, not detached.
      const headCheck = await execaCmd('git', ['branch', '--show-current'], { cwd: worktreeDir });
      const head = headCheck.stdout.trim();
      if (head !== config.branchName) {
        console.warn(`[AgentInstanceService] Worktree HEAD is "${head || 'DETACHED'}", expected "${config.branchName}" — re-attaching to session branch`);
        // Force the worktree onto a correctly-named session branch from base.
        await execaCmd('git', ['checkout', '-B', config.branchName, baseBranch], { cwd: worktreeDir });
      }
      console.log(`[AgentInstanceService] Created worktree at ${worktreeDir} for branch ${config.branchName}`);

      // Initialize .S9N_KIT_DevOpsAgent in the worktree
      await this.initializeKanvasDirectory(worktreeDir);

      // C6: link the main repo's .env into the worktree so the agent inherits env vars.
      await this.linkEnvIntoWorktree(config.repoPath, worktreeDir);

      // Propagate the source repo's pre-commit hook to the worktree's gitdir so
      // every KIT-initiated commit fires the project's existing hygiene. Worktree
      // gitdirs have their OWN .git/hooks directory — if the project uses the
      // `pre-commit` framework or husky, the hook is only installed in the
      // SOURCE repo's gitdir by default. This is the gap that let Kemory's
      // truncated ai_chat_service.py reach origin/main: kit_commit / merge auto-
      // commits ran `git commit` in a worktree gitdir with no pre-commit hook
      // physically present, so the project's parser/format/EOF checks silently
      // didn't run. Best-effort — failure here doesn't block worktree creation.
      await this.installPreCommitHookIntoWorktree(config.repoPath, worktreeDir);

      return worktreeDir;
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create worktree: ${error}`);
      // Fall back to using main repo path
      return config.repoPath;
    }
  }

  /**
   * C6: Link the main repo's `.env` into the worktree if appropriate.
   * Decision is delegated to the pure planner in `shared/env-symlink-plan.ts`;
   * this method only handles the fs side. Failure is non-fatal — we log and
   * carry on rather than blocking session start, except in the deliberate
   * `block-missing-env` case (which is logged as a warning here; the
   * stricter behavior is enforced higher up via the planner's error code).
   */
  private async linkEnvIntoWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      const repoEnvPath = join(repoPath, '.env');
      const treeEnvPath = join(worktreePath, '.env');
      const repoEnvExists = existsSync(repoEnvPath);

      let worktreeEnvExists = false;
      try {
        await lstat(treeEnvPath);
        worktreeEnvExists = true;
      } catch {
        // not present
      }

      const action = planEnvSymlink({
        repoPath,
        worktreePath,
        repoEnvExists,
        worktreeEnvExists,
      });

      switch (action.kind) {
        case 'create-symlink':
          await symlink(repoEnvPath, treeEnvPath);
          console.log(`[AgentInstanceService] Linked .env into worktree: ${treeEnvPath} -> ${repoEnvPath}`);
          break;
        case 'skip-in-place':
        case 'skip-already-exists':
          console.log(`[AgentInstanceService] .env link skipped: ${action.reason}`);
          break;
        case 'allow-missing-env-override':
          console.warn(`[AgentInstanceService] Starting session without .env (override): ${action.reason}`);
          break;
        case 'block-missing-env':
          console.warn(`[AgentInstanceService] No .env file in repo — agent may fail at runtime: ${action.error.message}`);
          break;
      }
    } catch (err) {
      console.warn(`[AgentInstanceService] Could not link .env into worktree: ${err}`);
    }
  }

  /**
   * Copy the source repo's pre-commit hook script (if any) into the worktree's
   * gitdir/hooks/ so KIT-initiated commits run the same checks. Worktrees have
   * isolated `.git/hooks/` directories at `<source>/.git/worktrees/<wt>/hooks/`,
   * so a hook installed by `pre-commit install` or `husky install` in the
   * source repo only fires for commits made from the source's working tree —
   * KIT-managed worktrees silently skip it. This is the gap that let Kemory's
   * 1119-line truncation reach origin/main.
   *
   * Strategy: copy `<source>/.git/hooks/pre-commit` (the executable that
   * `pre-commit install` / husky write) verbatim into the worktree's
   * hooks dir. The script itself dispatches to `.pre-commit-config.yaml` or
   * `.husky/pre-commit` so we don't need to know which tool is in use.
   *
   * Idempotent — if a hook is already present in the worktree gitdir we
   * leave it alone (the user may have hand-customized it). Failure here is
   * non-fatal: worktree creation still succeeds, the agent just doesn't get
   * the hook safety net.
   */
  private async installPreCommitHookIntoWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      // Resolve the worktree's gitdir via `git rev-parse --git-dir` from
      // inside the worktree — far more reliable than reconstructing the path
      // from the basename (legacy `local_deploy/` worktrees don't match).
      const gitDirRes = await execaCmd('git', ['rev-parse', '--git-dir'], { cwd: worktreePath });
      const rawGitDir = gitDirRes.stdout.trim();
      const wtGitDir = rawGitDir.startsWith('/') ? rawGitDir : join(worktreePath, rawGitDir);
      const wtHooksDir = join(wtGitDir, 'hooks');
      const wtPreCommit = join(wtHooksDir, 'pre-commit');

      if (existsSync(wtPreCommit)) {
        console.log(`[AgentInstanceService] Worktree pre-commit hook already present: ${wtPreCommit}`);
        return;
      }

      // Source hook lives at <source>/.git/hooks/pre-commit after pre-commit or
      // husky has been installed. If it doesn't exist, the project has no
      // hooks configured and there's nothing to propagate.
      const sourceGitDirRes = await execaCmd('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath });
      const rawSourceGitDir = sourceGitDirRes.stdout.trim();
      const sourceGitDir = rawSourceGitDir.startsWith('/') ? rawSourceGitDir : join(repoPath, rawSourceGitDir);
      const sourcePreCommit = join(sourceGitDir, 'hooks', 'pre-commit');

      if (!existsSync(sourcePreCommit)) {
        console.log(`[AgentInstanceService] No source pre-commit hook to install (${sourcePreCommit} missing)`);
        return;
      }

      await mkdir(wtHooksDir, { recursive: true });
      const fs = await import('fs/promises');
      const contents = await fs.readFile(sourcePreCommit);
      await fs.writeFile(wtPreCommit, contents, { mode: 0o755 });
      console.log(`[AgentInstanceService] Installed pre-commit hook into worktree: ${wtPreCommit}`);
    } catch (err) {
      // Hook install failure is never fatal — the worktree should still come
      // up. The KIT-side parser/diff gate provides defense-in-depth.
      console.warn(`[AgentInstanceService] Could not install pre-commit hook into worktree: ${err}`);
    }
  }

  /**
   * Create .agent-config file in worktree root
   * Contains agent identification and session info for external tools
   */
  private async createAgentConfigFile(
    worktreePath: string,
    instance: AgentInstance
  ): Promise<void> {
    try {
      const agentConfig: Record<string, unknown> = {
        version: '1.0.0',
        sessionId: instance.sessionId,
        instanceId: instance.id,
        agentType: instance.config.agentType,
        branchName: instance.config.branchName,
        baseBranch: (instance.config.baseBranch || 'main').replace(/^origin\//, ''),
        taskDescription: instance.config.taskDescription,
        createdAt: instance.createdAt,
        worktreePath,
        repoPath: instance.config.repoPath,
        environment: {
          KANVAS_SESSION_ID: instance.sessionId,
          KANVAS_AGENT_TYPE: instance.config.agentType,
          KANVAS_WORKTREE_PATH: worktreePath,
          KANVAS_BRANCH_NAME: instance.config.branchName,
          ...(this.mcpServerUrl ? { KANVAS_MCP_URL: this.mcpServerUrl } : {}),
        },
        ...(this.mcpServerUrl ? { mcpServerUrl: this.mcpServerUrl } : {}),
      };

      const configPath = join(worktreePath, '.agent-config');
      await writeFile(configPath, JSON.stringify(agentConfig, null, 2));
      console.log(`[AgentInstanceService] Created .agent-config at ${configPath}`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create .agent-config: ${error}`);
    }
  }

  /**
   * Create .vscode/settings.json with agent-specific settings
   * Sets window title to include agent name for easy identification
   */
  private async createVSCodeSettings(
    worktreePath: string,
    instance: AgentInstance
  ): Promise<void> {
    try {
      const vscodeDir = join(worktreePath, '.vscode');
      if (!existsSync(vscodeDir)) {
        await mkdir(vscodeDir, { recursive: true });
      }

      const settingsPath = join(vscodeDir, 'settings.json');
      let existingSettings: Record<string, unknown> = {};

      // Load existing settings if present
      if (existsSync(settingsPath)) {
        try {
          const content = await readFile(settingsPath, 'utf-8');
          existingSettings = JSON.parse(content);
        } catch {
          // Ignore parse errors, start fresh
        }
      }

      // Merge with agent-specific settings
      const agentLabel = instance.config.agentType.charAt(0).toUpperCase() + instance.config.agentType.slice(1);
      const shortSessionId = instance.sessionId?.replace('sess_', '').slice(0, 8) || 'unknown';

      const settings = {
        ...existingSettings,
        'window.title': `[${agentLabel}] \${rootName} - \${activeEditorShort} | Session: ${shortSessionId}`,
        'scm.defaultViewMode': 'tree',
        'git.autofetch': true,
        'editor.formatOnSave': true,
        // Recommended extensions for the agent workflow
        'recommendations': [
          'eamodio.gitlens',
          'streetsidesoftware.code-spell-checker',
        ],
      };

      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[AgentInstanceService] Created .vscode/settings.json at ${settingsPath}`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create VS Code settings: ${error}`);
    }
  }

  /**
   * Create .mcp.json in worktree root for MCP-capable agents (claude, cline)
   * Allows agents to auto-discover the KIT MCP server
   */
  private async createMcpConfigFile(worktreePath: string): Promise<void> {
    if (!this.mcpServerUrl) return;

    try {
      // Include both transport types so any agent (Claude Code, Codex, Cursor, etc.) can connect:
      // - kit: streamable-http for Claude Code (stateful, requires MCP session protocol)
      // - kit-rpc: http for Codex and other plain JSON-RPC clients (stateless /rpc endpoint)
      const mcpConfig: Record<string, unknown> = {
        mcpServers: {
          kit: {
            type: 'streamable-http',
            url: this.mcpServerUrl,
          },
          ...(this.rpcServerUrl ? {
            'kit-rpc': {
              type: 'http',
              url: this.rpcServerUrl,
            },
          } : {}),
        },
      };

      const configPath = join(worktreePath, MCP_CONFIG_FILE);
      await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));
      console.log(`[AgentInstanceService] Created ${MCP_CONFIG_FILE} at ${configPath}`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create ${MCP_CONFIG_FILE}: ${error}`);
    }
  }

  /**
   * Create .claude/settings.json in worktree root for Claude Code project-level MCP discovery.
   * Belt-and-suspenders: works alongside .mcp.json for maximum compatibility.
   */
  private async createClaudeProjectSettings(worktreePath: string): Promise<void> {
    if (!this.mcpServerUrl) return;

    try {
      const claudeDir = join(worktreePath, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, 'settings.json');
      const settings = {
        mcpServers: {
          kit: {
            type: 'streamable-http',
            url: this.mcpServerUrl,
          },
        },
      };
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[AgentInstanceService] Created .claude/settings.json at ${settingsPath}`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create .claude/settings.json: ${error}`);
    }
  }

  /**
   * Pre-seed the project-scoped MCP approval in ~/.claude.json.
   *
   * Claude Code requires explicit approval for project-scoped servers declared in
   * a worktree's .mcp.json (the "Do you trust the MCP servers in this project?"
   * prompt). Until that approval is recorded under projects[<path>].
   * enabledMcpjsonServers, Claude SILENTLY SKIPS the server on session start — so
   * kit_commit / kit_lock_file etc. never appear, even though the KIT MCP server
   * is healthy. Since KIT launches the session non-interactively, the prompt is
   * never answered. We pre-seed the approval here so the kit_* tools load on the
   * very first launch in a fresh worktree.
   *
   * Read-modify-write preserves all existing Claude config (history, other
   * projects, settings); we only add/extend this worktree's entry.
   */
  private async seedClaudeMcpApproval(worktreePath: string): Promise<void> {
    try {
      const claudeConfigPath = join(homedir(), '.claude.json');

      let config: Record<string, any> = {};
      if (existsSync(claudeConfigPath)) {
        try {
          config = JSON.parse(await readFile(claudeConfigPath, 'utf-8')) || {};
        } catch (parseErr) {
          // Corrupt/unexpected file — do NOT overwrite the user's Claude config.
          console.warn(`[AgentInstanceService] ~/.claude.json unparseable, skipping MCP pre-approval: ${parseErr}`);
          return;
        }
      }

      if (typeof config.projects !== 'object' || config.projects === null) config.projects = {};
      const project = (typeof config.projects[worktreePath] === 'object' && config.projects[worktreePath] !== null)
        ? config.projects[worktreePath] : {};

      // Approve the servers we declared in .mcp.json. Merge with any existing list.
      const ourServers = ['kit', ...(this.rpcServerUrl ? ['kit-rpc'] : [])];
      const existing: string[] = Array.isArray(project.enabledMcpjsonServers) ? project.enabledMcpjsonServers : [];
      project.enabledMcpjsonServers = Array.from(new Set([...existing, ...ourServers]));
      // If a prior decline recorded our servers as disabled, un-disable them
      // (disabled overrides enabled in Claude Code).
      if (Array.isArray(project.disabledMcpjsonServers)) {
        project.disabledMcpjsonServers = project.disabledMcpjsonServers.filter((s: string) => !ourServers.includes(s));
      }
      // Mark the project trust dialog as accepted so Claude doesn't re-prompt.
      if (project.hasTrustDialogAccepted !== true) project.hasTrustDialogAccepted = true;

      config.projects[worktreePath] = project;

      // Atomic write: temp file + rename, so a crash can't truncate ~/.claude.json.
      const tmpPath = `${claudeConfigPath}.kit-tmp-${Date.now()}`;
      await writeFile(tmpPath, JSON.stringify(config, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmpPath, claudeConfigPath);
      console.log(`[AgentInstanceService] Pre-approved kit MCP server in ~/.claude.json for ${worktreePath}`);
    } catch (error) {
      // Non-fatal: the session still launches; the agent just falls back to git/file locks.
      console.warn(`[AgentInstanceService] Could not pre-seed ~/.claude.json MCP approval: ${error}`);
    }
  }

  /**
   * Copy houserules.md and FOLDER_STRUCTURE.md from main repo to worktree root
   * Single source of truth: these files live at repo root, not inside .S9N_KIT_DevOpsAgent/
   */
  private async copyHouserulesToWorktree(worktreePath: string, mainRepoPath: string): Promise<void> {
    const filesToCopy = ['houserules.md', 'FOLDER_STRUCTURE.md'];
    for (const fileName of filesToCopy) {
      try {
        const targetPath = join(worktreePath, fileName);
        if (existsSync(targetPath)) continue;

        const sourcePath = join(mainRepoPath, fileName);
        if (existsSync(sourcePath)) {
          const content = await readFile(sourcePath, 'utf-8');
          await writeFile(targetPath, content);
          console.log(`[AgentInstanceService] Copied ${fileName} to worktree root`);
        }
      } catch (error) {
        console.warn(`[AgentInstanceService] Could not copy ${fileName}: ${error}`);
      }
    }
  }

  /**
   * Copy House_Rules_Contracts/ from main repo to worktree root
   * So agents working in local_deploy/ can read contract docs
   */
  private async copyContractsToWorktree(worktreePath: string, mainRepoPath: string): Promise<void> {
    try {
      const sourceDir = join(mainRepoPath, CONTRACTS_PATHS.baseDir);
      const targetDir = join(worktreePath, CONTRACTS_PATHS.baseDir);

      // Skip if source doesn't exist or target already exists
      if (!existsSync(sourceDir)) return;
      if (existsSync(targetDir)) return;

      await mkdir(targetDir, { recursive: true });

      // Copy all files from source to target
      const files = await readdir(sourceDir);
      for (const file of files) {
        const sourcePath = join(sourceDir, file);
        const targetPath = join(targetDir, file);
        const fileStat = await stat(sourcePath);
        if (fileStat.isFile()) {
          const content = await readFile(sourcePath, 'utf-8');
          await writeFile(targetPath, content);
        }
      }

      console.log(`[AgentInstanceService] Copied ${CONTRACTS_PATHS.baseDir}/ to worktree (${files.length} files)`);
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not copy contracts: ${error}`);
    }
  }

  /**
   * Detect submodules in a repository (wrapper for UI use)
   */
  async detectSubmodules(repoPath: string): Promise<IpcResult<Array<{ name: string; path: string; url: string }>>> {
    try {
      const gitmodulesPath = join(repoPath, '.gitmodules');
      if (!existsSync(gitmodulesPath)) {
        return { success: true, data: [] };
      }

      const content = await readFile(gitmodulesPath, 'utf-8');
      const submodules: Array<{ name: string; path: string; url: string }> = [];
      let current: Partial<{ name: string; path: string; url: string }> = {};

      for (const line of content.split('\n')) {
        const nameMatch = line.match(/\[submodule\s+"(.+)"\]/);
        if (nameMatch) {
          if (current.name && current.path) {
            submodules.push({ name: current.name, path: current.path, url: current.url || '' });
          }
          current = { name: nameMatch[1] };
        }
        const pathMatch = line.match(/\s*path\s*=\s*(.+)/);
        if (pathMatch) current.path = pathMatch[1].trim();
        const urlMatch = line.match(/\s*url\s*=\s*(.+)/);
        if (urlMatch) current.url = urlMatch[1].trim();
      }
      if (current.name && current.path) {
        submodules.push({ name: current.name, path: current.path, url: current.url || '' });
      }

      return { success: true, data: submodules };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DETECT_SUBMODULES_FAILED',
          message: error instanceof Error ? error.message : 'Failed to detect submodules',
        },
      };
    }
  }

  /**
   * Create multi-repo environment after primary worktree is ready.
   * For submodule secondaries: create branch in-place inside the submodule dir.
   * For external secondaries: create branch + worktree in that repo's local_deploy/.
   */
  private async createMultiRepoEnvironment(
    config: AgentInstanceConfig,
    sessionId: string,
    primaryWorktreePath: string
  ): Promise<RepoEntry[]> {
    const multiRepo = config.multiRepo!;
    const primaryRepoName = basename(config.repoPath);
    const entries: RepoEntry[] = [];

    // Primary repo entry
    const primaryEntry: RepoEntry = {
      ...multiRepo.primaryRepo,
      worktreePath: primaryWorktreePath,
      repoName: primaryRepoName,
    };
    entries.push(primaryEntry);

    // Process each secondary repo
    for (const secondary of multiRepo.secondaryRepos) {
      try {
        const branchName = secondary.branchName || generateSecondaryBranchName(primaryRepoName);

        if (secondary.isSubmodule) {
          // Submodule: branch in-place inside the primary worktree
          const submodulePath = join(primaryWorktreePath, secondary.repoPath);

          // Ensure submodule is initialized
          try {
            await execaCmd('git', ['submodule', 'update', '--init', secondary.repoPath], { cwd: primaryWorktreePath });
          } catch {
            // May already be initialized
          }

          // Create and checkout branch in submodule
          try {
            const base = secondary.baseBranch || 'HEAD';
            await execaCmd('git', ['checkout', '-b', branchName, base], { cwd: submodulePath });
            console.log(`[AgentInstanceService] Created branch ${branchName} in submodule ${secondary.repoName}`);
          } catch {
            // Branch might already exist — try just checking it out
            try {
              await execaCmd('git', ['checkout', branchName], { cwd: submodulePath });
            } catch (e) {
              console.warn(`[AgentInstanceService] Could not checkout submodule branch: ${e}`);
            }
          }

          entries.push({
            repoPath: secondary.repoPath,
            repoName: secondary.repoName,
            branchName,
            baseBranch: secondary.baseBranch || 'main',
            worktreePath: submodulePath,
            role: 'secondary',
            isSubmodule: true,
          });
        } else {
          // External repo: worktree lives at <externalRepoParent>/KIT-DevOps-<externalRepoName>/<branch>
          // (sibling of the external repo dir) — same rationale as createWorktreeIfNeeded.
          // Honor any existing legacy worktree at <repo>/local_deploy/<branch> for backward compat.
          const externalRepoPath = secondary.repoPath;
          const legacyDir = join(externalRepoPath, 'local_deploy', branchName);
          const externalBaseDir = getWorktreeBaseDir(externalRepoPath);
          const worktreeDir = existsSync(legacyDir) ? legacyDir : join(externalBaseDir, branchName);

          if (!existsSync(worktreeDir)) {
            // Create worktree — branch-safe (see createWorktreeIfNeeded for rationale).
            // Use `-b` when the branch is missing so we never detach onto a same-named tag.
            const base = (secondary.baseBranch || 'main').replace(/^origin\//, '');
            if (!existsSync(externalBaseDir)) {
              await mkdir(externalBaseDir, { recursive: true });
            }
            try {
              const branchResult = await execaCmd('git', ['branch', '--list', branchName], { cwd: externalRepoPath });
              const branchExists = Boolean(branchResult.stdout.trim());
              if (branchExists) {
                await execaCmd('git', ['worktree', 'add', worktreeDir, branchName], { cwd: externalRepoPath });
              } else {
                await execaCmd('git', ['worktree', 'add', '-b', branchName, worktreeDir, base], { cwd: externalRepoPath });
              }
              console.log(`[AgentInstanceService] Created external repo worktree at ${worktreeDir}`);
            } catch (e) {
              console.warn(`[AgentInstanceService] Could not create external worktree: ${e}`);
            }
          }

          entries.push({
            repoPath: externalRepoPath,
            repoName: secondary.repoName,
            branchName,
            baseBranch: secondary.baseBranch || 'main',
            worktreePath: existsSync(worktreeDir) ? worktreeDir : externalRepoPath,
            role: 'secondary',
            isSubmodule: false,
          });
        }
      } catch (error) {
        console.warn(`[AgentInstanceService] Failed to setup secondary repo ${secondary.repoName}: ${error}`);
      }
    }

    return entries;
  }

  /**
   * Setup agent environment in worktree
   * Called after instance creation to configure the workspace
   */
  async setupAgentEnvironment(instanceId: string): Promise<IpcResult<void>> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Instance not found' },
      };
    }

    const worktreePath = instance.worktreePath || instance.config.repoPath;

    await this.createAgentConfigFile(worktreePath, instance);
    await this.createVSCodeSettings(worktreePath, instance);

    // Copy houserules.md, FOLDER_STRUCTURE.md, and House_Rules_Contracts/ to worktree
    if (worktreePath !== instance.config.repoPath) {
      await this.copyHouserulesToWorktree(worktreePath, instance.config.repoPath);
      await this.copyContractsToWorktree(worktreePath, instance.config.repoPath);
    }

    // Create .mcp.json and .claude/settings.json for MCP-capable agents
    const mcpAgents = ['claude', 'cline'];
    if (mcpAgents.includes(instance.config.agentType)) {
      await this.createMcpConfigFile(worktreePath);
      await this.createClaudeProjectSettings(worktreePath);
      // Claude Code skips project-scoped .mcp.json servers until they're approved
      // in ~/.claude.json. Pre-seed that approval so kit_* tools load on first launch.
      if (instance.config.agentType === 'claude') {
        await this.seedClaudeMcpApproval(worktreePath);
      }
    }

    return { success: true };
  }

  /**
   * Get instructions for a specific agent type
   */
  getInstructions(agentType: AgentType, config: AgentInstanceConfig): IpcResult<string> {
    const vars: InstructionVars = {
      repoPath: config.repoPath,
      repoName: basename(config.repoPath),
      branchName: config.branchName,
      sessionId: `sess_${Date.now()}`,
      taskDescription: config.taskDescription,
    };

    return {
      success: true,
      data: getAgentInstructions(agentType, vars),
    };
  }

  /**
   * Launch DevOps Agent for an instance
   */
  async launchAgent(instanceId: string): Promise<IpcResult<void>> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Instance not found',
        },
      };
    }

    // DevOps Agent launch not yet implemented
    // This would spawn the CLI agent process
    return {
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Direct agent launch not yet implemented',
      },
    };
  }

  /**
   * List all instances
   */
  /**
   * Find a sibling session (same repoPath, different sessionId) that has had
   * MCP activity in the last 30 minutes. Used by InstructionsModal to surface
   * "Agent looks connected to a different session for this repo" hints when
   * the current session is still waiting. Returns null when there's no
   * active sibling — the modal then shows the generic gotcha hint instead.
   */
  findActiveSiblingInRepo(sessionId: string): { sessionId: string; branchName: string; lastActivity: string } | null {
    let me: AgentInstance | undefined;
    for (const inst of this.instances.values()) {
      if (inst.sessionId === sessionId) { me = inst; break; }
    }
    if (!me?.config?.repoPath) return null;

    let best: { sessionId: string; branchName: string; lastActivity: string; ms: number } | null = null;
    const cutoffMs = Date.now() - 30 * 60 * 1000;
    for (const inst of this.instances.values()) {
      if (!inst.sessionId || inst.sessionId === sessionId) continue;
      if (inst.config?.repoPath !== me.config.repoPath) continue;
      if (inst.status === 'closed' || inst.status === 'completed' || inst.status === 'failed') continue;
      const last = databaseService.lastMcpCallTime(inst.sessionId);
      if (!last) continue;
      const ms = new Date(last).getTime();
      if (ms < cutoffMs) continue;
      if (!best || ms > best.ms) {
        best = { sessionId: inst.sessionId, branchName: inst.config?.branchName || '(unknown)', lastActivity: last, ms };
      }
    }
    if (!best) return null;
    return { sessionId: best.sessionId, branchName: best.branchName, lastActivity: best.lastActivity };
  }

  /**
   * Attempt to re-establish a missing worktree by running
   *   git worktree add --force <worktreePath> <branch>
   * from the source repo. Works when the SOURCE repo and BRANCH still exist —
   * git materializes the worktree dir again from the branch HEAD. Returns true
   * on success.
   *
   * Use case: an external `rm -rf .git` / clone of the source repo blows away
   * the worktree registry; the worktree dir on disk may also be gone (e.g.
   * external session-manager prune). With the source repo and branch still
   * present, this re-creates the worktree in place. No user work is lost
   * unless it was uncommitted at the moment of the prune — that's gone with
   * any external delete and outside our recovery window.
   */
  private async tryRepairWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string | undefined
  ): Promise<boolean> {
    if (!repoPath || !worktreePath || !branchName) return false;
    if (!existsSync(repoPath)) return false;
    try {
      // Does the branch still exist in the source repo? If not, we can't
      // re-attach to it without inventing history.
      const branchListed = await execaCmd('git', ['branch', '--list', branchName], { cwd: repoPath });
      if (!branchListed.stdout.trim()) return false;
      // Ensure parent dir exists, then materialize the worktree.
      await mkdir(dirname(worktreePath), { recursive: true });
      await execaCmd('git', ['worktree', 'add', '--force', worktreePath, branchName], { cwd: repoPath });
      console.log(`[AgentInstanceService] Repaired worktree at ${worktreePath} (branch ${branchName})`);
      // Also re-install the project's pre-commit hook into the freshly
      // materialized worktree gitdir. `git worktree add --force` doesn't
      // copy hooks; without this, the repaired worktree commits with no
      // project hook firing — same hole as the original create path.
      await this.installPreCommitHookIntoWorktree(repoPath, worktreePath);
      return true;
    } catch (err) {
      console.warn(`[AgentInstanceService] Could not repair worktree at ${worktreePath}: ${err}`);
      return false;
    }
  }

  /**
   * One-time migration: for every non-terminal instance whose worktree still
   * lives at the legacy `<repo>/local_deploy/<branchName>` path, move it to
   * the new sibling location `<repo_parent>/KIT-DevOps-<repo_name>/<branchName>`
   * via `git worktree move`, then update `instance.worktreePath` and
   * regenerate the agent's prompt + instructions so the user-visible "Copy
   * Prompt" output points the agent at the new directory.
   *
   * Skips:
   *   - sessions already on the new layout
   *   - sessions whose legacy dir is missing on disk (nothing to move)
   *   - sessions whose target dir already exists (would conflict)
   *   - terminal sessions (completed/failed/closed)
   *
   * Returns { moved, regenerated } counts.
   */
  /**
   * Migrate stale `useWorktree: false` config where a real sibling worktree
   * exists. The instance store ended up with many rows in an inconsistent
   * state (useWorktree=false but worktreePath set to a distinct sibling)
   * because `restartInstance`'s cold path fell back to
   * `inheritedConfig?.useWorktree ?? false` when `sessionData.worktreePath`
   * was empty at restart time. Downstream code that inspects the flag
   * (external tooling, future guards) then reads "in-place" when the
   * instance is actually worktree-isolated. Fix: any row where
   * `worktreePath` is set AND differs from `repoPath` gets
   * `useWorktree: true`. Idempotent — clean rows are untouched.
   */
  migrateUseWorktreeFlag(): number {
    let migrated = 0;
    for (const instance of this.instances.values()) {
      const cfg = instance.config;
      if (!cfg) continue;
      const wt = instance.worktreePath;
      if (!wt || wt === cfg.repoPath) continue; // no drift possible
      if (cfg.useWorktree === true) continue;   // already correct
      cfg.useWorktree = true;
      migrated++;
    }
    if (migrated > 0) {
      this.saveInstances();
      console.log(`[AgentInstanceService] Migrated useWorktree=true on ${migrated} drifted instance(s)`);
    }
    return migrated;
  }

  async migrateLegacyWorktrees(): Promise<{ moved: number; regenerated: number }> {
    let moved = 0;
    let regenerated = 0;
    const migrate = async (
      repoPath: string,
      currentPath: string | undefined,
      branchName: string | undefined
    ): Promise<string | null> => {
      if (!repoPath || !currentPath || !branchName) return null;
      // Only touch legacy paths: <something>/local_deploy/<branchName>
      const legacyPattern = new RegExp(`^(.+)/local_deploy/${branchName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/?$`);
      if (!legacyPattern.test(currentPath)) return null;

      const targetBase = getWorktreeBaseDir(repoPath);
      const targetPath = join(targetBase, branchName);

      // Already at the new location on disk? Just heal the in-memory pointer.
      // This is the common case for sessions whose disk move succeeded in a
      // prior migration but whose instance.worktreePath couldn't be re-saved
      // (e.g. the IPC startup loop skipped them because the legacy path was
      // missing, so no fresh createInstance ever recomputed the pointer).
      // No `git worktree move` here — the files are already where we want them.
      if (existsSync(targetPath)) {
        console.log(`[AgentInstanceService] Worktree already at ${targetPath}; updating instance pointer from legacy ${currentPath}`);
        return targetPath;
      }

      // Otherwise: legacy is still on disk and we need to actually move it.
      if (!existsSync(currentPath)) {
        // Neither side exists. Nothing we can do here — leave for the
        // orphan reaper.
        return null;
      }
      try {
        await mkdir(targetBase, { recursive: true });
        await execaCmd('git', ['worktree', 'move', currentPath, targetPath], { cwd: repoPath });
        console.log(`[AgentInstanceService] Migrated worktree ${currentPath} -> ${targetPath}`);
        return targetPath;
      } catch (err) {
        console.warn(`[AgentInstanceService] Could not migrate worktree ${currentPath}: ${err}`);
        return null;
      }
    };

    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;
      let anyMoved = false;

      if (instance.multiRepoEntries && instance.multiRepoEntries.length > 0) {
        for (const r of instance.multiRepoEntries) {
          const newPath = await migrate(r.repoPath, r.worktreePath, r.branchName);
          if (newPath) {
            r.worktreePath = newPath;
            anyMoved = true;
            moved++;
          }
        }
        // For multi-repo instances, instance.worktreePath mirrors the primary
        // entry's worktreePath, and submodule secondaries are derived from it.
        // If the primary was migrated in a previous launch but this instance's
        // top-level pointer (and the submodule-secondary derivations) weren't
        // re-synced, do it now. Idempotent.
        const primary = instance.multiRepoEntries.find(e => e.role === 'primary');
        if (primary && primary.worktreePath) {
          if (instance.worktreePath !== primary.worktreePath) {
            instance.worktreePath = primary.worktreePath;
            anyMoved = true;
          }
          for (const r of instance.multiRepoEntries) {
            if (r.role === 'secondary' && r.isSubmodule) {
              const expected = join(primary.worktreePath, r.repoPath || r.repoName || '');
              if (r.worktreePath !== expected) {
                r.worktreePath = expected;
                anyMoved = true;
              }
            }
          }
        }
      } else {
        const newPath = await migrate(instance.config.repoPath, instance.worktreePath, instance.config.branchName);
        if (newPath) {
          instance.worktreePath = newPath;
          anyMoved = true;
          moved++;
        }
      }

      // Regenerate the agent's prompt/instructions with the new worktreePath so
      // the user-visible "Copy Prompt" string isn't stale.
      if (anyMoved) {
        const wt = instance.worktreePath || instance.config.repoPath;
        const vars: InstructionVars = {
          repoPath: wt,
          repoName: basename(instance.config.repoPath),
          branchName: instance.config.branchName,
          sessionId: instance.sessionId || instance.id,
          taskDescription: instance.config.taskDescription,
          systemPrompt: instance.config.systemPrompt || '',
          contextPreservation: instance.config.contextPreservation || '',
          rebaseFrequency: instance.config.rebaseFrequency || 'never',
          baseBranch: instance.config.baseBranch,
          mcpUrl: this.mcpServerUrl || undefined,
          rpcUrl: this.rpcServerUrl || undefined,
          customMcpEnabled: instance.config.customMcpEnabled,
          ...(instance.multiRepoEntries && instance.multiRepoEntries.length > 0
            ? {
                multiRepoEntries: instance.multiRepoEntries,
                commitScope: instance.config.multiRepo?.commitScope,
              }
            : {}),
        };
        try {
          instance.instructions = getAgentInstructions(instance.config.agentType, vars);
          instance.prompt = generateAgentPrompt(instance.config.agentType, vars);
          regenerated++;
        } catch (err) {
          console.warn(`[AgentInstanceService] Failed to regenerate prompt for ${instance.id}: ${err}`);
        }
      }
    }

    if (moved > 0) {
      this.saveInstances();
      console.log(`[AgentInstanceService] Migrated ${moved} legacy worktree(s); regenerated ${regenerated} prompt(s)`);
    }
    return { moved, regenerated };
  }

  /**
   * Walk every non-terminal instance and, for each one whose worktree dir is
   * missing, attempt to re-create it via `git worktree add --force <path>
   * <branch>` from the source repo. Many "lost" worktrees still have an
   * intact source repo + branch and come back with one command.
   *
   * Returns the count of worktrees successfully repaired. Anything still
   * missing after this pass should be reaped via `reapOrphanInstances`.
   */
  async repairOrphanWorktrees(): Promise<number> {
    let repaired = 0;
    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;
      if (instance.multiRepoEntries && instance.multiRepoEntries.length > 0) {
        for (const r of instance.multiRepoEntries) {
          if (r.worktreePath && !existsSync(r.worktreePath)) {
            const ok = await this.tryRepairWorktree(r.repoPath, r.worktreePath, r.branchName);
            if (ok) repaired++;
          }
        }
      } else {
        const wt = instance.worktreePath;
        if (wt && !existsSync(wt)) {
          const ok = await this.tryRepairWorktree(instance.config.repoPath, wt, instance.config.branchName);
          if (ok) repaired++;
        }
      }
    }
    if (repaired > 0) {
      console.log(`[AgentInstanceService] Repaired ${repaired} worktree(s) via 'git worktree add --force'`);
    }
    return repaired;
  }

  /**
   * Record `predecessorSessionId` on `instance` and persist. Used by both
   * restart paths to extend the lineage chain. `inheritedChain` is the
   * predecessor list of the instance being replaced — passed in so the new
   * instance inherits its full ancestry, not just the immediate predecessor.
   */
  private recordPredecessor(
    instance: AgentInstance,
    predecessorSessionId: string,
    inheritedChain: string[] = []
  ): void {
    if (!predecessorSessionId || predecessorSessionId === instance.sessionId) return;
    const existing = instance.predecessorSessionIds || [];
    // De-duplicate while preserving order (most ancient first, most recent last).
    const merged = [...existing, ...inheritedChain, predecessorSessionId];
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const sid of merged) {
      if (!sid || sid === instance.sessionId) continue;
      if (seen.has(sid)) continue;
      seen.add(sid);
      deduped.push(sid);
    }
    instance.predecessorSessionIds = deduped;
    this.saveInstances();
  }

  /**
   * Repatriate orphaned `mcp_calls` rows. Two strategies, in order:
   *
   *   1. **Lineage chain** (the reliable one going forward): for every live
   *      instance with `predecessorSessionIds`, transfer mcp_calls from each
   *      old sessionId to the live one. Lineage is recorded at restart time
   *      by `recordPredecessor`, so this catches every previous-restart id
   *      no matter how many restarts back.
   *
   *   2. **(repoPath, branchName) group fallback**: for any closed instances
   *      that ARE still in the Map (rare — `restartInstance` usually purges
   *      them), match them to a live instance with the same repo+branch and
   *      transfer. Cheap; runs after the chain pass and skips already-empty
   *      sessionIds.
   *
   * Idempotent — after one pass the old ids hold zero mcp rows, so reruns
   * find nothing to move.
   */
  backfillMcpCallsByLineage(): number {
    let totalTransferred = 0;

    // Pass 1: walk every live instance's recorded predecessor chain.
    for (const inst of this.instances.values()) {
      if (inst.status === 'closed' || inst.status === 'completed' || inst.status === 'failed') continue;
      if (!inst.sessionId || !inst.predecessorSessionIds || inst.predecessorSessionIds.length === 0) continue;
      for (const oldSid of inst.predecessorSessionIds) {
        if (oldSid === inst.sessionId) continue;
        const n = databaseService.transferMcpCalls(oldSid, inst.sessionId);
        if (n > 0) {
          totalTransferred += n;
          console.log(`[AgentInstanceService] Backfilled ${n} mcp_calls row(s) via lineage: ${oldSid} -> ${inst.sessionId}`);
        }
      }
    }

    // Pass 2: (repoPath, branchName) match for any closed sibling that
    // somehow survived purgeInstancesOnBranch.
    const byKey = new Map<string, { live: AgentInstance | null; closed: AgentInstance[] }>();
    for (const inst of this.instances.values()) {
      const cfg = inst.config;
      if (!cfg?.repoPath || !cfg?.branchName) continue;
      const key = `${cfg.repoPath}::${cfg.branchName}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { live: null, closed: [] };
        byKey.set(key, entry);
      }
      if (inst.status === 'closed' || inst.status === 'completed' || inst.status === 'failed') {
        entry.closed.push(inst);
      } else if (!entry.live && inst.sessionId) {
        entry.live = inst;
      }
    }
    for (const { live, closed } of byKey.values()) {
      if (!live || !live.sessionId || closed.length === 0) continue;
      for (const old of closed) {
        if (!old.sessionId || old.sessionId === live.sessionId) continue;
        const n = databaseService.transferMcpCalls(old.sessionId, live.sessionId);
        if (n > 0) {
          totalTransferred += n;
          console.log(`[AgentInstanceService] Backfilled ${n} mcp_calls row(s) via repo+branch match: ${old.sessionId} -> ${live.sessionId}`);
        }
      }
    }

    if (totalTransferred > 0) {
      console.log(`[AgentInstanceService] mcp_calls backfill complete: ${totalTransferred} row(s) repatriated`);
    }
    return totalTransferred;
  }

  /**
   * Detect "branch-gone orphans": the worktree directory still exists on disk,
   * but its `.git` link points at a missing registry entry AND the source
   * branch is gone from the source repo. This is the steady state after the
   * source repo gets reinitialized externally (the registry wipe we saw on
   * SA-Piggy-Bank) when the branch had also been deleted post-merge. Every
   * KIT git op against the worktree fails with `fatal: not a git repository`
   * — including Sync (rebase), which leaves the UI stuck.
   *
   * For each such instance, mark it `completed` (the typical reason a branch
   * is gone is that it was merged + deleted) and save. Reads the per-worktree
   * `.git` file to discover the registry path; uses `git rev-parse` to verify
   * the branch's absence in the source repo. Idempotent.
   */
  async reapBrokenLinks(): Promise<number> {
    let reaped = 0;
    const reapedDetails: Array<{ id: string; sessionId: string; branch: string; path: string }> = [];

    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;
      const wt = instance.worktreePath;
      const repoPath = instance.config?.repoPath;
      const branchName = instance.config?.branchName;
      if (!wt || !repoPath || !branchName) continue;
      if (!existsSync(wt)) continue; // handled by reapOrphanInstances

      // Is the worktree's .git link broken?
      const dotGitPath = join(wt, '.git');
      if (!existsSync(dotGitPath)) continue; // not the kind of broken state we're after
      let gitdir: string | null = null;
      try {
        const content = await readFile(dotGitPath, 'utf8');
        const m = content.match(/^gitdir:\s*(.+)\s*$/m);
        gitdir = m ? m[1].trim() : null;
      } catch {
        // unreadable — leave for the existing orphan path
        continue;
      }
      if (!gitdir) continue;
      if (existsSync(gitdir)) continue; // registry entry intact — nothing to do

      // Registry gone. Is the source branch still around?
      let branchExists = true;
      try {
        const r = await execaCmd('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: repoPath, reject: false });
        branchExists = (r as { exitCode?: number }).exitCode === 0;
      } catch {
        branchExists = false;
      }
      if (branchExists) continue; // recoverable case — leave for repair/sync to surface

      // Worktree dir exists, registry gone, branch gone. Almost always means
      // "merged + branch deleted, then source .git wiped". Mark completed.
      instance.status = 'completed';
      reaped++;
      reapedDetails.push({
        id: instance.id,
        sessionId: instance.sessionId || '(none)',
        branch: branchName,
        path: wt,
      });
    }

    if (reaped > 0) {
      this.saveInstances();
      console.warn(
        `[AgentInstanceService] Marked ${reaped} branch-gone orphan instance(s) as completed:\n` +
          reapedDetails.map(d => `  - ${d.id} (${d.sessionId}) branch=${d.branch} path=${d.path}`).join('\n')
      );
    }
    return reaped;
  }

  /**
   * Detect interrupted rebases in every live worktree and flag the instance.
   *
   * Why: when a rebase is left mid-flight (agent quit, machine slept, Kanvas
   * auto-save committed during the pause), `HEAD` ends up parked at a
   * historical snapshot. The next agent that walks in sees "files reverted"
   * and gets paranoid — exactly the failure mode you hit on
   * codex-session-20260527-citw. Surfacing it as an instance-level flag lets
   * the UI show a banner with "Abort + back up" rather than relying on the
   * agent to diagnose git plumbing on its own.
   *
   * For each non-terminal instance we resolve the worktree's gitdir via
   * `git rev-parse --git-dir` and look for `rebase-merge` or `rebase-apply`.
   * Anything older than STALE_REBASE_MINUTES (6h) gets flagged; younger ones
   * we leave alone — could be an in-flight rebase the agent is mid-way
   * through. Idempotent: a subsequent scan that finds no rebase state clears
   * the flag.
   */
  async detectStaleRebases(): Promise<number> {
    const STALE_REBASE_MINUTES = 360; // 6h — anything younger is plausibly active
    const { statSync } = await import('fs');
    let flagged = 0;
    let cleared = 0;
    let saveNeeded = false;

    const inspect = async (wt: string): Promise<AgentInstance['staleRebase'] | null> => {
      if (!existsSync(wt)) return null;
      let gitDirRel: string;
      try {
        const r = await execaCmd('git', ['rev-parse', '--git-dir'], { cwd: wt });
        gitDirRel = r.stdout.trim();
      } catch {
        return null;
      }
      const absGitDir = gitDirRel.startsWith('/') ? gitDirRel : join(wt, gitDirRel);
      for (const kind of ['merge', 'apply'] as const) {
        const dir = join(absGitDir, `rebase-${kind}`);
        if (!existsSync(dir)) continue;
        try {
          const s = statSync(dir);
          const ageMs = Date.now() - s.mtimeMs;
          const ageMinutes = Math.round(ageMs / 60_000);
          if (ageMinutes < STALE_REBASE_MINUTES) return null;
          return {
            detectedAt: new Date().toISOString(),
            startedAt: new Date(s.mtimeMs).toISOString(),
            kind,
            ageMinutes,
            gitDir: dir,
          };
        } catch {
          // unreadable — skip rather than guess
        }
      }
      return null;
    };

    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;

      let detected: AgentInstance['staleRebase'] | null = null;
      const wts = instance.multiRepoEntries && instance.multiRepoEntries.length > 0
        ? instance.multiRepoEntries.map(r => r.worktreePath).filter((p): p is string => !!p)
        : (instance.worktreePath ? [instance.worktreePath] : []);
      for (const wt of wts) {
        detected = await inspect(wt);
        if (detected) break; // first hit per instance is enough — UI will deep-link
      }

      if (detected && !instance.staleRebase) {
        instance.staleRebase = detected;
        flagged++;
        saveNeeded = true;
        const ageHours = Math.round(detected.ageMinutes / 60);
        console.warn(
          `[AgentInstanceService] Stale rebase flagged on ${instance.id} (${instance.sessionId || 'no-session'}): ${detected.kind}, ${ageHours}h old`
        );
      } else if (!detected && instance.staleRebase) {
        delete instance.staleRebase;
        cleared++;
        saveNeeded = true;
      }
    }

    if (saveNeeded) this.saveInstances();
    if (flagged + cleared > 0) {
      console.log(`[AgentInstanceService] Stale-rebase scan: ${flagged} flagged, ${cleared} cleared`);
    }
    return flagged;
  }

  /**
   * Garbage-collect crash-safety snapshots. `WatcherService.triggerPeriodicSnapshot`
   * pins worktree state to `refs/kit-autosave/<sessionId>` every 5 min; without
   * pruning, these refs accumulate forever (each is a stash commit + tree,
   * potentially megabytes for large worktrees). Prunes refs older than
   * SNAPSHOT_TTL_DAYS. Safe: real work is on session branches, not autosave
   * refs; the refs are pure crash-recovery. Runs on startup only for now —
   * a daily timer would be nicer but 7-day TTL doesn't need it.
   */
  async gcOldSnapshots(): Promise<number> {
    const SNAPSHOT_TTL_DAYS = 7;
    const cutoffSec = Math.floor(Date.now() / 1000) - SNAPSHOT_TTL_DAYS * 86400;
    let pruned = 0;

    // Group instances by repoPath (worktrees share a common gitdir per repo)
    // so we scan each source repo's ref namespace once.
    const seenRepos = new Set<string>();
    for (const inst of this.instances.values()) {
      const repoPath = inst.config?.repoPath;
      if (!repoPath || seenRepos.has(repoPath)) continue;
      seenRepos.add(repoPath);
      if (!existsSync(repoPath)) continue;
      try {
        // for-each-ref gives us `<sha> <committer-timestamp> <refname>`.
        // Autosave refs are the same across worktrees of the same repo since
        // they share the common gitdir.
        const listed = await execaCmd('git', [
          'for-each-ref',
          '--format=%(objectname)%09%(committerdate:unix)%09%(refname)',
          'refs/kit-autosave/',
        ], { cwd: repoPath });
        const lines = listed.stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          const [, tsStr, ref] = line.split('\t');
          const ts = parseInt(tsStr, 10);
          if (!Number.isFinite(ts) || ts >= cutoffSec) continue;
          try {
            await execaCmd('git', ['update-ref', '-d', ref], { cwd: repoPath });
            pruned++;
          } catch (err) {
            console.warn(`[AgentInstanceService] Failed to prune ${ref}: ${err}`);
          }
        }
      } catch { /* repo may not have any autosave refs — fine */ }
    }
    if (pruned > 0) {
      console.log(`[AgentInstanceService] GC'd ${pruned} stale autosave snapshot ref(s) (>${SNAPSHOT_TTL_DAYS}d)`);
    }
    return pruned;
  }

  /**
   * One-click rebase repair: back up the current tip + pre-rebase tip to
   * `backup/<sessionId>-pre-abort-HEAD` and `backup/<sessionId>-pre-rebase-tip`,
   * then `git rebase --abort`. Clears the `staleRebase` flag on success.
   * Returns the backup branch names so the UI can quote them in a toast.
   *
   * Safe by design: only runs when the gitdir genuinely has rebase state,
   * never deletes data (the floating commits remain in reflog for 90 days
   * after abort, the explicit backup branches survive even past that).
   */
  async repairStaleRebase(instanceId: string): Promise<IpcResult<{
    backupBranches: string[];
    landedAt: string;
  }>> {
    const instance = this.instances.get(instanceId);
    if (!instance) return { success: false, error: { code: 'NOT_FOUND', message: `Instance ${instanceId} not found` } };

    const wt = instance.multiRepoEntries?.[0]?.worktreePath || instance.worktreePath;
    if (!wt || !existsSync(wt)) {
      return { success: false, error: { code: 'NO_WORKTREE', message: 'Worktree path missing or gone' } };
    }

    // Verify there's actually rebase state — refuse to act otherwise so a
    // stale flag can't trigger a destructive `--abort` on a clean tree.
    let gitDirRel: string;
    try {
      const r = await execaCmd('git', ['rev-parse', '--git-dir'], { cwd: wt });
      gitDirRel = r.stdout.trim();
    } catch (err) {
      return { success: false, error: { code: 'GIT_FAIL', message: `git rev-parse failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
    const absGitDir = gitDirRel.startsWith('/') ? gitDirRel : join(wt, gitDirRel);
    const hasRebase = existsSync(join(absGitDir, 'rebase-merge')) || existsSync(join(absGitDir, 'rebase-apply'));
    if (!hasRebase) {
      // Stale flag, no real state — just clear and exit cleanly.
      delete instance.staleRebase;
      this.saveInstances();
      return { success: true, data: { backupBranches: [], landedAt: 'no-op (no rebase state)' } };
    }

    const tag = (instance.sessionId || instanceId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const headBackup = `backup/${tag}-pre-abort-HEAD`;
    const origBackup = `backup/${tag}-pre-rebase-tip`;
    const made: string[] = [];

    // Capture HEAD (whatever weird mid-rebase state it's in) and ORIG_HEAD
    // (the pre-rebase branch tip). Both are recoverable from reflog too, but
    // explicit branches survive reflog expiry and are easier to inspect.
    try {
      const headSha = (await execaCmd('git', ['rev-parse', 'HEAD'], { cwd: wt })).stdout.trim();
      if (headSha) {
        await execaCmd('git', ['branch', '-f', headBackup, headSha], { cwd: wt });
        made.push(headBackup);
      }
    } catch {
      // best-effort — don't block abort on backup failure (reflog still has it)
    }
    try {
      const origSha = (await execaCmd('git', ['rev-parse', 'ORIG_HEAD'], { cwd: wt })).stdout.trim();
      if (origSha) {
        await execaCmd('git', ['branch', '-f', origBackup, origSha], { cwd: wt });
        made.push(origBackup);
      }
    } catch {
      // ORIG_HEAD may be missing in some rebase states — that's fine
    }

    // Actually abort
    try {
      await execaCmd('git', ['rebase', '--abort'], { cwd: wt });
    } catch (err) {
      return { success: false, error: { code: 'ABORT_FAIL', message: `git rebase --abort failed: ${err instanceof Error ? err.message : String(err)}` } };
    }

    delete instance.staleRebase;
    this.saveInstances();

    const landedSha = (await execaCmd('git', ['rev-parse', '--short', 'HEAD'], { cwd: wt }).catch(() => ({ stdout: 'unknown' }))).stdout.trim();
    console.log(`[AgentInstanceService] Aborted stale rebase on ${instance.id} (${instance.sessionId || 'no-session'}); backups: ${made.join(', ') || 'none'}; HEAD now at ${landedSha}`);
    return { success: true, data: { backupBranches: made, landedAt: landedSha } };
  }

  /**
   * Mark instances whose worktreePath no longer exists on disk as 'closed' and
   * save. Returns the number of instances reaped.
   *
   * Why: `MergeService.executeMerge()` post-merge `git worktree remove` deletes
   * the directory but doesn't update the `AgentInstance` record. External
   * session-manager prune passes do the same. The next launch then tries to
   * re-register / restart / watch a path that's gone — `spawn git ENOENT`
   * every operation. Best paired with `repairOrphanWorktrees()` first; what
   * can't be repaired gets reaped here.
   */
  reapOrphanInstances(): number {
    let reaped = 0;
    const reapedDetails: Array<{ id: string; sessionId: string; reason: string; path: string }> = [];
    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;

      let allGone = false;
      let firstMissing: string | null = null;
      let reason = 'worktree-missing';

      if (instance.multiRepoEntries && instance.multiRepoEntries.length > 0) {
        allGone = instance.multiRepoEntries.every(r => r.worktreePath && !existsSync(r.worktreePath));
        firstMissing = instance.multiRepoEntries.find(r => !existsSync(r.worktreePath))?.worktreePath || null;
      } else {
        const wt = instance.worktreePath;
        if (wt && !existsSync(wt)) {
          allGone = true;
          firstMissing = wt;
        }
      }

      // Catch the disconnected-volume / moved-repo case the worktree check
      // misses: worktreePath is unset (or both worktree and repo are gone),
      // and the configured source repoPath dir doesn't exist on disk. The
      // session can't be Sync'd / restarted / interacted with — git ops will
      // ENOENT on every call. Reap it instead of leaving it stuck in waiting.
      if (!allGone) {
        const repo = instance.config?.repoPath;
        if (repo && !existsSync(repo)) {
          allGone = true;
          firstMissing = repo;
          reason = 'repo-missing';
        }
      }

      if (allGone) {
        instance.status = 'closed';
        reaped++;
        reapedDetails.push({
          id: instance.id,
          sessionId: instance.sessionId || '(none)',
          reason,
          path: firstMissing || '(unknown)',
        });
      }
    }
    if (reaped > 0) {
      this.saveInstances();
      console.warn(
        `[AgentInstanceService] Reaped ${reaped} orphan instance(s) whose worktree was removed off-app and could not be repaired:\n` +
          reapedDetails.map(d => `  - ${d.id} (${d.sessionId}) [${d.reason}] -> ${d.path}`).join('\n')
      );
    }
    return reaped;
  }

  /**
   * Re-register all active sessions with MCP binder on startup.
   * Needed because the binder is in-memory and sessions are persisted in electron-store.
   *
   * Reaps orphan instances first so we don't try to re-register sessions whose
   * worktree directory was removed off-app (typically by a merge cleanup).
   */
  registerExistingSessionsWithBinder(): void {
    this.reapOrphanInstances();

    let count = 0;
    for (const instance of this.instances.values()) {
      if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'closed') continue;
      const worktree = instance.worktreePath || instance.config.repoPath;
      if (!instance.sessionId || !worktree) continue;

      if (instance.multiRepoEntries && instance.multiRepoEntries.length > 0) {
        if (this.onMultiRepoSessionCreated) {
          this.onMultiRepoSessionCreated(
            instance.sessionId,
            instance.multiRepoEntries.map(r => ({
              repoName: r.repoName,
              worktreePath: r.worktreePath,
              role: r.role,
            }))
          );
          count++;
        }
      } else {
        if (this.onSessionCreated) {
          this.onSessionCreated(instance.sessionId, worktree);
          count++;
        }
      }
    }
    if (count > 0) {
      console.log(`[AgentInstanceService] Re-registered ${count} existing session(s) with MCP binder`);
    }
  }

  listInstances(): IpcResult<AgentInstance[]> {
    return {
      success: true,
      data: Array.from(this.instances.values()),
    };
  }

  /**
   * Get a specific instance
   */
  getInstance(instanceIdOrSessionId: string): IpcResult<AgentInstance | null> {
    let found = this.instances.get(instanceIdOrSessionId) || null;
    if (!found) {
      // Fall back to matching by sessionId (callers often only have the session id).
      for (const inst of this.instances.values()) {
        if (inst.sessionId === instanceIdOrSessionId) { found = inst; break; }
      }
    }
    return { success: true, data: found };
  }

  /**
   * Pre-delete safety check: returns info about worktree, uncommitted changes,
   * unpushed commits, and remote branch existence so the UI can show warnings.
   */
  /**
   * Resolve a sessionId to an instance, falling back to (repoPath, branchName)
   * when the in-memory map doesn't have a direct sessionId match. Required
   * because SessionReports loaded from disk often carry sessionIds from an
   * earlier lifecycle (pre-restart, pre-purge) that no longer exist in the
   * live map. Without this fallback, every Delete on such a session returns
   * "Session not found" and the user has to do filesystem surgery manually.
   *
   * Returns the matched instance (and its in-memory id) or null. Callers
   * still need their own NOT_FOUND branch for the truly-orphaned case where
   * even the (repo, branch) lookup misses — that's the "ghost delete" path.
   */
  private resolveInstanceForDelete(
    sessionId: string,
    hints?: { repoPath?: string; branchName?: string }
  ): { id: string; instance: AgentInstance } | null {
    for (const [id, inst] of this.instances) {
      if (inst.sessionId === sessionId) return { id, instance: inst };
    }
    if (hints?.repoPath && hints?.branchName) {
      for (const [id, inst] of this.instances) {
        if (inst.config?.repoPath === hints.repoPath &&
            inst.config?.branchName === hints.branchName) {
          return { id, instance: inst };
        }
      }
    }
    return null;
  }

  async getDeleteSafetyInfo(
    sessionId: string,
    hints?: { repoPath?: string; branchName?: string }
  ): Promise<IpcResult<{
    hasWorktree: boolean;
    worktreePath: string | null;
    hasUncommittedChanges: boolean;
    unpushedCommitCount: number;
    hasRemoteBranch: boolean;
    branchName: string;
    repoPath: string;
  }>> {
    // Resolve via sessionId first, fall back to (repoPath, branchName) hints
    // so a stale sessionId on a SessionReport doesn't block delete.
    const resolved = this.resolveInstanceForDelete(sessionId, hints);
    let repoPath: string;
    let branchName: string;
    let baseBranch: string;
    let worktreePath: string | null;

    if (resolved) {
      repoPath = resolved.instance.config.repoPath;
      branchName = resolved.instance.config.branchName;
      baseBranch = (resolved.instance.config.baseBranch || 'main').replace(/^origin\//, '');
      worktreePath = resolved.instance.worktreePath && resolved.instance.worktreePath !== repoPath
        ? resolved.instance.worktreePath : null;
    } else if (hints?.repoPath && hints?.branchName) {
      // Ghost-mode safety check: no in-memory instance, but we know which
      // (repo, branch) this session refers to. We can still do all the git
      // checks against the user-provided paths. Worktree path is unknown
      // here — the cleanup call will derive it from the worktree registry.
      repoPath = hints.repoPath;
      branchName = hints.branchName;
      baseBranch = 'main';
      worktreePath = null;
    } else {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Session not found and no (repoPath, branchName) hint provided. Re-open the session list and try again.' } };
    }

    let hasUncommittedChanges = false;
    let unpushedCommitCount = 0;
    let hasRemoteBranch = false;

    const checkPath = worktreePath || repoPath;
    // Count against the worktree (where the branch is actually checked out) so
    // HEAD resolves to the session branch even when the main repo is on a
    // different branch.
    const countPath = worktreePath || repoPath;

    try {
      // Check uncommitted changes
      const statusOut = await execaCmd('git', ['status', '--porcelain'], { cwd: checkPath });
      hasUncommittedChanges = statusOut.stdout.trim().length > 0;
    } catch { /* ignore */ }

    // ------------------------------------------------------------------
    // Unpushed / at-risk commit count.
    //
    // FIX: the old metric `origin/<branch>..<branch>` (no fetch, compared
    // against the branch's OWN remote ref) massively over-reported after a
    // rebase — a real dialog warned "322 unpushed commits will be lost" when
    // only 1 commit was truly at risk (the rest were patch-present on
    // origin/main). We now:
    //   1. FETCH the branch's remote ref + the base branch so we compare
    //      against fresh state.
    //   2. Compute a PATCH-EQUIVALENCE-AWARE count (--cherry-pick) against
    //      BOTH origin/<branch> and origin/<baseBranch>, and take the MIN —
    //      work present on either baseline is not lost when we delete locally.
    // ------------------------------------------------------------------

    // Best-effort fetch (short timeout, never fatal — offline / no-remote is fine).
    await execaCmd('git', ['fetch', 'origin', branchName], { cwd: repoPath, timeout: 15_000 }).catch(() => {});
    await execaCmd('git', ['fetch', 'origin', baseBranch], { cwd: repoPath, timeout: 15_000 }).catch(() => {});

    const cherryCount = async (base: string): Promise<number | null> => {
      try {
        const out = await execaCmd(
          'git',
          ['rev-list', '--count', '--cherry-pick', '--right-only', `${base}...HEAD`],
          { cwd: countPath }
        );
        const n = parseInt(out.stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null; // base ref doesn't exist / not comparable
      }
    };

    const vsRemoteBranch = await cherryCount(`origin/${branchName}`);
    const vsBaseBranch = await cherryCount(`origin/${baseBranch}`);

    let totalCommits: number | undefined;
    if (vsRemoteBranch === null && vsBaseBranch === null) {
      // No comparable baseline at all — fall back to raw commit count so a
      // brand-new never-pushed branch still warns about its real work.
      try {
        const out = await execaCmd('git', ['rev-list', '--count', 'HEAD'], { cwd: countPath });
        const n = parseInt(out.stdout.trim(), 10);
        if (Number.isFinite(n)) totalCommits = n;
      } catch { /* ignore */ }
    }

    unpushedCommitCount = resolveUnpushedCount({ vsRemoteBranch, vsBaseBranch }, totalCommits);

    try {
      // Check if remote branch exists
      await execaCmd('git', ['ls-remote', '--exit-code', '--heads', 'origin', branchName], { cwd: repoPath });
      hasRemoteBranch = true;
    } catch { /* no remote branch */ }

    return {
      success: true,
      data: {
        hasWorktree: !!worktreePath,
        worktreePath,
        hasUncommittedChanges,
        unpushedCommitCount,
        hasRemoteBranch,
        branchName,
        repoPath,
      },
    };
  }

  /**
   * Delete an instance with optional worktree and branch cleanup
   */
  async deleteInstanceWithCleanup(
    sessionId: string,
    options: { deleteWorktree?: boolean; deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean },
    hints?: { repoPath?: string; branchName?: string; worktreePath?: string }
  ): Promise<IpcResult<void>> {
    // Resolve via sessionId, then (repo, branch) hints, then ghost-mode if
    // even hints alone are enough to do filesystem cleanup. The "Session not
    // found" hardstop here was the user-visible bug: stale SessionReports
    // carry sessionIds that no longer match the live map, and the only way
    // out was manual git surgery.
    const resolved = this.resolveInstanceForDelete(sessionId, hints);

    let instanceId: string | undefined;
    let repoPath: string;
    let branchName: string;
    let worktreePath: string | null;

    if (resolved) {
      instanceId = resolved.id;
      repoPath = resolved.instance.config.repoPath;
      branchName = resolved.instance.config.branchName;
      worktreePath = resolved.instance.worktreePath && resolved.instance.worktreePath !== repoPath
        ? resolved.instance.worktreePath : null;
    } else if (hints?.repoPath && hints?.branchName) {
      // Ghost-mode delete: no in-memory instance, but the UI knows the
      // (repo, branch) — just clean what's on disk. instanceId stays
      // undefined; we'll skip the deleteInstance() bookkeeping call at the
      // end since there's nothing to delete from electron-store.
      repoPath = hints.repoPath;
      branchName = hints.branchName;
      worktreePath = hints.worktreePath || null;
      console.log(`[AgentInstanceService] Ghost-mode delete for ${sessionId} (no in-memory instance) — operating on ${repoPath} branch ${branchName}`);
    } else {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Session not found and no (repoPath, branchName) hint provided.' } };
    }

    // 1. Remove worktree first (must happen before branch delete)
    if (options.deleteWorktree && worktreePath) {
      try {
        const stack = (new Error().stack || '').split('\n').slice(2, 7).map(s => s.trim()).join(' <- ');
        console.warn(`[AgentInstanceService] WORKTREE REMOVE (deleteInstanceWithCleanup ${sessionId}): ${worktreePath}\n  caller: ${stack}`);
        this.terminalLogService?.warn?.(`Worktree removed (deleteInstanceWithCleanup): ${worktreePath} — caller: ${stack}`, sessionId, 'WorktreeRemove');
        await execaCmd('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
        console.log(`[AgentInstanceService] Removed worktree at ${worktreePath}`);
      } catch (err) {
        console.warn(`[AgentInstanceService] Failed to remove worktree: ${err}`);
      }
    }

    // 2. Delete local branch
    if (options.deleteLocalBranch) {
      try {
        await execaCmd('git', ['branch', '-D', branchName], { cwd: repoPath });
        console.log(`[AgentInstanceService] Deleted local branch ${branchName}`);
      } catch (err) {
        console.warn(`[AgentInstanceService] Failed to delete local branch: ${err}`);
      }
    }

    // 3. Delete remote branch
    if (options.deleteRemoteBranch) {
      try {
        await execaCmd('git', ['push', 'origin', '--delete', branchName], { cwd: repoPath });
        console.log(`[AgentInstanceService] Deleted remote branch ${branchName}`);
      } catch (err) {
        console.warn(`[AgentInstanceService] Failed to delete remote branch: ${err}`);
      }
    }

    // 4. Delete the instance itself (files, state, etc.) — only if we had
    // an in-memory instance. Ghost-mode delete already finished the on-disk
    // cleanup above and has nothing to remove from electron-store.
    if (instanceId) {
      return this.deleteInstance(instanceId);
    }

    // Ghost-mode: still attempt to delete session files on disk by sessionId,
    // since SessionReports come from those files and the user will keep
    // seeing the entry in the list until they're gone.
    try {
      await this.deleteSessionFilesFromDiskBySessionId(sessionId, repoPath);
    } catch (err) {
      console.warn(`[AgentInstanceService] Ghost-mode delete: failed to clean session files: ${err}`);
    }
    return { success: true, data: undefined };
  }

  /**
   * Delete an instance
   * Also deletes session files from disk to prevent them reappearing on restart
   */
  async deleteInstance(instanceId: string): Promise<IpcResult<void>> {
    const instance = this.instances.get(instanceId);

    if (instance) {
      // Delete session files from disk (prevents AgentListenerService from reloading them)
      await this.deleteSessionFilesFromDisk(instance);

      // Clear session state
      if (instance.sessionId) {
        this.clearSessionState(instance.sessionId);
      }

      // Decrement the agent count for this repo in recent repos
      if (instance.config.repoPath) {
        this.decrementRepoAgentCount(instance.config.repoPath);
      }

      // Delete from in-memory store
      this.instances.delete(instanceId);
      this.saveInstances();

      // Notify renderer to remove the session
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('instance:deleted', instanceId);
        if (instance.sessionId) {
          win.webContents.send('session:closed', instance.sessionId);
        }
      }

      console.log(`[AgentInstanceService] Deleted instance ${instanceId} and session files`);
    }

    return { success: true };
  }

  /**
   * Delete a session by sessionId (used by merge workflow and UI)
   * Finds the instance and deletes it along with session files
   * @param sessionId - The session ID to delete
   * @param repoPath - Optional repo path to delete files from (needed when no instance stored)
   */
  async deleteSessionById(sessionId: string, repoPath?: string): Promise<IpcResult<void>> {
    // Find instance by sessionId
    let targetInstanceId: string | undefined;
    let targetInstance: AgentInstance | undefined;

    for (const [id, instance] of this.instances) {
      if (instance.sessionId === sessionId) {
        targetInstanceId = id;
        targetInstance = instance;
        break;
      }
    }

    if (targetInstance && targetInstanceId) {
      return this.deleteInstance(targetInstanceId);
    }

    // Even if no instance found, try to delete session files from disk
    // (might have been created without a stored instance or loaded from disk files)
    console.log(`[AgentInstanceService] No instance found for session ${sessionId}, attempting to delete session files only`);

    // If we have a repoPath, delete the session files from disk and decrement count
    if (repoPath) {
      await this.deleteSessionFilesFromDiskBySessionId(sessionId, repoPath);
      this.decrementRepoAgentCount(repoPath);
    }

    // Clear session state
    this.clearSessionState(sessionId);

    // Notify renderer
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('session:closed', sessionId);
    }

    return { success: true };
  }

  /**
   * Delete session files from disk when we only have sessionId and repoPath
   * Used when no instance is stored (e.g., sessions loaded from disk files)
   */
  private async deleteSessionFilesFromDiskBySessionId(sessionId: string, repoPath: string): Promise<void> {
    const { unlink, readdir } = await import('fs/promises');
    const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);

    // Session file to delete
    const sessionFilePath = join(repoPath, KANVAS_PATHS.sessions, `${sessionId}.json`);

    // Try to find and delete the agent file (we need to find it by pattern since we don't know agentType)
    const agentsDir = join(repoPath, KANVAS_PATHS.agents);

    // Files to delete
    const filesToDelete = [
      sessionFilePath,
      // Activity log
      join(repoPath, KANVAS_PATHS.activity, `${sessionId}.log`),
      // Commit message file
      join(repoPath, `.devops-commit-${shortSessionId}.msg`),
    ];

    // Find agent files that match this session
    try {
      if (existsSync(agentsDir)) {
        const agentFiles = await readdir(agentsDir);
        for (const file of agentFiles) {
          if (file.includes(shortSessionId)) {
            filesToDelete.push(join(agentsDir, file));
          }
        }
      }
    } catch {
      // Ignore errors reading agents directory
    }

    // Delete files
    for (const filePath of filesToDelete) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
          console.log(`[AgentInstanceService] Deleted: ${filePath}`);
        }
      } catch (error) {
        console.warn(`[AgentInstanceService] Could not delete ${filePath}:`, error);
      }
    }
  }

  /**
   * Delete session files from disk to prevent AgentListenerService from reloading them
   */
  private async deleteSessionFilesFromDisk(instance: AgentInstance): Promise<void> {
    const { unlink } = await import('fs/promises');
    const repoPath = instance.config.repoPath;
    const sessionId = instance.sessionId;

    if (!sessionId) return;

    const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
    const agentId = `kanvas-${instance.config.agentType}-${shortSessionId}`;

    // Files to delete
    const filesToDelete = [
      // Session file in repo's .S9N_KIT_DevOpsAgent/sessions/
      join(repoPath, KANVAS_PATHS.sessions, `${sessionId}.json`),
      // Agent file in repo's .S9N_KIT_DevOpsAgent/agents/
      join(repoPath, KANVAS_PATHS.agents, `${agentId}.json`),
      // Activity log
      join(repoPath, KANVAS_PATHS.activity, `${sessionId}.log`),
      // Heartbeat file
      join(repoPath, KANVAS_PATHS.heartbeats, `${agentId}.beat`),
      // Commit message file
      join(repoPath, `.devops-commit-${shortSessionId}.msg`),
      // Agent config in worktree
      instance.worktreePath ? join(instance.worktreePath, '.agent-config') : null,
    ].filter(Boolean) as string[];

    // Also check worktree's .S9N_KIT_DevOpsAgent if different from repo
    if (instance.worktreePath && instance.worktreePath !== repoPath) {
      filesToDelete.push(
        join(instance.worktreePath, KANVAS_PATHS.sessions, `${sessionId}.json`),
        join(instance.worktreePath, KANVAS_PATHS.agents, `${agentId}.json`)
      );
    }

    // Delete files
    for (const filePath of filesToDelete) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
          console.log(`[AgentInstanceService] Deleted: ${filePath}`);
        }
      } catch (error) {
        // Ignore deletion errors - file might already be deleted
        console.warn(`[AgentInstanceService] Could not delete ${filePath}:`, error);
      }
    }
  }

  /**
   * Restart an instance - commits pending changes, reinitializes repo, creates new session
   * If there are uncommitted changes, commits them first
   * If there are multiple commits since last restart, consolidates their messages
   * @param sessionId - The session ID to restart
   * @param sessionData - Optional session data to use if no instance exists
   */
  /**
   * Compute a session's REAL "last change" time — the most recent of:
   *   - last logged activity (covers MCP calls, commits, locks — written to the DB)
   *   - the worktree's last commit time
   *   - the newest mtime among uncommitted/untracked files in the worktree
   *
   * This is what the UI should show instead of the session's `updated` bookkeeping
   * field (which moves on create/restart, not on real work). Returns an ISO string
   * or null. Cheap: uses `git status --porcelain` (changed files only), not a full
   * tree walk.
   */
  async getSessionLastChange(sessionId: string): Promise<IpcResult<string | null>> {
    try {
      let instance: AgentInstance | undefined;
      for (const inst of this.instances.values()) {
        if (inst.sessionId === sessionId || inst.id === sessionId) { instance = inst; break; }
      }
      const worktreePath = instance?.worktreePath || instance?.config?.repoPath;

      const candidates: number[] = [];

      // 1. Last logged activity (MCP calls etc.)
      const dbTs = databaseService.getLatestActivityTimestamp(instance?.sessionId || sessionId);
      if (dbTs) { const t = Date.parse(dbTs); if (!Number.isNaN(t)) candidates.push(t); }

      if (worktreePath && existsSync(worktreePath)) {
        // 2. Last commit time on the worktree's branch (one cheap git call).
        try {
          const { stdout } = await execaCmd('git', ['log', '-1', '--format=%cI'], { cwd: worktreePath });
          const t = Date.parse(stdout.trim());
          if (!Number.isNaN(t)) candidates.push(t);
        } catch { /* no commits yet */ }

        // 3. Worktree directory mtime — a CHEAP single stat that catches recent
        //    file adds/removes. We intentionally do NOT run `git status` + stat
        //    every file here: on a large repo that's expensive and this method is
        //    polled per session. Uncommitted edits are captured within minutes by
        //    the watcher's auto-commit (→ #2) and by logged activity (→ #1).
        try {
          const st = await stat(worktreePath);
          candidates.push(st.mtime.getTime());
        } catch { /* worktree gone */ }
      }

      if (candidates.length === 0) return { success: true, data: null };
      return { success: true, data: new Date(Math.max(...candidates)).toISOString() };
    } catch (error) {
      return { success: false, error: { code: 'LAST_CHANGE_FAILED', message: error instanceof Error ? error.message : 'failed' } };
    }
  }

  /**
   * Remove any in-memory instances on the given repo+branch. Used by restart so
   * a re-created session can't leave a stale duplicate on the same branch (which
   * would surface as two rows like "1-31eb" / "2-31eb").
   */
  private purgeInstancesOnBranch(repoPath: string, branchName: string): void {
    for (const [id, inst] of this.instances) {
      if (inst.config?.repoPath === repoPath && inst.config?.branchName === branchName) {
        this.instances.delete(id);
      }
    }
  }

  async restartInstance(
    sessionId: string,
    sessionData?: {
      repoPath: string;
      branchName: string;
      baseBranch?: string;
      worktreePath?: string;
      agentType?: AgentType;
      task?: string;
    },
    commitChanges = true
  ): Promise<IpcResult<AgentInstance>> {
    const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
    this.terminalLogService?.logSystem(`Starting restart for session ${shortSessionId}...`, sessionId);

    try {
      // Find instance by sessionId
      let targetInstance: AgentInstance | undefined;
      for (const instance of this.instances.values()) {
        if (instance.sessionId === sessionId) {
          targetInstance = instance;
          break;
        }
      }

      // If no instance found but we have session data, create a temporary config.
      // Try to inherit from any closed/historical instance that ever ran on this
      // (repoPath, branchName) pair — that's where mergeAction, multiRepo,
      // customMcpEnabled etc. live. Cherry-picking only the sessionData fields
      // (as the original code did) silently stripped tag-push config on every
      // cold-path restart, which is why most users saw "tags suddenly broken".
      if (!targetInstance && sessionData) {
        console.log(`[AgentInstanceService] No instance found for ${sessionId}, creating from session data`);
        this.terminalLogService?.info(`No stored instance found, using session data`, sessionId, 'Restart');

        // Scan the in-memory map for a recent instance on the same (repo, branch)
        // whose config we can carry forward. Most recent wins.
        let inheritedConfig: AgentInstanceConfig | undefined;
        for (const inst of this.instances.values()) {
          if (inst.config?.repoPath === sessionData.repoPath &&
              inst.config?.branchName === sessionData.branchName) {
            inheritedConfig = inst.config;
            break;
          }
        }

        const config: AgentInstanceConfig = {
          // Inherit everything first (mergeAction, multiRepo, customMcpEnabled, etc.)…
          ...(inheritedConfig || {}),
          // …then override with the live session-data values we trust more.
          repoPath: sessionData.repoPath,
          agentType: sessionData.agentType || inheritedConfig?.agentType || 'claude',
          taskDescription: sessionData.task || inheritedConfig?.taskDescription || 'Restarted session',
          branchName: sessionData.branchName,
          baseBranch: (sessionData.baseBranch || inheritedConfig?.baseBranch || 'main').replace(/^origin\//, ''),
          useWorktree: !!sessionData.worktreePath || (inheritedConfig?.useWorktree ?? false),
          autoCommit: inheritedConfig?.autoCommit ?? true,
          commitInterval: inheritedConfig?.commitInterval ?? 30000,
          rebaseFrequency: inheritedConfig?.rebaseFrequency ?? 'never',
          systemPrompt: inheritedConfig?.systemPrompt ?? '',
          contextPreservation: inheritedConfig?.contextPreservation ?? '',
        };

        // Purge any lingering instance on this branch so restart can't duplicate it.
        this.purgeInstancesOnBranch(config.repoPath, config.branchName);

        // Create the new instance directly (skip finding old instance)
        this.terminalLogService?.info(`Initializing Kanvas directory...`, sessionId, 'Restart');
        const initResult = await this.initializeKanvasDirectory(config.repoPath);
        if (!initResult.success) {
          this.terminalLogService?.error(`Failed to initialize directory: ${initResult.error?.message}`, sessionId, 'Restart');
          return {
            success: false,
            error: initResult.error || { code: 'INIT_ERROR', message: 'Failed to initialize directory' },
          };
        }

        // Optionally commit any pending changes before creating new session
        const worktreePath = sessionData.worktreePath || config.repoPath;
        if (commitChanges) {
          this.terminalLogService?.info(`Checking for uncommitted changes...`, sessionId, 'Restart');
          const commitResult = await this.commitPendingChangesOnRestart(sessionId, worktreePath);
          if (commitResult.committed) {
            console.log(`[AgentInstanceService] Committed pending changes: ${commitResult.message}`);
            this.terminalLogService?.info(`Committed pending changes: ${commitResult.message}`, sessionId, 'Restart');
          } else {
            this.terminalLogService?.info(`No uncommitted changes found`, sessionId, 'Restart');
          }
        } else {
          this.terminalLogService?.info(`Skipping commit — user chose to discard uncommitted changes`, sessionId, 'Restart');
        }

        // Create new instance with the config
        this.terminalLogService?.info(`Creating new session...`, sessionId, 'Restart');
        const newInstance = await this.createInstance(config);

        if (newInstance.success && newInstance.data) {
          // Record lineage so backfillMcpCallsByLineage can repatriate any
          // mcp_calls stranded under previous sessionIds. No prior instance
          // record here (this is the "restart from session data" path), so
          // the chain is just the immediate predecessor.
          this.recordPredecessor(newInstance.data, sessionId);

          // Transfer database records (commits, activity logs) from old session to new
          if (newInstance.data.sessionId) {
            const transferred = databaseService.transferSessionData(sessionId, newInstance.data.sessionId);
            this.terminalLogService?.info(
              `Transferred ${transferred.transferred.commits} commits and ${transferred.transferred.activity} activity entries`,
              newInstance.data.sessionId,
              'Restart'
            );
          }

          const windows = BrowserWindow.getAllWindows();
          for (const win of windows) {
            win.webContents.send('session:closed', sessionId);
          }
          const newShortId = newInstance.data.sessionId?.replace('sess_', '').slice(0, 8);
          console.log(`[AgentInstanceService] Session restarted from session data: ${sessionId} -> ${newInstance.data.sessionId}`);
          this.terminalLogService?.logSystem(`Session restarted: ${shortSessionId} -> ${newShortId}`, newInstance.data.sessionId);
        }

        return newInstance;
      }

      if (!targetInstance) {
        this.terminalLogService?.error(`Instance not found and no session data provided`, sessionId, 'Restart');
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Instance with session ${sessionId} not found. Provide session data to restart.`,
          },
        };
      }

      const config = targetInstance.config;
      const oldInstanceId = targetInstance.id;
      const worktreePath = targetInstance.worktreePath || config.repoPath;
      // Snapshot the target's predecessor chain BEFORE we delete it, so the
      // new instance can inherit and extend it (used by the mcp_calls
      // lineage backfill).
      const inheritedPredecessors: string[] = [...(targetInstance.predecessorSessionIds || [])];

      console.log(`[AgentInstanceService] Restarting session ${sessionId} in ${worktreePath}`);
      this.terminalLogService?.info(`Found stored instance, restarting in ${worktreePath}`, sessionId, 'Restart');

      // Check for uncommitted changes and optionally commit them
      if (commitChanges) {
        this.terminalLogService?.info(`Checking for uncommitted changes...`, sessionId, 'Restart');
        const commitResult = await this.commitPendingChangesOnRestart(sessionId, worktreePath);
        if (commitResult.committed) {
          console.log(`[AgentInstanceService] Committed pending changes: ${commitResult.message}`);
          this.terminalLogService?.info(`Committed pending changes: ${commitResult.message}`, sessionId, 'Restart');
        } else {
          this.terminalLogService?.info(`No uncommitted changes found`, sessionId, 'Restart');
        }
      } else {
        this.terminalLogService?.info(`Skipping commit — user chose to discard uncommitted changes`, sessionId, 'Restart');
      }

      // Clean up old session files from .S9N_KIT_DevOpsAgent
      this.terminalLogService?.info(`Cleaning up old session files...`, sessionId, 'Restart');
      await this.cleanupSessionFiles(config.repoPath, sessionId);

      // Delete old instance — and any other lingering instance on the same branch
      // (e.g. a stale one left after the worktree was removed) to avoid duplicates.
      this.instances.delete(oldInstanceId);
      this.purgeInstancesOnBranch(config.repoPath, config.branchName);

      // Re-initialize the .S9N_KIT_DevOpsAgent directory (ensures structure is correct)
      this.terminalLogService?.info(`Re-initializing Kanvas directory...`, sessionId, 'Restart');
      const initResult = await this.initializeKanvasDirectory(config.repoPath);
      if (!initResult.success) {
        this.terminalLogService?.error(`Failed to reinitialize: ${initResult.error?.message}`, sessionId, 'Restart');
        return {
          success: false,
          error: initResult.error || { code: 'INIT_ERROR', message: 'Failed to reinitialize directory' },
        };
      }

      // Create new instance with same config (this generates new session ID)
      this.terminalLogService?.info(`Creating new session...`, sessionId, 'Restart');
      const newInstance = await this.createInstance(config);

      if (newInstance.success && newInstance.data) {
        // Carry the predecessor chain forward (inherited from targetInstance)
        // and add the just-replaced sessionId. Persists immediately so the
        // record survives a crash mid-restart.
        this.recordPredecessor(newInstance.data, sessionId, inheritedPredecessors);

        // Transfer database records (commits, activity logs) from old session to new
        if (newInstance.data.sessionId) {
          const transferred = databaseService.transferSessionData(sessionId, newInstance.data.sessionId);
          this.terminalLogService?.info(
            `Transferred ${transferred.transferred.commits} commits and ${transferred.transferred.activity} activity entries`,
            newInstance.data.sessionId,
            'Restart'
          );
        }

        // Notify renderer of the restart (old session removed, new one added)
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          win.webContents.send('session:closed', sessionId);
        }

        const newShortId = newInstance.data.sessionId?.replace('sess_', '').slice(0, 8);
        console.log(`[AgentInstanceService] Session restarted: ${sessionId} -> ${newInstance.data.sessionId}`);
        this.terminalLogService?.logSystem(`Session restarted: ${shortSessionId} -> ${newShortId}`, newInstance.data.sessionId);
      }

      return newInstance;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to restart instance';
      this.terminalLogService?.error(`Restart failed: ${errorMsg}`, sessionId, 'Restart');
      return {
        success: false,
        error: {
          code: 'RESTART_ERROR',
          message: errorMsg,
        },
      };
    }
  }

  /**
   * Check for uncommitted changes and commit them before restart
   * Consolidates commit messages from commits since last processed commit
   */
  private async commitPendingChangesOnRestart(
    sessionId: string,
    worktreePath: string
  ): Promise<{ committed: boolean; message?: string }> {
    try {
      // Check if there are uncommitted changes
      const statusResult = await execaCmd('git', ['status', '--porcelain'], { cwd: worktreePath });
      const hasChanges = statusResult.stdout.trim().length > 0;

      if (!hasChanges) {
        console.log(`[AgentInstanceService] No uncommitted changes to commit`);
        return { committed: false };
      }

      // Get commits since last processed commit for consolidated message
      const sessionState = this.getSessionState(sessionId);
      const lastCommit = sessionState?.lastProcessedCommit;

      let commitMessages: string[] = [];
      if (lastCommit) {
        try {
          // Get all commit messages since last processed commit
          const logResult = await execaCmd(
            'git',
            ['log', `${lastCommit}..HEAD`, '--format=%s', '--reverse'],
            { cwd: worktreePath }
          );
          commitMessages = logResult.stdout.trim().split('\n').filter(Boolean);
        } catch {
          // Ignore errors getting commit history
        }
      }

      // Stage all changes
      await execaCmd('git', ['add', '-A'], { cwd: worktreePath });

      // Create consolidated commit message
      let commitMessage: string;
      if (commitMessages.length > 0) {
        // Consolidate recent commit messages
        commitMessage = `[Kanvas Restart] Consolidated changes\n\nChanges since last session:\n${commitMessages.map(m => `- ${m}`).join('\n')}\n\n+ Uncommitted changes at restart`;
      } else {
        commitMessage = `[Kanvas Restart] Save uncommitted changes before session restart`;
      }

      // Commit
      await execaCmd('git', ['commit', '-m', commitMessage], { cwd: worktreePath });

      console.log(`[AgentInstanceService] Committed ${commitMessages.length > 0 ? 'consolidated' : 'pending'} changes`);
      return { committed: true, message: commitMessage.split('\n')[0] };
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not commit pending changes: ${error}`);
      return { committed: false };
    }
  }

  /**
   * Clean up session files from .S9N_KIT_DevOpsAgent directory
   */
  private async cleanupSessionFiles(repoPath: string, sessionId: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);

    // Files to clean up
    const filesToRemove = [
      // Session file
      join(repoPath, KANVAS_PATHS.sessions, `${sessionId}.json`),
      // Activity log
      join(repoPath, KANVAS_PATHS.activity, `${sessionId}.log`),
      // Command file
      join(repoPath, KANVAS_PATHS.commands, `${sessionId}.cmd`),
      // Commit message file
      join(repoPath, `.devops-commit-${shortSessionId}.msg`),
    ];

    // Also clean up any active edit declarations for this session
    const activeEditsDir = join(repoPath, FILE_COORDINATION_PATHS.activeEdits);
    if (existsSync(activeEditsDir)) {
      try {
        const editFiles = await readdir(activeEditsDir);
        for (const file of editFiles) {
          if (file.includes(shortSessionId)) {
            filesToRemove.push(join(activeEditsDir, file));
          }
        }
      } catch {
        // Ignore errors reading active edits
      }
    }

    // Remove files
    for (const filePath of filesToRemove) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
          console.log(`[AgentInstanceService] Cleaned up: ${filePath}`);
        }
      } catch (error) {
        console.warn(`[AgentInstanceService] Could not remove ${filePath}:`, error);
      }
    }
  }

  /**
   * Clear all instances and sessions
   */
  clearAllInstances(): IpcResult<{ count: number }> {
    const count = this.instances.size;
    this.instances.clear();
    this.store.set('instances', []);

    // Notify renderer to clear all sessions
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('instances:cleared');
    }

    console.log(`[AgentInstanceService] Cleared ${count} instances`);
    return { success: true, data: { count } };
  }

  /**
   * Update the base branch for a session
   * Allows changing which branch the session rebases from
   */
  async updateBaseBranch(sessionId: string, newBaseBranch: string): Promise<IpcResult<void>> {
    try {
      // Find instance by sessionId
      let targetInstance: AgentInstance | undefined;
      for (const instance of this.instances.values()) {
        if (instance.sessionId === sessionId) {
          targetInstance = instance;
          break;
        }
      }

      if (!targetInstance) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `No instance found for session ${sessionId}` },
        };
      }

      const repoPath = targetInstance.config.repoPath;

      // Validate the branch exists (check local and remote branches)
      const branchResult = await execaCmd(
        'git',
        ['branch', '-a', '--list', `*${newBaseBranch}`],
        { cwd: repoPath }
      );

      const matchingBranches = branchResult.stdout.trim().split('\n').filter(Boolean);
      if (matchingBranches.length === 0) {
        return {
          success: false,
          error: { code: 'BRANCH_NOT_FOUND', message: `Branch "${newBaseBranch}" not found in repository` },
        };
      }

      // Update the config — normalize to strip origin/ prefix
      const cleanedBaseBranch = newBaseBranch.replace(/^origin\//, '');
      targetInstance.config.baseBranch = cleanedBaseBranch;
      this.instances.set(targetInstance.id, targetInstance);
      this.saveInstances();

      // Update the session file on disk
      const sessionFilePath = join(repoPath, KANVAS_PATHS.sessions, `${sessionId}.json`);
      if (existsSync(sessionFilePath)) {
        try {
          const content = await readFile(sessionFilePath, 'utf-8');
          const sessionData = JSON.parse(content);
          sessionData.baseBranch = cleanedBaseBranch;
          sessionData.updated = new Date().toISOString();
          await writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2));
        } catch {
          // Non-fatal: session file update failed
          console.warn(`[AgentInstanceService] Could not update session file for ${sessionId}`);
        }
      }

      // Re-emit session report to renderer with updated baseBranch
      const shortSessionId = sessionId.replace('sess_', '').slice(0, 8);
      const agentId = `kanvas-${targetInstance.config.agentType}-${shortSessionId}`;
      const now = new Date().toISOString();

      const sessionReport = {
        sessionId,
        agentId,
        agentType: targetInstance.config.agentType,
        task: targetInstance.config.taskDescription || targetInstance.config.branchName || `${targetInstance.config.agentType} session`,
        branchName: targetInstance.config.branchName,
        baseBranch: cleanedBaseBranch,
        worktreePath: targetInstance.worktreePath && targetInstance.worktreePath !== repoPath
          ? targetInstance.worktreePath : undefined,
        repoPath,
        status: targetInstance.status === 'running' ? 'active' as const : 'idle' as const,
        created: targetInstance.createdAt,
        updated: now,
        commitCount: 0,
      };

      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('session:reported', sessionReport);
      }

      console.log(`[AgentInstanceService] Updated baseBranch for session ${sessionId} to ${newBaseBranch}`);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: error instanceof Error ? error.message : 'Failed to update base branch',
        },
      };
    }
  }

  /**
   * Update instance status
   *
   * R1 fix: when a session transitions across the active/inactive boundary
   * (e.g. running → completed), we recalc `RecentRepo.agentCount` so the
   * repo-picker session count stays accurate without restarting the app.
   */
  updateInstanceStatus(instanceId: string, status: AgentInstance['status'], error?: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      const wasActive = isActiveInstance(instance);
      instance.status = status;
      if (error) {
        instance.error = error;
      }
      const nowActive = isActiveInstance(instance);
      this.saveInstances();
      this.emitStatusChange(instance);
      if (wasActive !== nowActive) {
        this.recalculateRepoAgentCounts();
      }
    }
  }

  // Recent repos management

  async getRecentRepos(): Promise<IpcResult<RecentRepo[]>> {
    return {
      success: true,
      data: this.store.get('recentRepos', []),
    };
  }

  async addRecentRepo(repo: RecentRepo): Promise<IpcResult<void>> {
    const repos = this.store.get('recentRepos', []);

    // Update existing or add new
    const existingIndex = repos.findIndex(r => r.path === repo.path);
    if (existingIndex >= 0) {
      repos[existingIndex] = {
        ...repos[existingIndex],
        lastUsed: repo.lastUsed,
        agentCount: repos[existingIndex].agentCount + 1,
      };
    } else {
      repos.unshift(repo);
    }

    // Keep only last 10
    const trimmed = repos.slice(0, 10);
    this.store.set('recentRepos', trimmed);

    return { success: true };
  }

  async removeRecentRepo(path: string): Promise<IpcResult<void>> {
    const repos = this.store.get('recentRepos', []);
    const filtered = repos.filter(r => r.path !== path);
    this.store.set('recentRepos', filtered);
    return { success: true };
  }

  /**
   * Decrement the agent count for a repo when a session is deleted
   */
  decrementRepoAgentCount(repoPath: string): void {
    const repos = this.store.get('recentRepos', []) as RecentRepo[];
    const existingIndex = repos.findIndex(r => r.path === repoPath);
    if (existingIndex >= 0) {
      const newCount = Math.max(0, repos[existingIndex].agentCount - 1);
      repos[existingIndex] = {
        ...repos[existingIndex],
        agentCount: newCount,
      };
      this.store.set('recentRepos', repos);
      console.log(`[AgentInstanceService] Decremented agent count for ${repoPath} to ${newCount}`);
    }
  }

  /**
   * Recalculate agent counts for all recent repos based on actual stored instances.
   * R1 fix: counts ONLY active sessions (filters out completed/closed/failed)
   * so the "Setup new instance" repo picker shows the live session count, not
   * a stale all-time tally.
   *
   * Active/inactive rule lives in `shared/instance-status.ts` so it stays in
   * sync with the C5 Single-Session Mode guard.
   */
  recalculateRepoAgentCounts(): void {
    const repos = this.store.get('recentRepos', []) as RecentRepo[];
    const instances = Array.from(this.instances.values()).filter(isActiveInstance);

    // Count instances per repo
    const countByRepo = new Map<string, number>();
    for (const instance of instances) {
      const repoPath = instance.config.repoPath;
      countByRepo.set(repoPath, (countByRepo.get(repoPath) || 0) + 1);
    }

    // Update counts in recent repos
    let updated = false;
    for (const repo of repos) {
      const actualCount = countByRepo.get(repo.path) || 0;
      if (repo.agentCount !== actualCount) {
        console.log(`[AgentInstanceService] Fixing agent count for ${repo.name}: ${repo.agentCount} -> ${actualCount}`);
        repo.agentCount = actualCount;
        updated = true;
      }
    }

    if (updated) {
      this.store.set('recentRepos', repos);
      console.log('[AgentInstanceService] Recalculated repo agent counts');
    }
  }

  // Private helpers

  private saveInstances(): void {
    this.store.set('instances', Array.from(this.instances.values()));
  }

  private emitStatusChange(instance: AgentInstance): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('instance:status-changed', instance);
    }
  }

  /**
   * Regenerate prompts for all stored instances using the latest template.
   * Ensures prompt updates (e.g. tool renames) propagate to existing sessions.
   */
  refreshStoredPrompts(): void {
    let updated = false;
    for (const instance of this.instances.values()) {
      if (!instance.sessionId || !instance.config) continue;
      const vars: InstructionVars = {
        repoPath: instance.worktreePath || instance.config.repoPath,
        repoName: instance.config.repoPath.split('/').pop() || 'unknown',
        branchName: instance.config.branchName,
        sessionId: instance.sessionId,
        taskDescription: instance.config.taskDescription || '',
        systemPrompt: instance.config.systemPrompt || '',
        contextPreservation: instance.config.contextPreservation || '',
        rebaseFrequency: instance.config.rebaseFrequency || 'never',
        mcpUrl: this.mcpServerUrl || undefined,
        rpcUrl: this.rpcServerUrl || undefined,
        baseBranch: (instance.config.baseBranch || 'main').replace(/^origin\//, ''),
        multiRepoEntries: instance.multiRepoEntries,
        commitScope: instance.config.multiRepo?.commitScope,
      };
      instance.instructions = getAgentInstructions(instance.config.agentType, vars);
      if (instance.config.agentType === 'claude') {
        instance.prompt = generateClaudePrompt(vars);
      }
      updated = true;
    }
    if (updated) {
      this.saveInstances();
      console.log(`[AgentInstanceService] Refreshed prompts for ${this.instances.size} stored instances`);
    }
  }

  /**
   * Emit all stored sessions to renderer on app startup
   * This ensures sessions persist across app restarts
   */
  emitStoredSessions(): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      console.log('[AgentInstanceService] No windows available to emit sessions');
      return;
    }

    const instances = Array.from(this.instances.values());
    console.log(`[AgentInstanceService] Emitting ${instances.length} stored sessions to renderer`);

    for (const instance of instances) {
      if (!instance.sessionId) continue;

      const shortSessionId = instance.sessionId.replace('sess_', '').slice(0, 8);
      const agentId = `kanvas-${instance.config.agentType}-${shortSessionId}`;
      const now = new Date().toISOString();

      // Create session report from instance
      const sessionReport = {
        sessionId: instance.sessionId,
        agentId,
        agentType: instance.config.agentType,
        task: instance.config.taskDescription || instance.config.branchName || `${instance.config.agentType} session`,
        branchName: instance.config.branchName,
        baseBranch: (instance.config.baseBranch || 'main').replace(/^origin\//, ''), // The branch this session was created from (merge target)
        // Only expose worktreePath when a real git worktree exists (distinct from repoPath).
        // Falling back to repoPath makes worktreePath === repoPath, which confuses the
        // conflict-resolution modal into running git ops on the root instead of the worktree.
        worktreePath: instance.worktreePath && instance.worktreePath !== instance.config.repoPath
          ? instance.worktreePath
          : undefined,
        repoPath: instance.config.repoPath,
        status: instance.status === 'running' ? 'active' as const : 'idle' as const,
        created: instance.createdAt,
        updated: now,
        commitCount: 0,
      };

      // Create agent info
      const agentInfo = {
        agentId,
        agentType: instance.config.agentType,
        agentName: `${instance.config.agentType.charAt(0).toUpperCase()}${instance.config.agentType.slice(1)} (${basename(instance.config.repoPath)})`,
        version: '1.0.0',
        pid: process.pid,
        startedAt: instance.createdAt,
        repoPath: instance.config.repoPath,
        capabilities: ['code-generation', 'file-editing'],
        sessions: [instance.sessionId],
        lastHeartbeat: now,
        isAlive: instance.status === 'running',
      };

      // Emit to all windows
      for (const win of windows) {
        win.webContents.send('session:reported', sessionReport);
        win.webContents.send('agent:registered', agentInfo);
      }
    }
  }

  // ==========================================================================
  // SESSION STATE TRACKING (for crash recovery)
  // ==========================================================================

  /**
   * Get the session state (last processed commit, etc.)
   */
  getSessionState(sessionId: string): SessionState | null {
    const states = this.store.get('sessionStates', {});
    return states[sessionId] || null;
  }

  /**
   * Update the last processed commit for a session
   */
  updateLastProcessedCommit(
    sessionId: string,
    commitHash: string,
    contractChangesCount = 0,
    breakingChangesCount = 0
  ): void {
    // Mutate the in-memory cache immediately
    if (!this.sessionStatesCache) {
      this.sessionStatesCache = this.store.get('sessionStates', {});
    }
    this.sessionStatesCache[sessionId] = {
      sessionId,
      lastProcessedCommit: commitHash,
      lastProcessedAt: new Date().toISOString(),
      contractChangesCount: (this.sessionStatesCache[sessionId]?.contractChangesCount || 0) + contractChangesCount,
      breakingChangesCount: (this.sessionStatesCache[sessionId]?.breakingChangesCount || 0) + breakingChangesCount,
    };
    console.log(`[AgentInstanceService] Updated session ${sessionId} last commit: ${commitHash.substring(0, 7)}`);

    // Flush to disk at most once every 5 seconds — electron-store uses fs.writeFileSync
    // which blocks the main thread; calling it on every commit causes ANR on busy agents.
    if (!this.sessionStatesFlushTimer) {
      this.sessionStatesFlushTimer = setTimeout(() => {
        this.sessionStatesFlushTimer = null;
        if (this.sessionStatesCache) {
          this.store.set('sessionStates', this.sessionStatesCache);
        }
      }, 5_000);
    }
  }

  /**
   * Get all session states (for crash recovery check) — uses in-memory cache when available
   */
  getAllSessionStates(): Record<string, SessionState> {
    return this.sessionStatesCache ?? this.store.get('sessionStates', {});
  }

  /**
   * Clear session state (when session is deleted)
   */
  clearSessionState(sessionId: string): void {
    if (this.sessionStatesCache) {
      delete this.sessionStatesCache[sessionId];
    }
    const states = this.store.get('sessionStates', {});
    delete states[sessionId];
    this.store.set('sessionStates', states);
  }

  /**
   * Get commits since last processed commit for a session
   * Returns commits that need to be processed (for crash recovery)
   */
  async getUnprocessedCommits(sessionId: string): Promise<{
    commits: Array<{ hash: string; message: string; timestamp: string }>;
    worktreePath: string | null;
  }> {
    const instance = Array.from(this.instances.values()).find(i => i.sessionId === sessionId);
    if (!instance) {
      return { commits: [], worktreePath: null };
    }

    const worktreePath = instance.worktreePath || instance.config.repoPath;
    const sessionState = this.getSessionState(sessionId);
    const lastCommit = sessionState?.lastProcessedCommit;

    try {
      // Get commits since last processed commit
      let gitArgs: string[];
      if (lastCommit) {
        // Get commits after the last processed one
        gitArgs = ['log', `${lastCommit}..HEAD`, '--format=%H|%s|%aI', '--reverse'];
      } else {
        // No last commit, get last 10 commits to avoid overwhelming
        gitArgs = ['log', '-10', '--format=%H|%s|%aI', '--reverse'];
      }

      const result = await execaCmd('git', gitArgs, { cwd: worktreePath });
      const lines = result.stdout.trim().split('\n').filter(Boolean);

      const commits = lines.map(line => {
        const [hash, message, timestamp] = line.split('|');
        return { hash, message, timestamp };
      });

      console.log(`[AgentInstanceService] Found ${commits.length} unprocessed commits for session ${sessionId}`);
      return { commits, worktreePath };
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not get unprocessed commits: ${error}`);
      return { commits: [], worktreePath };
    }
  }

  /**
   * Process all unprocessed commits for all sessions on startup
   * This is the crash recovery routine
   */
  async processUnprocessedCommitsOnStartup(
    contractDetection: { analyzeCommit: (sessionId: string, commitHash: string, worktreePath: string) => Promise<{ contractChanges: number; breakingChanges: number }> }
  ): Promise<{ sessionsProcessed: number; commitsProcessed: number }> {
    let sessionsProcessed = 0;
    let commitsProcessed = 0;

    console.log('[AgentInstanceService] Starting crash recovery - checking for unprocessed commits...');

    for (const instance of this.instances.values()) {
      if (!instance.sessionId) continue;

      const { commits, worktreePath } = await this.getUnprocessedCommits(instance.sessionId);
      if (commits.length === 0 || !worktreePath) continue;

      sessionsProcessed++;
      console.log(`[AgentInstanceService] Processing ${commits.length} commits for session ${instance.sessionId}`);

      for (const commit of commits) {
        try {
          // Analyze commit for contract changes
          const analysis = await contractDetection.analyzeCommit(
            instance.sessionId,
            commit.hash,
            worktreePath
          );

          // Update session state
          this.updateLastProcessedCommit(
            instance.sessionId,
            commit.hash,
            analysis.contractChanges,
            analysis.breakingChanges
          );

          commitsProcessed++;
        } catch (error) {
          console.warn(`[AgentInstanceService] Failed to process commit ${commit.hash}: ${error}`);
          // Continue with next commit
        }
      }
    }

    console.log(`[AgentInstanceService] Crash recovery complete: ${sessionsProcessed} sessions, ${commitsProcessed} commits processed`);
    return { sessionsProcessed, commitsProcessed };
  }
}

export const agentInstanceService = new AgentInstanceService();
