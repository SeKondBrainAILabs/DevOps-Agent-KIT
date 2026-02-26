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
import { join, basename } from 'path';
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

async function execaCmd(cmd: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  const execa = await getExeca();
  return execa(cmd, args, options);
}
import { KANVAS_PATHS, FILE_COORDINATION_PATHS, DEVOPS_KIT_DIR } from '../../shared/agent-protocol';
import { getAgentInstructions, generateClaudePrompt, InstructionVars } from '../../shared/agent-instructions';
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
import { generateSecondaryBranchName } from '../../shared/types';
import type { TerminalLogService } from './TerminalLogService';
import { MCP_CONFIG_FILE, CONTRACTS_PATHS } from '../../shared/agent-protocol';

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

    // Load existing instances
    const savedInstances = this.store.get('instances', []);
    for (const instance of savedInstances) {
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

      // Get all branches
      const branchesResult = await execaCmd('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: repoPath });
      const branches = branchesResult.stdout.split('\n').filter(Boolean);

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

      // Generate the standalone prompt for easy copying (only for Claude)
      const prompt = config.agentType === 'claude'
        ? generateClaudePrompt(instructionVars)
        : undefined;

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

      // Create the branch if it doesn't exist
      await this.createBranchIfNeeded(config);

      // Create worktree for isolated development
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
        mcpUrl: this.mcpServerUrl || undefined,
      };
      instance.instructions = getAgentInstructions(config.agentType, finalInstructionVars);
      if (config.agentType === 'claude') {
        instance.prompt = generateClaudePrompt(finalInstructionVars);
      }

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
          if (config.agentType === 'claude') {
            instance.prompt = generateClaudePrompt(multiRepoVars);
          }

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
   * Create branch if it doesn't exist
   */
  private async createBranchIfNeeded(config: AgentInstanceConfig): Promise<void> {
    try {
      // Check if branch exists
      const branchResult = await execaCmd('git', ['branch', '--list', config.branchName], { cwd: config.repoPath });

      if (!branchResult.stdout.trim()) {
        // Branch doesn't exist, create it
        await execaCmd('git', ['checkout', '-b', config.branchName, config.baseBranch], { cwd: config.repoPath });
        console.log(`[AgentInstanceService] Created branch ${config.branchName} from ${config.baseBranch}`);

        // Switch back to original branch
        await execaCmd('git', ['checkout', '-'], { cwd: config.repoPath });
      }
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create branch: ${error}`);
      // Don't fail the whole operation if branch creation fails
    }
  }

  /**
   * Create worktree for isolated development
   * Creates worktree in local_deploy/{branchName} directory
   */
  private async createWorktreeIfNeeded(config: AgentInstanceConfig): Promise<string> {
    try {
      // Worktree directory: local_deploy/{branchName}
      const worktreeDir = join(config.repoPath, 'local_deploy', config.branchName);

      // Check if worktree already exists
      if (existsSync(worktreeDir)) {
        console.log(`[AgentInstanceService] Worktree already exists at ${worktreeDir}`);
        return worktreeDir;
      }

      // Ensure local_deploy directory exists
      const localDeployDir = join(config.repoPath, 'local_deploy');
      if (!existsSync(localDeployDir)) {
        await mkdir(localDeployDir, { recursive: true });
      }

      // Create worktree
      await execaCmd('git', ['worktree', 'add', worktreeDir, config.branchName], { cwd: config.repoPath });
      console.log(`[AgentInstanceService] Created worktree at ${worktreeDir} for branch ${config.branchName}`);

      // Initialize .S9N_KIT_DevOpsAgent in the worktree
      await this.initializeKanvasDirectory(worktreeDir);

      return worktreeDir;
    } catch (error) {
      console.warn(`[AgentInstanceService] Could not create worktree: ${error}`);
      // Fall back to using main repo path
      return config.repoPath;
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
        baseBranch: instance.config.baseBranch,
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
   * Allows agents to auto-discover the Kanvas MCP server
   */
  private async createMcpConfigFile(worktreePath: string): Promise<void> {
    if (!this.mcpServerUrl) return;

    try {
      const mcpConfig = {
        mcpServers: {
          kanvas: {
            type: 'streamable-http',
            url: this.mcpServerUrl,
          },
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
          // External repo: create worktree in that repo's local_deploy/
          const externalRepoPath = secondary.repoPath;
          const worktreeDir = join(externalRepoPath, 'local_deploy', branchName);

          if (!existsSync(worktreeDir)) {
            // Create branch if needed
            try {
              const branchResult = await execaCmd('git', ['branch', '--list', branchName], { cwd: externalRepoPath });
              if (!branchResult.stdout.trim()) {
                const base = secondary.baseBranch || 'main';
                await execaCmd('git', ['checkout', '-b', branchName, base], { cwd: externalRepoPath });
                await execaCmd('git', ['checkout', '-'], { cwd: externalRepoPath });
              }
            } catch {
              // Branch creation may fail, continue
            }

            // Create worktree
            const localDeployDir = join(externalRepoPath, 'local_deploy');
            if (!existsSync(localDeployDir)) {
              await mkdir(localDeployDir, { recursive: true });
            }
            try {
              await execaCmd('git', ['worktree', 'add', worktreeDir, branchName], { cwd: externalRepoPath });
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

    // Create .mcp.json for MCP-capable agents
    const mcpAgents = ['claude', 'cline'];
    if (mcpAgents.includes(instance.config.agentType)) {
      await this.createMcpConfigFile(worktreePath);
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
  listInstances(): IpcResult<AgentInstance[]> {
    return {
      success: true,
      data: Array.from(this.instances.values()),
    };
  }

  /**
   * Get a specific instance
   */
  getInstance(instanceId: string): IpcResult<AgentInstance | null> {
    return {
      success: true,
      data: this.instances.get(instanceId) || null,
    };
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
  async restartInstance(
    sessionId: string,
    sessionData?: {
      repoPath: string;
      branchName: string;
      baseBranch?: string;
      worktreePath?: string;
      agentType?: AgentType;
      task?: string;
    }
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

      // If no instance found but we have session data, create a temporary config
      if (!targetInstance && sessionData) {
        console.log(`[AgentInstanceService] No instance found for ${sessionId}, creating from session data`);
        this.terminalLogService?.info(`No stored instance found, using session data`, sessionId, 'Restart');

        // Create config from session data
        const config: AgentInstanceConfig = {
          repoPath: sessionData.repoPath,
          agentType: sessionData.agentType || 'claude',
          taskDescription: sessionData.task || 'Restarted session',
          branchName: sessionData.branchName,
          baseBranch: sessionData.baseBranch || 'main',
          useWorktree: !!sessionData.worktreePath,
          autoCommit: true,
          commitInterval: 30000,
          rebaseFrequency: 'never',
          systemPrompt: '',
          contextPreservation: '',
        };

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

        // Commit any pending changes in the worktree before creating new session
        const worktreePath = sessionData.worktreePath || config.repoPath;
        this.terminalLogService?.info(`Checking for uncommitted changes...`, sessionId, 'Restart');
        const commitResult = await this.commitPendingChangesOnRestart(sessionId, worktreePath);
        if (commitResult.committed) {
          console.log(`[AgentInstanceService] Committed pending changes: ${commitResult.message}`);
          this.terminalLogService?.info(`Committed pending changes: ${commitResult.message}`, sessionId, 'Restart');
        } else {
          this.terminalLogService?.info(`No uncommitted changes found`, sessionId, 'Restart');
        }

        // Create new instance with the config
        this.terminalLogService?.info(`Creating new session...`, sessionId, 'Restart');
        const newInstance = await this.createInstance(config);

        if (newInstance.success && newInstance.data) {
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

      console.log(`[AgentInstanceService] Restarting session ${sessionId} in ${worktreePath}`);
      this.terminalLogService?.info(`Found stored instance, restarting in ${worktreePath}`, sessionId, 'Restart');

      // Check for uncommitted changes and commit them
      this.terminalLogService?.info(`Checking for uncommitted changes...`, sessionId, 'Restart');
      const commitResult = await this.commitPendingChangesOnRestart(sessionId, worktreePath);
      if (commitResult.committed) {
        console.log(`[AgentInstanceService] Committed pending changes: ${commitResult.message}`);
        this.terminalLogService?.info(`Committed pending changes: ${commitResult.message}`, sessionId, 'Restart');
      } else {
        this.terminalLogService?.info(`No uncommitted changes found`, sessionId, 'Restart');
      }

      // Clean up old session files from .S9N_KIT_DevOpsAgent
      this.terminalLogService?.info(`Cleaning up old session files...`, sessionId, 'Restart');
      await this.cleanupSessionFiles(config.repoPath, sessionId);

      // Delete old instance
      this.instances.delete(oldInstanceId);

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

      // Update the config
      targetInstance.config.baseBranch = newBaseBranch;
      this.instances.set(targetInstance.id, targetInstance);
      this.saveInstances();

      // Update the session file on disk
      const sessionFilePath = join(repoPath, KANVAS_PATHS.sessions, `${sessionId}.json`);
      if (existsSync(sessionFilePath)) {
        try {
          const content = await readFile(sessionFilePath, 'utf-8');
          const sessionData = JSON.parse(content);
          sessionData.baseBranch = newBaseBranch;
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
        baseBranch: newBaseBranch,
        worktreePath: targetInstance.worktreePath || repoPath,
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
   */
  updateInstanceStatus(instanceId: string, status: AgentInstance['status'], error?: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.status = status;
      if (error) {
        instance.error = error;
      }
      this.saveInstances();
      this.emitStatusChange(instance);
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
   * Recalculate agent counts for all recent repos based on actual stored instances
   * This fixes stale counts that got out of sync
   */
  recalculateRepoAgentCounts(): void {
    const repos = this.store.get('recentRepos', []) as RecentRepo[];
    const instances = Array.from(this.instances.values());

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
        baseBranch: instance.config.baseBranch, // The branch this session was created from (merge target)
        worktreePath: instance.worktreePath || instance.config.repoPath,
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
    const states = this.store.get('sessionStates', {});
    states[sessionId] = {
      sessionId,
      lastProcessedCommit: commitHash,
      lastProcessedAt: new Date().toISOString(),
      contractChangesCount: (states[sessionId]?.contractChangesCount || 0) + contractChangesCount,
      breakingChangesCount: (states[sessionId]?.breakingChangesCount || 0) + breakingChangesCount,
    };
    this.store.set('sessionStates', states);
    console.log(`[AgentInstanceService] Updated session ${sessionId} last commit: ${commitHash.substring(0, 7)}`);
  }

  /**
   * Get all session states (for crash recovery check)
   */
  getAllSessionStates(): Record<string, SessionState> {
    return this.store.get('sessionStates', {});
  }

  /**
   * Clear session state (when session is deleted)
   */
  clearSessionState(sessionId: string): void {
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
