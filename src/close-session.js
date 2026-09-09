#!/usr/bin/env node

/**
 * Session Cleanup Tool
 * Safely closes and cleans up DevOps agent sessions
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// Configuration
const CONFIG = {
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m'
  }
};

class SessionCloser {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.locksPath = path.join(this.repoRoot, 'local_deploy', 'session-locks');
    this.worktreesPath = path.join(this.repoRoot, 'local_deploy', 'worktrees');
  }

  getRepoRoot() {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error(`${CONFIG.colors.red}Error: Not in a git repository${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }

  /**
   * List all active sessions
   */
  listSessions() {
    if (!fs.existsSync(this.locksPath)) {
      console.log(`${CONFIG.colors.yellow}No active sessions found${CONFIG.colors.reset}`);
      return [];
    }

    const sessions = [];
    const lockFiles = fs.readdirSync(this.locksPath).filter(f => f.endsWith('.lock'));

    lockFiles.forEach(file => {
      const lockPath = path.join(this.locksPath, file);
      const sessionData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      sessions.push(sessionData);
    });

    return sessions;
  }

  /**
   * Display sessions for selection
   */
  async selectSession() {
    const sessions = this.listSessions();
    
    if (sessions.length === 0) {
      console.log(`${CONFIG.colors.yellow}No active sessions to close${CONFIG.colors.reset}`);
      return null;
    }

    console.log(`\n${CONFIG.colors.bright}Active Sessions:${CONFIG.colors.reset}\n`);
    
    sessions.forEach((session, index) => {
      const status = session.status === 'active' ? 
        `${CONFIG.colors.green}●${CONFIG.colors.reset}` : 
        `${CONFIG.colors.yellow}○${CONFIG.colors.reset}`;
      
      console.log(`${status} ${CONFIG.colors.bright}${index + 1})${CONFIG.colors.reset} ${session.sessionId}`);
      console.log(`   Task: ${session.task}`);
      console.log(`   Branch: ${session.branchName}`);
      console.log(`   Created: ${session.created}`);
      console.log();
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(`Select session to close (1-${sessions.length}) or 'q' to quit: `, (answer) => {
        rl.close();
        
        if (answer.toLowerCase() === 'q') {
          resolve(null);
        } else {
          const index = parseInt(answer) - 1;
          if (index >= 0 && index < sessions.length) {
            resolve(sessions[index]);
          } else {
            console.log(`${CONFIG.colors.red}Invalid selection${CONFIG.colors.reset}`);
            resolve(null);
          }
        }
      });
    });
  }

  /**
   * Close a session with all cleanup
   */
  async closeSession(session) {
    console.log(`\n${CONFIG.colors.yellow}Closing session: ${session.sessionId}${CONFIG.colors.reset}`);
    
    const steps = [
      { name: 'Kill agent process', fn: () => this.killAgent(session) },
      { name: 'Check for uncommitted changes', fn: () => this.checkUncommittedChanges(session) },
      { name: 'Push final changes', fn: () => this.pushChanges(session) },
      { name: 'Remove worktree', fn: () => this.removeWorktree(session) },
      { name: 'Delete local branch', fn: () => this.deleteLocalBranch(session) },
      { name: 'Clean up lock file', fn: () => this.removeLockFile(session) }
    ];

    let allSuccess = true;

    for (const step of steps) {
      process.stdout.write(`${step.name}... `);
      try {
        const result = await step.fn();
        if (result !== false) {
          console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset}`);
        }
      } catch (error) {
        console.log(`${CONFIG.colors.red}✗ ${error.message}${CONFIG.colors.reset}`);
        allSuccess = false;
      }
    }

    // Ask about remote branch
    const deleteRemote = await this.askDeleteRemote(session);
    if (deleteRemote) {
      process.stdout.write('Delete remote branch... ');
      try {
        this.deleteRemoteBranch(session);
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset}`);
      } catch (error) {
        console.log(`${CONFIG.colors.yellow}⚠ ${error.message}${CONFIG.colors.reset}`);
      }
    }

    if (allSuccess) {
      console.log(`\n${CONFIG.colors.green}✓ Session closed successfully!${CONFIG.colors.reset}`);
    } else {
      console.log(`\n${CONFIG.colors.yellow}⚠ Session closed with warnings${CONFIG.colors.reset}`);
    }
  }

  /**
   * Kill the agent process if running
   */
  killAgent(session) {
    if (session.agentPid) {
      try {
        process.kill(session.agentPid, 'SIGTERM');
        return true;
      } catch (error) {
        // Process might already be dead
        return true;
      }
    }
    return true;
  }

  /**
   * Check for uncommitted changes
   */
  checkUncommittedChanges(session) {
    try {
      const status = execSync(`git -C "${session.worktreePath}" status --porcelain`, { encoding: 'utf8' });
      if (status.trim()) {
        console.log(`\n${CONFIG.colors.yellow}Warning: Uncommitted changes in worktree:${CONFIG.colors.reset}`);
        console.log(status);
        
        // Optionally commit them
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        return new Promise((resolve) => {
          rl.question('Commit these changes? (y/n): ', (answer) => {
            rl.close();
            if (answer.toLowerCase() === 'y') {
              execSync(`git -C "${session.worktreePath}" add -A`, { stdio: 'pipe' });
              execSync(`git -C "${session.worktreePath}" commit -m "chore: final session cleanup"`, { stdio: 'pipe' });
            }
            resolve(true);
          });
        });
      }
    } catch (error) {
      // Worktree might not exist
    }
    return true;
  }

  /**
   * Push any final changes
   */
  pushChanges(session) {
    try {
      // Check if there are unpushed commits
      const unpushed = execSync(
        `git -C "${session.worktreePath}" log origin/${session.branchName}..HEAD --oneline 2>/dev/null`, 
        { encoding: 'utf8' }
      ).trim();
      
      if (unpushed) {
        execSync(`git -C "${session.worktreePath}" push origin ${session.branchName}`, { stdio: 'pipe' });
      }
    } catch (error) {
      // Branch might not exist on remote or worktree might be gone
    }
    return true;
  }

  /**
   * Remove the worktree
   */
  removeWorktree(session) {
    try {
      execSync(`git worktree remove "${session.worktreePath}" --force`, { stdio: 'pipe' });
      execSync('git worktree prune', { stdio: 'pipe' });
    } catch (error) {
      // Worktree might already be removed
    }
    return true;
  }

  /**
   * Delete local branch
   */
  deleteLocalBranch(session) {
    try {
      execSync(`git branch -D ${session.branchName}`, { stdio: 'pipe' });
    } catch (error) {
      // Branch might not exist locally
    }
    return true;
  }

  /**
   * Remove lock file
   */
  removeLockFile(session) {
    const lockFile = path.join(this.locksPath, `${session.sessionId}.lock`);
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
    return true;
  }

  /**
   * Ask if remote branch should be deleted
   */
  askDeleteRemote(session) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question(`\nDelete remote branch ${session.branchName}? (y/n): `, (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });
  }

  /**
   * Delete remote branch
   */
  deleteRemoteBranch(session) {
    execSync(`git push origin --delete ${session.branchName}`, { stdio: 'pipe' });
    return true;
  }

  /**
   * Main execution
   */
  async run() {
    console.log(`${CONFIG.colors.bright}\n🔧 DevOps Session Cleanup Tool${CONFIG.colors.reset}`);
    
    const session = await this.selectSession();
    if (session) {
      await this.closeSession(session);
    } else {
      console.log(`\n${CONFIG.colors.dim}No session selected${CONFIG.colors.reset}`);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const closer = new SessionCloser();
  closer.run().catch(error => {
    console.error(`${CONFIG.colors.red}Error: ${error.message}${CONFIG.colors.reset}`);
    process.exit(1);
  });
}

module.exports = SessionCloser;