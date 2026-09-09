#!/usr/bin/env node

/**
 * Enhanced Session Cleanup Tool with Dual Merge Support
 * Safely closes and cleans up DevOps agent sessions with hierarchical and target branch merging
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

class EnhancedSessionCloser {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.locksPath = path.join(this.repoRoot, 'local_deploy', 'session-locks');
    this.worktreesPath = path.join(this.repoRoot, 'local_deploy', 'worktrees');
    this.projectSettingsPath = path.join(this.repoRoot, 'local_deploy', 'project-settings.json');
    this.projectSettings = this.loadProjectSettings();
  }

  getRepoRoot() {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error(`${CONFIG.colors.red}Error: Not in a git repository${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }

  loadProjectSettings() {
    try {
      if (fs.existsSync(this.projectSettingsPath)) {
        return JSON.parse(fs.readFileSync(this.projectSettingsPath, 'utf8'));
      }
    } catch (error) {
      console.warn(`${CONFIG.colors.yellow}Warning: Could not load project settings${CONFIG.colors.reset}`);
    }
    return {};
  }

  /**
   * Get current daily branch name
   */
  getDailyBranch() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return `daily/${today}`;
  }

  /**
   * Check if a branch exists
   */
  async branchExists(branchName) {
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a branch if it doesn't exist
   */
  async ensureBranch(branchName, baseBranch = 'main') {
    if (await this.branchExists(branchName)) {
      return true;
    }

    try {
      console.log(`${CONFIG.colors.blue}Creating branch: ${branchName} from ${baseBranch}${CONFIG.colors.reset}`);
      execSync(`git checkout -b ${branchName} ${baseBranch}`, { stdio: 'ignore' });
      execSync(`git push -u origin ${branchName}`, { stdio: 'ignore' });
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}Failed to create branch ${branchName}: ${error.message}${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Merge one branch into another
   */
  async mergeBranch(sourceBranch, targetBranch) {
    try {
      console.log(`${CONFIG.colors.blue}Merging ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      
      // Ensure target branch exists
      await this.ensureBranch(targetBranch);
      
      // Checkout target branch
      execSync(`git checkout ${targetBranch}`, { stdio: 'ignore' });
      
      // Attempt merge
      execSync(`git merge --no-ff ${sourceBranch} -m "Merge session branch ${sourceBranch}"`, { stdio: 'ignore' });
      
      // Push the merge
      execSync(`git push origin ${targetBranch}`, { stdio: 'ignore' });
      
      console.log(`${CONFIG.colors.green}✓ Successfully merged ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}✗ Failed to merge ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      console.error(`${CONFIG.colors.dim}Error: ${error.message}${CONFIG.colors.reset}`);
      
      // Reset any partial merge state
      try {
        execSync('git merge --abort', { stdio: 'ignore' });
      } catch {}
      
      return false;
    }
  }

  /**
   * Perform dual merge: session → daily AND session → target
   */
  async performDualMerge(sessionData) {
    const sessionBranch = sessionData.branchName;
    const dailyBranch = this.getDailyBranch();
    const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget || 'main';
    const mergeStrategy = this.projectSettings?.branchManagement?.mergeStrategy || 'hierarchical-first';

    console.log(`\n${CONFIG.colors.bright}Performing dual merge with strategy: ${mergeStrategy}${CONFIG.colors.reset}`);
    console.log(`Session: ${sessionBranch}`);
    console.log(`Daily: ${dailyBranch}`);
    console.log(`Target: ${targetBranch}\n`);

    let dailySuccess = false;
    let targetSuccess = false;

    try {
      if (mergeStrategy === 'hierarchical-first') {
        // Merge to daily first, then to target
        dailySuccess = await this.mergeBranch(sessionBranch, dailyBranch);
        if (dailySuccess) {
          targetSuccess = await this.mergeBranch(sessionBranch, targetBranch);
        }
      } else if (mergeStrategy === 'target-first') {
        // Merge to target first, then to daily
        targetSuccess = await this.mergeBranch(sessionBranch, targetBranch);
        if (targetSuccess) {
          dailySuccess = await this.mergeBranch(sessionBranch, dailyBranch);
        }
      } else {
        // Parallel merge (both at once)
        dailySuccess = await this.mergeBranch(sessionBranch, dailyBranch);
        targetSuccess = await this.mergeBranch(sessionBranch, targetBranch);
      }

      // Report results
      if (dailySuccess && targetSuccess) {
        console.log(`${CONFIG.colors.green}✅ Dual merge completed successfully${CONFIG.colors.reset}`);
        return true;
      } else if (dailySuccess || targetSuccess) {
        console.log(`${CONFIG.colors.yellow}⚠️  Partial merge completed:${CONFIG.colors.reset}`);
        console.log(`   Daily merge: ${dailySuccess ? '✓' : '✗'}`);
        console.log(`   Target merge: ${targetSuccess ? '✓' : '✗'}`);
        return true; // Partial success is still success
      } else {
        console.log(`${CONFIG.colors.red}❌ Both merges failed${CONFIG.colors.reset}`);
        return false;
      }
    } catch (error) {
      console.error(`${CONFIG.colors.red}❌ Dual merge failed: ${error.message}${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Perform single merge to configured target or daily branch
   */
  async performSingleMerge(sessionData) {
    const sessionBranch = sessionData.branchName;
    const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget || this.getDailyBranch();

    console.log(`\n${CONFIG.colors.bright}Performing single merge${CONFIG.colors.reset}`);
    console.log(`Session: ${sessionBranch} → ${targetBranch}\n`);

    return await this.mergeBranch(sessionBranch, targetBranch);
  }

  /**
   * Clean up session files and worktree
   */
  async cleanupSessionFiles(sessionData) {
    const sessionId = sessionData.sessionId;
    const branchName = sessionData.branchName;
    const worktreePath = sessionData.worktreePath;

    try {
      // Remove worktree if it exists
      if (worktreePath && fs.existsSync(worktreePath)) {
        console.log(`${CONFIG.colors.blue}Removing worktree: ${worktreePath}${CONFIG.colors.reset}`);
        execSync(`git worktree remove --force "${worktreePath}"`, { stdio: 'ignore' });
      }

      // Delete session branch
      if (branchName && await this.branchExists(branchName)) {
        console.log(`${CONFIG.colors.blue}Deleting session branch: ${branchName}${CONFIG.colors.reset}`);
        execSync(`git branch -D ${branchName}`, { stdio: 'ignore' });
        
        // Also delete remote branch if it exists
        try {
          execSync(`git push origin --delete ${branchName}`, { stdio: 'ignore' });
        } catch {
          // Remote branch might not exist, ignore
        }
      }

      // Remove session lock file
      const lockFile = path.join(this.locksPath, `${sessionId}.lock`);
      if (fs.existsSync(lockFile)) {
        console.log(`${CONFIG.colors.blue}Removing session lock file${CONFIG.colors.reset}`);
        fs.unlinkSync(lockFile);
      }

      // Remove any commit message files
      const commitMsgFile = path.join(this.repoRoot, `.devops-commit-${sessionId}.msg`);
      if (fs.existsSync(commitMsgFile)) {
        fs.unlinkSync(commitMsgFile);
      }

      console.log(`${CONFIG.colors.green}✓ Session cleanup completed${CONFIG.colors.reset}`);
    } catch (error) {
      console.error(`${CONFIG.colors.red}✗ Session cleanup failed: ${error.message}${CONFIG.colors.reset}`);
      throw error;
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
   * Prompt for close action
   */
  async promptForCloseAction() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      console.log('\nWhat would you like to do with this session?');
      console.log(`  ${CONFIG.colors.green}(m) Merge changes and cleanup${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.yellow}(k) Keep session active, just cleanup worktree${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.red}(d) Delete session and all changes${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.dim}(c) Cancel${CONFIG.colors.reset}`);
      
      rl.question('\nChoose action (m/k/d/c): ', (answer) => {
        rl.close();
        const action = answer.toLowerCase();
        if (['m', 'k', 'd', 'c'].includes(action)) {
          resolve(action);
        } else {
          console.log('Invalid choice, defaulting to cancel');
          resolve('c');
        }
      });
    });
  }

  /**
   * Close a session with the specified action
   */
  async closeSession(sessionData) {
    console.log(`\n${CONFIG.colors.bright}Closing session: ${sessionData.sessionId}${CONFIG.colors.reset}`);
    console.log(`Task: ${sessionData.task}`);
    console.log(`Branch: ${sessionData.branchName}`);

    const action = await this.promptForCloseAction();
    
    switch (action) {
      case 'm':
        await this.mergeAndCleanup(sessionData);
        break;
      case 'k':
        await this.keepSessionCleanupWorktree(sessionData);
        break;
      case 'd':
        await this.deleteSession(sessionData);
        break;
      case 'c':
        console.log('Session close cancelled');
        return;
    }
  }

  /**
   * Merge session and cleanup
   */
  async mergeAndCleanup(sessionData) {
    console.log(`\n${CONFIG.colors.bright}Merging and cleaning up session...${CONFIG.colors.reset}`);

    try {
      const enableDualMerge = this.projectSettings?.branchManagement?.enableDualMerge;
      const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget;

      let mergeSuccess = false;

      if (enableDualMerge && targetBranch) {
        console.log(`${CONFIG.colors.blue}Dual merge enabled${CONFIG.colors.reset}`);
        mergeSuccess = await this.performDualMerge(sessionData);
      } else {
        console.log(`${CONFIG.colors.blue}Single merge mode${CONFIG.colors.reset}`);
        mergeSuccess = await this.performSingleMerge(sessionData);
      }

      if (mergeSuccess) {
        await this.cleanupSessionFiles(sessionData);
        console.log(`\n${CONFIG.colors.green}✅ Session successfully merged and cleaned up${CONFIG.colors.reset}`);
      } else {
        console.log(`\n${CONFIG.colors.red}❌ Merge failed. Session preserved for manual resolution.${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}You can manually resolve conflicts and try again later.${CONFIG.colors.reset}`);
      }
    } catch (error) {
      console.error(`\n${CONFIG.colors.red}❌ Error during merge and cleanup: ${error.message}${CONFIG.colors.reset}`);
    }
  }

  /**
   * Keep session active but cleanup worktree
   */
  async keepSessionCleanupWorktree(sessionData) {
    console.log(`\n${CONFIG.colors.bright}Keeping session active, cleaning up worktree...${CONFIG.colors.reset}`);

    try {
      // Only remove worktree, keep branch and session
      if (sessionData.worktreePath && fs.existsSync(sessionData.worktreePath)) {
        console.log(`${CONFIG.colors.blue}Removing worktree: ${sessionData.worktreePath}${CONFIG.colors.reset}`);
        execSync(`git worktree remove --force "${sessionData.worktreePath}"`, { stdio: 'ignore' });
      }

      // Update session status
      const lockFile = path.join(this.locksPath, `${sessionData.sessionId}.lock`);
      if (fs.existsSync(lockFile)) {
        sessionData.status = 'inactive';
        sessionData.worktreePath = null;
        sessionData.inactiveAt = new Date().toISOString();
        fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
      }

      console.log(`\n${CONFIG.colors.green}✅ Session marked as inactive, worktree cleaned up${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}Session branch ${sessionData.branchName} is preserved${CONFIG.colors.reset}`);
    } catch (error) {
      console.error(`\n${CONFIG.colors.red}❌ Error during worktree cleanup: ${error.message}${CONFIG.colors.reset}`);
    }
  }

  /**
   * Delete session completely
   */
  async deleteSession(sessionData) {
    console.log(`\n${CONFIG.colors.bright}Deleting session completely...${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.red}⚠️  This will permanently delete all work in this session!${CONFIG.colors.reset}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const confirmed = await new Promise((resolve) => {
      rl.question('Are you sure? Type "DELETE" to confirm: ', (answer) => {
        rl.close();
        resolve(answer === 'DELETE');
      });
    });

    if (!confirmed) {
      console.log('Deletion cancelled');
      return;
    }

    try {
      await this.cleanupSessionFiles(sessionData);
      console.log(`\n${CONFIG.colors.green}✅ Session completely deleted${CONFIG.colors.reset}`);
    } catch (error) {
      console.error(`\n${CONFIG.colors.red}❌ Error during session deletion: ${error.message}${CONFIG.colors.reset}`);
    }
  }

  /**
   * Main execution function
   */
  async run() {
    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}DevOps Agent - Enhanced Session Closer${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Repository: ${this.repoRoot}${CONFIG.colors.reset}\n`);

    // Show current configuration
    const enableDualMerge = this.projectSettings?.branchManagement?.enableDualMerge;
    const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget;
    
    console.log(`${CONFIG.colors.bright}Current Configuration:${CONFIG.colors.reset}`);
    console.log(`  Dual merge: ${enableDualMerge ? CONFIG.colors.green + 'enabled' : CONFIG.colors.yellow + 'disabled'}${CONFIG.colors.reset}`);
    console.log(`  Target branch: ${targetBranch || CONFIG.colors.dim + 'not set'}${CONFIG.colors.reset}`);
    console.log(`  Daily branch: ${this.getDailyBranch()}`);

    const sessionData = await this.selectSession();
    if (sessionData) {
      await this.closeSession(sessionData);
    }
  }
}

// CLI execution
if (require.main === module) {
  const closer = new EnhancedSessionCloser();
  closer.run().catch(console.error);
}

module.exports = EnhancedSessionCloser;
