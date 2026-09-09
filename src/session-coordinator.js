#!/usr/bin/env node

/**
 * ============================================================================
 * SESSION COORDINATOR - Foolproof Claude/Agent Handshake System
 * ============================================================================
 * 
 * This coordinator ensures Claude/Cline and DevOps agents work in sync.
 * It generates instructions for Claude and manages session allocation.
 * 
 * WORKFLOW:
 * 1. Start DevOps agent → generates session & instructions
 * 2. Copy instructions to Claude/Cline
 * 3. Claude follows instructions to use correct worktree
 * 4. Agent monitors that worktree for changes
 * 
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn, execSync, exec, fork } from 'child_process';
import { credentialsManager } from './credentials-manager.js';

// Inject credentials immediately
credentialsManager.injectEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { hasDockerConfiguration } from './docker-utils.js';
import HouseRulesManager from './house-rules-manager.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  sessionsDir: 'local_deploy/sessions',
  locksDir: 'local_deploy/session-locks',
  worktreesDir: 'local_deploy/worktrees',
  instructionsDir: 'local_deploy/instructions',
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m'
  }
};

// ============================================================================
// SESSION COORDINATOR CLASS
// ============================================================================

export class SessionCoordinator {
  constructor() {
    this.repoRoot = this.getRepoRoot();
    this.sessionsPath = path.join(this.repoRoot, CONFIG.sessionsDir);
    this.locksPath = path.join(this.repoRoot, CONFIG.locksDir);
    this.worktreesPath = path.join(this.repoRoot, CONFIG.worktreesDir);
    this.instructionsPath = path.join(this.repoRoot, CONFIG.instructionsDir);
    
    // Store user settings in home directory for cross-project usage
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    this.globalSettingsDir = path.join(homeDir, '.devops-agent');
    this.globalSettingsPath = path.join(this.globalSettingsDir, 'settings.json');
    
    // Store project-specific settings in local_deploy
    this.projectSettingsPath = path.join(this.repoRoot, 'local_deploy', 'project-settings.json');
    
    // Package version
    const packageJsonPath = path.join(__dirname, '../package.json');
    this.currentVersion = fs.existsSync(packageJsonPath) 
      ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version 
      : '0.0.0';
    
    this.ensureDirectories();
    this.cleanupStaleLocks();
    this.ensureSettingsFile();
    // DO NOT call ensureDeveloperInitials here - it should only be called when creating new sessions
  }

  getRepoRoot() {
    try {
      // Check if we're in a submodule
      const superproject = execSync('git rev-parse --show-superproject-working-tree', { encoding: 'utf8' }).trim();
      if (superproject) {
        // We're in a submodule, use the parent repository root
        console.log(`${CONFIG.colors.dim}Running from submodule, using parent repository: ${superproject}${CONFIG.colors.reset}`);
        return superproject;
      }
      // Not in a submodule, use current repository root
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error('Error: Not in a git repository');
      process.exit(1);
    }
  }

  ensureDirectories() {
    // Ensure local project directories
    [this.sessionsPath, this.locksPath, this.worktreesPath, this.instructionsPath].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Ensure file-coordination directory
    const fileCoordinationDir = path.join(this.repoRoot, 'local_deploy', '.file-coordination');
    const activeEditsDir = path.join(fileCoordinationDir, 'active-edits');
    const completedEditsDir = path.join(fileCoordinationDir, 'completed-edits');
    
    [fileCoordinationDir, activeEditsDir, completedEditsDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Ensure global settings directory in home folder
    if (!fs.existsSync(this.globalSettingsDir)) {
      fs.mkdirSync(this.globalSettingsDir, { recursive: true });
    }
  }

  cleanupStaleLocks() {
    // Clean up locks older than 24 hours (increased from 1 hour to allow resuming next day)
    const staleThreshold = Date.now() - 86400000;
    
    if (fs.existsSync(this.locksPath)) {
      const locks = fs.readdirSync(this.locksPath);
      locks.forEach(lockFile => {
        const lockPath = path.join(this.locksPath, lockFile);
        try {
          const stats = fs.statSync(lockPath);
          // Only cleanup if VERY old
          if (stats.mtimeMs < staleThreshold) {
            fs.unlinkSync(lockPath);
            console.log(`${CONFIG.colors.dim}Cleaned stale lock: ${lockFile}${CONFIG.colors.reset}`);
          }
        } catch (e) {
          // Ignore errors
        }
      });
    }
  }
  
  /**
   * Check for newer version on npm registry
   */
  async checkForUpdates(skip = false) {
    if (skip) return;
    
    const globalSettings = this.loadGlobalSettings();
    const now = Date.now();
    
    // Only check once per day
    if (globalSettings.lastUpdateCheck && (now - globalSettings.lastUpdateCheck) < 86400000) {
      return;
    }
    
    try {
      // Show checking message
      console.log(`${CONFIG.colors.dim}🔍 Checking for DevOps Agent updates...${CONFIG.colors.reset}`);
      
      // Check npm for dist-tags
      const distTags = JSON.parse(execSync('npm view s9n-devops-agent dist-tags --json', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim());
      
      const latest = distTags.latest;
      const dev = distTags.dev;
      
      // Update last check time
      globalSettings.lastUpdateCheck = now;
      this.saveGlobalSettings(globalSettings);
      
      // Determine which version to compare against
      // If current is a dev version, we check dev tag as well
      const isDev = this.currentVersion.includes('dev') || this.currentVersion.includes('-');
      
      let updateAvailable = false;
      let targetVersion = latest;
      let updateTag = 'latest';
      
      if (isDev && dev && this.compareVersions(dev, this.currentVersion) > 0) {
          updateAvailable = true;
          targetVersion = dev;
          updateTag = 'dev';
      } else if (this.compareVersions(latest, this.currentVersion) > 0) {
          updateAvailable = true;
          targetVersion = latest;
          updateTag = 'latest';
      }
      
      if (updateAvailable) {
        console.log(`\n${CONFIG.colors.yellow}▲ Update Available!${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}Current version: ${this.currentVersion}${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.bright}New version:     ${targetVersion} (${updateTag})${CONFIG.colors.reset}`);
        console.log();
        
        // Ask if user wants to update now
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const updateNow = await new Promise((resolve) => {
          rl.question(`${CONFIG.colors.green}Would you like to update now? (Y/n):${CONFIG.colors.reset} `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() !== 'n');
          });
        });
        
        if (updateNow) {
          console.log(`\n${CONFIG.colors.blue}Updating s9n-devops-agent...${CONFIG.colors.reset}`);
          try {
            execSync(`npm install -g s9n-devops-agent@${updateTag}`, {
              stdio: 'inherit',
              cwd: process.cwd()
            });
            console.log(`\n${CONFIG.colors.green}✓ Update complete! Please restart the agent.${CONFIG.colors.reset}`);
            process.exit(0);
          } catch (err) {
            console.log(`\n${CONFIG.colors.red}✗ Update failed: ${err.message}${CONFIG.colors.reset}`);
            console.log(`${CONFIG.colors.dim}You can manually update with: npm install -g s9n-devops-agent@${updateTag}${CONFIG.colors.reset}`);
          }
        } else {
          console.log(`${CONFIG.colors.dim}You can update later with: npm install -g s9n-devops-agent@${updateTag}${CONFIG.colors.reset}`);
        }
        console.log();
      } else {
        // Version is up to date
        console.log(`${CONFIG.colors.dim}✓ DevOps Agent is up to date (v${this.currentVersion})${CONFIG.colors.reset}`);
      }
    } catch (err) {
      // Silently fail - don't block execution on update check
      console.log(`${CONFIG.colors.dim}✗ Could not check for updates (offline or npm unavailable)${CONFIG.colors.reset}`);
    }
  }
  
  /**
   * Compare semantic versions (robust to suffixes)
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    
    const normalize = v => v.replace(/^v/, '').split('.').map(p => parseInt(p, 10));
    const p1 = normalize(v1);
    const p2 = normalize(v2);
    
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = isNaN(p1[i]) ? 0 : p1[i];
      const n2 = isNaN(p2[i]) ? 0 : p2[i];
      
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    
    return 0;
  }
  
  /**
   * Ensure developer initials are configured globally
   */
  async ensureGlobalSetup(skip = false) {
    if (skip) return;
    
    const globalSettings = this.loadGlobalSettings();
    
    // Check if global setup is needed (developer initials)
    if (!globalSettings.developerInitials || !globalSettings.configured) {
      console.log(`\n${CONFIG.colors.yellow}First-time DevOps Agent setup!${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.bright}Please enter your 3-letter developer initials${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}(These will be used in branch names across ALL projects)${CONFIG.colors.reset}`);
      
      const initials = await this.promptForInitials();
      globalSettings.developerInitials = initials.toLowerCase();
      globalSettings.configured = true;
      
      this.saveGlobalSettings(globalSettings);
      
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Developer initials saved globally: ${CONFIG.colors.bright}${initials}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}Your initials are saved in ~/.devops-agent/settings.json${CONFIG.colors.reset}`);
    }
  }
  
  /**
   * Initialize House Rules Contracts folder and files
   */
  async initializeContractsFolder() {
    const contractsDir = path.join(this.repoRoot, 'House_Rules_Contracts');
    
    // Check if contracts folder already exists
    if (fs.existsSync(contractsDir)) {
      console.log(`${CONFIG.colors.dim}✓ Contracts folder already exists${CONFIG.colors.reset}`);
      return;
    }
    
    console.log(`\n${CONFIG.colors.blue}Creating contracts folder...${CONFIG.colors.reset}`);
    
    try {
      // Create contracts directory
      fs.mkdirSync(contractsDir, { recursive: true });
      
      // Find the npm package location to copy templates
      const packageRoot = path.resolve(__dirname, '..');
      const contractsTemplateDir = path.join(packageRoot, 'House_Rules_Contracts');
      
      if (fs.existsSync(contractsTemplateDir)) {
        // Copy all contract template files
        const files = fs.readdirSync(contractsTemplateDir);
        let copiedCount = 0;
        
        for (const file of files) {
          if (file.endsWith('.md') || file.endsWith('.json')) {
            const srcPath = path.join(contractsTemplateDir, file);
            const destPath = path.join(contractsDir, file);
            const content = fs.readFileSync(srcPath, 'utf8');
            fs.writeFileSync(destPath, content);
            copiedCount++;
          }
        }
        
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Created contracts folder with ${copiedCount} template files`);
        console.log(`${CONFIG.colors.dim}  Location: ${contractsDir}${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}  Files: API_CONTRACT.md, DATABASE_SCHEMA_CONTRACT.md, SQL_CONTRACT.json, etc.${CONFIG.colors.reset}`);
      } else {
        // Fallback: create empty contracts folder with basic README
        const readmeContent = `# House Rules Contracts\n\nThis folder contains contract files that document all project components.\n\nSee houserules.md for complete documentation on the Contract System.\n`;
        fs.writeFileSync(path.join(contractsDir, 'README.md'), readmeContent);
        console.log(`${CONFIG.colors.yellow}⚠ Created empty contracts folder (templates not found in package)${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}  You can manually populate contract files from the DevOps Agent repository${CONFIG.colors.reset}`);
      }
    } catch (err) {
      console.log(`${CONFIG.colors.red}✗ Error creating contracts folder: ${err.message}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  You can manually create House_Rules_Contracts/ folder${CONFIG.colors.reset}`);
    }
  }
  
  /**
   * Ensure house rules are set up for the project
   */
  async ensureHouseRulesSetup(skip = false) {
    if (skip) return;
    
    const houseRulesManager = new HouseRulesManager(this.repoRoot);
    const houseRulesPath = path.join(this.repoRoot, 'houserules.md');
    
    // Check if house rules exist
    if (!fs.existsSync(houseRulesPath)) {
      console.log(`\n${CONFIG.colors.yellow}House rules not found - creating default house rules...${CONFIG.colors.reset}`);
      console.log(`\n${CONFIG.colors.bright}=== Folder Organization Strategy ===${CONFIG.colors.reset}`);
      console.log();
      console.log(`${CONFIG.colors.bright}Option 1: STRUCTURED Organization${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • NEW code follows a module-based structure:${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}    ModuleName/src/featurename/   (source code)${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}    ModuleName/test/featurename/  (tests)${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Existing files stay where they are (no moving!)${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Benefits: Better discoverability, clear ownership, scales well${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Best for: Larger projects, teams, microservices${CONFIG.colors.reset}`);
      console.log();
      console.log(`${CONFIG.colors.bright}Option 2: FLEXIBLE Organization${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Use any folder structure you prefer${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • No enforced patterns for new code${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Benefits: Freedom, simplicity, less overhead${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}  • Best for: Small projects, prototypes, solo developers${CONFIG.colors.reset}`);
      console.log();
      console.log(`${CONFIG.colors.yellow}Note: Both include the full contract system for preventing duplicate work.${CONFIG.colors.reset}`);
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const wantsStructure = await new Promise((resolve) => {
        rl.question(`${CONFIG.colors.green}Use structured organization? (Y/n):${CONFIG.colors.reset} `, (answer) => {
          rl.close();
          resolve(answer.toLowerCase() !== 'n');
        });
      });
      
      // Determine which template to copy
      const templateName = wantsStructure ? 'houserules_structured.md' : 'houserules.md';
      
      // Find the npm package location (where this script is running from)
      // session-coordinator.js is in src/, so package root is one level up
      const packageRoot = path.resolve(__dirname, '..');
      const templatePath = path.join(packageRoot, templateName);
      
      // Copy the template to the project root
      try {
        if (fs.existsSync(templatePath)) {
          const templateContent = fs.readFileSync(templatePath, 'utf8');
          fs.writeFileSync(houseRulesPath, templateContent);
          console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} House rules created at: ${CONFIG.colors.bright}${houseRulesPath}${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Using ${wantsStructure ? 'structured' : 'flexible'} organization template${CONFIG.colors.reset}`);
        } else {
          console.log(`${CONFIG.colors.yellow}⚠ Template not found, creating basic house rules...${CONFIG.colors.reset}`);
          // Fallback to programmatic creation
          const result = await houseRulesManager.updateHouseRules({ createIfMissing: true, backupExisting: false });
          if (result.created) {
            console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} House rules created at: ${CONFIG.colors.bright}${result.path}${CONFIG.colors.reset}`);
          }
        }
      } catch (err) {
        console.log(`${CONFIG.colors.red}✗ Error creating house rules: ${err.message}${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}You can manually create houserules.md in your project root${CONFIG.colors.reset}`);
      }
      
      // Initialize contracts folder after house rules are created
      await this.initializeContractsFolder();
    } else {
      // House rules exist - check if they need updating
      const status = houseRulesManager.getStatus();
      if (status.needsUpdate) {
        console.log(`\n${CONFIG.colors.yellow}House rules updates available${CONFIG.colors.reset}`);
        const updatedSections = Object.entries(status.managedSections)
          .filter(([_, info]) => info.needsUpdate)
          .map(([name]) => name);
        
        if (updatedSections.length > 0) {
          console.log(`${CONFIG.colors.dim}Sections with updates: ${updatedSections.join(', ')}${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Your custom rules will be preserved.${CONFIG.colors.reset}`);
          
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          
          const answer = await new Promise(resolve => {
            rl.question(`\nUpdate house rules now? (Y/n): `, resolve);
          });
          rl.close();
          
          if (answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no') {
            const result = await houseRulesManager.updateHouseRules();
            if (result.updated) {
              console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Updated ${result.totalChanges} section(s)`);
            }
          } else {
            console.log(`${CONFIG.colors.dim}Skipped house rules update. Run 'npm run house-rules:update' later.${CONFIG.colors.reset}`);
          }
        }
      }
    }
  }
  
  /**
   * Ensure project-specific version settings are configured
   */
  async ensureProjectSetup(options = {}) {
    if (options.skip) return;
    
    const projectSettings = this.loadProjectSettings();
    
    // Check if project setup is needed (version strategy)
    if (options.force || !projectSettings.versioningStrategy || !projectSettings.versioningStrategy.configured) {
      console.log(`\n${CONFIG.colors.yellow}Project Versioning Setup${CONFIG.colors.reset}`);
      if (options.force) {
          console.log(`${CONFIG.colors.dim}Reconfiguring version strategy...${CONFIG.colors.reset}`);
      } else {
          console.log(`${CONFIG.colors.yellow}First-time project setup for this repository!${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Let's configure the versioning strategy for this project${CONFIG.colors.reset}`);
      }
      
      const versionInfo = await this.promptForStartingVersion();
      projectSettings.versioningStrategy = {
        prefix: versionInfo.prefix,
        startMinor: versionInfo.startMinor,
        dailyIncrement: versionInfo.dailyIncrement || 1,
        configured: true
      };
      
      this.saveProjectSettings(projectSettings);
      
      // Set environment variables for the current session
      process.env.AC_VERSION_PREFIX = versionInfo.prefix;
      process.env.AC_VERSION_START_MINOR = versionInfo.startMinor.toString();
      process.env.AC_VERSION_INCREMENT = versionInfo.dailyIncrement.toString();
      
      const incrementDisplay = (versionInfo.dailyIncrement / 100).toFixed(2);
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Project versioning configured:`);
      console.log(`  Starting: ${CONFIG.colors.bright}${versionInfo.prefix}${versionInfo.startMinor}${CONFIG.colors.reset}`);
      console.log(`  Daily increment: ${CONFIG.colors.bright}${incrementDisplay}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}Settings saved in local_deploy/project-settings.json${CONFIG.colors.reset}`);
    } else {
      // Project already configured, set environment variables
      process.env.AC_VERSION_PREFIX = projectSettings.versioningStrategy.prefix;
      process.env.AC_VERSION_START_MINOR = projectSettings.versioningStrategy.startMinor.toString();
      process.env.AC_VERSION_INCREMENT = (projectSettings.versioningStrategy.dailyIncrement || 1).toString();
    }
  }
  
  /**
   * Get developer initials from settings (no prompting)
   */
  getDeveloperInitials() {
    const settings = this.loadSettings();
    // Never prompt here, just return default if not configured
    return settings.developerInitials || 'dev';
  }
  
  /**
   * Ensure settings files exist
   */
  ensureSettingsFile() {
    // Create global settings if not exists
    if (!fs.existsSync(this.globalSettingsPath)) {
      const defaultGlobalSettings = {
        developerInitials: "",
        email: "",
        preferences: {
          defaultTargetBranch: "main",
          pushOnCommit: true,
          verboseLogging: false
        },
        configured: false
      };
      fs.writeFileSync(this.globalSettingsPath, JSON.stringify(defaultGlobalSettings, null, 2));
      console.log(`${CONFIG.colors.dim}Created global settings at ~/.devops-agent/settings.json${CONFIG.colors.reset}`);
    }
    
    // Create project settings if not exists
    if (!fs.existsSync(this.projectSettingsPath)) {
      const defaultProjectSettings = {
        versioningStrategy: {
          prefix: "v0.",
          startMinor: 20,
          configured: false
        },
        autoMergeConfig: {
          enabled: false,
          targetBranch: "main",
          strategy: "pull-request"
        }
      };
      const projectDir = path.dirname(this.projectSettingsPath);
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
      fs.writeFileSync(this.projectSettingsPath, JSON.stringify(defaultProjectSettings, null, 2));
    }
  }
  
  /**
   * Load global settings (user-specific)
   */
  loadGlobalSettings() {
    if (fs.existsSync(this.globalSettingsPath)) {
      return JSON.parse(fs.readFileSync(this.globalSettingsPath, 'utf8'));
    }
    return {
      developerInitials: "",
      email: "",
      preferences: {},
      configured: false
    };
  }
  
  /**
   * Load project settings
   */
  loadProjectSettings() {
    if (fs.existsSync(this.projectSettingsPath)) {
      return JSON.parse(fs.readFileSync(this.projectSettingsPath, 'utf8'));
    }
    return {
      versioningStrategy: {
        prefix: "v0.",
        startMinor: 20,
        configured: false
      },
      autoMergeConfig: {}
    };
  }
  
  /**
   * Combined settings loader for compatibility
   */
  loadSettings() {
    const global = this.loadGlobalSettings();
    const project = this.loadProjectSettings();
    return {
      ...global,
      ...project,
      developerInitials: project.developerInitials || global.developerInitials,
      configured: global.configured
    };
  }
  
  /**
   * Save global settings
   */
  saveGlobalSettings(settings) {
    fs.writeFileSync(this.globalSettingsPath, JSON.stringify(settings, null, 2));
    console.log(`${CONFIG.colors.dim}Global settings saved to ~/.devops-agent/settings.json${CONFIG.colors.reset}`);
  }
  
  /**
   * Save project settings
   */
  saveProjectSettings(settings) {
    const projectDir = path.dirname(this.projectSettingsPath);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    fs.writeFileSync(this.projectSettingsPath, JSON.stringify(settings, null, 2));
    console.log(`${CONFIG.colors.dim}Project settings saved to local_deploy/project-settings.json${CONFIG.colors.reset}`);
  }
  
  /**
   * Save settings (splits between global and project)
   */
  saveSettings(settings) {
    // Split settings into global and project
    const globalSettings = {
      developerInitials: settings.developerInitials,
      email: settings.email || "",
      preferences: settings.preferences || {},
      configured: settings.configured
    };
    
    const projectSettings = {
      versioningStrategy: settings.versioningStrategy,
      autoMergeConfig: settings.autoMergeConfig || {}
    };
    
    this.saveGlobalSettings(globalSettings);
    this.saveProjectSettings(projectSettings);
  }
  
  /**
   * Prompt for developer initials
   */
  promptForInitials() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      const askInitials = () => {
        rl.question('Developer initials (3 letters): ', (answer) => {
          const initials = answer.trim();
          if (initials.length !== 3) {
            console.log(`${CONFIG.colors.red}Please enter exactly 3 letters${CONFIG.colors.reset}`);
            askInitials();
          } else if (!/^[a-zA-Z]+$/.test(initials)) {
            console.log(`${CONFIG.colors.red}Please use only letters${CONFIG.colors.reset}`);
            askInitials();
          } else {
            rl.close();
            resolve(initials);
          }
        });
      };
      askInitials();
    });
  }
  
  /**
   * Get list of available branches
   */
  getAvailableBranches() {
    try {
      const result = execSync('git branch -a --format="%(refname:short)"', { 
        cwd: this.repoRoot,
        encoding: 'utf8' 
      });
      
      return result.split('\n')
        .filter(branch => branch.trim())
        .filter(branch => !branch.includes('HEAD'))
        .map(branch => branch.replace('origin/', ''));
    } catch (error) {
      return ['main', 'develop', 'master'];
    }
  }
  
  /**
   * Prompt for Docker restart configuration
   */
  async promptForDockerConfig() {
    // Check if Docker setting is already configured with 'Never'
    const projectSettings = this.loadProjectSettings();
    if (projectSettings.dockerConfig && projectSettings.dockerConfig.neverAsk === true) {
      // User selected 'Never' - skip Docker configuration
      // Show a subtle message so they know why it's skipped
      console.log(`${CONFIG.colors.dim}Skipping Docker config (User preference: Never ask). Edit local_deploy/project-settings.json to enable.${CONFIG.colors.reset}`);
      return { enabled: false, neverAsk: true };
    }
    
    if (projectSettings.dockerConfig && projectSettings.dockerConfig.alwaysEnabled === true) {
      // User selected 'Always' - use saved configuration
      console.log(`\n${CONFIG.colors.dim}Using saved Docker configuration${CONFIG.colors.reset}`);
      return projectSettings.dockerConfig;
    }
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    console.log(`\n${CONFIG.colors.yellow}═══ Docker Configuration ═══${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Automatically restart Docker containers after each push.${CONFIG.colors.reset}`);
    console.log();
    console.log(`${CONFIG.colors.bright}Options:${CONFIG.colors.reset}`);
    console.log(`  ${CONFIG.colors.green}Y${CONFIG.colors.reset}) Yes - Enable for this session only`);
    console.log(`  ${CONFIG.colors.red}N${CONFIG.colors.reset}) No - Disable for this session`);
    console.log(`  ${CONFIG.colors.blue}A${CONFIG.colors.reset}) Always - Enable and remember settings`);
    console.log(`  ${CONFIG.colors.magenta}Never${CONFIG.colors.reset}) Never ask again (permanently disable)`);
    
    // Ask if they want automatic Docker restarts
    const answer = await new Promise((resolve) => {
      rl.question('\nAuto-restart Docker containers after push? (Y/N/A/Never) [N]: ', (ans) => {
        resolve(ans.trim().toLowerCase());
      });
    });
    
    // Handle 'Never' option
    if (answer === 'never' || answer === 'nev') {
      rl.close();
      // Save 'Never' setting
      projectSettings.dockerConfig = {
        enabled: false,
        neverAsk: true
      };
      this.saveProjectSettings(projectSettings);
      console.log(`${CONFIG.colors.dim}Docker configuration disabled permanently. Edit local_deploy/project-settings.json to change.${CONFIG.colors.reset}`);
      return { enabled: false, neverAsk: true };
    }
    
    const autoRestart = answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'always';
    const alwaysAutoRestart = answer === 'a' || answer === 'always';
    
    if (!autoRestart) {
      rl.close();
      return { enabled: false };
    }
    
    // Ask which compose file to use if multiple
    const dockerInfo = hasDockerConfiguration(process.cwd());
    let selectedComposeFile = null;
    
    if (dockerInfo.composeFiles.length > 1) {
      console.log(`\n${CONFIG.colors.bright}Select docker-compose file:${CONFIG.colors.reset}`);
      
      // Check running containers for each compose file
      for (let i = 0; i < dockerInfo.composeFiles.length; i++) {
        const file = dockerInfo.composeFiles[i];
        let runningInfo = '';
        
        try {
          // Try to get container count for this compose file
          const { execSync } = await import('child_process');
          const result = execSync(`docker compose -f "${file.path}" ps -q 2>/dev/null | wc -l`, { encoding: 'utf8' });
          const count = parseInt(result.trim());
          if (count > 0) {
            runningInfo = ` ${CONFIG.colors.green}(${count} running)${CONFIG.colors.reset}`;
          }
        } catch (err) {
          // Ignore errors, just don't show running info
        }
        
        console.log(`  ${i + 1}) ${file.name}${runningInfo}`);
        console.log(`     ${CONFIG.colors.dim}${file.path}${CONFIG.colors.reset}`);
      }
      
      const fileChoice = await new Promise((resolve) => {
        rl.question(`\nChoose file (1-${dockerInfo.composeFiles.length}) [1]: `, (answer) => {
          const choice = parseInt(answer) || 1;
          if (choice >= 1 && choice <= dockerInfo.composeFiles.length) {
            resolve(dockerInfo.composeFiles[choice - 1]);
          } else {
            resolve(dockerInfo.composeFiles[0]);
          }
        });
      });
      
      selectedComposeFile = fileChoice.path;
    } else if (dockerInfo.composeFiles.length === 1) {
      selectedComposeFile = dockerInfo.composeFiles[0].path;
    }
    
    // Ask about rebuild preference
    const rebuild = await new Promise((resolve) => {
      rl.question('\nRebuild containers on restart? (y/N): ', (answer) => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
    
    // Ask about specific service
    const specificService = await new Promise((resolve) => {
      rl.question('\nSpecific service to restart (leave empty for all): ', (answer) => {
        resolve(answer.trim() || null);
      });
    });
    
    rl.close();
    
    const config = {
      enabled: true,
      composeFile: selectedComposeFile,
      rebuild: rebuild,
      service: specificService,
      forceRecreate: false,
      alwaysEnabled: alwaysAutoRestart
    };
    
    // Save configuration if 'Always' was selected
    if (alwaysAutoRestart) {
      projectSettings.dockerConfig = config;
      this.saveProjectSettings(projectSettings);
      console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Docker configuration saved permanently`);
    }
    
    console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Docker restart configuration:`);
    console.log(`  ${CONFIG.colors.bright}Auto-restart:${CONFIG.colors.reset} Enabled${alwaysAutoRestart ? ' (Always)' : ' (This session)'}`);
    if (selectedComposeFile) {
      console.log(`  ${CONFIG.colors.bright}Compose file:${CONFIG.colors.reset} ${path.basename(selectedComposeFile)}`);
    }
    console.log(`  ${CONFIG.colors.bright}Rebuild:${CONFIG.colors.reset} ${rebuild ? 'Yes' : 'No'}`);
    if (specificService) {
      console.log(`  ${CONFIG.colors.bright}Service:${CONFIG.colors.reset} ${specificService}`);
    }
    
    return config;
  }

  /**
   * Prompt for base branch (source)
   */
  async promptForBaseBranch() {
    console.log(`\n${CONFIG.colors.yellow}═══ Base Branch Selection ═══${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Which branch should I use as the starting point for your work?${CONFIG.colors.reset}`);
    
    // Get available branches
    const branches = this.getAvailableBranches();
    // Prioritize main/develop/master
    const priorityBranches = ['main', 'master', 'develop', 'development'];
    
    const sortedBranches = branches.sort((a, b) => {
        const aP = priorityBranches.indexOf(a);
        const bP = priorityBranches.indexOf(b);
        if (aP !== -1 && bP !== -1) return aP - bP;
        if (aP !== -1) return -1;
        if (bP !== -1) return 1;
        return a.localeCompare(b);
    });
    
    const uniqueBranches = [...new Set(sortedBranches)].slice(0, 10);
    
    console.log();
    uniqueBranches.forEach((branch, index) => {
      const isPriority = priorityBranches.includes(branch);
      const marker = isPriority ? ` ${CONFIG.colors.green}⭐${CONFIG.colors.reset}` : '';
      console.log(`  ${index + 1}) ${branch}${marker}`);
    });
    console.log(`  0) Enter a different branch name`);
    console.log(`  Hit Enter for default (HEAD)`);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question(`\nSelect base branch (1-${uniqueBranches.length}, 0, or Enter): `, (answer) => {
        rl.close();
        const choice = answer.trim();
        
        if (choice === '') {
             resolve('HEAD');
             return;
        }
        
        const num = parseInt(choice);
        
        if (num === 0) {
           const rl2 = readline.createInterface({
               input: process.stdin,
               output: process.stdout
           });
           rl2.question('Enter custom branch name: ', (custom) => {
               rl2.close();
               resolve(custom.trim() || 'HEAD');
           });
        } else if (num >= 1 && num <= uniqueBranches.length) {
            resolve(uniqueBranches[num - 1]);
        } else {
            resolve('HEAD');
        }
      });
    });
  }

  /**
   * Prompt for auto-merge configuration
   */
  async promptForMergeConfig() {
    // Check if auto-merge setting is already configured
    const projectSettings = this.loadProjectSettings();
    if (projectSettings.autoMergeConfig && projectSettings.autoMergeConfig.alwaysEnabled !== undefined) {
      // Already configured with 'Always', use saved settings
      if (projectSettings.autoMergeConfig.alwaysEnabled) {
        console.log(`\n${CONFIG.colors.dim}Using saved auto-merge configuration${CONFIG.colors.reset}`);
        return projectSettings.autoMergeConfig;
      }
    }
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    console.log(`\n${CONFIG.colors.yellow}═══ Auto-merge Configuration ═══${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Automatically merge your daily work branches into a target branch.${CONFIG.colors.reset}`);
    console.log();
    console.log(`${CONFIG.colors.bright}How it works:${CONFIG.colors.reset}`);
    console.log(`  • The agent creates dated branches (e.g., ${CONFIG.colors.blue}agent_dev_2025-10-01${CONFIG.colors.reset})`);
    console.log(`  • At the end of each day, your work is automatically merged`);
    console.log(`  • This keeps your target branch (main/develop) up to date`);
    console.log(`  • Prevents accumulation of stale feature branches`);
    console.log();
    console.log(`${CONFIG.colors.bright}Options:${CONFIG.colors.reset}`);
    console.log(`  ${CONFIG.colors.green}Y${CONFIG.colors.reset}) Yes - Enable for this session only`);
    console.log(`  ${CONFIG.colors.red}N${CONFIG.colors.reset}) No - Disable for this session`);
    console.log(`  ${CONFIG.colors.blue}A${CONFIG.colors.reset}) Always - Enable and remember for all sessions (24x7 operation)`);
    
    // Ask if they want auto-merge
    const answer = await new Promise((resolve) => {
      rl.question('\nEnable auto-merge? (Y/N/A) [N]: ', (ans) => {
        resolve(ans.trim().toLowerCase());
      });
    });
    
    const autoMerge = answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'always';
    const alwaysAutoMerge = answer === 'a' || answer === 'always';
    
    if (!autoMerge) {
      rl.close();
      console.log(`${CONFIG.colors.dim}Auto-merge disabled. You'll need to manually merge your work.${CONFIG.colors.reset}`);
      return { autoMerge: false, alwaysEnabled: false };
    }
    
    // Get available branches
    const branches = this.getAvailableBranches();
    const uniqueBranches = [...new Set(branches)].slice(0, 10); // Show max 10 branches
    
    console.log(`\n${CONFIG.colors.bright}Which branch should today's work be merged INTO?${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}(e.g., main, develop, v2.0, feature/xyz)${CONFIG.colors.reset}\n`);
    
    console.log(`${CONFIG.colors.bright}Available branches:${CONFIG.colors.reset}`);
    uniqueBranches.forEach((branch, index) => {
      const isDefault = branch === 'main' || branch === 'master' || branch === 'develop';
      const marker = isDefault ? ` ${CONFIG.colors.green}⭐ (recommended)${CONFIG.colors.reset}` : '';
      console.log(`  ${index + 1}) ${branch}${marker}`);
    });
    console.log(`  0) Enter a different branch name`);
    
    // Ask for target branch
    const targetBranch = await new Promise((resolve) => {
      rl.question(`\nSelect target branch to merge INTO (1-${uniqueBranches.length}, or 0): `, async (answer) => {
        const choice = parseInt(answer);
        if (choice === 0) {
          rl.question('Enter custom branch name: ', (customBranch) => {
            resolve(customBranch.trim());
          });
        } else if (choice >= 1 && choice <= uniqueBranches.length) {
          resolve(uniqueBranches[choice - 1]);
        } else {
          resolve('main'); // Default to main if invalid choice
        }
      });
    });
    
    // Ask for merge strategy
    console.log(`\n${CONFIG.colors.bright}Merge strategy:${CONFIG.colors.reset}`);
    console.log(`  1) Create pull request (recommended)`);
    console.log(`  2) Direct merge (when tests pass)`);
    console.log(`  3) Squash and merge`);
    
    const strategy = await new Promise((resolve) => {
      rl.question('Select merge strategy (1-3) [1]: ', (answer) => {
        const choice = parseInt(answer) || 1;
        switch(choice) {
          case 2:
            resolve('direct');
            break;
          case 3:
            resolve('squash');
            break;
          default:
            resolve('pull-request');
        }
      });
    });
    
    rl.close();
    
    const config = {
      autoMerge: true,
      targetBranch,
      strategy,
      requireTests: strategy !== 'pull-request',
      alwaysEnabled: alwaysAutoMerge
    };
    
    console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Auto-merge configuration saved:`);
    console.log(`  ${CONFIG.colors.bright}Today's work${CONFIG.colors.reset} → ${CONFIG.colors.bright}${targetBranch}${CONFIG.colors.reset}`);
    console.log(`  Strategy: ${CONFIG.colors.bright}${strategy}${CONFIG.colors.reset}`);
    
    if (alwaysAutoMerge) {
      console.log(`  ${CONFIG.colors.blue}Mode: Always enabled${CONFIG.colors.reset} (24x7 operation - auto rollover)`);
      // Save to project settings
      projectSettings.autoMergeConfig = config;
      this.saveProjectSettings(projectSettings);
    } else {
      console.log(`  ${CONFIG.colors.dim}Mode: This session only${CONFIG.colors.reset}`);
    }
    
    console.log(`${CONFIG.colors.dim}  (Daily branches will be merged into ${targetBranch} at end of day)${CONFIG.colors.reset}`);
    
    return config;
  }
  
  /**
   * Prompt for starting version configuration
   */
  async promptForStartingVersion() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    console.log(`\n${CONFIG.colors.yellow}Version Configuration${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Set the starting version for this codebase${CONFIG.colors.reset}`);
    
    // Ask if inheriting existing codebase
    const isInherited = await new Promise((resolve) => {
      rl.question('\nIs this an existing/inherited codebase? (y/N): ', (answer) => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
    
    let prefix = 'v0.';
    let startMinor = 20; // Default v0.20
    let dailyIncrement = 1; // Default 0.01 per day
    
    if (isInherited) {
      console.log(`\n${CONFIG.colors.bright}Current Version Examples:${CONFIG.colors.reset}`);
      console.log('  v1.5  → Enter: v1. and 50');
      console.log('  v2.3  → Enter: v2. and 30');
      console.log('  v0.8  → Enter: v0. and 80');
      console.log('  v3.12 → Enter: v3. and 120');
      
      // Get version prefix
      prefix = await new Promise((resolve) => {
        rl.question('\nEnter version prefix (e.g., v1., v2., v0.) [v0.]: ', (answer) => {
          const cleaned = answer.trim() || 'v0.';
          // Ensure it ends with a dot
          resolve(cleaned.endsWith('.') ? cleaned : cleaned + '.');
        });
      });
      
      // Get starting minor version
      const currentVersion = await new Promise((resolve) => {
        rl.question(`Current version number (e.g., for ${prefix}5 enter 50, for ${prefix}12 enter 120) [20]: `, (answer) => {
          const num = parseInt(answer.trim());
          resolve(isNaN(num) ? 20 : num);
        });
      });
      
      // Next version will be current + 1
      startMinor = currentVersion + 1;
      
      console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Next version will be: ${CONFIG.colors.bright}${prefix}${startMinor}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}(This represents ${prefix}${(startMinor/100).toFixed(2)} in semantic versioning)${CONFIG.colors.reset}`);
    } else {
      // New project
      console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Starting new project at: ${CONFIG.colors.bright}v0.20${CONFIG.colors.reset}`);
    }
    
    // Ask for daily increment preference
    console.log(`\n${CONFIG.colors.yellow}Daily Version Increment${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}How much should the version increment each day?${CONFIG.colors.reset}`);
    console.log('  1) 0.01 per day (v0.20 → v0.21 → v0.22) [default]');
    console.log('  2) 0.1 per day  (v0.20 → v0.30 → v0.40)');
    console.log('  3) 0.2 per day  (v0.20 → v0.40 → v0.60)');
    console.log('  4) Custom increment');
    
    const incrementChoice = await new Promise((resolve) => {
      rl.question('\nSelect increment (1-4) [1]: ', (answer) => {
        const choice = parseInt(answer.trim()) || 1;
        resolve(choice);
      });
    });
    
    switch (incrementChoice) {
      case 2:
        dailyIncrement = 10; // 0.1
        break;
      case 3:
        dailyIncrement = 20; // 0.2
        break;
      case 4:
        dailyIncrement = await new Promise((resolve) => {
          rl.question('Enter increment value (e.g., 5 for 0.05, 25 for 0.25): ', (answer) => {
            const value = parseInt(answer.trim());
            resolve(isNaN(value) || value <= 0 ? 1 : value);
          });
        });
        break;
      default:
        dailyIncrement = 1; // 0.01
    }
    
    const incrementDisplay = (dailyIncrement / 100).toFixed(2);
    console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Daily increment set to: ${CONFIG.colors.bright}${incrementDisplay}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}(${prefix}${startMinor} → ${prefix}${startMinor + dailyIncrement} → ${prefix}${startMinor + dailyIncrement * 2}...)${CONFIG.colors.reset}`);
    
    rl.close();
    
    return {
      prefix,
      startMinor,
      dailyIncrement
    };
  }

  generateSessionId() {
    const timestamp = Date.now().toString(36).slice(-4);
    const random = crypto.randomBytes(2).toString('hex');
    return `${timestamp}-${random}`;
  }

  /**
   * Ensure GROQ API key is configured (for AI-powered commit messages)
   */
  async ensureGroqApiKey() {
    const globalSettings = this.loadGlobalSettings();
    
    // Check if we've already asked or if key is set
    if (globalSettings.groqApiKeyConfigured === 'never') {
      return; // User chose never
    }
    
    if (credentialsManager.hasGroqApiKey()) {
      return; // Key already configured
    }
    
    // First time - ask if they want AI-powered commit messages
    console.log(`\n${CONFIG.colors.yellow}═══ AI-Powered Commit Messages ═══${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}DevOps Agent can generate commit messages using AI (GROQ).${CONFIG.colors.reset}`);
    console.log();
    console.log(`${CONFIG.colors.bright}Options:${CONFIG.colors.reset}`);
    console.log(`  ${CONFIG.colors.green}Y${CONFIG.colors.reset}) Yes - Configure GROQ API key now`);
    console.log(`  ${CONFIG.colors.red}N${CONFIG.colors.reset}) Skip - Configure later with: npm run setup`);
    console.log(`  ${CONFIG.colors.magenta}Never${CONFIG.colors.reset}) Never ask again (disable AI commits)`);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise((resolve) => {
      rl.question('\nEnable AI-powered commit messages? (Y/N/Never) [N]: ', (ans) => {
        resolve(ans.trim().toLowerCase());
      });
    });
    
    if (answer === 'never' || answer === 'nev') {
      globalSettings.groqApiKeyConfigured = 'never';
      this.saveGlobalSettings(globalSettings);
      console.log(`${CONFIG.colors.dim}AI commit messages disabled. You can enable later by editing ~/.devops-agent/settings.json${CONFIG.colors.reset}`);
      rl.close();
      return;
    }
    
    if (answer === 'y' || answer === 'yes') {
      console.log();
      console.log(`${CONFIG.colors.bright}GROQ API Key Setup${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.dim}Get your free API key at: ${CONFIG.colors.cyan}https://console.groq.com/keys${CONFIG.colors.reset}`);
      console.log();
      
      const apiKey = await new Promise((resolve) => {
        rl.question('Enter your GROQ API key: ', (key) => {
          resolve(key.trim());
        });
      });
      
      if (apiKey) {
        credentialsManager.setGroqApiKey(apiKey);
        credentialsManager.injectEnv();
        globalSettings.groqApiKeyConfigured = 'yes';
        this.saveGlobalSettings(globalSettings);
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} GROQ API key saved successfully!`);
      } else {
        console.log(`${CONFIG.colors.yellow}No key entered. You can configure later with: npm run setup${CONFIG.colors.reset}`);
      }
    } else {
      console.log(`${CONFIG.colors.dim}Skipping for now. Configure later with: npm run setup${CONFIG.colors.reset}`);
    }
    
    rl.close();
  }

  /**
   * Create a new session and generate Claude instructions
   */
  async createSession(options = {}) {
    // Check for updates (once per day) - skip if requested (e.g. called from Kora)
    await this.checkForUpdates(options.skipUpdate);
    
    // Ensure both global and project setup are complete
    await this.ensureGlobalSetup(options.skipSetup);     // Developer initials (once per user)
    await this.ensureProjectSetup({ force: false, skip: options.skipSetup });    // Version strategy (once per project)
    await this.ensureHouseRulesSetup(options.skipSetup); // House rules setup (once per project)
    await this.ensureGroqApiKey();      // GROQ API key for AI commits (once per user)
    
    // Resume Check: If task provided, check for existing sessions with similar task names
    if (options.task && options.task !== 'development') {
        const matchingSession = this.findSessionByTask(options.task);
        if (matchingSession) {
            console.log(`\\n${CONFIG.colors.yellow}Found existing session for '${options.task}'${CONFIG.colors.reset}`);
            console.log(`Session ID: ${CONFIG.colors.bright}${matchingSession.sessionId}${CONFIG.colors.reset}`);
            console.log(`Status: ${matchingSession.status}`);
            console.log(`Branch: ${matchingSession.branchName}`);
            
            const rlResume = readline.createInterface({ input: process.stdin, output: process.stdout });
            const resume = await new Promise(resolve => {
                rlResume.question(`\\nDo you want to resume this session instead? (Y/n): `, ans => {
                    rlResume.close();
                    resolve(ans.trim().toLowerCase() !== 'n');
                });
            });
            
            if (resume) {
                // Return existing session info structure similar to createSession
                // but we might need to "claim" it if it's inactive
                if (matchingSession.status !== 'active') {
                    // Claim/Restart it
                    return this.claimSession(matchingSession, options.agent || 'claude');
                } else {
                    // It's already active, just return info so startAgent can pick it up
                    // But startAgent requires lock file integrity.
                    // If it's active, we might be double-attaching unless we check PID.
                    // findAvailableSession logic already handles dead PIDs.
                    // If PID is alive, we probably shouldn't interfere, but here we assume user knows best.
                    return matchingSession;
                }
            }
        }
    }

    const sessionId = this.generateSessionId();
    const task = options.task || 'development';
    
    // If agent type wasn't provided, ask for it now
    let agentType = options.agent;
    if (!agentType) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      console.log(`\n${CONFIG.colors.blue}Select Agent Type:${CONFIG.colors.reset}`);
      console.log(`  1) Claude (default)`);
      console.log(`  2) Cline`);
      console.log(`  3) Cursor`);
      console.log(`  4) Copilot`);
      console.log(`  5) Warp`);
      console.log(`  6) Custom\n`);
      
      const agentChoice = await new Promise(resolve => {
        rl.question('Agent [1]: ', resolve);
      });
      
      switch(agentChoice.trim() || '1') {
        case '1': agentType = 'claude'; break;
        case '2': agentType = 'cline'; break;
        case '3': agentType = 'cursor'; break;
        case '4': agentType = 'copilot'; break;
        case '5': agentType = 'warp'; break;
        case '6':
          agentType = await new Promise(resolve => {
            rl.question('Enter agent name: ', resolve);
          });
          agentType = agentType.trim() || 'claude';
          break;
        default: agentType = 'claude';
      }
      rl.close();
    }
    
    const devInitials = this.getDeveloperInitials();
    
    console.log(`\n${CONFIG.colors.bgBlue}${CONFIG.colors.bright} Creating New Session ${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.blue}Session ID:${CONFIG.colors.reset} ${CONFIG.colors.bright}${sessionId}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.blue}Task:${CONFIG.colors.reset} ${task}`);
    console.log(`${CONFIG.colors.blue}Agent:${CONFIG.colors.reset} ${agentType}`);
    console.log(`${CONFIG.colors.blue}Developer:${CONFIG.colors.reset} ${devInitials}`);
    
    // Ask for auto-merge configuration
    const mergeConfig = await this.promptForMergeConfig();
    
    // Ask for base branch (where to start work from)
    const baseBranch = await this.promptForBaseBranch();
    
    // Ask for auto-rebase interval
    const rebaseInterval = await this.promptForRebaseInterval();
    
    // Check for Docker configuration and ask about restart preference
    let dockerConfig = null;
    
    // Check if user has already set "Never ask" preference (ONCE, at the top)
    const projectSettings = this.loadProjectSettings();
    if (projectSettings.dockerConfig && projectSettings.dockerConfig.neverAsk === true) {
      // User selected 'Never' - skip Docker configuration entirely
      dockerConfig = { enabled: false, neverAsk: true };
    } else {
      const dockerInfo = hasDockerConfiguration(process.cwd());
      
      if (dockerInfo.hasCompose || dockerInfo.hasDockerfile) {
        // Docker detected - show what we found and ask about restart preferences
        console.log(`\n${CONFIG.colors.yellow}Docker Configuration Detected${CONFIG.colors.reset}`);
        
        if (dockerInfo.hasCompose) {
          console.log(`${CONFIG.colors.dim}Found docker-compose files:${CONFIG.colors.reset}`);
          dockerInfo.composeFiles.forEach(file => {
            console.log(`  • ${file.name} ${CONFIG.colors.dim}(in ${file.location})${CONFIG.colors.reset}`);
          });
        }
        
        if (dockerInfo.hasDockerfile) {
          console.log(`${CONFIG.colors.dim}Found Dockerfile${CONFIG.colors.reset}`);
        }
        
        // promptForDockerConfig already handles Y/N/A/Never options
        dockerConfig = await this.promptForDockerConfig();
      } else if (projectSettings.dockerConfig && projectSettings.dockerConfig.alwaysEnabled) {
        // Use saved configuration even if Docker not auto-detected
        console.log(`\n${CONFIG.colors.dim}Using saved Docker configuration${CONFIG.colors.reset}`);
        dockerConfig = projectSettings.dockerConfig;
      } else {
        // No Docker detected and no saved preference - ask user
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        console.log(`\n${CONFIG.colors.yellow}No Docker Configuration Found${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}I couldn't find any docker-compose files in:${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}  • Project directory${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}  • Parent directory${CONFIG.colors.reset}`);
        console.log(`${CONFIG.colors.dim}  • Parent/Infrastructure or parent/infrastructure${CONFIG.colors.reset}`);
        console.log();
        console.log(`${CONFIG.colors.bright}Options:${CONFIG.colors.reset}`);
        console.log(`  ${CONFIG.colors.green}Y${CONFIG.colors.reset}) Yes - I have a Docker setup to configure`);
        console.log(`  ${CONFIG.colors.red}N${CONFIG.colors.reset}) No - Skip for this session`);
        console.log(`  ${CONFIG.colors.magenta}Never${CONFIG.colors.reset}) Never ask again (permanently disable)`);
        
        const answer = await new Promise((resolve) => {
          rl.question(`\nDo you have a Docker setup? (Y/N/Never) [N]: `, (ans) => {
            resolve(ans.trim().toLowerCase());
          });
        });
        
        // Handle 'Never' option
        if (answer === 'never' || answer === 'nev') {
          rl.close();
          projectSettings.dockerConfig = {
            enabled: false,
            neverAsk: true
          };
          this.saveProjectSettings(projectSettings);
          console.log(`${CONFIG.colors.dim}Docker configuration disabled permanently. Edit local_deploy/project-settings.json to change.${CONFIG.colors.reset}`);
          dockerConfig = { enabled: false, neverAsk: true };
        } else {
          const hasDocker = answer === 'y' || answer === 'yes';
        
          if (hasDocker) {
            const dockerPath = await new Promise((resolve) => {
              rl.question(`\nEnter the full path to your docker-compose file: `, (answer) => {
                resolve(answer.trim());
              });
            });
            
            if (dockerPath && fs.existsSync(dockerPath)) {
              console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Found docker-compose file at: ${dockerPath}`);
              
              // Ask about rebuild and service preferences
              const rebuild = await new Promise((resolve) => {
                rl.question('\nRebuild containers on restart? (y/N): ', (answer) => {
                  resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
                });
              });
              
              const specificService = await new Promise((resolve) => {
                rl.question('\nSpecific service to restart (leave empty for all): ', (answer) => {
                  resolve(answer.trim() || null);
                });
              });
              
              dockerConfig = {
                enabled: true,
                composeFile: dockerPath,
                rebuild: rebuild,
                service: specificService,
                forceRecreate: false
              };
              
              console.log(`\n${CONFIG.colors.green}✓${CONFIG.colors.reset} Docker restart configuration:`);
              console.log(`  ${CONFIG.colors.bright}Auto-restart:${CONFIG.colors.reset} Enabled`);
              console.log(`  ${CONFIG.colors.bright}Compose file:${CONFIG.colors.reset} ${path.basename(dockerPath)}`);
              console.log(`  ${CONFIG.colors.bright}Rebuild:${CONFIG.colors.reset} ${rebuild ? 'Yes' : 'No'}`);
              if (specificService) {
                console.log(`  ${CONFIG.colors.bright}Service:${CONFIG.colors.reset} ${specificService}`);
              }
            } else if (dockerPath) {
              console.log(`${CONFIG.colors.red}✗${CONFIG.colors.reset} File not found: ${dockerPath}`);
              console.log(`${CONFIG.colors.dim}Skipping Docker configuration${CONFIG.colors.reset}`);
            }
          } else {
            console.log(`${CONFIG.colors.dim}Skipping Docker configuration${CONFIG.colors.reset}`);
          }
          
          rl.close();
        }
      }
    }
    // Create worktree with developer initials first in the name
    const worktreeName = `${devInitials}-${agentType}-${sessionId}-${task.replace(/\s+/g, '-')}`;
    const worktreePath = path.join(this.worktreesPath, worktreeName);
    const branchName = `${devInitials}/${agentType}/${sessionId}/${task.replace(/\s+/g, '-')}`;
    
    try {
      // Detect if we're in a submodule and get the parent repository
      let repoRoot = process.cwd();
      let isSubmodule = false;
      let parentRemote = null;
      
      try {
        // Check if we're in a submodule
        execSync('git rev-parse --show-superproject-working-tree', { stdio: 'pipe' });
        const superproject = execSync('git rev-parse --show-superproject-working-tree', { encoding: 'utf8' }).trim();
        
        if (superproject) {
          isSubmodule = true;
          // Get the parent repository's remote
          parentRemote = execSync(`git -C "${superproject}" remote get-url origin`, { encoding: 'utf8' }).trim();
          console.log(`\n${CONFIG.colors.yellow}Detected submodule - will configure worktree for parent repository${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Parent repository: ${superproject}${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.dim}Parent remote: ${parentRemote}${CONFIG.colors.reset}`);
        }
      } catch (e) {
        // Not a submodule, continue normally
      }
      
      // Create worktree
      console.log(`\n${CONFIG.colors.yellow}Creating worktree...${CONFIG.colors.reset}`);
      const baseRef = baseBranch || 'HEAD';
      console.log(`${CONFIG.colors.dim}Branching off: ${baseRef}${CONFIG.colors.reset}`);
      
      execSync(`git worktree add -b ${branchName} "${worktreePath}" ${baseRef}`, { stdio: 'pipe' });
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Worktree created at: ${worktreePath}`);
      
      // Store base branch in session data for rebase logic
      const sessionBaseBranch = baseRef === 'HEAD' ? await this.resolveHeadBranch() : baseRef;
      
      // If we're in a submodule, set up the correct remote for the worktree
      if (isSubmodule && parentRemote) {
        console.log(`${CONFIG.colors.yellow}Configuring worktree to use parent repository remote...${CONFIG.colors.reset}`);
        // Remove the default origin that points to the submodule
        try {
          execSync(`git -C "${worktreePath}" remote remove origin`, { stdio: 'pipe' });
        } catch (e) {
          // Origin might not exist, continue
        }
        // Add the parent repository as origin
        execSync(`git -C "${worktreePath}" remote add origin ${parentRemote}`, { stdio: 'pipe' });
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Worktree configured to push to parent repository`);
      }
      
      // Create session lock
      const lockData = {
        sessionId,
        agentType,
        task,
        worktreePath,
        branchName,
        baseBranch: sessionBaseBranch,
        created: new Date().toISOString(),
        status: 'active',
        pid: process.pid,
        developerInitials: devInitials,
        mergeConfig: mergeConfig,
        rebaseInterval: rebaseInterval,
        dockerConfig: dockerConfig
      };
      
      const lockFile = path.join(this.locksPath, `${sessionId}.lock`);
      
      // Generate Claude instructions
      const instructions = this.generateClaudeInstructions(lockData);
      
      // Save instructions to file
      const instructionsFile = path.join(this.instructionsPath, `${sessionId}.md`);
      fs.writeFileSync(instructionsFile, instructions.markdown);
      
      // DON'T display instructions here - they will be shown after agent starts
      // to avoid showing them before the agent's interactive commands
      
      // Create session config in worktree
      this.createWorktreeConfig(worktreePath, lockData);
      
      // Store instructions in lockData so createAndStart can access them
      lockData.instructions = instructions;
      
      // Write lock file with instructions included
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
      
      return {
        sessionId,
        worktreePath,
        branchName,
        lockFile,
        instructionsFile,
        task
      };
      
    } catch (error) {
      console.error(`${CONFIG.colors.red}Failed to create session: ${error.message}${CONFIG.colors.reset}`);
      process.exit(1);
    }
  }

  /**
   * Prompt for auto-rebase interval
   */
  async promptForRebaseInterval() {
    console.log(`\n${CONFIG.colors.yellow}═══ Auto-Rebase Configuration ═══${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}I can automatically pull updates from the base branch to keep you up-to-date.${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}This helps prevent conflicts later by rebasing your work periodically.${CONFIG.colors.reset}`);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question(`\nHow often should I rebase? (in hours, 0 to disable) [0]: `, (answer) => {
        rl.close();
        const hours = parseFloat(answer.trim());
        if (isNaN(hours) || hours <= 0) {
            console.log(`${CONFIG.colors.dim}Auto-rebase disabled. I'll let you manage updates manually.${CONFIG.colors.reset}`);
            resolve(0);
        } else {
            console.log(`${CONFIG.colors.green}✓ I'll check for updates and rebase every ${hours} hour(s).${CONFIG.colors.reset}`);
            resolve(hours);
        }
      });
    });
  }

  /**
   * Resolve HEAD to actual branch name
   */
  async resolveHeadBranch() {
      try {
          const head = execSync('git rev-parse --abbrev-ref HEAD', { cwd: this.repoRoot, encoding: 'utf8' }).trim();
          return head;
      } catch (e) {
          return 'main';
      }
  }

  /**
   * Generate instructions for the coding agent
   */
  generateClaudeInstructions(sessionData) {
    const { sessionId, worktreePath, branchName, task } = sessionData;
    
    const plaintext = `
SESSION_ID: ${sessionId}
WORKTREE: ${worktreePath}
BRANCH: ${branchName}
TASK: ${task}

INSTRUCTIONS:
1. Change to worktree directory: cd "${worktreePath}"
2. Verify branch: git branch --show-current
3. Make your changes for: ${task}
4. Write commit message to: .devops-commit-${sessionId}.msg (use >> to append)
5. The DevOps agent will auto-commit and push your changes
`;

    const markdown = `# DevOps Session Instructions

## Session Information
- **Session ID:** \`${sessionId}\`
- **Task:** ${task}
- **Worktree Path:** \`${worktreePath}\`
- **Branch:** \`${branchName}\`

## 🚨 CRITICAL: File Coordination Protocol

**BEFORE editing any files, you MUST:**

1. **Declare your intent** by creating:
   \`\`\`json
   // File: ${path.join(this.repoRoot, 'local_deploy/.file-coordination/active-edits')}/<agent>-${sessionId}.json
   {
     "agent": "<your-name>",
     "session": "${sessionId}",
     "files": ["list", "files", "to", "edit"],
     "operation": "edit",
     "reason": "${task}",
     "declaredAt": "<ISO-8601-timestamp>",
     "estimatedDuration": 300
   }
   \`\`\`

2. **Check for conflicts** - read all files in \`${path.join(this.repoRoot, 'local_deploy/.file-coordination/active-edits')}\`
3. **Only proceed if no conflicts** - wait or choose different files if blocked
4. **Release files when done** - delete your declaration after edits

## Instructions for Your Coding Agent

### Step 1: Navigate to Your Worktree
\`\`\`bash
cd "${worktreePath}"
\`\`\`

### Step 2: Verify You're on the Correct Branch
\`\`\`bash
git branch --show-current
# Should output: ${branchName}
\`\`\`

### Step 3: Declare Files Before Editing
Create your declaration in \`${path.join(this.repoRoot, 'local_deploy/.file-coordination/active-edits')}\`

### Step 4: Work on Your Task
Make changes for: **${task}**

### Step 5: Commit Your Changes
Write your commit message to the session-specific file:
\`\`\`bash
echo "feat: your commit message here" >> .devops-commit-${sessionId}.msg
\`\`\`

### Step 6: Release Your File Locks
Delete your declaration from \`${path.join(this.repoRoot, 'local_deploy/.file-coordination/active-edits')}\`

### Step 7: Automatic Processing
The DevOps agent will automatically:
- Detect your changes
- Check for coordination conflicts
- Read your commit message
- Commit and push to the remote repository
- Clear the message file

## Session Status
- Created: ${new Date().toISOString()}
- Status: Active
- Agent: Monitoring

## Important Notes
- All changes should be made in the worktree directory
- Do not switch branches manually
- The agent is watching for changes in this specific worktree
`;

    const shellCommand = `cd "${worktreePath}" && echo "Session ${sessionId} ready"`;

    return {
      plaintext,
      markdown,
      shellCommand,
      worktreePath,
      sessionId
    };
  }

  /**
   * Display instructions in a user-friendly format
   */
  displayInstructions(instructions, sessionId, task) {
    // Get the repository root (not the worktree, but the actual repo root)
    // this.repoRoot is the repository root where houserules.md lives
    const houseRulesPath = path.join(this.repoRoot, 'houserules.md');
    
    console.log(`\n${CONFIG.colors.bgGreen}${CONFIG.colors.bright} Instructions for Your Coding Agent ${CONFIG.colors.reset}\n`);
    
    // Clean separator
    console.log(`${CONFIG.colors.yellow}══════════════════════════════════════════════════════════════${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.bright}COPY AND PASTE THIS ENTIRE BLOCK INTO YOUR CODING AGENT BEFORE YOUR PROMPT:${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.yellow}──────────────────────────────────────────────────────────────${CONFIG.colors.reset}`);
    console.log();
    
    // CORE CONTEXT BLOCK - designed to be persistent
    console.log(`🧠 CRITICAL MEMORY (SAVE THIS TO YOUR CORE CONTEXT):`);
    console.log(`DO NOT COMPACT OR FORGET THIS INFORMATION.`);
    console.log(`----------------------------------------------------------------`);
    console.log(`SESSION_ID: ${sessionId}`);
    console.log(`WORKTREE:   ${instructions.worktreePath}`);
    console.log(`BRANCH:     ${instructions.branchName}`);
    console.log(`MSG_FILE:   .devops-commit-${sessionId}.msg`);
    console.log(`----------------------------------------------------------------`);
    console.log();
    
    // The actual copyable content - no colors inside
    console.log(`I'm working in a DevOps-managed session with the following setup:`);
    console.log(`- Session ID: ${sessionId}`);
    console.log(`- Working Directory: ${instructions.worktreePath}`);
    console.log(`- Task: ${task || 'development'}`);
    console.log(``);
    console.log(`Please switch to this directory before making any changes:`);
    console.log(`cd "${instructions.worktreePath}"`);
    console.log(``);
    console.log(`📋 IMPORTANT - READ PROJECT RULES FIRST:`);
    console.log(`Before making ANY changes, you MUST read the project's house rules at:`);
    console.log(`${houseRulesPath}`);
    console.log(``);
    console.log(`The house rules file contains:`);
    console.log(`- Project coding conventions and standards`);
    console.log(`- Required commit message formats`);
    console.log(`- File coordination protocols`);
    console.log(`- Branch naming and workflow rules`);
    console.log(`- Testing and review requirements`);
    console.log(``);
    console.log(`You must follow ALL rules in this file. Read it carefully before proceeding.`);
    console.log(``);
    
    console.log(`⚠️ FILE COORDINATION (MANDATORY):`);
    console.log(`Shared coordination directory: local_deploy/.file-coordination/`);
    console.log(``);
    console.log(`⛔ ABSOLUTE RULE: ALWAYS USE THE WORKTREE PATH`);
    console.log(`Even if you compact context or restart, you MUST ALWAYS operate in:`);
    console.log(`\"${instructions.worktreePath}\"`);
    console.log(`NEVER fall back to the main repository root.`);
    console.log(``);
    console.log(`🔄 CONTEXT RECOVERY (If you get lost):`);
    console.log(`1. Check current directory: pwd`);
    console.log(`   It MUST match: ${instructions.worktreePath}`);
    console.log(`2. If not, switch immediately: cd \"${instructions.worktreePath}\"`);
    console.log(`3. Verify git branch: git branch --show-current`);
    console.log(`   It MUST be: ${instructions.branchName}`);
    console.log(``);
    console.log(`BEFORE editing ANY files:`);
    console.log(`1. Check for conflicts: ls ../../../local_deploy/.file-coordination/active-edits/`);
    console.log(`2. Create declaration: local_deploy/.file-coordination/active-edits/<agent>-${sessionId}.json`);
    console.log(``);
    console.log(`Example declaration:`);
    console.log(`{`);
    console.log(`  "agent": "claude", "session": "${sessionId}",`);
    console.log(`  "files": ["src/app.js"], "operation": "edit",`);
    console.log(`  "reason": "${task}", "declaredAt": "${new Date().toISOString()}",`);
    console.log(`  "estimatedDuration": 300`);
    console.log(`}`);
    console.log(``);
    console.log(`Write commit messages to: .devops-commit-${sessionId}.msg`);
    console.log(`(Use '>>' to append if you want to add to an existing message)`);
    console.log(`The DevOps agent will automatically commit and push changes.`);
    console.log(``);
    console.log(`⛔ IMPORTANT: STOP HERE AND WAIT`);
    console.log(`Do NOT start coding or making changes yet!`);
    console.log(`Follow the steps above in order when instructed by the user.`);
    console.log(`Wait for further instructions before proceeding.`);
    console.log();
    
    console.log(`${CONFIG.colors.yellow}══════════════════════════════════════════════════════════════${CONFIG.colors.reset}`);
    console.log();
    console.log(`${CONFIG.colors.bright}${CONFIG.colors.bgYellow} IMPORTANT ${CONFIG.colors.reset} ${CONFIG.colors.yellow}Copy the text above and paste it into your coding agent${CONFIG.colors.reset}`);
    console.log();
  }
  
  /**
   * Wait for user confirmation after showing instructions
   */
  async waitForConfirmation(sessionId) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    await new Promise(resolve => {
      rl.question(`${CONFIG.colors.green}Press Enter once you've copied and pasted the instructions to your agent...${CONFIG.colors.reset} `, resolve);
    });
    rl.close();
    
    console.log(`${CONFIG.colors.green}✓ Instructions copied${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Full instructions saved to: ${CONFIG.instructionsDir}/${sessionId}.md${CONFIG.colors.reset}`);
  }

  /**
   * Create configuration in the worktree
   */
  createWorktreeConfig(worktreePath, sessionData) {
    // NOTE: File coordination now uses shared local_deploy/.file-coordination/
    // No need to create per-worktree coordination directories
    
    // Session config file
    const configPath = path.join(worktreePath, '.devops-session.json');
    fs.writeFileSync(configPath, JSON.stringify(sessionData, null, 2));
    
    // Commit message file
    const msgFile = path.join(worktreePath, `.devops-commit-${sessionData.sessionId}.msg`);
    fs.writeFileSync(msgFile, '');
    
    // VS Code settings
    const vscodeDir = path.join(worktreePath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    
    const settings = {
      'window.title': `${sessionData.agentType.toUpperCase()} Session ${sessionData.sessionId} - ${sessionData.task}`,
      'terminal.integrated.env.osx': {
        'DEVOPS_SESSION_ID': sessionData.sessionId,
        'DEVOPS_WORKTREE': path.basename(worktreePath),
        'DEVOPS_BRANCH': sessionData.branchName,
        'AC_MSG_FILE': `.devops-commit-${sessionData.sessionId}.msg`,
        'AC_BRANCH_PREFIX': `${sessionData.developerInitials || 'dev'}_${sessionData.agentType}_${sessionData.sessionId}_`
      }
    };
    
    fs.writeFileSync(
      path.join(vscodeDir, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );
    
    // Create a README for the session
    const readme = `# DevOps Session: ${sessionData.sessionId}

## Task
${sessionData.task}

## Session Details
- **Session ID:** ${sessionData.sessionId}
- **Branch:** ${sessionData.branchName}
- **Created:** ${sessionData.created}
- **Agent Type:** ${sessionData.agentType}

## How to Use
1. Make your changes in this directory
2. Write commit message to: \`.devops-commit-${sessionData.sessionId}.msg\`
3. The DevOps agent will handle the rest

## Status
The DevOps agent is monitoring this worktree for changes.
`;
    
    fs.writeFileSync(path.join(worktreePath, 'SESSION_README.md'), readme);
    
    // Update .gitignore in the worktree to exclude session files
    const gitignorePath = path.join(worktreePath, '.gitignore');
    let gitignoreContent = '';
    
    // Read existing gitignore if it exists
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    }
    
    // Session file patterns to ignore
    const sessionPatterns = [
      '# DevOps session management files',
      '.devops-commit-*.msg',
      '.devops-session.json', 
      'SESSION_README.md',
      '.session-cleanup-requested',
      '.worktree-session',
      '.agent-config',
      '.session-*',
      '.devops-command-*'
    ];
    
    // Check if we need to add patterns
    let needsUpdate = false;
    for (const pattern of sessionPatterns) {
      if (!gitignoreContent.includes(pattern)) {
        needsUpdate = true;
        break;
      }
    }
    
    if (needsUpdate) {
      // Add session patterns to gitignore
      if (!gitignoreContent.endsWith('\n') && gitignoreContent.length > 0) {
        gitignoreContent += '\n';
      }
      gitignoreContent += '\n' + sessionPatterns.join('\n') + '\n';
      fs.writeFileSync(gitignorePath, gitignoreContent);
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Updated .gitignore to exclude session files`);
    }
    
    console.log(`${CONFIG.colors.dim}Session files created but not committed (they are gitignored)${CONFIG.colors.reset}`);
    
    // Note: We do NOT commit these files - they're for session management only
    // This prevents the "uncommitted changes" issue when starting sessions
  }

  /**
   * Request a session (for Claude to call)
   */
  async requestSession(agentName = 'claude') {
    console.log(`\n${CONFIG.colors.magenta}[${agentName.toUpperCase()}]${CONFIG.colors.reset} Requesting session...`);
    
    // Check for available unlocked sessions
    const availableSession = this.findAvailableSession();
    
    if (availableSession) {
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Found available session: ${availableSession.sessionId}`);
      return this.claimSession(availableSession, agentName);
    } else {
      console.log(`${CONFIG.colors.yellow}No available sessions. Creating new one...${CONFIG.colors.reset}`);
      const task = await this.promptForTask();
      return this.createSession({ task, agent: agentName });
    }
  }

  /**
   * Find a session by task name (fuzzy match with token-based scoring)
   */
  findSessionByTask(taskName) {
    if (!fs.existsSync(this.locksPath)) return null;
    
    const locks = fs.readdirSync(this.locksPath).filter(f => f.endsWith('.lock'));
    const inputTokens = taskName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    
    if (inputTokens.length === 0) return null;

    let bestMatch = null;
    let maxScore = 0;

    for (const lockFile of locks) {
      try {
        const lockPath = path.join(this.locksPath, lockFile);
        const session = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        
        // Normalize session task
        const sessionTask = (session.task || '').toLowerCase();
        const sessionTokens = sessionTask.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        
        // 1. Direct substring check (original logic preserved as high priority)
        const cleanInput = taskName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanTask = sessionTask.replace(/[^a-z0-9]/g, '');
        
        if (cleanTask === cleanInput || (cleanTask.length > 4 && cleanTask.includes(cleanInput)) || (cleanInput.length > 4 && cleanInput.includes(cleanTask))) {
           // Strong match found immediately
           return session;
        }

        // 2. Token-based overlap scoring
        let matchCount = 0;
        for (const token of inputTokens) {
          if (sessionTokens.some(t => t.includes(token) || token.includes(t))) {
            matchCount++;
          }
        }
        
        // Calculate score: percentage of input tokens matched
        const score = matchCount / inputTokens.length;
        
        // Threshold: at least 50% of tokens match or 1 strong token match
        if (score > 0.5 || (inputTokens.length === 1 && score === 1)) {
           if (score > maxScore) {
             maxScore = score;
             bestMatch = session;
           }
        }
        
      } catch (e) {
        // Ignore invalid locks
      }
    }
    
    return bestMatch;
  }

  /**
   * Find an available unclaimed session or orphaned session
   */
  findAvailableSession() {
    if (!fs.existsSync(this.locksPath)) {
      return null;
    }
    
    const locks = fs.readdirSync(this.locksPath);
    
    for (const lockFile of locks) {
      const lockPath = path.join(this.locksPath, lockFile);
      try {
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      
        // Check if session is available (not claimed)
        if (lockData.status === 'waiting' && !lockData.claimedBy) {
          return lockData;
        }
        
        // Check if session is orphaned/stopped but not cleaned up
        // If the PID is no longer running, it might be orphaned
        if (lockData.status === 'active' && lockData.agentPid) {
          try {
            // Check if process exists
            process.kill(lockData.agentPid, 0);
          } catch (e) {
            // Process doesn't exist - it's orphaned!
            console.log(`${CONFIG.colors.yellow}Found orphaned session: ${lockData.sessionId} (PID ${lockData.agentPid} dead)${CONFIG.colors.reset}`);
            // Mark as stopped so it can be reclaimed
            lockData.status = 'stopped';
            lockData.agentPid = null;
            lockData.agentStopped = new Date().toISOString();
            fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
            return lockData;
          }
        }
      } catch (e) {
        // Invalid lock file
      }
    }
    
    return null;
  }

  /**
   * Claim a session for an agent
   */
  claimSession(session, agentName) {
    session.claimedBy = agentName;
    session.claimedAt = new Date().toISOString();
    session.status = 'active';
    
    const lockFile = path.join(this.locksPath, `${session.sessionId}.lock`);
    fs.writeFileSync(lockFile, JSON.stringify(session, null, 2));
    
    const instructions = this.generateClaudeInstructions(session);
    // Don't display instructions here - they'll be shown after agent starts
    
    // Add instructions to session object and save to lock file
    session.instructions = instructions;
    fs.writeFileSync(lockFile, JSON.stringify(session, null, 2));
    
    return session;
  }

  /**
   * Start the DevOps agent for a session
   */
  async startAgent(sessionId, options = {}) {
    const lockFile = path.join(this.locksPath, `${sessionId}.lock`);
    
    if (!fs.existsSync(lockFile)) {
      console.error(`${CONFIG.colors.red}Session not found: ${sessionId}${CONFIG.colors.reset}`);
      return false;
    }
    
    const sessionData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    
    if (!fs.existsSync(sessionData.worktreePath)) {
      console.error(`${CONFIG.colors.red}Worktree directory not found: ${sessionData.worktreePath}${CONFIG.colors.reset}`);
      console.log(`${CONFIG.colors.yellow}This session appears to be broken or the worktree was deleted manually.${CONFIG.colors.reset}`);
      console.log(`Marking session as stopped.`);
      
      sessionData.status = 'stopped';
      sessionData.agentPid = null;
      fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
      return false;
    }

    console.log(`\n${CONFIG.colors.bgYellow}${CONFIG.colors.bright} Starting DevOps Agent ${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.blue}Session:${CONFIG.colors.reset} ${sessionId}`);
    console.log(`${CONFIG.colors.blue}Worktree:${CONFIG.colors.reset} ${sessionData.worktreePath}`);
    console.log(`${CONFIG.colors.blue}Branch:${CONFIG.colors.reset} ${sessionData.branchName}`);
    
    // Update session status
    sessionData.agentStarted = new Date().toISOString();
    sessionData.agentPid = process.pid;
    fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
    
    // Get developer initials from session data or settings (NO PROMPTING HERE)
    const devInitials = sessionData.developerInitials || this.getDeveloperInitials() || 'dev';
    const settings = this.loadSettings();
    const projectSettings = this.loadProjectSettings();
    
    // Start the agent
    const env = {
      ...process.env,
      DEVOPS_SESSION_ID: sessionId,
      AC_MSG_FILE: `.devops-commit-${sessionId}.msg`,
      AC_BRANCH_PREFIX: `${devInitials}_${sessionData.agentType}_${sessionId}_`,
      AC_WORKING_DIR: sessionData.worktreePath,
      // Don't set AC_BRANCH - let the agent create daily branches within the worktree
      // AC_BRANCH would force a static branch, preventing daily/weekly rollover
      AC_PUSH: 'true',  // Enable auto-push for session branches
      AC_DAILY_PREFIX: `${devInitials}_${sessionData.agentType}_${sessionId}_`,  // Daily branches with dev initials first
      AC_TZ: process.env.AC_TZ || 'Asia/Dubai',  // Preserve timezone for daily branches
      AC_DATE_STYLE: process.env.AC_DATE_STYLE || 'dash',  // Preserve date style
      // Apply version configuration if set
      ...(projectSettings.versioningStrategy?.prefix && { AC_VERSION_PREFIX: projectSettings.versioningStrategy.prefix }),
      ...(projectSettings.versioningStrategy?.startMinor && { AC_VERSION_START_MINOR: projectSettings.versioningStrategy.startMinor.toString() }),
      
      // Rebase configuration
      AC_REBASE_INTERVAL: (sessionData.rebaseInterval || 0).toString(),
      AC_BASE_BRANCH: sessionData.baseBranch || 'HEAD' // We need to pass the base branch for rebasing
    };
    
    const agentScript = path.join(__dirname, 'cs-devops-agent-worker.js');
    
    console.log(`\n${CONFIG.colors.green}Agent starting...${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Monitoring: ${sessionData.worktreePath}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Message file: .devops-commit-${sessionId}.msg${CONFIG.colors.reset}`);
    
    // Use fork for better Node.js script handling
    // Fork automatically uses the same node executable and handles paths better
    try {
        const child = fork(agentScript, [], {
          cwd: sessionData.worktreePath,
          env,
          stdio: 'inherit',
          silent: false
        });
        
        child.on('error', (err) => {
            console.error(`\n${CONFIG.colors.red}Failed to start agent process: ${err.message}${CONFIG.colors.reset}`);
            if (err.code === 'ENOENT') {
                console.error(`${CONFIG.colors.yellow}This usually means the worktree directory is missing or inaccessible.${CONFIG.colors.reset}`);
            }
            
            // Mark as stopped
            sessionData.status = 'stopped';
            sessionData.agentPid = null;
            fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
        });
        
        child.on('exit', (code) => {
          console.log(`${CONFIG.colors.yellow}Agent exited with code: ${code}${CONFIG.colors.reset}`);
          
          // Update session status
          sessionData.agentStopped = new Date().toISOString();
          sessionData.status = 'stopped';
          fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
        });
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
          console.log(`\n${CONFIG.colors.yellow}Stopping agent...${CONFIG.colors.reset}`);
          if (child && !child.killed) {
             child.kill('SIGINT');
          }
          setTimeout(() => process.exit(0), 1000);
        });
        
        return true;
    } catch (err) {
        console.error(`${CONFIG.colors.red}Critical error starting agent: ${err.message}${CONFIG.colors.reset}`);
        return false;
    }
  }

  /**
   * List all sessions
   */
  listSessions() {
    console.log(`\n${CONFIG.colors.bright}Active Sessions:${CONFIG.colors.reset}`);
    
    if (!fs.existsSync(this.locksPath)) {
      console.log('No active sessions');
      return;
    }
    
    const locks = fs.readdirSync(this.locksPath);
    
    if (locks.length === 0) {
      console.log('No active sessions');
      return;
    }
    
    locks.forEach(lockFile => {
      const lockPath = path.join(this.locksPath, lockFile);
      const session = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      
      const status = session.status === 'active' ? 
        `${CONFIG.colors.green}●${CONFIG.colors.reset}` : 
        `${CONFIG.colors.yellow}○${CONFIG.colors.reset}`;
      
      console.log(`\n${status} ${CONFIG.colors.bright}${session.sessionId}${CONFIG.colors.reset}`);
      console.log(`  Task: ${session.task}`);
      console.log(`  Agent: ${session.agentType}`);
      console.log(`  Branch: ${session.branchName}`);
      console.log(`  Status: ${session.status}`);
      
      if (session.claimedBy) {
        console.log(`  Claimed by: ${session.claimedBy}`);
      }
      
      if (session.agentPid) {
        console.log(`  Agent PID: ${session.agentPid}`);
      }
    });
  }

  /**
   * Prompt for task name
   */
  promptForTask() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question('Enter task name: ', (answer) => {
        rl.close();
        resolve(answer || 'development');
      });
    });
  }

  /**
   * Create a combined session (both create and start agent)
   */
  async createAndStart(options = {}) {
    const session = await this.createSession(options);
    
    // Read the lock file to get the stored instructions
    const lockFile = path.join(this.locksPath, `${session.sessionId}.lock`);
    const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    
    // Display instructions FIRST before starting agent
    if (lockData.instructions) {
      console.log('\n'); // Add spacing
      this.displayInstructions(lockData.instructions, session.sessionId, options.task || 'development');
      await this.waitForConfirmation(session.sessionId);
    }
    
    // NOW start the agent after user has copied instructions
    console.log(`\n${CONFIG.colors.yellow}Starting DevOps agent monitoring...${CONFIG.colors.reset}`);
    await this.startAgent(session.sessionId);
    
    return session;
  }
  
  /**
   * Close a specific session
   */
  async closeSession(sessionId) {
    const lockFile = path.join(this.locksPath, `${sessionId}.lock`);
    
    if (!fs.existsSync(lockFile)) {
      console.error(`${CONFIG.colors.red}Session not found: ${sessionId}${CONFIG.colors.reset}`);
      return false;
    }
    
    const session = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    console.log(`\n${CONFIG.colors.yellow}Closing session: ${sessionId}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Task: ${session.task}${CONFIG.colors.reset}`);
    console.log(`${CONFIG.colors.dim}Branch: ${session.branchName}${CONFIG.colors.reset}`);
    
    // Kill agent if running
    if (session.agentPid) {
      try {
        process.kill(session.agentPid, 'SIGTERM');
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Agent process stopped`);
      } catch (err) {
        // Process might already be dead
      }
    }
    
    // Check for uncommitted changes
    if (fs.existsSync(session.worktreePath)) {
      try {
        const status = execSync(`git -C "${session.worktreePath}" status --porcelain`, { encoding: 'utf8' });
        if (status.trim()) {
          console.log(`\n${CONFIG.colors.yellow}Warning: Uncommitted changes found${CONFIG.colors.reset}`);
          console.log(status);
          
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          
          const answer = await new Promise(resolve => {
            rl.question('Commit these changes before closing? (y/N): ', resolve);
          });
          rl.close();
          
          if (answer.toLowerCase() === 'y') {
            execSync(`git -C "${session.worktreePath}" add -A`, { stdio: 'pipe' });
            execSync(`git -C "${session.worktreePath}" commit -m "chore: final session cleanup for ${sessionId}"`, { stdio: 'pipe' });
            execSync(`git -C "${session.worktreePath}" push origin ${session.branchName}`, { stdio: 'pipe' });
            console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Changes committed and pushed`);
          }
        }
      } catch (err) {
        console.log(`${CONFIG.colors.dim}Could not check git status${CONFIG.colors.reset}`);
      }
      
      // Ask about merging to target branch before cleanup
      let rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      console.log(`\n${CONFIG.colors.yellow}Worktree Cleanup Options${CONFIG.colors.reset}`);
      
      // Get target branch from merge config or default to 'main'
      let targetBranch = session.mergeConfig?.targetBranch || 'main';
      
      const mergeFirst = await new Promise(resolve => {
        rl.question(`\nMerge ${CONFIG.colors.bright}${session.branchName}${CONFIG.colors.reset} → ${CONFIG.colors.bright}${targetBranch}${CONFIG.colors.reset} before cleanup? (y/N): `, resolve);
      });
      rl.close();
      
      if (mergeFirst.toLowerCase() === 'y') {
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const confirmTarget = await new Promise(resolve => {
          rl.question(`Target branch [${targetBranch}]: `, resolve);
        });
        rl.close();
        
        if (confirmTarget.trim()) {
          targetBranch = confirmTarget.trim();
        }
        
        try {
          console.log(`\n${CONFIG.colors.blue}Merging ${session.branchName} into ${targetBranch}...${CONFIG.colors.reset}`);
          
          // Check if target branch exists locally
          let branchExists = false;
          try {
            execSync(`git rev-parse --verify ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
            branchExists = true;
          } catch (err) {
            // Branch doesn't exist locally
          }
          
          if (!branchExists) {
            // Check if branch exists on remote
            try {
              execSync(`git ls-remote --heads origin ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
              // Branch exists on remote, fetch it
              console.log(`${CONFIG.colors.dim}Target branch doesn't exist locally, fetching from remote...${CONFIG.colors.reset}`);
              execSync(`git fetch origin ${targetBranch}:${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
            } catch (err) {
              // Branch doesn't exist on remote either, create it
              console.log(`${CONFIG.colors.yellow}Target branch '${targetBranch}' doesn't exist. Creating it...${CONFIG.colors.reset}`);
              execSync(`git checkout -b ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
              execSync(`git push -u origin ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
              console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Created new branch ${targetBranch}`);
            }
          }
          
          // Switch to target branch in main repo
          execSync(`git checkout ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
          
          // Pull latest (if branch already existed)
          if (branchExists) {
            try {
              execSync(`git pull origin ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
            } catch (err) {
              console.log(`${CONFIG.colors.dim}Could not pull latest changes (may be new branch)${CONFIG.colors.reset}`);
            }
          }
          
          // Merge the session branch
          execSync(`git merge --no-ff ${session.branchName} -m "Merge session ${sessionId}: ${session.task}"`, { 
            cwd: this.repoRoot, 
            stdio: 'pipe' 
          });
          
          // Push merged changes
          execSync(`git push origin ${targetBranch}`, { cwd: this.repoRoot, stdio: 'pipe' });
          
          console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Successfully merged to ${targetBranch}`);
          
          // Delete remote branch after successful merge
          try {
            execSync(`git push origin --delete ${session.branchName}`, { cwd: this.repoRoot, stdio: 'pipe' });
            console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Deleted remote branch ${session.branchName}`);
          } catch (err) {
            console.log(`${CONFIG.colors.dim}Could not delete remote branch${CONFIG.colors.reset}`);
          }
        } catch (err) {
          console.error(`${CONFIG.colors.red}✗ Merge failed: ${err.message}${CONFIG.colors.reset}`);
          console.log(`${CONFIG.colors.yellow}You may need to resolve conflicts manually${CONFIG.colors.reset}`);
        }
      }
      
      // Ask about removing worktree
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const removeWorktree = await new Promise(resolve => {
        rl.question(`\nRemove worktree at ${session.worktreePath}? (Y/n): `, resolve);
      });
      rl.close();
      
      if (removeWorktree.toLowerCase() !== 'n') {
        try {
          // Remove worktree
          execSync(`git worktree remove "${session.worktreePath}" --force`, { stdio: 'pipe' });
          console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Worktree removed`);
          
          // Delete local branch
          try {
            execSync(`git branch -D ${session.branchName}`, { cwd: this.repoRoot, stdio: 'pipe' });
            console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Deleted local branch ${session.branchName}`);
          } catch (err) {
            console.log(`${CONFIG.colors.dim}Could not delete local branch${CONFIG.colors.reset}`);
          }
          
          // Prune worktree list
          execSync('git worktree prune', { stdio: 'pipe' });
        } catch (err) {
          console.error(`${CONFIG.colors.red}Failed to remove worktree: ${err.message}${CONFIG.colors.reset}`);
        }
      }
    }
    
    // Remove lock file
    fs.unlinkSync(lockFile);
    console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Session closed successfully`);
    
    return true;
  }
  
  /**
   * Interactive session selection and close
   */
  async selectAndCloseSession() {
    if (!fs.existsSync(this.locksPath)) {
      console.log(`${CONFIG.colors.yellow}No active sessions${CONFIG.colors.reset}`);
      return;
    }
    
    const locks = fs.readdirSync(this.locksPath);
    if (locks.length === 0) {
      console.log(`${CONFIG.colors.yellow}No active sessions${CONFIG.colors.reset}`);
      return;
    }
    
    const sessions = [];
    locks.forEach(lockFile => {
      const lockPath = path.join(this.locksPath, lockFile);
      const session = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      sessions.push(session);
    });
    
    console.log(`\n${CONFIG.colors.bright}Select session to close:${CONFIG.colors.reset}\n`);
    
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
    
    const answer = await new Promise(resolve => {
      rl.question(`Select session (1-${sessions.length}) or 'q' to quit: `, resolve);
    });
    rl.close();
    
    if (answer.toLowerCase() === 'q') {
      return;
    }
    
    const index = parseInt(answer) - 1;
    if (index >= 0 && index < sessions.length) {
      await this.closeSession(sessions[index].sessionId);
    } else {
      console.log(`${CONFIG.colors.red}Invalid selection${CONFIG.colors.reset}`);
    }
  }
  
  /**
   * Recover sessions from existing worktrees that are missing lock files
   */
  async recoverSessions() {
    console.log(`\n${CONFIG.colors.yellow}Scanning for recoverable sessions...${CONFIG.colors.reset}`);
    
    // First, verify existing locks
    if (fs.existsSync(this.locksPath)) {
      const locks = fs.readdirSync(this.locksPath);
      for (const lockFile of locks) {
        if (!lockFile.endsWith('.lock')) continue;
        
        const lockPath = path.join(this.locksPath, lockFile);
        try {
          const sessionData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          
          // Check if worktree actually exists
          if (sessionData.worktreePath && !fs.existsSync(sessionData.worktreePath)) {
             console.log(`${CONFIG.colors.red}Found invalid lock for ${sessionData.sessionId}: Worktree missing${CONFIG.colors.reset}`);
             console.log(`Removing broken lock file...`);
             fs.unlinkSync(lockPath);
          }
        } catch (e) {
          // Invalid JSON or file read error, remove it
          try { fs.unlinkSync(lockPath); } catch (err) {}
        }
      }
    }

    if (!fs.existsSync(this.worktreesPath)) {
      console.log('No worktrees directory found.');
      return 0;
    }

    const worktrees = fs.readdirSync(this.worktreesPath);
    let recovered = 0;

    for (const dir of worktrees) {
      // Skip .DS_Store and other system files
      if (dir.startsWith('.')) continue;

      const worktreePath = path.join(this.worktreesPath, dir);
      
      // Ensure it's a directory
      try {
        if (!fs.statSync(worktreePath).isDirectory()) continue;
      } catch (e) { continue; }

      const configPath = path.join(worktreePath, '.devops-session.json');

      if (fs.existsSync(configPath)) {
        try {
          const sessionData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          
          if (!sessionData.sessionId) continue;

          const lockFile = path.join(this.locksPath, `${sessionData.sessionId}.lock`);

          if (!fs.existsSync(lockFile)) {
            // Restore lock file
            // Reset status to 'stopped' so it can be resumed/claimed
            sessionData.status = 'stopped'; 
            sessionData.agentPid = null;
            sessionData.agentStopped = new Date().toISOString();
            sessionData.recoveredAt = new Date().toISOString();
            
            fs.writeFileSync(lockFile, JSON.stringify(sessionData, null, 2));
            console.log(`${CONFIG.colors.green}✓ Recovered session ${sessionData.sessionId} (${sessionData.task})${CONFIG.colors.reset}`);
            recovered++;

            // Check for uncommitted changes in the recovered session
            try {
              const status = execSync(`git -C "${worktreePath}" status --porcelain`, { encoding: 'utf8' });
              if (status.trim()) {
                console.log(`\n${CONFIG.colors.yellow}Uncommitted changes found in recovered session ${sessionData.sessionId}${CONFIG.colors.reset}`);
                
                const rl = readline.createInterface({
                  input: process.stdin,
                  output: process.stdout
                });
                
                const commitNow = await new Promise(resolve => {
                  rl.question('Would you like to commit these changes now? (Y/n): ', answer => {
                    rl.close();
                    resolve(answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no');
                  });
                });
                
                if (commitNow) {
                  const timestamp = new Date().toISOString();
                  execSync(`git -C "${worktreePath}" add -A`, { stdio: 'ignore' });
                  execSync(`git -C "${worktreePath}" commit -m "chore: recovered session auto-commit at ${timestamp}"`, { stdio: 'ignore' });
                  console.log(`${CONFIG.colors.green}✓ Changes committed.${CONFIG.colors.reset}`);
                  
                  // Ask to push
                  const rlPush = readline.createInterface({ input: process.stdin, output: process.stdout });
                  const pushNow = await new Promise(resolve => {
                    rlPush.question('Push changes to remote? (Y/n): ', answer => {
                      rlPush.close();
                      resolve(answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no');
                    });
                  });
                  
                  if (pushNow) {
                    try {
                      execSync(`git -C "${worktreePath}" push origin ${sessionData.branchName}`, { stdio: 'ignore' });
                      console.log(`${CONFIG.colors.green}✓ Changes pushed to ${sessionData.branchName}.${CONFIG.colors.reset}`);
                    } catch (e) {
                      console.log(`${CONFIG.colors.red}✗ Push failed. You may need to pull first or check remote.${CONFIG.colors.reset}`);
                    }
                  }
                }
              }
            } catch (e) {
              // Ignore git errors during recovery scan
            }
          }
        } catch (err) {
          console.error(`Failed to recover ${dir}: ${err.message}`);
        }
      }
    }

    if (recovered === 0) {
      console.log('No orphaned sessions found to recover.');
    } else {
      console.log(`\n${CONFIG.colors.green}Recovered ${recovered} sessions. You can now resume them.${CONFIG.colors.reset}`);
    }
    
    return recovered;
  }

  async cleanupAll() {
    console.log(`\n${CONFIG.colors.yellow}Cleaning up stale sessions and worktrees...${CONFIG.colors.reset}`);
    
    // Clean up old lock files (older than 24 hours)
    const oneDayAgo = Date.now() - 86400000;
    let cleanedLocks = 0;
    
    if (fs.existsSync(this.locksPath)) {
      const locks = fs.readdirSync(this.locksPath);
      locks.forEach(lockFile => {
        const lockPath = path.join(this.locksPath, lockFile);
        const stats = fs.statSync(lockPath);
        if (stats.mtimeMs < oneDayAgo) {
          fs.unlinkSync(lockPath);
          cleanedLocks++;
        }
      });
    }
    
    if (cleanedLocks > 0) {
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Removed ${cleanedLocks} stale lock files`);
    }
    
    // Prune git worktrees
    try {
      execSync('git worktree prune', { stdio: 'pipe' });
      console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Pruned git worktrees`);
    } catch (err) {
      console.log(`${CONFIG.colors.dim}Could not prune worktrees${CONFIG.colors.reset}`);
    }
    
    // Clean up orphaned worktree directories
    if (fs.existsSync(this.worktreesPath)) {
      const worktrees = fs.readdirSync(this.worktreesPath);
      let cleanedWorktrees = 0;
      
      for (const dir of worktrees) {
        const worktreePath = path.join(this.worktreesPath, dir);
        
        // Check if this worktree is still valid
        try {
          execSync(`git worktree list | grep "${worktreePath}"`, { stdio: 'pipe' });
        } catch (err) {
          // Worktree not in git list, it's orphaned
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
            cleanedWorktrees++;
          } catch (err) {
            console.log(`${CONFIG.colors.dim}Could not remove ${dir}${CONFIG.colors.reset}`);
          }
        }
      }
      
      if (cleanedWorktrees > 0) {
        console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Removed ${cleanedWorktrees} orphaned worktree directories`);
      }
    }
    
    console.log(`${CONFIG.colors.green}✓${CONFIG.colors.reset} Cleanup complete`);
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  // Display copyright and license information immediately
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  console.log();
  console.log("=".repeat(70));
  console.log();
  console.log("  CS_DevOpsAgent - Intelligent Git Automation System");
  console.log(`  Version ${packageJson.version} | Build ${new Date().toISOString().split('T')[0].replace(/-/g, '')}`);
  console.log("  ");
  console.log("  Copyright (c) 2026 SeKondBrain AI Labs Limited");
  console.log("  Author: Sachin Dev Duggal");
  console.log("  ");
  console.log("  Licensed under the MIT License");
  console.log("  This software is provided 'as-is' without any warranty.");
  console.log("  See LICENSE file for full license text.");
  console.log("=".repeat(70));
  console.log();
  
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  const coordinator = new SessionCoordinator();
  
  switch (command) {
    case 'create': {
      // Clean up orphaned sessions first
      await coordinator.recoverSessions();
      
      // Create a new session
      const task = args.includes('--task') ? 
        args[args.indexOf('--task') + 1] : 
        await coordinator.promptForTask();
      
      const agent = args.includes('--agent') ? 
        args[args.indexOf('--agent') + 1] : 
        'claude';
      
      await coordinator.createSession({ task, agent });
      break;
    }
    
    case 'start': {
      // Start agent for a session
      const sessionId = args[1];
      if (!sessionId) {
        // Ask if user wants Kora assistance
        const koraRl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        console.log(`\n${CONFIG.colors.magenta}🤖 Kora AI Assistant Available${CONFIG.colors.reset}`);
        const useKora = await new Promise(resolve => {
          koraRl.question(`Would you like Kora to guide you? (Y/n): `, answer => {
            koraRl.close();
            resolve(answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no');
          });
        });
        
        if (useKora) {
          console.log(`\n${CONFIG.colors.magenta}Launching Kora...${CONFIG.colors.reset}`);
          const chatScript = path.join(__dirname, 'agent-chat.js');
          const child = spawn('node', [chatScript], { 
            stdio: 'inherit',
            env: process.env 
          });
          
          child.on('exit', (code) => {
            process.exit(code);
          });
          return; // Hand off to Kora
        }

        // No session ID provided - show interactive menu
        console.log(`\n${CONFIG.colors.bright}DevOps Agent Session Manager${CONFIG.colors.reset}\n`);
        
        // Show existing sessions first
        const locks = fs.existsSync(coordinator.locksPath) ? 
          fs.readdirSync(coordinator.locksPath).filter(f => f.endsWith('.lock')) : [];
        
        if (locks.length > 0) {
          console.log(`${CONFIG.colors.blue}Active Sessions:${CONFIG.colors.reset}`);
          coordinator.listSessions();
          console.log();
        } else {
          console.log(`${CONFIG.colors.dim}No active sessions${CONFIG.colors.reset}\n`);
        }
        
        console.log('What would you like to do?\n');
        console.log(`  ${CONFIG.colors.green}1${CONFIG.colors.reset} - Create a new session`);
        console.log(`  ${CONFIG.colors.green}2${CONFIG.colors.reset} - Close a session`);
        console.log(`  ${CONFIG.colors.green}q${CONFIG.colors.reset} - Quit\n`);
        
        let rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const choice = await new Promise(resolve => {
          rl.question('Enter your choice: ', resolve);
        });
        rl.close();
        
        switch(choice) {
          case '1': {
            // Prompt for agent type
            rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout
            });
            
            console.log(`\n${CONFIG.colors.blue}Select Agent Type:${CONFIG.colors.reset}`);
            console.log(`  1) Claude (default)`);
            console.log(`  2) Cline`);
            console.log(`  3) Cursor`);
            console.log(`  4) Copilot`);
            console.log(`  5) Warp`);
            console.log(`  6) Custom\n`);
            
            const agentChoice = await new Promise(resolve => {
              rl.question('Agent [1]: ', resolve);
            });
            
            // Improved agent selection handling
            const validAgents = {
              '1': 'claude',
              '2': 'cline',
              '3': 'cursor',
              '4': 'copilot',
              '5': 'warp'
            };
            
            let agent = 'claude';
            const choiceTrimmed = agentChoice.trim().toLowerCase();
            
            // Handle numeric choice
            if (validAgents[choiceTrimmed]) {
              agent = validAgents[choiceTrimmed];
            } 
            // Handle explicit string match (e.g. user typed "warp")
            else if (Object.values(validAgents).includes(choiceTrimmed)) {
              agent = choiceTrimmed;
            }
            // Handle custom input
            else if (choiceTrimmed === '6' || choiceTrimmed === 'custom') {
                const customAgent = await new Promise(resolve => {
                  rl.question('Enter agent name: ', resolve);
                });
                agent = customAgent.trim() || 'claude';
            }
            // Invalid input handling
            else if (choiceTrimmed) {
               console.log(`${CONFIG.colors.yellow}Unknown agent '${choiceTrimmed}', defaulting to Claude.${CONFIG.colors.reset}`);
               agent = 'claude';
            }
            // Default (empty input)
            else {
               agent = 'claude';
            }
            
            rl.close();
            await coordinator.createAndStart({ agent });
            break;
          }
          case '2':
            await coordinator.selectAndCloseSession();
            break;
          case 'q':
          case 'Q':
            console.log('Goodbye!');
            break;
          default:
            console.log(`${CONFIG.colors.red}Invalid choice${CONFIG.colors.reset}`);
        }
        break;
      }
      await coordinator.startAgent(sessionId);
      break;
    }
    
    case 'create-and-start': {
      // Clean up orphaned sessions first
      await coordinator.recoverSessions();
      
      // Create session and immediately start agent
      const task = args.includes('--task') ? 
        args[args.indexOf('--task') + 1] : 
        await coordinator.promptForTask();
      
      const agent = args.includes('--agent') ? 
        args[args.indexOf('--agent') + 1] : 
        undefined; // Pass undefined to trigger prompt in createSession
      
      const skipSetup = args.includes('--skip-setup');
      const skipUpdate = args.includes('--skip-update');
      
      await coordinator.createAndStart({ task, agent, skipSetup, skipUpdate });
      break;
    }
    
    case 'request': {
      // Request a session (for Claude to call)
      const agent = args[1] || 'claude';
      await coordinator.requestSession(agent);
      break;
    }

    case 'resume': {
      // Resume an existing session by ID or Task
      const sessionId = args.includes('--session-id') ? 
        args[args.indexOf('--session-id') + 1] : 
        undefined;
      
      const task = args.includes('--task') ? 
        args[args.indexOf('--task') + 1] : 
        undefined;

      let targetSessionId = sessionId;

      if (!targetSessionId && task) {
        const session = coordinator.findSessionByTask(task);
        if (session) {
          targetSessionId = session.sessionId;
        }
      }

      if (targetSessionId) {
        // Check if session is already active/claimed?
        // startAgent checks existence.
        const success = await coordinator.startAgent(targetSessionId);
        if (!success) process.exit(1);
      } else {
        console.error(`${CONFIG.colors.red}Error: Could not find session to resume.${CONFIG.colors.reset}`);
        if (task) console.error(`No session found matching task: ${task}`);
        else console.error(`Please provide --session-id or --task`);
        process.exit(1);
      }
      break;
    }
    
  case 'list': {
    coordinator.listSessions();
    break;
  }
  
  case 'close': {
    // Close a session and clean up
    const sessionId = args[1];
    if (sessionId) {
      await coordinator.closeSession(sessionId);
    } else {
      // Interactive selection
      await coordinator.selectAndCloseSession();
    }
    break;
  }
  
    case 'cleanup': {
      // Clean up stale sessions and worktrees
      await coordinator.cleanupAll();
      break;
    }

    case 'recover': {
      // Recover orphaned sessions from worktrees
      await coordinator.recoverSessions();
      break;
    }

    case 'recover': {
      // Recover orphaned sessions from worktrees
      await coordinator.recoverSessions();
      break;
    }
  
  case 'help':
  default: {
      console.log(`
${CONFIG.colors.bright}DevOps Session Coordinator${CONFIG.colors.reset}

${CONFIG.colors.blue}Usage:${CONFIG.colors.reset}
  node session-coordinator.js <command> [options]

${CONFIG.colors.blue}Commands:${CONFIG.colors.reset}
  ${CONFIG.colors.green}create${CONFIG.colors.reset}              Create a new session and show instructions
  ${CONFIG.colors.green}start <id>${CONFIG.colors.reset}          Start DevOps agent for a session
  ${CONFIG.colors.green}create-and-start${CONFIG.colors.reset}    Create session and start agent (all-in-one)
  ${CONFIG.colors.green}request [agent]${CONFIG.colors.reset}     Request a session (for Claude to call)
  ${CONFIG.colors.green}list${CONFIG.colors.reset}                List all active sessions
  ${CONFIG.colors.green}close [id]${CONFIG.colors.reset}          Close session and clean up worktree
  ${CONFIG.colors.green}cleanup${CONFIG.colors.reset}             Clean up all stale sessions
  ${CONFIG.colors.green}help${CONFIG.colors.reset}                Show this help

${CONFIG.colors.blue}Options:${CONFIG.colors.reset}
  --task <name>       Task or feature name
  --agent <type>      Agent type (claude, cline, copilot, etc.)

${CONFIG.colors.blue}Examples:${CONFIG.colors.reset}
  ${CONFIG.colors.dim}# Workflow 1: Manual coordination${CONFIG.colors.reset}
  node session-coordinator.js create --task "auth-feature"
  ${CONFIG.colors.dim}# Copy instructions to Claude${CONFIG.colors.reset}
  node session-coordinator.js start <session-id>

  ${CONFIG.colors.dim}# Workflow 2: All-in-one${CONFIG.colors.reset}
  node session-coordinator.js create-and-start --task "api-endpoints"

  ${CONFIG.colors.dim}# Workflow 3: Claude requests a session${CONFIG.colors.reset}
  node session-coordinator.js request claude

${CONFIG.colors.yellow}Typical Workflow:${CONFIG.colors.reset}
1. Run: ${CONFIG.colors.green}node session-coordinator.js create-and-start${CONFIG.colors.reset}
2. Copy the displayed instructions to Claude/Cline
3. Claude navigates to the worktree and starts working
4. Agent automatically commits and pushes changes
`);
    }
  }
}

// Run the CLI only if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`${CONFIG.colors.red}Error: ${err.message}${CONFIG.colors.reset}`);
    process.exit(1);
  });
}
