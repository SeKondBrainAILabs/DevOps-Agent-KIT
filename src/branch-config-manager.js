#!/usr/bin/env node

/**
 * Branch Configuration Manager
 * Manages branch management settings for the DevOps Agent
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

class BranchConfigManager {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.localDeployDir = path.join(this.repoRoot, 'local_deploy');
    this.projectSettingsPath = path.join(this.localDeployDir, 'project-settings.json');
    this.defaultSettings = this.getDefaultSettings();
    this.ensureDirectories();
  }

  getRepoRoot() {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error(`${CONFIG.colors.red}Error: Not in a git repository${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }

  ensureDirectories() {
    if (!fs.existsSync(this.localDeployDir)) {
      fs.mkdirSync(this.localDeployDir, { recursive: true });
    }
  }

  getDefaultSettings() {
    return {
      version: "1.4.0",
      branchManagement: {
        defaultMergeTarget: "main",
        enableDualMerge: false,
        enableWeeklyConsolidation: true,
        orphanSessionThresholdDays: 7,
        mergeStrategy: "hierarchical-first",
        conflictResolution: "prompt"
      },
      rolloverSettings: {
        enableAutoRollover: true,
        rolloverTime: "00:00",
        timezone: "UTC",
        preserveRunningAgent: true
      },
      cleanup: {
        autoCleanupOrphans: false,
        weeklyCleanupDay: "sunday",
        retainWeeklyBranches: 12
      }
    };
  }

  /**
   * Load current project settings
   */
  loadSettings() {
    try {
      if (fs.existsSync(this.projectSettingsPath)) {
        const settings = JSON.parse(fs.readFileSync(this.projectSettingsPath, 'utf8'));
        // Merge with defaults to ensure all properties exist
        return this.mergeWithDefaults(settings);
      }
    } catch (error) {
      console.warn(`${CONFIG.colors.yellow}Warning: Could not load project settings: ${error.message}${CONFIG.colors.reset}`);
    }
    return this.defaultSettings;
  }

  /**
   * Merge loaded settings with defaults
   */
  mergeWithDefaults(settings) {
    const merged = JSON.parse(JSON.stringify(this.defaultSettings));
    
    // Deep merge function
    const deepMerge = (target, source) => {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    };
    
    deepMerge(merged, settings);
    return merged;
  }

  /**
   * Save settings to file
   */
  saveSettings(settings) {
    try {
      // Ensure version is updated
      settings.version = this.defaultSettings.version;
      
      fs.writeFileSync(this.projectSettingsPath, JSON.stringify(settings, null, 2));
      console.log(`${CONFIG.colors.green}✓ Settings saved to ${this.projectSettingsPath}${CONFIG.colors.reset}`);
      return true;
    } catch (error) {
      console.error(`${CONFIG.colors.red}✗ Failed to save settings: ${error.message}${CONFIG.colors.reset}`);
      return false;
    }
  }

  /**
   * Get a nested property value using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current && current[key], obj);
  }

  /**
   * Set a nested property value using dot notation
   */
  setNestedValue(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((current, key) => {
      if (!current[key]) current[key] = {};
      return current[key];
    }, obj);
    
    // Convert string values to appropriate types
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(value) && !isNaN(parseFloat(value))) value = parseFloat(value);
    
    target[lastKey] = value;
  }

  /**
   * Display current settings
   */
  displaySettings(settings = null) {
    if (!settings) {
      settings = this.loadSettings();
    }

    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Current Branch Management Settings${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Repository: ${this.repoRoot}${CONFIG.colors.reset}\n`);

    // Branch Management
    console.log(`${CONFIG.colors.bright}Branch Management:${CONFIG.colors.reset}`);
    console.log(`  Default merge target: ${CONFIG.colors.cyan}${settings.branchManagement.defaultMergeTarget}${CONFIG.colors.reset}`);
    console.log(`  Dual merge enabled: ${settings.branchManagement.enableDualMerge ? CONFIG.colors.green + 'Yes' : CONFIG.colors.yellow + 'No'}${CONFIG.colors.reset}`);
    console.log(`  Weekly consolidation: ${settings.branchManagement.enableWeeklyConsolidation ? CONFIG.colors.green + 'Yes' : CONFIG.colors.yellow + 'No'}${CONFIG.colors.reset}`);
    console.log(`  Orphan threshold: ${CONFIG.colors.cyan}${settings.branchManagement.orphanSessionThresholdDays} days${CONFIG.colors.reset}`);
    console.log(`  Merge strategy: ${CONFIG.colors.cyan}${settings.branchManagement.mergeStrategy}${CONFIG.colors.reset}`);
    console.log(`  Conflict resolution: ${CONFIG.colors.cyan}${settings.branchManagement.conflictResolution}${CONFIG.colors.reset}`);

    // Rollover Settings
    console.log(`\n${CONFIG.colors.bright}Rollover Settings:${CONFIG.colors.reset}`);
    console.log(`  Auto rollover: ${settings.rolloverSettings.enableAutoRollover ? CONFIG.colors.green + 'Yes' : CONFIG.colors.yellow + 'No'}${CONFIG.colors.reset}`);
    console.log(`  Rollover time: ${CONFIG.colors.cyan}${settings.rolloverSettings.rolloverTime}${CONFIG.colors.reset}`);
    console.log(`  Timezone: ${CONFIG.colors.cyan}${settings.rolloverSettings.timezone}${CONFIG.colors.reset}`);
    console.log(`  Preserve running agent: ${settings.rolloverSettings.preserveRunningAgent ? CONFIG.colors.green + 'Yes' : CONFIG.colors.yellow + 'No'}${CONFIG.colors.reset}`);

    // Cleanup Settings
    console.log(`\n${CONFIG.colors.bright}Cleanup Settings:${CONFIG.colors.reset}`);
    console.log(`  Auto cleanup orphans: ${settings.cleanup.autoCleanupOrphans ? CONFIG.colors.green + 'Yes' : CONFIG.colors.yellow + 'No'}${CONFIG.colors.reset}`);
    console.log(`  Weekly cleanup day: ${CONFIG.colors.cyan}${settings.cleanup.weeklyCleanupDay}${CONFIG.colors.reset}`);
    console.log(`  Retain weekly branches: ${CONFIG.colors.cyan}${settings.cleanup.retainWeeklyBranches}${CONFIG.colors.reset}`);
  }

  /**
   * Interactive configuration wizard
   */
  async runConfigWizard() {
    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Branch Management Configuration Wizard${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}This wizard will help you configure branch management settings${CONFIG.colors.reset}\n`);

    const settings = this.loadSettings();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const prompt = (question, defaultValue) => {
      return new Promise((resolve) => {
        const displayDefault = defaultValue !== undefined ? ` (${defaultValue})` : '';
        rl.question(`${question}${displayDefault}: `, (answer) => {
          resolve(answer.trim() || defaultValue);
        });
      });
    };

    const promptYesNo = (question, defaultValue = false) => {
      return new Promise((resolve) => {
        const defaultDisplay = defaultValue ? 'Y/n' : 'y/N';
        rl.question(`${question} (${defaultDisplay}): `, (answer) => {
          const normalized = answer.toLowerCase().trim();
          if (normalized === '') {
            resolve(defaultValue);
          } else {
            resolve(normalized === 'y' || normalized === 'yes');
          }
        });
      });
    };

    try {
      // Branch Management Settings
      console.log(`${CONFIG.colors.bright}Branch Management Settings:${CONFIG.colors.reset}`);
      
      settings.branchManagement.defaultMergeTarget = await prompt(
        'Default merge target branch',
        settings.branchManagement.defaultMergeTarget
      );

      settings.branchManagement.enableDualMerge = await promptYesNo(
        'Enable dual merge (merge to both daily and target branches)',
        settings.branchManagement.enableDualMerge
      );

      if (settings.branchManagement.enableDualMerge) {
        console.log('\nMerge strategy options:');
        console.log('  1. hierarchical-first - Merge to daily branch first, then target');
        console.log('  2. target-first - Merge to target branch first, then daily');
        console.log('  3. parallel - Merge to both branches simultaneously');
        
        const strategyChoice = await prompt('Choose merge strategy (1-3)', '1');
        const strategies = ['hierarchical-first', 'target-first', 'parallel'];
        settings.branchManagement.mergeStrategy = strategies[parseInt(strategyChoice) - 1] || 'hierarchical-first';
      }

      settings.branchManagement.enableWeeklyConsolidation = await promptYesNo(
        'Enable weekly branch consolidation',
        settings.branchManagement.enableWeeklyConsolidation
      );

      const orphanDays = await prompt(
        'Days before session considered orphaned',
        settings.branchManagement.orphanSessionThresholdDays
      );
      settings.branchManagement.orphanSessionThresholdDays = parseInt(orphanDays) || 7;

      // Rollover Settings
      console.log(`\n${CONFIG.colors.bright}Rollover Settings:${CONFIG.colors.reset}`);
      
      settings.rolloverSettings.enableAutoRollover = await promptYesNo(
        'Enable automatic daily rollover',
        settings.rolloverSettings.enableAutoRollover
      );

      if (settings.rolloverSettings.enableAutoRollover) {
        settings.rolloverSettings.rolloverTime = await prompt(
          'Rollover time (HH:MM format)',
          settings.rolloverSettings.rolloverTime
        );

        settings.rolloverSettings.timezone = await prompt(
          'Timezone for rollover',
          settings.rolloverSettings.timezone
        );
      }

      settings.rolloverSettings.preserveRunningAgent = await promptYesNo(
        'Preserve running agent during rollover',
        settings.rolloverSettings.preserveRunningAgent
      );

      // Cleanup Settings
      console.log(`\n${CONFIG.colors.bright}Cleanup Settings:${CONFIG.colors.reset}`);
      
      settings.cleanup.autoCleanupOrphans = await promptYesNo(
        'Automatically cleanup orphaned sessions',
        settings.cleanup.autoCleanupOrphans
      );

      if (settings.branchManagement.enableWeeklyConsolidation) {
        console.log('\nWeekly cleanup day options: sunday, monday, tuesday, wednesday, thursday, friday, saturday');
        settings.cleanup.weeklyCleanupDay = await prompt(
          'Day of week for weekly cleanup',
          settings.cleanup.weeklyCleanupDay
        );

        const retainWeeks = await prompt(
          'Number of weekly branches to retain',
          settings.cleanup.retainWeeklyBranches
        );
        settings.cleanup.retainWeeklyBranches = parseInt(retainWeeks) || 12;
      }

      rl.close();

      // Display final configuration
      console.log(`\n${CONFIG.colors.bright}Configuration Summary:${CONFIG.colors.reset}`);
      this.displaySettings(settings);

      // Confirm save
      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const shouldSave = await new Promise((resolve) => {
        rl2.question('\nSave this configuration? (Y/n): ', (answer) => {
          rl2.close();
          resolve(answer.toLowerCase() !== 'n');
        });
      });

      if (shouldSave) {
        this.saveSettings(settings);
        console.log(`\n${CONFIG.colors.green}✅ Configuration saved successfully${CONFIG.colors.reset}`);
      } else {
        console.log(`\n${CONFIG.colors.yellow}Configuration not saved${CONFIG.colors.reset}`);
      }

    } catch (error) {
      rl.close();
      console.error(`\n${CONFIG.colors.red}❌ Configuration wizard failed: ${error.message}${CONFIG.colors.reset}`);
    }
  }

  /**
   * Get a specific setting value
   */
  getSetting(settingPath) {
    const settings = this.loadSettings();
    const value = this.getNestedValue(settings, settingPath);
    
    if (value !== undefined) {
      console.log(`${settingPath}: ${CONFIG.colors.cyan}${value}${CONFIG.colors.reset}`);
    } else {
      console.log(`${CONFIG.colors.red}Setting not found: ${settingPath}${CONFIG.colors.reset}`);
    }
    
    return value;
  }

  /**
   * Set a specific setting value
   */
  setSetting(settingPath, value) {
    const settings = this.loadSettings();
    
    try {
      this.setNestedValue(settings, settingPath, value);
      
      if (this.saveSettings(settings)) {
        console.log(`${CONFIG.colors.green}✓ Updated ${settingPath} = ${value}${CONFIG.colors.reset}`);
        return true;
      }
    } catch (error) {
      console.error(`${CONFIG.colors.red}✗ Failed to set ${settingPath}: ${error.message}${CONFIG.colors.reset}`);
    }
    
    return false;
  }

  /**
   * Reset settings to defaults
   */
  resetSettings() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      console.log(`${CONFIG.colors.yellow}⚠️  This will reset all branch management settings to defaults${CONFIG.colors.reset}`);
      rl.question('Are you sure? (y/N): ', (answer) => {
        rl.close();
        
        if (answer.toLowerCase() === 'y') {
          if (this.saveSettings(this.defaultSettings)) {
            console.log(`${CONFIG.colors.green}✅ Settings reset to defaults${CONFIG.colors.reset}`);
            resolve(true);
          } else {
            resolve(false);
          }
        } else {
          console.log('Reset cancelled');
          resolve(false);
        }
      });
    });
  }

  /**
   * Validate current settings
   */
  validateSettings() {
    const settings = this.loadSettings();
    const issues = [];

    console.log(`\n${CONFIG.colors.bright}${CONFIG.colors.blue}Validating Settings${CONFIG.colors.reset}\n`);

    // Validate merge target branch exists
    if (settings.branchManagement.defaultMergeTarget) {
      try {
        execSync(`git show-ref --verify --quiet refs/remotes/origin/${settings.branchManagement.defaultMergeTarget}`, { stdio: 'ignore' });
        console.log(`${CONFIG.colors.green}✓ Target branch '${settings.branchManagement.defaultMergeTarget}' exists${CONFIG.colors.reset}`);
      } catch {
        issues.push(`Target branch '${settings.branchManagement.defaultMergeTarget}' does not exist`);
        console.log(`${CONFIG.colors.red}✗ Target branch '${settings.branchManagement.defaultMergeTarget}' does not exist${CONFIG.colors.reset}`);
      }
    }

    // Validate merge strategy
    const validStrategies = ['hierarchical-first', 'target-first', 'parallel'];
    if (!validStrategies.includes(settings.branchManagement.mergeStrategy)) {
      issues.push(`Invalid merge strategy: ${settings.branchManagement.mergeStrategy}`);
      console.log(`${CONFIG.colors.red}✗ Invalid merge strategy: ${settings.branchManagement.mergeStrategy}${CONFIG.colors.reset}`);
    } else {
      console.log(`${CONFIG.colors.green}✓ Merge strategy '${settings.branchManagement.mergeStrategy}' is valid${CONFIG.colors.reset}`);
    }

    // Validate orphan threshold
    if (settings.branchManagement.orphanSessionThresholdDays < 1) {
      issues.push('Orphan threshold must be at least 1 day');
      console.log(`${CONFIG.colors.red}✗ Orphan threshold must be at least 1 day${CONFIG.colors.reset}`);
    } else {
      console.log(`${CONFIG.colors.green}✓ Orphan threshold (${settings.branchManagement.orphanSessionThresholdDays} days) is valid${CONFIG.colors.reset}`);
    }

    // Validate rollover time format
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(settings.rolloverSettings.rolloverTime)) {
      issues.push(`Invalid rollover time format: ${settings.rolloverSettings.rolloverTime}`);
      console.log(`${CONFIG.colors.red}✗ Invalid rollover time format: ${settings.rolloverSettings.rolloverTime}${CONFIG.colors.reset}`);
    } else {
      console.log(`${CONFIG.colors.green}✓ Rollover time format is valid${CONFIG.colors.reset}`);
    }

    // Validate weekly cleanup day
    const validDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    if (!validDays.includes(settings.cleanup.weeklyCleanupDay.toLowerCase())) {
      issues.push(`Invalid weekly cleanup day: ${settings.cleanup.weeklyCleanupDay}`);
      console.log(`${CONFIG.colors.red}✗ Invalid weekly cleanup day: ${settings.cleanup.weeklyCleanupDay}${CONFIG.colors.reset}`);
    } else {
      console.log(`${CONFIG.colors.green}✓ Weekly cleanup day is valid${CONFIG.colors.reset}`);
    }

    // Summary
    if (issues.length === 0) {
      console.log(`\n${CONFIG.colors.green}✅ All settings are valid${CONFIG.colors.reset}`);
    } else {
      console.log(`\n${CONFIG.colors.red}❌ Found ${issues.length} issue(s):${CONFIG.colors.reset}`);
      issues.forEach(issue => {
        console.log(`  • ${issue}`);
      });
    }

    return issues.length === 0;
  }

  /**
   * Main execution function
   */
  async run(command, ...args) {
    try {
      switch (command) {
        case 'show':
        case 'display':
          this.displaySettings();
          break;
          
        case 'wizard':
        case 'setup':
          await this.runConfigWizard();
          break;
          
        case 'get':
          if (args.length === 0) {
            console.log(`${CONFIG.colors.red}Usage: get <setting.path>${CONFIG.colors.reset}`);
            return;
          }
          this.getSetting(args[0]);
          break;
          
        case 'set':
          if (args.length < 2) {
            console.log(`${CONFIG.colors.red}Usage: set <setting.path> <value>${CONFIG.colors.reset}`);
            return;
          }
          this.setSetting(args[0], args[1]);
          break;
          
        case 'reset':
          await this.resetSettings();
          break;
          
        case 'validate':
          this.validateSettings();
          break;
          
        default:
          console.log(`${CONFIG.colors.red}Unknown command: ${command}${CONFIG.colors.reset}`);
          console.log('\nAvailable commands:');
          console.log('  show/display - Display current settings');
          console.log('  wizard/setup - Run interactive configuration wizard');
          console.log('  get <path>   - Get a specific setting value');
          console.log('  set <path> <value> - Set a specific setting value');
          console.log('  reset        - Reset all settings to defaults');
          console.log('  validate     - Validate current settings');
          console.log('\nExample setting paths:');
          console.log('  branchManagement.enableDualMerge');
          console.log('  branchManagement.defaultMergeTarget');
          console.log('  cleanup.retainWeeklyBranches');
      }
    } catch (error) {
      console.error(`${CONFIG.colors.red}❌ Operation failed: ${error.message}${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }
}

// CLI execution
if (require.main === module) {
  const command = process.argv[2] || 'show';
  const args = process.argv.slice(3);
  const manager = new BranchConfigManager();
  manager.run(command, ...args);
}

module.exports = BranchConfigManager;
