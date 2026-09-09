#!/usr/bin/env node

/**
 * ============================================================================
 * CLAUDE SESSION MANAGER
 * ============================================================================
 * 
 * Manages multiple Claude/Cline sessions with automatic worktree assignment.
 * Each Claude session gets its own worktree to prevent conflicts.
 * 
 * Usage:
 *   # Start a new Claude session
 *   node claude-session-manager.js start --task "feature-auth"
 *   
 *   # Get current session info
 *   node claude-session-manager.js current
 *   
 *   # List all active sessions
 *   node claude-session-manager.js list
 *   
 *   # End a session
 *   node claude-session-manager.js end --session <id>
 * 
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  sessionsFile: 'local_deploy/claude-sessions.json',
  worktreesDir: 'local_deploy/worktrees',
  sessionPrefix: 'claude-session',
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
  }
};

// ============================================================================
// SESSION MANAGER CLASS
// ============================================================================

class ClaudeSessionManager {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.sessionsPath = path.join(this.repoRoot, CONFIG.sessionsFile);
    this.worktreesPath = path.join(this.repoRoot, CONFIG.worktreesDir);
    this.loadSessions();
  }

  getRepoRoot() {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error('Error: Not in a git repository');
      process.exit(1);
    }
  }

  loadSessions() {
    if (fs.existsSync(this.sessionsPath)) {
      const data = fs.readFileSync(this.sessionsPath, 'utf8');
      this.sessions = JSON.parse(data);
    } else {
      this.sessions = {};
    }
  }

  saveSessions() {
    fs.writeFileSync(this.sessionsPath, JSON.stringify(this.sessions, null, 2));
  }

  generateSessionId() {
    // Generate a short, unique session ID
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(2).toString('hex');
    return `${timestamp}-${random}`;
  }

  /**
   * Start a new Claude session with its own worktree
   */
  startSession(task, options = {}) {
    const sessionId = options.sessionId || this.generateSessionId();
    const sessionName = `${CONFIG.sessionPrefix}-${sessionId}`;
    const worktreeName = `${sessionName}-${task.replace(/\s+/g, '-').toLowerCase()}`;
    const worktreePath = path.join(this.worktreesPath, worktreeName);
    const branchName = `claude/${sessionId}/${task.replace(/\s+/g, '-').toLowerCase()}`;
    
    console.log(`${CONFIG.colors.blue}Starting new Claude session...${CONFIG.colors.reset}`);
    console.log(`Session ID: ${CONFIG.colors.bright}${sessionId}${CONFIG.colors.reset}`);
    console.log(`Task: ${task}`);
    
    // Check if session already exists
    if (this.sessions[sessionId]) {
      console.log(`${CONFIG.colors.yellow}Session ${sessionId} already exists${CONFIG.colors.reset}`);
      return this.sessions[sessionId];
    }
    
    // Create worktree
    try {
      if (!fs.existsSync(this.worktreesPath)) {
        fs.mkdirSync(this.worktreesPath, { recursive: true });
      }
      
      // Create new branch and worktree
      console.log(`Creating worktree at: ${worktreePath}`);
      execSync(`git worktree add -b ${branchName} "${worktreePath}" HEAD`, { stdio: 'inherit' });
      
      // Create session configuration
      const session = {
        id: sessionId,
        name: sessionName,
        task: task,
        worktree: {
          path: worktreePath,
          branch: branchName,
          name: worktreeName
        },
        created: new Date().toISOString(),
        status: 'active',
        pid: process.pid,
        commitMsgFile: `.${sessionName}-commit-msg`,
        agentConfig: {
          AC_MSG_FILE: `.${sessionName}-commit-msg`,
          AC_BRANCH_PREFIX: `claude_${sessionId}_`,
          AGENT_NAME: sessionName
        }
      };
      
      // Save session
      this.sessions[sessionId] = session;
      this.saveSessions();
      
      // Create session config file in worktree
      this.createWorktreeConfig(session);
      
      // Create VS Code workspace file
      this.createVSCodeWorkspace(session);
      
      console.log(`${CONFIG.colors.green}✓ Session created successfully!${CONFIG.colors.reset}`);
      console.log(`\n${CONFIG.colors.bright}To use this session:${CONFIG.colors.reset}`);
      console.log(`1. Open VS Code: ${CONFIG.colors.blue}code "${worktreePath}"${CONFIG.colors.reset}`);
      console.log(`2. Or navigate: ${CONFIG.colors.blue}cd "${worktreePath}"${CONFIG.colors.reset}`);
      console.log(`3. Start agent: ${CONFIG.colors.blue}npm run agent:session ${sessionId}${CONFIG.colors.reset}`);
      
      // Output for Claude to read
      console.log(`\n${CONFIG.colors.magenta}[CLAUDE_SESSION_INFO]${CONFIG.colors.reset}`);
      console.log(JSON.stringify({
        sessionId: sessionId,
        worktreePath: worktreePath,
        branchName: branchName,
        commitMsgFile: session.commitMsgFile
      }, null, 2));
      
      return session;
      
    } catch (error) {
      console.error(`${CONFIG.colors.red}Failed to create session: ${error.message}${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }

  /**
   * Create configuration files in the worktree
   */
  createWorktreeConfig(session) {
    const configPath = path.join(session.worktree.path, '.claude-session.json');
    fs.writeFileSync(configPath, JSON.stringify(session, null, 2));
    
    // Create commit message file
    const msgFilePath = path.join(session.worktree.path, session.commitMsgFile);
    fs.writeFileSync(msgFilePath, '');
    
    // Create .env.claude file for environment variables
    const envContent = Object.entries(session.agentConfig)
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n');
    
    const envPath = path.join(session.worktree.path, '.env.claude');
    fs.writeFileSync(envPath, envContent);
  }

  /**
   * Create VS Code workspace configuration
   */
  createVSCodeWorkspace(session) {
    const vscodeDir = path.join(session.worktree.path, '.vscode');
    
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    
    // Settings for this workspace
    const settings = {
      'window.title': `Claude ${session.id} - ${session.task}`,
      'terminal.integrated.env.osx': session.agentConfig,
      'terminal.integrated.env.linux': session.agentConfig,
      'terminal.integrated.env.windows': session.agentConfig,
      'files.exclude': {
        '.claude-session.json': false,
        [session.commitMsgFile]: false
      }
    };
    
    fs.writeFileSync(
      path.join(vscodeDir, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );
    
    // Create workspace file
    const workspaceFile = {
      folders: [
        {
          path: '.',
          name: `Claude: ${session.task}`
        }
      ],
      settings: settings
    };
    
    fs.writeFileSync(
      path.join(session.worktree.path, `${session.name}.code-workspace`),
      JSON.stringify(workspaceFile, null, 2)
    );
  }

  /**
   * Get current session based on current directory
   */
  getCurrentSession() {
    const cwd = process.cwd();
    
    // Check if we're in a worktree
    for (const [sessionId, session] of Object.entries(this.sessions)) {
      if (session.worktree.path === cwd || cwd.startsWith(session.worktree.path + '/')) {
        return session;
      }
    }
    
    // Check for session file in current directory
    const sessionFilePath = path.join(cwd, '.claude-session.json');
    if (fs.existsSync(sessionFilePath)) {
      const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
      return sessionData;
    }
    
    return null;
  }

  /**
   * List all active sessions
   */
  listSessions() {
    console.log(`\n${CONFIG.colors.bright}Active Claude Sessions:${CONFIG.colors.reset}`);
    
    const activeSessions = Object.values(this.sessions).filter(s => s.status === 'active');
    
    if (activeSessions.length === 0) {
      console.log('No active sessions');
      return;
    }
    
    for (const session of activeSessions) {
      const exists = fs.existsSync(session.worktree.path);
      const status = exists ? CONFIG.colors.green + '✓' : CONFIG.colors.red + '✗';
      
      console.log(`\n${status} ${CONFIG.colors.bright}${session.id}${CONFIG.colors.reset}`);
      console.log(`  Task: ${session.task}`);
      console.log(`  Branch: ${session.worktree.branch}`);
      console.log(`  Path: ${session.worktree.path}`);
      console.log(`  Created: ${new Date(session.created).toLocaleString()}`);
      
      if (!exists) {
        console.log(`  ${CONFIG.colors.yellow}(Worktree missing)${CONFIG.colors.reset}`);
      }
    }
    
    console.log(`\nTotal active sessions: ${activeSessions.length}`);
  }

  /**
   * End a session and optionally clean up
   */
  endSession(sessionId, options = {}) {
    const session = this.sessions[sessionId];
    
    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      return;
    }
    
    console.log(`${CONFIG.colors.yellow}Ending session: ${sessionId}${CONFIG.colors.reset}`);
    
    // Mark as inactive
    session.status = 'inactive';
    session.ended = new Date().toISOString();
    
    if (options.cleanup) {
      // Remove worktree
      if (fs.existsSync(session.worktree.path)) {
        console.log(`Removing worktree: ${session.worktree.path}`);
        try {
          execSync(`git worktree remove "${session.worktree.path}" --force`, { stdio: 'inherit' });
        } catch (error) {
          console.error(`Failed to remove worktree: ${error.message}`);
        }
      }
      
      // Delete branch if requested
      if (options.deleteBranch) {
        console.log(`Deleting branch: ${session.worktree.branch}`);
        try {
          execSync(`git branch -D ${session.worktree.branch}`, { stdio: 'inherit' });
        } catch (error) {
          console.error(`Failed to delete branch: ${error.message}`);
        }
      }
      
      // Remove from sessions
      delete this.sessions[sessionId];
    }
    
    this.saveSessions();
    console.log(`${CONFIG.colors.green}Session ended${CONFIG.colors.reset}`);
  }

  /**
   * Start the DevOps agent for a specific session
   */
  startAgent(sessionId) {
    const session = this.sessions[sessionId];
    
    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      return;
    }
    
    console.log(`${CONFIG.colors.blue}Starting DevOps agent for session: ${sessionId}${CONFIG.colors.reset}`);
    
    // Build environment variables
    const env = Object.entries(session.agentConfig)
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ');
    
    // Command to start the agent
    const agentScript = path.join(__dirname, 'cs-devops-agent-worker.js');
    const command = `cd "${session.worktree.path}" && ${env} node "${agentScript}"`;
    
    console.log(`\nRun this command to start the agent:`);
    console.log(`${CONFIG.colors.blue}${command}${CONFIG.colors.reset}`);
    
    return command;
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function showHelp() {
  console.log(`
${CONFIG.colors.bright}Claude Session Manager${CONFIG.colors.reset}

Usage:
  node claude-session-manager.js <command> [options]

Commands:
  start --task <name>      Start a new Claude session with a task
  current                  Show current session info
  list                     List all active sessions
  end --session <id>       End a session
  agent --session <id>     Get command to start agent for session
  help                     Show this help message

Options:
  --task <name>           Task or feature name
  --session <id>          Session ID
  --cleanup               Remove worktree when ending session
  --delete-branch         Delete branch when ending session

Examples:
  # Start a new session for authentication feature
  node claude-session-manager.js start --task "authentication-feature"
  
  # List all active sessions
  node claude-session-manager.js list
  
  # End a session and clean up
  node claude-session-manager.js end --session abc123 --cleanup --delete-branch
  
  # Get current session info (run from within a worktree)
  node claude-session-manager.js current
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === 'help') {
    showHelp();
    return;
  }
  
  const manager = new ClaudeSessionManager();
  
  switch (command) {
    case 'start': {
      const taskIdx = args.indexOf('--task');
      if (taskIdx === -1 || !args[taskIdx + 1]) {
        console.error('Error: --task is required for start command');
        process.exit(1);
      }
      const task = args[taskIdx + 1];
      manager.startSession(task);
      break;
    }
    
    case 'current': {
      const session = manager.getCurrentSession();
      if (session) {
        console.log(`${CONFIG.colors.bright}Current Session:${CONFIG.colors.reset}`);
        console.log(JSON.stringify(session, null, 2));
      } else {
        console.log('Not in a Claude session worktree');
      }
      break;
    }
    
    case 'list': {
      manager.listSessions();
      break;
    }
    
    case 'end': {
      const sessionIdx = args.indexOf('--session');
      if (sessionIdx === -1 || !args[sessionIdx + 1]) {
        console.error('Error: --session is required for end command');
        process.exit(1);
      }
      const sessionId = args[sessionIdx + 1];
      const cleanup = args.includes('--cleanup');
      const deleteBranch = args.includes('--delete-branch');
      manager.endSession(sessionId, { cleanup, deleteBranch });
      break;
    }
    
    case 'agent': {
      const sessionIdx = args.indexOf('--session');
      if (sessionIdx === -1 || !args[sessionIdx + 1]) {
        console.error('Error: --session is required for agent command');
        process.exit(1);
      }
      const sessionId = args[sessionIdx + 1];
      manager.startAgent(sessionId);
      break;
    }
    
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Run the CLI
main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});