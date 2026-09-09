#!/usr/bin/env node

/**
 * Orphaned Session Cleaner
 * Detects and cleans up sessions that have been inactive for a specified period
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

class OrphanedSessionCleaner {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.locksPath = path.join(this.repoRoot, 'local_deploy', 'session-locks');
    this.worktreesPath = path.join(this.repoRoot, 'local_deploy', 'worktrees');
    this.projectSettingsPath = path.join(this.repoRoot, 'local_deploy', 'project-settings.json');
    this.projectSettings = this.loadProjectSettings();
    this.thresholdDays = this.projectSettings?.branchManagement?.orphanSessionThresholdDays || 7;
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
   * Get the last commit date for a branch
   */
  async getLastCommitDate(branchName) {
    try {
      const timestamp = execSync(`git log -1 --format="%ct" origin/${branchName}`, { encoding: 'utf8' }).trim();
      return new Date(parseInt(timestamp) * 1000);
    } catch (error) {
      // Branch might not exist or have no commits
      throw new Error(`Cannot get last commit date for branch ${branchName}`);
    }
  }

  /**
   * Check if a branch exists locally or remotely
   */
  async branchExists(branchName) {
    try {
      // Check remote first (more reliable)
      execSync(`git show-ref --verify --quiet refs/remotes/origin/${branchName}`, { stdio: 'ignore' });
      return true;
    } catch {
      try {
        // Check local
        execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get current daily branch name
   */
  getDailyBranch() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return `daily/${today}`;
  }

  /**
   * Find all orphaned sessions
   */
  async findOrphanedSessions() {
    if (!fs.existsSync(this.locksPath)) {
      return [];
    }

    console.log(`${CONFIG.colors.blue}Scanning for orphaned sessions (threshold: ${this.thresholdDays} days)...${CONFIG.colors.reset}`);

    const orphans = [];
    const lockFiles = fs.readdirSync(this.locksPath).filter(f => f.endsWith('.lock'));
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - this.thresholdDays);

    // Fetch latest remote information
    try {
      execSync('git fetch --all --prune', { stdio: 'ignore' });
    } catch (error) {
      console.warn(`${CONFIG.colors.yellow}Warning: Could not fetch remote branches${CONFIG.colors.reset}`);
    }

    for (const lockFile of lockFiles) {
      const lockPath = path.join(this.locksPath, lockFile);
      
      try {
        const sessionData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const sessionId = sessionData.sessionId;
        const branchName = sessionData.branchName;
        
        console.log(`${CONFIG.colors.dim}Checking session: ${sessionId} (${branchName})${CONFIG.colors.reset}`);
        
        let lastActivity = null;
        let daysSinceLastActivity = 0;
        let branchMissing = false;
        let reason = '';

        try {
          if (await this.branchExists(branchName)) {
            // Branch exists, check last commit date
            lastActivity = await this.getLastCommitDate(branchName);
            daysSinceLastActivity = Math.floor((new Date() - lastActivity) / (1000 * 60 * 60 * 24));
            
            if (lastActivity < thresholdDate) {
              reason = `No commits for ${daysSinceLastActivity} days`;
            }
          } else {
            // Branch doesn't exist, use session creation date
            branchMissing = true;
            lastActivity = new Date(sessionData.created);
            daysSinceLastActivity = Math.floor((new Date() - lastActivity) / (1000 * 60 * 60 * 24));
            reason = `Branch missing, created ${daysSinceLastActivity} days ago`;
          }
        } catch (error) {
          // Error getting branch info, consider it orphaned
          branchMissing = true;
          lastActivity = new Date(sessionData.created);
          daysSinceLastActivity = Math.floor((new Date() - lastActivity) / (1000 * 60 * 60 * 24));
          reason = `Branch error: ${error.message}`;
        }

        // Check if session should be considered orphaned
        if (daysSinceLastActivity >= this.thresholdDays) {
          orphans.push({
            ...sessionData,
            lastActivity,
            daysSinceLastActivity,
            branchMissing,
            reason,
            lockFile: lockPath
          });
        }
      } catch (error) {
        console.error(`${CONFIG.colors.red}Error processing session lock ${lockFile}: ${error.message}${CONFIG.colors.reset}`);
      }
    }

    return orphans;
  }

  /**
   * Display orphaned sessions and prompt for cleanup
   */
  async promptForOrphanCleanup(orphans) {
    console.log(`\n${CONFIG.colors.bright}🧹 Found ${orphans.length} orphaned session(s):${CONFIG.colors.reset}\n`);
    
    orphans.forEach((orphan, index) => {
      const statusIcon = orphan.branchMissing ? '❌' : '⏰';
      console.log(`${statusIcon} ${CONFIG.colors.bright}${index + 1}. ${orphan.sessionId}${CONFIG.colors.reset}`);
      console.log(`   Task: ${orphan.task}`);
      console.log(`   Agent: ${orphan.agentType || 'unknown'}`);
      console.log(`   Branch: ${orphan.branchName}${orphan.branchMissing ? ' (missing)' : ''}`);
      console.log(`   Inactive: ${orphan.daysSinceLastActivity} days`);
      console.log(`   Reason: ${orphan.reason}`);
      console.log(`   Created: ${orphan.created}`);
      if (orphan.lastActivity) {
        console.log(`   Last activity: ${orphan.lastActivity.toISOString().split('T')[0]}`);
      }
      console.log('');
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      console.log(`${CONFIG.colors.bright}Cleanup Options:${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.green}(a) Clean up all orphaned sessions${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.yellow}(s) Select specific sessions to clean up${CONFIG.colors.reset}`);
      console.log(`  ${CONFIG.colors.dim}(n) No cleanup, just report${CONFIG.colors.reset}`);
      
      rl.question('\nChoose action (a/s/n): ', (answer) => {
        rl.close();
        const action = answer.toLowerCase();
        if (['a', 's', 'n'].includes(action)) {
          resolve(action);
        } else {
          console.log('Invalid choice, defaulting to no cleanup');
          resolve('n');
        }
      });
    });
  }

  /**
   * Select specific sessions for cleanup
   */
  async selectSessionsForCleanup(orphans) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      console.log(`\n${CONFIG.colors.bright}Select sessions to clean up:${CONFIG.colors.reset}`);
      console.log('Enter session numbers separated by commas (e.g., 1,3,5) or "all" for all sessions:');
      
      rl.question('Selection: ', (answer) => {
        rl.close();
        
        if (answer.toLowerCase() === 'all') {
          resolve(orphans);
        } else {
          const indices = answer.split(',')
            .map(s => parseInt(s.trim()) - 1)
            .filter(i => i >= 0 && i < orphans.length);
          
          const selectedOrphans = indices.map(i => orphans[i]);
          resolve(selectedOrphans);
        }
      });
    });
  }

  /**
   * Merge branch using the same logic as enhanced-close-session.js
   */
  async mergeBranch(sourceBranch, targetBranch) {
    try {
      console.log(`${CONFIG.colors.blue}  Merging ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      
      // Ensure target branch exists
      await this.ensureBranch(targetBranch);
      
      // Checkout target branch
      execSync(`git checkout ${targetBranch}`, { stdio: 'ignore' });
      
      // Attempt merge
      execSync(`git merge --no-ff origin/${sourceBranch} -m "Merge orphaned session branch ${sourceBranch}"`, { stdio: 'ignore' });
      
      // Push the merge
      execSync(`git push origin ${targetBranch}`, { stdio: 'ignore' });
      
      console.log(`${CONFIG.colors.green}  ✓ Successfully merged ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}  ✗ Failed to merge ${sourceBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      console.error(`${CONFIG.colors.dim}  Error: ${error.message}${CONFIG.colors.reset}`);
      
      // Reset any partial merge state
      try {
        execSync('git merge --abort', { stdio: 'ignore' });
      } catch {}
      
      return false;
    }
  }

  /**
   * Ensure a branch exists
   */
  async ensureBranch(branchName, baseBranch = 'main') {
    if (await this.branchExists(branchName)) {
      return true;
    }

    try {
      console.log(`${CONFIG.colors.blue}  Creating branch: ${branchName} from ${baseBranch}${CONFIG.colors.reset}`);
      execSync(`git checkout -b ${branchName} origin/${baseBranch}`, { stdio: 'ignore' });
      execSync(`git push -u origin ${branchName}`, { stdio: 'ignore' });
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}  Failed to create branch ${branchName}: ${error.message}${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Perform dual merge for orphaned session
   */
  async performDualMerge(orphan) {
    const sessionBranch = orphan.branchName;
    const dailyBranch = this.getDailyBranch();
    const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget || 'main';
    const enableDualMerge = this.projectSettings?.branchManagement?.enableDualMerge;

    if (!enableDualMerge || !targetBranch) {
      // Single merge to daily branch
      return await this.mergeBranch(sessionBranch, dailyBranch);
    }

    console.log(`${CONFIG.colors.blue}  Performing dual merge...${CONFIG.colors.reset}`);
    
    const dailySuccess = await this.mergeBranch(sessionBranch, dailyBranch);
    const targetSuccess = await this.mergeBranch(sessionBranch, targetBranch);

    if (dailySuccess && targetSuccess) {
      console.log(`${CONFIG.colors.green}  ✓ Dual merge completed successfully${CONFIG.colors.reset}`);
      return true;
    } else if (dailySuccess || targetSuccess) {
      console.log(`${CONFIG.colors.yellow}  ⚠️  Partial merge completed${CONFIG.colors.reset}`);
      return true; // Partial success is still success
    } else {
      console.log(`${CONFIG.colors.red}  ❌ Both merges failed${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Clean up session files and worktree
   */
  async cleanupSessionFiles(orphan) {
    const sessionId = orphan.sessionId;
    const branchName = orphan.branchName;
    const worktreePath = orphan.worktreePath;

    try {
      // Remove worktree if it exists
      if (worktreePath && fs.existsSync(worktreePath)) {
        console.log(`${CONFIG.colors.blue}  Removing worktree: ${worktreePath}${CONFIG.colors.reset}`);
        execSync(`git worktree remove --force "${worktreePath}"`, { stdio: 'ignore' });
      }

      // Delete session branch (only if it exists and was successfully merged)
      if (!orphan.branchMissing && await this.branchExists(branchName)) {
        console.log(`${CONFIG.colors.blue}  Deleting session branch: ${branchName}${CONFIG.colors.reset}`);
        
        // Delete local branch
        try {
          execSync(`git branch -D ${branchName}`, { stdio: 'ignore' });
        } catch {}
        
        // Delete remote branch
        try {
          execSync(`git push origin --delete ${branchName}`, { stdio: 'ignore' });
        } catch {}
      }

      // Remove session lock file
      if (fs.existsSync(orphan.lockFile)) {
        console.log(`${CONFIG.colors.blue}  Removing session lock file${CONFIG.colors.reset}`);
        fs.unlinkSync(orphan.lockFile);
      }

      // Remove any commit message files
      const commitMsgFile = path.join(this.repoRoot, `.devops-commit-${sessionId}.msg`);
      if (fs.existsSync(commitMsgFile)) {
        fs.unlinkSync(commitMsgFile);
      }

      console.log(`${CONFIG.colors.green}  ✓ Session cleanup completed${CONFIG.colors.reset}`);
    } catch (error) {
      console.error(`${CONFIG.colors.red}  ✗ Session cleanup failed: ${error.message}${CONFIG.colors.reset}`);
      throw error;
    }
  }

  /**
   * Clean up a single orphaned session
   */
  async cleanupOrphanedSession(orphan) {
    console.log(`\n${CONFIG.colors.bright}Cleaning up session: ${orphan.sessionId}${CONFIG.colors.reset}`);
    console.log(`Task: ${orphan.task}`);
    console.log(`Branch: ${orphan.branchName}${orphan.branchMissing ? ' (missing)' : ''}`);
    console.log(`Inactive for: ${orphan.daysSinceLastActivity} days`);

    try {
      // Only attempt merge if branch exists and has content
      if (!orphan.branchMissing) {
        console.log(`${CONFIG.colors.blue}Attempting to merge session work...${CONFIG.colors.reset}`);
        const mergeSuccess = await this.performDualMerge(orphan);
        
        if (!mergeSuccess) {
          console.log(`${CONFIG.colors.yellow}⚠️  Merge failed, but continuing with cleanup${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Branch ${orphan.branchName} will be preserved for manual review${CONFIG.colors.reset}`);
          
          // Don't delete the branch if merge failed
          orphan.branchMissing = true;
        }
      } else {
        console.log(`${CONFIG.colors.yellow}Branch missing or inaccessible, skipping merge${CONFIG.colors.reset}`);
      }

      // Clean up session files
      await this.cleanupSessionFiles(orphan);
      
      console.log(`${CONFIG.colors.green}✅ Successfully cleaned up session: ${orphan.sessionId}${CONFIG.colors.reset}`);
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}❌ Failed to cleanup session ${orphan.sessionId}: ${error.message}${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Main cleanup process
   */
  async cleanupOrphans() {
    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Orphaned Session Cleanup${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Repository: ${this.repoRoot}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Threshold: ${this.thresholdDays} days${CONFIG.colors.reset}\n`);

    const orphans = await this.findOrphanedSessions();
    
    if (orphans.length === 0) {
      console.log(`${CONFIG.colors.green}✅ No orphaned sessions found${CONFIG.colors.reset}`);
      return;
    }

    const action = await this.promptForOrphanCleanup(orphans);
    
    if (action === 'n') {
      console.log('Orphan cleanup cancelled');
      return;
    }

    let sessionsToCleanup = orphans;
    if (action === 's') {
      sessionsToCleanup = await this.selectSessionsForCleanup(orphans);
      if (sessionsToCleanup.length === 0) {
        console.log('No sessions selected for cleanup');
        return;
      }
    }

    console.log(`\n${CONFIG.colors.bright}🧹 Cleaning up ${sessionsToCleanup.length} orphaned session(s)...${CONFIG.colors.reset}`);

    let successCount = 0;
    let failureCount = 0;

    for (const orphan of sessionsToCleanup) {
      const success = await this.cleanupOrphanedSession(orphan);
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    console.log(`\n${CONFIG.colors.bright}Cleanup Summary:${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.green}✅ Successfully cleaned: ${successCount}${CONFIG.colors.reset}`);
    if (failureCount > 0) {
      console.log(`${CONFIG.colors.red}❌ Failed to clean: ${failureCount}${CONFIG.colors.reset}`);
    }
    
    if (successCount > 0) {
      console.log(`\n${CONFIG.colors.green}✅ Orphan cleanup completed${CONFIG.colors.reset}`);
    }
  }

  /**
   * List orphaned sessions without cleanup
   */
  async listOrphans() {
    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Orphaned Session Report${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Repository: ${this.repoRoot}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Threshold: ${this.thresholdDays} days${CONFIG.colors.reset}\n`);

    const orphans = await this.findOrphanedSessions();
    
    if (orphans.length === 0) {
      console.log(`${CONFIG.colors.green}✅ No orphaned sessions found${CONFIG.colors.reset}`);
      return;
    }

    console.log(`${CONFIG.colors.bright}Found ${orphans.length} orphaned session(s):${CONFIG.colors.reset}\n`);
    
    orphans.forEach((orphan, index) => {
      const statusIcon = orphan.branchMissing ? '❌' : '⏰';
      console.log(`${statusIcon} ${CONFIG.colors.bright}${index + 1}. ${orphan.sessionId}${CONFIG.colors.reset}`);
      console.log(`   Task: ${orphan.task}`);
      console.log(`   Branch: ${orphan.branchName}${orphan.branchMissing ? ' (missing)' : ''}`);
      console.log(`   Inactive: ${orphan.daysSinceLastActivity} days`);
      console.log(`   Reason: ${orphan.reason}`);
      console.log('');
    });

    console.log(`${CONFIG.colors.dim}Run with 'cleanup' command to clean up these sessions${CONFIG.colors.reset}`);
  }

  /**
   * Main execution function
   */
  async run(command = 'cleanup') {
    try {
      switch (command) {
        case 'cleanup':
          await this.cleanupOrphans();
          break;
        case 'list':
          await this.listOrphans();
          break;
        default:
          console.log(`${CONFIG.colors.red}Unknown command: ${command}${CONFIG.colors.reset}`);
          console.log('Available commands: cleanup, list');
      }
    } catch (error) {
      console.error(`${CONFIG.colors.red}❌ Operation failed: ${error.message}${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }
}

// CLI execution
if (require.main === module) {
  const command = process.argv[2] || 'cleanup';
  const cleaner = new OrphanedSessionCleaner();
  cleaner.run(command);
}

module.exports = OrphanedSessionCleaner;
