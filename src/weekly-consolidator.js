#!/usr/bin/env node

/**
 * Weekly Branch Consolidator
 * Automatically consolidates daily branches into weekly branches to prevent branch proliferation
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

class WeeklyConsolidator {
  constructor() {
    this.repoRoot = this.getRepoRoot();
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
   * Get all branches from remote
   */
  getAllBranches() {
    try {
      const output = execSync('git branch -r --format="%(refname:short)"', { encoding: 'utf8' });
      return output.split('\n')
        .filter(branch => branch.trim())
        .map(branch => branch.replace('origin/', '').trim())
        .filter(branch => !branch.includes('HEAD'));
    } catch (error) {
      console.error(`${CONFIG.colors.red}Error getting branches: ${error.message}${CONFIG.colors.reset}`);
      return [];
    }
  }

  /**
   * Get daily branches from the past week
   */
  getLastWeekDailyBranches() {
    const allBranches = this.getAllBranches();
    const dailyBranches = allBranches.filter(branch => branch.startsWith('daily/'));
    
    // Calculate date range for last week (Monday to Sunday)
    const now = new Date();
    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - now.getDay()); // Last Sunday
    lastSunday.setHours(0, 0, 0, 0);
    
    const weekAgo = new Date(lastSunday);
    weekAgo.setDate(lastSunday.getDate() - 7); // Previous Sunday
    
    console.log(`${CONFIG.colors.dim}Looking for daily branches between ${weekAgo.toISOString().split('T')[0]} and ${lastSunday.toISOString().split('T')[0]}${CONFIG.colors.reset}`);
    
    const lastWeekBranches = dailyBranches.filter(branch => {
      const dateStr = branch.replace('daily/', '');
      const branchDate = new Date(dateStr + 'T00:00:00Z');
      return branchDate >= weekAgo && branchDate < lastSunday;
    }).sort();
    
    return lastWeekBranches;
  }

  /**
   * Generate weekly branch name from daily branches
   */
  generateWeeklyBranchName(dailyBranches) {
    if (dailyBranches.length === 0) {
      return null;
    }
    
    const firstDate = dailyBranches[0].replace('daily/', '');
    const lastDate = dailyBranches[dailyBranches.length - 1].replace('daily/', '');
    
    return `weekly/${firstDate}_to_${lastDate}`;
  }

  /**
   * Check if a branch exists locally or remotely
   */
  async branchExists(branchName) {
    try {
      // Check local first
      execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, { stdio: 'ignore' });
      return true;
    } catch {
      try {
        // Check remote
        execSync(`git show-ref --verify --quiet refs/remotes/origin/${branchName}`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Create a new branch from a base branch
   */
  async createBranch(branchName, baseBranch) {
    try {
      console.log(`${CONFIG.colors.blue}Creating branch: ${branchName} from ${baseBranch}${CONFIG.colors.reset}`);
      
      // Fetch latest changes
      execSync('git fetch --all --prune', { stdio: 'ignore' });
      
      // Create and checkout new branch
      execSync(`git checkout -b ${branchName} origin/${baseBranch}`, { stdio: 'ignore' });
      
      // Push to remote
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
      
      // Checkout target branch
      execSync(`git checkout ${targetBranch}`, { stdio: 'ignore' });
      
      // Pull latest changes
      execSync(`git pull origin ${targetBranch}`, { stdio: 'ignore' });
      
      // Merge source branch
      const mergeMessage = `Merge daily branch ${sourceBranch} into weekly consolidation`;
      execSync(`git merge --no-ff origin/${sourceBranch} -m "${mergeMessage}"`, { stdio: 'ignore' });
      
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
   * Delete branches after successful consolidation
   */
  async cleanupDailyBranches(dailyBranches) {
    console.log(`\n${CONFIG.colors.bright}Cleaning up consolidated daily branches...${CONFIG.colors.reset}`);
    
    for (const branch of dailyBranches) {
      try {
        console.log(`${CONFIG.colors.blue}Deleting branch: ${branch}${CONFIG.colors.reset}`);
        
        // Delete local branch if it exists
        try {
          execSync(`git branch -D ${branch}`, { stdio: 'ignore' });
        } catch {}
        
        // Delete remote branch
        execSync(`git push origin --delete ${branch}`, { stdio: 'ignore' });
        
        console.log(`${CONFIG.colors.green}✓ Deleted ${branch}${CONFIG.colors.reset}`);
      } catch (error) {
        console.error(`${CONFIG.colors.red}✗ Failed to delete ${branch}: ${error.message}${CONFIG.colors.reset}`);
      }
    }
  }

  /**
   * Perform dual merge to target branch if enabled
   */
  async performDualMergeToTarget(weeklyBranch) {
    const enableDualMerge = this.projectSettings?.branchManagement?.enableDualMerge;
    const targetBranch = this.projectSettings?.branchManagement?.defaultMergeTarget;
    
    if (!enableDualMerge || !targetBranch) {
      console.log(`${CONFIG.colors.dim}Dual merge not enabled or target branch not configured${CONFIG.colors.reset}`);
      return true;
    }
    
    console.log(`\n${CONFIG.colors.bright}Performing dual merge to target branch...${CONFIG.colors.reset}`);
    
    try {
      const success = await this.mergeBranch(weeklyBranch, targetBranch);
      if (success) {
        console.log(`${CONFIG.colors.green}✓ Weekly branch merged to target: ${weeklyBranch} → ${targetBranch}${CONFIG.colors.reset}`);
      }
      return success;
    } catch (error) {
      console.error(`${CONFIG.colors.red}✗ Failed to merge weekly branch to target${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Main consolidation process
   */
  async consolidateWeeklyBranches() {
    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Weekly Branch Consolidation${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Repository: ${this.repoRoot}${CONFIG.colors.reset}\n`);
    
    // Check if weekly consolidation is enabled
    const enableWeeklyConsolidation = this.projectSettings?.branchManagement?.enableWeeklyConsolidation;
    if (enableWeeklyConsolidation === false) {
      console.log(`${CONFIG.colors.yellow}Weekly consolidation is disabled in project settings${CONFIG.colors.reset}`);
      return;
    }
    
    // Get daily branches from last week
    const lastWeekDailies = this.getLastWeekDailyBranches();
    
    if (lastWeekDailies.length === 0) {
      console.log(`${CONFIG.colors.yellow}No daily branches found for consolidation${CONFIG.colors.reset}`);
      return;
    }
    
    console.log(`${CONFIG.colors.bright}Found ${lastWeekDailies.length} daily branches to consolidate:${CONFIG.colors.reset}`);
    lastWeekDailies.forEach(branch => {
      console.log(`  • ${branch}`);
    });
    
    // Generate weekly branch name
    const weeklyBranchName = this.generateWeeklyBranchName(lastWeekDailies);
    console.log(`\n${CONFIG.colors.bright}Creating weekly branch: ${weeklyBranchName}${CONFIG.colors.reset}`);
    
    // Check if weekly branch already exists
    if (await this.branchExists(weeklyBranchName)) {
      console.log(`${CONFIG.colors.yellow}Weekly branch ${weeklyBranchName} already exists, skipping consolidation${CONFIG.colors.reset}`);
      return;
    }
    
    try {
      // Create weekly branch from first daily branch
      const success = await this.createBranch(weeklyBranchName, lastWeekDailies[0]);
      if (!success) {
        throw new Error('Failed to create weekly branch');
      }
      
      // Merge remaining daily branches into weekly branch
      let allMergesSuccessful = true;
      for (let i = 1; i < lastWeekDailies.length; i++) {
        const mergeSuccess = await this.mergeBranch(lastWeekDailies[i], weeklyBranchName);
        if (!mergeSuccess) {
          allMergesSuccessful = false;
          console.error(`${CONFIG.colors.red}Stopping consolidation due to merge failure${CONFIG.colors.reset}`);
          break;
        }
      }
      
      if (!allMergesSuccessful) {
        console.error(`${CONFIG.colors.red}❌ Weekly consolidation failed due to merge conflicts${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}Weekly branch ${weeklyBranchName} created but not all dailies were merged${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}Manual intervention required to resolve conflicts${CONFIG.colors.reset}`);
        return;
      }
      
      // Perform dual merge to target branch if enabled
      await this.performDualMergeToTarget(weeklyBranchName);
      
      // Clean up daily branches after successful consolidation
      await this.cleanupDailyBranches(lastWeekDailies);
      
      console.log(`\n${CONFIG.colors.green}✅ Weekly consolidation completed successfully${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.bright}Weekly branch: ${weeklyBranchName}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}Consolidated ${lastWeekDailies.length} daily branches${CONFIG.colors.reset}`);
      
    } catch (error) {
      console.error(`\n${CONFIG.colors.red}❌ Weekly consolidation failed: ${error.message}${CONFIG.colors.reset}`);
      throw error;
    }
  }

  /**
   * List existing weekly branches
   */
  listWeeklyBranches() {
    const allBranches = this.getAllBranches();
    const weeklyBranches = allBranches.filter(branch => branch.startsWith('weekly/')).sort();
    
    if (weeklyBranches.length === 0) {
      console.log(`${CONFIG.colors.yellow}No weekly branches found${CONFIG.colors.reset}`);
      return;
    }
    
    console.log(`\n${CONFIG.colors.bright}Existing Weekly Branches:${CONFIG.colors.reset}`);
    weeklyBranches.forEach(branch => {
      console.log(`  • ${branch}`);
    });
  }

  /**
   * Clean up old weekly branches (keep only recent ones)
   */
  async cleanupOldWeeklyBranches() {
    const retainWeeks = this.projectSettings?.cleanup?.retainWeeklyBranches || 12;
    const allBranches = this.getAllBranches();
    const weeklyBranches = allBranches.filter(branch => branch.startsWith('weekly/')).sort();
    
    if (weeklyBranches.length <= retainWeeks) {
      console.log(`${CONFIG.colors.green}No old weekly branches to clean up (${weeklyBranches.length} <= ${retainWeeks})${CONFIG.colors.reset}`);
      return;
    }
    
    const branchesToDelete = weeklyBranches.slice(0, weeklyBranches.length - retainWeeks);
    
    console.log(`\n${CONFIG.colors.bright}Cleaning up old weekly branches (keeping ${retainWeeks} most recent):${CONFIG.colors.reset}`);
    
    for (const branch of branchesToDelete) {
      try {
        console.log(`${CONFIG.colors.blue}Deleting old weekly branch: ${branch}${CONFIG.colors.reset}`);
        
        // Delete local branch if it exists
        try {
          execSync(`git branch -D ${branch}`, { stdio: 'ignore' });
        } catch {}
        
        // Delete remote branch
        execSync(`git push origin --delete ${branch}`, { stdio: 'ignore' });
        
        console.log(`${CONFIG.colors.green}✓ Deleted ${branch}${CONFIG.colors.reset}`);
      } catch (error) {
        console.error(`${CONFIG.colors.red}✗ Failed to delete ${branch}: ${error.message}${CONFIG.colors.reset}`);
      }
    }
  }

  /**
   * Main execution function
   */
  async run(command = 'consolidate') {
    try {
      switch (command) {
        case 'consolidate':
          await this.consolidateWeeklyBranches();
          break;
        case 'list':
          this.listWeeklyBranches();
          break;
        case 'cleanup':
          await this.cleanupOldWeeklyBranches();
          break;
        default:
          console.log(`${CONFIG.colors.red}Unknown command: ${command}${CONFIG.colors.reset}`);
          console.log('Available commands: consolidate, list, cleanup');
      }
    } catch (error) {
      console.error(`${CONFIG.colors.red}❌ Operation failed: ${error.message}${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }
}

// CLI execution
if (require.main === module) {
  const command = process.argv[2] || 'consolidate';
  const consolidator = new WeeklyConsolidator();
  consolidator.run(command);
}

module.exports = WeeklyConsolidator;
