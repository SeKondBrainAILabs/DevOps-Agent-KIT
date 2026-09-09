#!/usr/bin/env node

/**
 * ============================================================================
 * DEVOPS-AGENT SETUP WIZARD (v2.0)
 * ============================================================================
 * 
 * Enhanced setup experience with explanations and auto-detection.
 * 
 * What this does:
 * - Configures your developer environment
 * - Sets up git automation
 * - Creates VS Code integration
 * - Installs required dependencies
 * 
 * Why it matters:
 * - One-time setup for smooth development
 * - Personalized configuration
 * - Ready-to-use AI agent integration
 * 
 * Usage: s9n-devops-agent setup
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { credentialsManager } from './credentials-manager.js';
import { SessionCoordinator } from './session-coordinator.js';
import {
  colors,
  status,
  showWelcome,
  sectionTitle,
  explain,
  tip,
  warn,
  info,
  success,
  error as errorMsg,
  confirm,
  prompt as uiPrompt,
  choose,
  progressStep,
  drawSection
} from './ui-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Backward compatibility log functions
const log = {
  info: (msg) => info(msg),
  success: (msg) => success(msg),
  warn: (msg) => warn(msg),
  error: (msg) => errorMsg(msg),
  header: () => console.log('\n' + '━'.repeat(70) + '\n'),
  title: (msg) => sectionTitle(msg),
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function findProjectRoot() {
  let currentDir = process.cwd();
  
  // Look for .git directory to find project root
  while (currentDir !== path.dirname(currentDir)) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Fallback to current directory
  return process.cwd();
}

// Use UI utilities prompt with fallback
async function prompt(question) {
  // Strip ANSI codes and clean question for display
  const cleanQuestion = question.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return await uiPrompt(cleanQuestion);
}

function validateInitials(initials) {
  // Remove spaces and convert to lowercase
  const cleaned = initials.replace(/\s/g, '').toLowerCase();
  
  // Check if exactly 3 letters
  if (!/^[a-z]{3}$/.test(cleaned)) {
    return null;
  }
  
  return cleaned;
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.backup.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    log.info(`Backed up ${path.basename(filePath)} to ${path.basename(backupPath)}`);
    return backupPath;
  }
  return null;
}

function setupFolderStructure(projectRoot) {
  log.header();
  log.title('📂 Checking Folder Structure');

  // Folders defined in folders.md
  const standardFolders = [
    'src',
    'test',
    'docs',
    'scripts',
    'deploy_test',
    'product_requirement_docs',
    'infrastructure'
  ];

  const missingFolders = standardFolders.filter(folder => !fs.existsSync(path.join(projectRoot, folder)));

  if (missingFolders.length === 0) {
    log.info('Standard folder structure already exists.');
    return;
  }

  log.info('Found missing standard folders:');
  missingFolders.forEach(folder => console.log(`   - ${folder}/`));
  console.log();

  explain(`
${colors.bright}Recommended Structure:${colors.reset}
Standard folders help organize your code, tests, and documentation.
This structure is compatible with the DevOps Agent's automation tools.
  `);

  return missingFolders;
}

async function checkContractsExist(projectRoot) {
  // Search recursively for contract folders and files
  try {
    const requiredContracts = [
      'FEATURES_CONTRACT.md',
      'API_CONTRACT.md',
      'DATABASE_SCHEMA_CONTRACT.md',
      'SQL_CONTRACT.json',
      'THIRD_PARTY_INTEGRATIONS.md',
      'INFRA_CONTRACT.md'
    ];

    // Map to hold found files for each type
    const contractMap = {};
    requiredContracts.forEach(c => contractMap[c] = []);

    // Find all files that look like contracts
    // We look for files containing "CONTRACT" in the name, excluding typical ignores
    // Use -iname for case-insensitive matching
    const findCommand = `find "${projectRoot}" -type f \\( -iname "*CONTRACT*.md" -o -iname "*CONTRACT*.json" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/local_deploy/*"`;
    
    let files = [];
    try {
        const output = execSync(findCommand, { encoding: 'utf8' }).trim();
        files = output.split('\n').filter(Boolean);
    } catch (e) {
        // find might fail if no matches or other issues, just treat as empty
    }

    // Categorize found files
    for (const file of files) {
        const basename = path.basename(file).toUpperCase();
        
        // Skip files in the target directory itself (House_Rules_Contracts) to avoid self-merging if we run this multiple times
        // actually we SHOULD include them to see if we have them, but valid if we are merging duplicates from elsewhere
        
        let matched = false;
        
        if (basename.includes('FEATURE')) contractMap['FEATURES_CONTRACT.md'].push(file);
        else if (basename.includes('API')) contractMap['API_CONTRACT.md'].push(file);
        else if (basename.includes('DATABASE') || basename.includes('SCHEMA')) contractMap['DATABASE_SCHEMA_CONTRACT.md'].push(file);
        else if (basename.includes('SQL')) contractMap['SQL_CONTRACT.json'].push(file);
        else if (basename.includes('INFRA')) contractMap['INFRA_CONTRACT.md'].push(file);
        else if (basename.includes('THIRD') || basename.includes('INTEGRATION')) contractMap['THIRD_PARTY_INTEGRATIONS.md'].push(file);
        else {
             // Fallback or ignore
        }
    }

    const targetDir = path.join(projectRoot, 'House_Rules_Contracts');
    let hasChanges = false;

    // Process each contract type
    let scatteredCount = 0;
    let centralCount = 0;
    let missingCount = 0;
    
    // Print summary header
    console.log(`\n${colors.bright}Contract Search Results:${colors.reset}`);
    
    for (const [type, foundFiles] of Object.entries(contractMap)) {
        // Filter out unique paths (resolve them)
        const uniqueFiles = [...new Set(foundFiles.map(f => path.resolve(f)))];
        const isCentral = fs.existsSync(path.join(targetDir, type));
        
        let statusIcon = '';
        let statusText = '';
        
        if (isCentral) {
            statusIcon = colors.green + '✓' + colors.reset;
            statusText = colors.green + 'Present (Central)' + colors.reset;
            centralCount++;
        } else if (uniqueFiles.length > 0) {
            statusIcon = colors.yellow + '⚠️' + colors.reset;
            statusText = colors.yellow + `Found ${uniqueFiles.length} scattered file(s)` + colors.reset;
            scatteredCount++;
        } else {
            statusIcon = colors.red + '✗' + colors.reset;
            statusText = colors.red + 'Missing' + colors.reset;
            missingCount++;
        }
        
        console.log(` ${statusIcon} ${type.padEnd(30)} : ${statusText}`);
        
        if (uniqueFiles.length > 0 && !isCentral) {
             // Show locations for scattered files
             uniqueFiles.forEach(f => console.log(`    ${colors.dim}- ${path.relative(projectRoot, f)}${colors.reset}`));
             
             const shouldMerge = await confirm(`   Merge/Copy ${uniqueFiles.length} file(s) to House_Rules_Contracts/${type}?`, true);
             
             if (shouldMerge) {
                 ensureDirectoryExists(targetDir);
                 const targetPath = path.join(targetDir, type);
                 
                 let mergedContent = '';
                 // Handle JSON vs MD
                 if (type.endsWith('.json')) {
                     // For JSON, we try to merge arrays/objects or just list them
                     const mergedJson = [];
                     for (const file of uniqueFiles) {
                         try {
                             const content = JSON.parse(fs.readFileSync(file, 'utf8'));
                             mergedJson.push({ source: path.relative(projectRoot, file), content });
                         } catch (e) {
                             log.warn(`Skipping invalid JSON in ${path.basename(file)}`);
                         }
                     }
                     mergedContent = JSON.stringify(mergedJson, null, 2);
                 } else {
                     // Markdown
                     mergedContent = `# Merged ${type}\n\nGenerated on ${new Date().toISOString()}\n\n`;
                     for (const file of uniqueFiles) {
                         const content = fs.readFileSync(file, 'utf8');
                         mergedContent += `\n<!-- SOURCE: ${path.relative(projectRoot, file)} -->\n`;
                         mergedContent += `## Source: ${path.basename(file)}\n(Path: ${path.relative(projectRoot, file)})\n\n`;
                         mergedContent += `${content}\n\n---\n`;
                     }
                 }
                 
                 fs.writeFileSync(targetPath, mergedContent);
                 log.success(`   Merged into ${path.relative(projectRoot, targetPath)}`);
                 hasChanges = true;
                 centralCount++; // Now it's central
                 scatteredCount--;
             }
        }
    }

    console.log(); // Spacing

    // Final check logic
    const result = {
        missingCount,
        scatteredCount,
        centralCount,
        valid: missingCount === 0
    };

    if (missingCount === 0) {
        if (hasChanges) log.success('Contracts consolidated and verified.');
        else log.info('All required contracts are present.');
        return result;
    }
    
    if (scatteredCount > 0) {
        log.warn(`${scatteredCount} contract types exist but are not centralized.`);
        log.warn('We recommend merging them, but you can proceed without it.');
    }
    
    if (missingCount > 0) {
        log.warn(`${missingCount} contract types are completely missing.`);
    }
    
    return result;
    
  } catch (error) {
    log.warn(`Error searching for contracts: ${error.message}`);
    return { missingCount: 1, scatteredCount: 0, valid: false }; // Fallback
  }
}

async function generateContracts(projectRoot) {
  log.header();
  log.title('📜 Generating Contracts');
  
  const scriptsDir = path.join(projectRoot, 'scripts', 'contract-automation');
  const generateScript = path.join(scriptsDir, 'generate-contracts.js');
  const analyzeScript = path.join(scriptsDir, 'analyze-with-llm.js');
  
  if (!fs.existsSync(generateScript)) {
    log.error('Contract generation scripts not found!');
    return;
  }
  
  try {
    // 1. Run local scan
    info('Running local codebase scan...');
    execSync(`node "${generateScript}"`, { cwd: projectRoot, stdio: 'inherit' });
    success('Scan complete.');
    
    // 2. Run LLM analysis if key exists
    if (credentialsManager.hasGroqApiKey()) {
      info('Enhancing contracts with AI analysis...');
      try {
        // Inject env for the child process
        const env = { ...process.env };
        credentialsManager.injectEnv(); // Ensure current process has it
        // Note: execSync inherits env by default, but explicit is safer if we modified it
        if (!env.GROQ_API_KEY && credentialsManager.getGroqApiKey()) {
           env.GROQ_API_KEY = credentialsManager.getGroqApiKey();
           env.OPENAI_API_KEY = credentialsManager.getGroqApiKey();
        }

        execSync(`node "${analyzeScript}" --scan-results=House_Rules_Contracts/contract-scan-results.json`, { 
          cwd: projectRoot, 
          stdio: 'inherit',
          env
        });
        success('AI analysis complete.');
      } catch (err) {
        warn(`AI analysis failed: ${err.message}`);
        warn('Contracts generated but without AI enhancements.');
      }
    } else {
      warn('Skipping AI analysis (no Groq API Key).');
      warn('Run "s9n-devops-agent creds set-groq-key <key>" later to enable this.');
    }
    
  } catch (error) {
    log.error(`Contract generation failed: ${error.message}`);
  }
}

// ===========================================================================
// SETUP FUNCTIONS
// ===========================================================================

async function setupNpmPackages(projectRoot) {
  log.header();
  log.title('📦 Installing NPM Packages');
  
  const packageJsonPath = path.join(projectRoot, 'package.json');
  
  // Check if package.json exists, create if not
  if (!fs.existsSync(packageJsonPath)) {
    log.info('Creating package.json...');
    const packageJson = {
      name: path.basename(projectRoot),
      version: '1.0.0',
      type: 'module',
      description: 'SecondBrain Development Project',
      scripts: {},
      devDependencies: {}
    };
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    log.success('Created package.json');
  }
  
  // Read current package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // Ensure type: module
  if (packageJson.type !== 'module') {
    packageJson.type = 'module';
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    log.success('Set package.json type to "module"');
  }
  
  // Install required packages
  log.info('Installing chokidar and execa...');
  try {
    execSync('npm install --save-dev chokidar execa', { 
      cwd: projectRoot,
      stdio: 'inherit' 
    });
    log.success('Installed required npm packages');
  } catch (error) {
    log.warn('Could not install packages automatically. Please run: npm install --save-dev chokidar execa');
  }
  
  return packageJson;
}

function setupVSCodeSettings(projectRoot, initials, agentName = 'Claude') {
  log.header();
  log.title('⚙️  Setting up VS Code Configuration');
  
  const vscodeDir = path.join(projectRoot, '.vscode');
  ensureDirectoryExists(vscodeDir);
  
  // Setup settings.json
  const settingsPath = path.join(vscodeDir, 'settings.json');
  let settings = {};
  
  if (fs.existsSync(settingsPath)) {
    backupFile(settingsPath);
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      log.warn('Could not parse existing settings.json, creating new one');
    }
  }
  
  // Add cs-devops-agent settings
  settings['terminal.integrated.env.osx'] = settings['terminal.integrated.env.osx'] || {};
  settings['terminal.integrated.env.linux'] = settings['terminal.integrated.env.linux'] || {};
  settings['terminal.integrated.env.windows'] = settings['terminal.integrated.env.windows'] || {};
  
  const envVars = {
    AC_BRANCH_PREFIX: `dev_${initials}_`,
    AC_DAILY_PREFIX: `dev_${initials}_`,
    AC_TZ: 'Asia/Dubai',
    AC_PUSH: 'true',
    AC_REQUIRE_MSG: 'true',
    AC_MSG_MIN_BYTES: '20',
    AC_DEBOUNCE_MS: '1500',
    AC_MSG_DEBOUNCE_MS: '3000',
    AC_CLEAR_MSG_WHEN: 'push',
    AC_ROLLOVER_PROMPT: 'true',
    AC_DEBUG: 'false'
  };
  
  // Apply to all platforms
  Object.assign(settings['terminal.integrated.env.osx'], envVars);
  Object.assign(settings['terminal.integrated.env.linux'], envVars);
  Object.assign(settings['terminal.integrated.env.windows'], envVars);
  
  // Add file associations for commit messages
  settings['files.associations'] = settings['files.associations'] || {};
  settings['files.associations'][`.${agentName.toLowerCase()}-commit-msg`] = 'markdown';
  settings['files.associations'][`${agentName.toUpperCase()}_CHANGELOG.md`] = 'markdown';
  
  // Add file watchers
  settings['files.watcherExclude'] = settings['files.watcherExclude'] || {};
  settings['files.watcherExclude']['**/Archive/**'] = true;
  settings['files.watcherExclude']['**/__pycache__/**'] = true;
  
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log.success(`Created/Updated VS Code settings with prefix: dev_${initials}_`);
  
  return settings;
}

function setupVSCodeTasks(projectRoot, initials, agentName = 'Claude') {
  log.title('📋 Setting up VS Code Tasks');
  
  const vscodeDir = path.join(projectRoot, '.vscode');
  const tasksPath = path.join(vscodeDir, 'tasks.json');
  
  let tasks = {
    version: '2.0.0',
    tasks: []
  };
  
  if (fs.existsSync(tasksPath)) {
    backupFile(tasksPath);
    try {
      tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    } catch (e) {
      log.warn('Could not parse existing tasks.json, creating new one');
    }
  }
  
  // Remove old cs-devops-agent tasks if they exist
  tasks.tasks = tasks.tasks.filter(task => !task.label.includes('DevOps Agent'));
  
  // Add new cs-devops-agent tasks
  const autoCommitTasks = [
    {
      label: '🚀 Start DevOps Agent Worker',
      type: 'shell',
      command: 'node',
      args: ['ScriptCS_DevOpsAgent/cs-devops-agent-worker.js'],
      options: {
        env: {
          AC_BRANCH_PREFIX: `dev_${initials}_`,
          AC_DEBUG: 'true'
        }
      },
      problemMatcher: [],
      presentation: {
        echo: true,
        reveal: 'always',
        focus: false,
        panel: 'dedicated',
        showReuseMessage: false,
        clear: true
      },
      runOptions: {
        runOn: 'manual'
      }
    },
    {
      label: '🛑 Stop DevOps Agent Worker',
      type: 'shell',
      command: 'pkill -f "node.*cs-devops-agent-worker" || echo "Worker not running"',
      problemMatcher: [],
      presentation: {
        echo: true,
        reveal: 'always',
        focus: false,
        panel: 'shared'
      }
    },
    {
      label: '📝 Create Commit Message',
      type: 'shell',
      command: `echo "feat(): " > .${agentName.toLowerCase()}-commit-msg && code .${agentName.toLowerCase()}-commit-msg`,
      problemMatcher: [],
      presentation: {
        echo: false,
        reveal: 'never'
      }
    },
    {
      label: '📊 Show Git Status',
      type: 'shell',
      command: 'git status && echo "" && git branch --show-current',
      problemMatcher: [],
      presentation: {
        echo: true,
        reveal: 'always',
        focus: false,
        panel: 'shared'
      }
    }
  ];
  
  tasks.tasks.push(...autoCommitTasks);
  
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
  log.success('Created/Updated VS Code tasks.json');
  
  return tasks;
}

function setupCommitFiles(projectRoot, initials, agentName = 'Claude') {
  log.header();
  log.title('📝 Setting up Commit Message Files');
  
  // Setup commit message file (dynamic name)
  const commitMsgPath = path.join(projectRoot, `.${agentName.toLowerCase()}-commit-msg`);
  if (!fs.existsSync(commitMsgPath)) {
    fs.writeFileSync(commitMsgPath, '');
    log.success(`Created .${agentName.toLowerCase()}-commit-msg file`);
  } else {
    log.info(`.${agentName.toLowerCase()}-commit-msg already exists`);
  }
  
  // Setup CHANGELOG (standard name in root)
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    const initialContent = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project setup with DevOps Agent integration

---

## Change History (${agentName} Assistant)

`;
    fs.writeFileSync(changelogPath, initialContent);
    log.success('Created CHANGELOG.md in project root');
  } else {
    log.info('CHANGELOG.md already exists in project root');
  }
  
  // Setup Documentation/infrastructure.md
  const docDir = path.join(projectRoot, 'Documentation');
  const infraDocPath = path.join(docDir, 'infrastructure.md');
  
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
    log.success('Created Documentation directory');
  }
  
  if (!fs.existsSync(infraDocPath)) {
    const infraTemplate = `# Infrastructure Change Log

This document tracks all infrastructure changes made to the project. It is automatically updated when infrastructure-related files are modified.

## Format Guidelines

Each entry should follow this format:
\`\`\`
## [Date] - [Agent/Developer Name]
### Category: [Config|Dependencies|Build|Architecture|Database|API|Security]
**Change Type**: [Added|Modified|Removed|Fixed]
**Component**: [Affected component/service]
**Description**: Brief description of the change
**Reason**: Why this change was necessary
**Impact**: Potential impacts or considerations
**Files Changed**: 
- file1.js
- config/settings.json
\`\`\`

---

<!-- New entries will be added above this line -->`;
    
    fs.writeFileSync(infraDocPath, infraTemplate);
    log.success('Created infrastructure documentation template');
  } else {
    log.info('Documentation/infrastructure.md already exists');
  }
  
  // Setup Agent Rules (dynamic name)
  const agentMdPath = path.join(projectRoot, `${agentName.toUpperCase()}.md`);
  if (!fs.existsSync(agentMdPath)) {
    const agentRules = `# House Rules for ${agentName}

## Developer Information
- Developer Initials: ${initials.toUpperCase()}
- Branch Prefix: dev_${initials}_
- Default Timezone: Asia/Dubai
- Project Root: ${projectRoot}

## Commit Policy
After applying any file edits, you must document changes in two places:

### 1. Single Commit Message File (\`.${agentName.toLowerCase()}-commit-msg\`)

**Location**: \`/.${agentName.toLowerCase()}-commit-msg\`  
**Action**: APPEND to this file (don't overwrite) - the worker will clean it  
**Format**:
\`\`\`
type(scope): subject line describing the change (max 72 characters)

- Bullet point 1: Specific file or module changed and what was done
- Bullet point 2: Behavioral change or feature added (if applicable)
- Bullet point 3: Any side effects or related updates (if applicable)
\`\`\`

**Commit Types**:
- \`feat\`: New feature or capability added
- \`fix\`: Bug fix or error correction
- \`refactor\`: Code restructuring without changing functionality
- \`docs\`: Documentation updates (README, comments, etc.)
- \`test\`: Adding or modifying tests
- \`chore\`: Maintenance tasks (configs, dependencies, cleanup)

**Rules**:
- Be specific about WHAT changed and WHERE (mention file names)
- Describe the IMPACT of the change, not just what was done
- Never include bash commands or command-line syntax
- Never attempt to run git commands directly
- Keep the subject line under 72 characters
- Use present tense ("add" not "added", "fix" not "fixed")

### 2. Changelog Documentation (\`CHANGELOG.md\`)
**Location**: \`/CHANGELOG.md\`
**Action**: APPEND a new section (don't overwrite)  
**Format**:
\`\`\`markdown
## YYYY-MM-DDTHH:MM:SSZ
type(scope): exact same subject line from commit message
- Exact same bullet point 1 from commit message
- Exact same bullet point 2 from commit message
- Exact same bullet point 3 from commit message (if used)
\`\`\`

**Timestamp Format**: ISO-8601 with timezone (Z for UTC)
- Example: \`2025-09-15T14:30:00Z\`
- Use current time when making the change

### Example of Both Files

**.${agentName.toLowerCase()}-commit-msg** (append new entries):
\`\`\`
feat(api): add webhook support for real-time notifications

- Created WebhookManager class in services/webhook_manager.py
- Added POST /api/webhooks endpoint for webhook registration
- Integrated webhook triggers into event processing pipeline
\`\`\`

**CHANGELOG.md** (appended):
\`\`\`markdown
## 2025-09-15T14:35:00Z
feat(api): add webhook support for real-time notifications
- Created WebhookManager class in services/webhook_manager.py
- Added POST /api/webhooks endpoint for webhook registration
- Integrated webhook triggers into event processing pipeline
\`\`\`

## DevOps Agent Worker
The cs-devops-agent worker is configured to:
- Use branch prefix: dev_${initials}_
- Create daily branches: dev_${initials}_YYYY-MM-DD
- Auto-commit when .${agentName.toLowerCase()}-commit-msg changes
- Handle daily rollover at midnight
- Automatically stage, commit, and push changes
- Clear commit message after successful push

## Code Quality & Documentation Standards

### BE A THOUGHTFUL ENGINEER
Write code that your future self and others can understand easily.

### 1. Module/File Headers
Every file should start with a comprehensive description:
\`\`\`javascript
/**
 * Module Name - Brief Description
 * ================================
 * 
 * This module handles [main purpose]. It provides [key functionality].
 * 
 * Key Components:
 * - ComponentA: Does X
 * - ComponentB: Handles Y
 * 
 * Dependencies:
 * - External: library1, library2
 * - Internal: module.submodule
 * 
 * Usage Example:
 *     import { MainClass } from './this-module';
 *     const instance = new MainClass();
 *     const result = instance.process();
 * */
\`\`\`

### 2. Function/Method Documentation
\`\`\`javascript
/**
 * Execute a named process with the provided input.
 * 
 * This method runs through each step sequentially,
 * passing output from one step as input to the next.
 * 
 * @param {string} processName - Name of process to execute
 * @param {string} inputText - Initial input text to process
 * @param {Object} [context] - Optional context for variable substitution
 * @returns {ProcessResult} Object containing success status and outputs
 * @throws {Error} If processName doesn't exist
 * @throws {ConnectionError} If service is unavailable
 * 
 * @example
 * const result = await processor.execute("validate", "input data");
 * if (result.success) {
 *     console.log(result.output);
 * }
 */
async function executeProcess(processName, inputText, context) {
    // ...
}
\`\`\`

### 3. Inline Comments
\`\`\`javascript
// Good inline comments explain WHY, not WHAT
const retryDelay = 1000; // Wait 1 second between retries to avoid rate limiting

// Document complex logic
if (mode === 'production') {
    // Force secure connections in production
    // This ensures data privacy for sensitive operations
    options.secure = true;
}
\`\`\`

### 4. TODO/FIXME Comments
\`\`\`javascript
// TODO(${initials}, YYYY-MM-DD): Implement caching for frequent requests
// This would reduce API calls by ~40% based on usage patterns

// FIXME(${initials}, YYYY-MM-DD): Handle edge case when input is null
\`\`\`

## Code Quality Standards
- Ensure all changes maintain existing code style and conventions
- Add appropriate error handling for new functionality
- Update related documentation when changing functionality
- Write self-documenting code with clear variable and function names
- Add JSDoc comments for all public functions and classes

## Communication
- When asked about changes, reference the ${agentName.toUpperCase()}_CHANGELOG.md for history
- Provide context about why changes were made, not just what was changed
- Alert user to any breaking changes or required migrations

## Image and Asset Creation
- **NEVER create or generate images without explicit user permission**
- Always ask before creating any image files (PNG, JPG, SVG, etc.)

## Version Control Best Practices
- Make atomic commits - each commit should represent one logical change
- Write meaningful commit messages following the conventional format
- Review changes before committing to ensure quality
- Keep commits focused and avoid mixing unrelated changes

## Security Considerations
- Never commit sensitive information (passwords, API keys, tokens)
- Use environment variables for configuration that varies by environment
- Validate all user input before processing
`;
    fs.writeFileSync(agentMdPath, agentRules);
    log.success(`Created ${agentName.toUpperCase()}.md with house rules`);
  } else {
    log.info(`${agentName.toUpperCase()}.md already exists`);
  }
  
  // Update .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    let gitignore = fs.readFileSync(gitignorePath, 'utf8');
    
    // Check if entries already exist
    const entriesToAdd = [
      `.${agentName.toLowerCase()}-commit-msg`,
      '**/Archive/',
      '*.backup.*',
      'local_deploy/',
      '.file-coordination/'
    ];
    
    let modified = false;
    for (const entry of entriesToAdd) {
      if (!gitignore.includes(entry)) {
        gitignore += `\n${entry}`;
        modified = true;
      }
    }
    
    if (modified) {
      gitignore += '\n';
      fs.writeFileSync(gitignorePath, gitignore);
      log.success('Updated .gitignore');
    }
  }
}

function createRunScripts(projectRoot, initials, packageJson, agentName = 'Claude') {
  log.header();
  log.title('🎯 Creating Run Scripts');
  
  // Update package.json scripts
  packageJson.scripts = packageJson.scripts || {};
  packageJson.scripts['cs-devops-agent'] = 'node ScriptCS_DevOpsAgent/cs-devops-agent-worker.js';
  packageJson.scripts['cs-devops-agent:debug'] = 'AC_DEBUG=true node ScriptCS_DevOpsAgent/cs-devops-agent-worker.js';
  packageJson.scripts['cs-devops-agent:setup'] = 'node ScriptCS_DevOpsAgent/setup-cs-devops-agent.js';
  
  const packageJsonPath = path.join(projectRoot, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  log.success('Updated package.json scripts');
  
  // Create a personalized shell script
  const scriptContent = `#!/bin/bash
# DevOps Agent Worker Runner for ${initials.toUpperCase()}
# Generated on ${new Date().toISOString()}

echo "🚀 Starting DevOps Agent Worker"
echo "Developer: ${initials.toUpperCase()}"
echo "Branch Prefix: dev_${initials}_"
echo ""

# Export environment variables
export AC_BRANCH_PREFIX="dev_${initials}_"
export AC_DAILY_PREFIX="dev_${initials}_"
export AC_TZ="Asia/Dubai"
export AC_PUSH="true"
export AC_REQUIRE_MSG="true"
export AC_MSG_MIN_BYTES="20"
export AC_DEBOUNCE_MS="1500"
export AC_MSG_DEBOUNCE_MS="3000"
export AC_CLEAR_MSG_WHEN="push"
# Daily rollover is automatic - no prompting needed
export AC_ROLLOVER_PROMPT="false"
export AC_DEBUG="false"
# Set message file explicitly to match dynamic configuration
export AC_MSG_FILE=".${agentName.toLowerCase()}-commit-msg"

# Check for debug flag
if [ "$1" == "--debug" ] || [ "$1" == "-d" ]; then
  export AC_DEBUG="true"
  echo "🐛 Debug mode enabled"
fi

# Check for no-push flag
if [ "$1" == "--no-push" ] || [ "$1" == "-n" ]; then
  export AC_PUSH="false"
  echo "📦 Push disabled (local commits only)"
fi

# Run the cs-devops-agent worker
node ScriptCS_DevOpsAgent/cs-devops-agent-worker.js
`;
  
  const scriptPath = path.join(projectRoot, `run-cs-devops-agent-${initials}.sh`);
  fs.writeFileSync(scriptPath, scriptContent);
  fs.chmodSync(scriptPath, '755');
  log.success(`Created personalized run script: run-cs-devops-agent-${initials}.sh`);
  
  // Create a .env.example file
  const envExampleContent = `# DevOps Agent Worker Configuration
# Copy to .env and customize as needed

# Developer Settings
AC_BRANCH_PREFIX=dev_${initials}_
AC_DAILY_PREFIX=dev_${initials}_

# Timezone (for daily branch creation)
AC_TZ=Asia/Dubai

# Git Settings
AC_PUSH=true

# Message Requirements
AC_REQUIRE_MSG=true
AC_MSG_MIN_BYTES=20
AC_MSG_PATTERN=^(feat|fix|refactor|docs|test|chore)(\\([^)]+\\))?:\\s
AC_MSG_FILE=.${agentName.toLowerCase()}-commit-msg

# Timing Settings
AC_DEBOUNCE_MS=1500
AC_MSG_DEBOUNCE_MS=3000

# Behavior
AC_CLEAR_MSG_WHEN=push
# Daily rollover is automatic
AC_ROLLOVER_PROMPT=false
AC_DEBUG=false
`;
  
  const envExamplePath = path.join(projectRoot, '.env.example');
  fs.writeFileSync(envExamplePath, envExampleContent);
  log.success('Created .env.example file');
}

async function setupEnvFile(projectRoot) {
  log.header();
  log.title('🔑 Setting up Environment Variables');
  
  const envPath = path.join(projectRoot, '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    log.info('.env file already exists');
  } else {
    log.info('Creating .env file');
  }
  
  // Check if OPENAI_API_KEY is already present in memory (from credentials.json)
  const existingKey = credentialsManager.getGroqApiKey();
  
  // Check for OPENAI_API_KEY in .env content
  if (!envContent.includes('OPENAI_API_KEY=')) {
    if (existingKey) {
      log.info('Found existing Groq API Key in credentials store.');
      const newLine = envContent.endsWith('\n') || envContent === '' ? '' : '\n';
      envContent += `${newLine}# Groq API Key for Contract Automation\nOPENAI_API_KEY=${existingKey}\n`;
      fs.writeFileSync(envPath, envContent);
      log.success('Restored OPENAI_API_KEY to .env');
    } else {
      console.log();
      explain(`
${colors.bright}Groq API Key Setup${colors.reset}
The contract automation features use Groq LLM (via OpenAI compatibility).
You can enter your API key now, or set it later in the .env file.
      `);
      
      const apiKey = await prompt('Enter Groq API Key (leave empty to skip)');
      
      if (apiKey) {
        const newLine = envContent.endsWith('\n') || envContent === '' ? '' : '\n';
        envContent += `${newLine}# Groq API Key for Contract Automation\nOPENAI_API_KEY=${apiKey}\n`;
        fs.writeFileSync(envPath, envContent);
        
        // Also save to credentials manager for persistence across updates
        credentialsManager.setGroqApiKey(apiKey);
        
        log.success('Added OPENAI_API_KEY to .env');
      } else {
        log.warn('Skipped Groq API Key. Contract automation features may not work.');
        if (!fs.existsSync(envPath)) {
          fs.writeFileSync(envPath, '# Environment Variables\n');
        }
      }
    }
  } else {
    log.info('OPENAI_API_KEY is already configured in .env');
    // Ensure it's backed up in credentials manager if it exists in .env
    const match = envContent.match(/OPENAI_API_KEY=(.+)/);
    if (match && match[1] && !existingKey) {
        credentialsManager.setGroqApiKey(match[1].trim());
    }
  }
}

// ============================================================================
// CLEANUP FUNCTIONS
// ============================================================================

function cleanupDevOpsAgentFiles(projectRoot, agentName = 'Claude') {
  log.header();
  log.title('🧹 Cleaning Up DevOpsAgent Files');
  
  const scriptsDir = path.join(projectRoot, 'ScriptCS_DevOpsAgent');
  
  // Check if this is a submodule deployment
  const isSubmodule = fs.existsSync(path.join(scriptsDir, '.git'));
  const devOpsAgentRoot = isSubmodule ? scriptsDir : path.join(projectRoot, 'DevOpsAgent');
  
  if (!fs.existsSync(devOpsAgentRoot)) {
    log.info('No DevOpsAgent directory to clean up');
    return;
  }
  
  // Files to rename/archive in the DevOpsAgent folder
  const filesToRename = [
    { source: 'CLAUDE.md', target: 'CLAUDE.md.template' },
    { source: 'houserules.md', target: 'houserules.md.template' },
    { source: 'package.json', target: 'package.json.template' },
    { source: '.env.example', target: '.env.template' }
  ];
  
  for (const file of filesToRename) {
    const sourcePath = path.join(devOpsAgentRoot, file.source);
    const targetPath = path.join(devOpsAgentRoot, file.target);
    
    if (fs.existsSync(sourcePath) && !fs.existsSync(targetPath)) {
      try {
        fs.renameSync(sourcePath, targetPath);
        log.success(`Renamed ${file.source} to ${file.target} in DevOpsAgent folder`);
      } catch (error) {
        log.warn(`Could not rename ${file.source}: ${error.message}`);
      }
    }
  }
  
  // Create a .gitignore in DevOpsAgent to ignore deployed files
  const devOpsGitignore = path.join(devOpsAgentRoot, '.gitignore');
  if (!fs.existsSync(devOpsGitignore)) {
    const ignoreContent = `# Ignore deployed files to avoid conflicts\n*.deployed\n.env\nnode_modules/\n`;
    fs.writeFileSync(devOpsGitignore, ignoreContent);
    log.success('Created .gitignore in DevOpsAgent folder');
  }
}

// ============================================================================
// MAIN SETUP FLOW
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const skipPrompts = args.includes('--yes') || args.includes('-y');
  const rootArgIndex = args.indexOf('--root');
  const initialsArgIndex = args.indexOf('--initials');
  const agentArgIndex = args.indexOf('--agent');
  
  const providedRoot = rootArgIndex !== -1 ? args[rootArgIndex + 1] : null;
  const providedInitials = initialsArgIndex !== -1 ? args[initialsArgIndex + 1] : null;
  const providedAgent = agentArgIndex !== -1 ? args[agentArgIndex + 1] : null;

  console.clear();
  
  // Show welcome
  showWelcome('DevOps Agent Setup Wizard');
  console.log();
  
  explain(`
Welcome to the DevOps Agent setup! This wizard will configure everything
you need to start working with AI assistants on your project.

${colors.bright}What we'll set up:${colors.reset}
${status.checkmark} Your personal developer configuration
${status.checkmark} Git automation and branch management  
${status.checkmark} VS Code integration and shortcuts
${status.checkmark} Required npm dependencies

${colors.dim}This takes about 2 minutes.${colors.reset}
  `);
  console.log();
  
  // Find project root
  const projectRoot = providedRoot ? path.resolve(providedRoot) : findProjectRoot();
  log.info(`Project root: ${projectRoot}`);
  
  // Initialize coordinator to access settings
  const coordinator = new SessionCoordinator();
  const currentSettings = coordinator.loadSettings();
  
  // Get developer initials
  console.log();
  sectionTitle('Developer Identification');
  
  let initials = providedInitials || currentSettings.developerInitials;
  
  if (!initials) {
    explain(`
${colors.bright}What:${colors.reset} Your 3-letter initials (e.g., abc, xyz)
${colors.bright}Why:${colors.reset} Identifies your branches and configuration
${colors.bright}How:${colors.reset} Creates branches like dev_abc_2025-10-31
    `);
    
    while (!initials) {
      const input = await prompt('Enter your 3-letter initials');
      initials = validateInitials(input);
      
      if (!initials) {
        errorMsg('Please enter exactly 3 letters (a-z)');
        tip('Examples: abc, xyz, jdoe');
      }
    }
  } else {
    initials = validateInitials(initials);
    if (!initials) {
       log.error(`Invalid initials provided: ${providedInitials}`);
       process.exit(1);
    }
  }
  
  success(`Using initials: ${colors.cyan}${initials.toUpperCase()}${colors.reset}`);
  tip(`Your branches will be named: ${colors.cyan}dev_${initials}_YYYY-MM-DD${colors.reset}`);
  console.log();

  // Get Primary Agent
  console.log();
  sectionTitle('Primary AI Assistant');
  
  let agentName = providedAgent;
  const defaultAgent = currentSettings.preferences?.primaryAgent || 'Claude';
  
  if (!agentName) {
    explain(`
${colors.bright}What:${colors.reset} The AI assistant you primarily use (Claude, Warp, Cursor, etc.)
${colors.bright}Why:${colors.reset} Customizes file names (e.g., .warp-commit-msg, WARP.md)
    `);
    
    if (skipPrompts) {
        agentName = defaultAgent; // Default if skipping prompts
    } else {
        agentName = await prompt(`Primary AI Assistant? [${defaultAgent}]`, defaultAgent);
        agentName = agentName.trim() || defaultAgent;
    }
  }
  
  success(`Using assistant: ${colors.cyan}${agentName}${colors.reset}`);
  console.log();
  
  // Ask to save settings if changed or not saved
  if (!skipPrompts && (initials !== currentSettings.developerInitials || agentName !== currentSettings.preferences?.primaryAgent)) {
      console.log();
      sectionTitle('Save Preferences');
      explain(`
${colors.bright}Save these settings for future sessions?${colors.reset}
• ${colors.bright}Global:${colors.reset} Saves to ~/.devops-agent/settings.json (applies to all projects)
• ${colors.bright}Project:${colors.reset} Saves to local_deploy/project-settings.json (this project only)
      `);
      
      const saveChoice = await choose('Where should we save these settings?', [
          'Global (User Profile)',
          'Project (Local Only)',
          'Do not save'
      ], { defaultChoice: '1' });
      
      if (saveChoice === 0) {
          // Global
          const globalSettings = coordinator.loadGlobalSettings();
          globalSettings.developerInitials = initials;
          globalSettings.preferences = globalSettings.preferences || {};
          globalSettings.preferences.primaryAgent = agentName;
          globalSettings.configured = true;
          coordinator.saveGlobalSettings(globalSettings);
          log.success('Settings saved globally.');
      } else if (saveChoice === 1) {
          // Project
          const projectSettings = coordinator.loadProjectSettings();
          projectSettings.preferences = projectSettings.preferences || {};
          projectSettings.developerInitials = initials; // Allow project overrides
          projectSettings.preferences.primaryAgent = agentName;
          coordinator.saveProjectSettings(projectSettings);
          log.success('Settings saved to project.');
      }
  }
  
  // Groq API Key Setup
  sectionTitle('Groq API Key (Contract Automation)');
  
  const hasKey = credentialsManager.hasGroqApiKey();
  let groqKey = null;

  if (!skipPrompts) {
      explain(`
${colors.bright}What:${colors.reset} API Key for Groq (llama-3.1-70b-versatile)
${colors.bright}Why:${colors.reset} Required for AI-Optimized Contract Automation System
${colors.bright}Security:${colors.reset} Stored locally in ${colors.yellow}local_deploy/credentials.json${colors.reset} (gitignored)
      `);

      if (hasKey) {
        info('Groq API Key is already configured.');
        const update = await confirm('Do you want to update it?', false);
        if (update) {
          groqKey = await prompt('Enter your Groq API Key');
        }
      } else {
        groqKey = await prompt('Enter your Groq API Key (leave empty to skip)');
      }

      if (groqKey && groqKey.trim()) {
        credentialsManager.setGroqApiKey(groqKey.trim());
        success('Groq API Key saved securely.');
      } else if (!hasKey) {
        warn('Skipping Groq API Key setup.');
        warn('NOTE: Contract Automation features (analyze-with-llm.js) will NOT work without this key.');
      }
  } else {
      if (hasKey) {
          info('Using existing Groq API Key.');
      } else {
          warn('Skipping Groq API Key setup (non-interactive mode).');
      }
  }
  
  console.log();

  // Confirm before proceeding
  drawSection('Configuration Summary', [
    `${status.folder} Branch prefix: ${colors.cyan}dev_${initials}_${colors.reset}`,
    `${status.branch} Daily branches: ${colors.cyan}dev_${initials}_YYYY-MM-DD${colors.reset}`,
    `${status.checkmark} VS Code settings and tasks`,
    `${status.checkmark} NPM packages and scripts`,
    `${status.checkmark} Commit message files`,
    `${status.checkmark} House rules for AI agents`,
    `${status.folder} Standard folder structure check`,
    `${status.checkmark} Contract files check`
  ]);
  console.log();
  
  const proceed = skipPrompts ? true : await confirm('Ready to configure DevOps Agent?', true);
  
  if (!proceed) {
    warn('Setup cancelled');
    process.exit(0);
  }
  
  console.log();
  info('Starting configuration...');
  console.log();
  
  try {
    // Check and setup folder structure first
    const missingFolders = setupFolderStructure(projectRoot);
    if (missingFolders && missingFolders.length > 0) {
      const createFolders = skipPrompts ? true : await confirm('Create missing standard folders?', true);
      if (createFolders) {
        missingFolders.forEach(folder => {
          ensureDirectoryExists(path.join(projectRoot, folder));
          log.success(`Created ${folder}/`);
        });
      } else {
        log.warn('Skipping folder creation.');
      }
    }

    // Check for contracts
    const contractStatus = await checkContractsExist(projectRoot);
    
    if (contractStatus.missingCount > 0) {
      log.header();
      log.title('📜 Contract Files Missing');
      
      console.log(`${colors.red}Found ${contractStatus.missingCount} missing contract types.${colors.reset}`);
      if (contractStatus.scatteredCount > 0) {
        console.log(`${colors.yellow}Note: ${contractStatus.scatteredCount} contract types were found but are scattered/unmerged.${colors.reset}`);
      }
      
      if (!skipPrompts) {
          explain(`
${colors.bright}Contract System:${colors.reset}
This project uses a Contract System to coordinate multiple AI agents.
Since required contracts are missing, we should generate them to ensure
all agents understand the project structure and rules.
          `);
      }
      
      const shouldGenerate = skipPrompts ? true : await confirm('Generate contract files now?', true);
      if (shouldGenerate) {
        await generateContracts(projectRoot);
      }
    } else if (contractStatus.scatteredCount > 0) {
      // All present, but some scattered. The checkContractsExist function already asked to merge.
      // We don't need to do anything else here.
      log.info('All contracts present (some were found in scattered locations).');
    }

    // Run setup steps
    const packageJson = await setupNpmPackages(projectRoot);
    setupVSCodeSettings(projectRoot, initials, agentName);
    setupVSCodeTasks(projectRoot, initials, agentName);
    setupCommitFiles(projectRoot, initials, agentName);
    createRunScripts(projectRoot, initials, packageJson, agentName);
    
    // Setup .env with API keys
    if (!skipPrompts) {
        await setupEnvFile(projectRoot);
    } else {
        // Just create .env if missing in non-interactive mode
        const envPath = path.join(projectRoot, '.env');
        if (!fs.existsSync(envPath)) {
            fs.writeFileSync(envPath, '# Environment Variables\n');
            log.success('Created .env file');
        }
    }

    // Initialize SessionCoordinator for versioning and house rules setup
    // const coordinator = new SessionCoordinator(); // Already initialized at top
    
    // Ensure House Rules are set up
    if (!skipPrompts) {
        log.header();
        log.title('🏠 House Rules Setup');
        await coordinator.ensureHouseRulesSetup();
    } else {
        // In non-interactive mode, ensure defaults if missing
        // ensureHouseRulesSetup has internal logic, but we might want to skip the prompt
        // Since we can't easily force defaults without modifying coordinator, we'll skip for now
        // or we could check if it exists and warn
        if (!fs.existsSync(path.join(projectRoot, 'houserules.md'))) {
             log.warn('House rules missing. Run setup interactively to configure folder structure.');
        }
    }
    
    // Check/Setup versioning strategy
    if (!skipPrompts) {
        const settings = coordinator.loadProjectSettings();
        if (!settings.versioningStrategy?.configured) {
             log.header();
             log.title('📅 Project Versioning Strategy');
             await coordinator.ensureProjectSetup();
        } else {
             // Optional reconfigure
             log.info('Versioning strategy is already configured.');
             const reconfigure = await confirm('Do you want to reconfigure versioning?', false);
             if (reconfigure) {
                 await coordinator.ensureProjectSetup({ force: true });
             }
        }
    } else {
         // In non-interactive mode, we only ensure if missing (and hope it doesn't block or has defaults)
         // Actually promptForStartingVersion is interactive-only, so we skip if missing in non-interactive
         // or we could force defaults. For now, we skip to avoid hanging.
         const settings = coordinator.loadProjectSettings();
         if (!settings.versioningStrategy?.configured) {
             log.warn('Skipping versioning setup (interactive-only). Run setup without --yes to configure.');
         }
    }
    
    // Clean up DevOpsAgent files to avoid duplicates
    cleanupDevOpsAgentFiles(projectRoot, agentName);
    
    // Print instructions
    printInstructions(initials, agentName);
    
  } catch (error) {
    log.error(`Setup failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

function printInstructions(initials, agentName = 'Claude') {
  log.header();
  log.title('✅ Setup Complete!');
  console.log('');
  log.info(`Developer Initials: ${colors.bright}${initials.toUpperCase()}${colors.reset}`);
  log.info(`Branch Prefix: ${colors.bright}dev_${initials}_${colors.reset}`);
  log.info(`Primary Agent: ${colors.bright}${agentName}${colors.reset}`);
  console.log('');
  
  log.title('📚 Quick Start Guide:');
  console.log('');
  console.log('1. Start the cs-devops-agent worker:');
  console.log(`   ${colors.green}npm run cs-devops-agent${colors.reset}`);
  console.log(`   ${colors.yellow}OR${colors.reset}`);
  console.log(`   ${colors.green}./run-cs-devops-agent-${initials}.sh${colors.reset}`);
  console.log(`   ${colors.yellow}OR${colors.reset}`);
  console.log(`   ${colors.green}Use VS Code: Cmd+Shift+P → Tasks: Run Task → 🚀 Start DevOps Agent Worker${colors.reset}`);
  console.log('');
  
  console.log('2. Make your code changes');
  console.log('');
  
  console.log('3. Create a commit message:');
  console.log(`   ${colors.green}echo "feat(module): description" > .${agentName.toLowerCase()}-commit-msg${colors.reset}`);
  console.log(`   ${colors.yellow}OR${colors.reset}`);
  console.log(`   ${colors.green}Use VS Code: Cmd+Shift+P → Tasks: Run Task → 📝 Create Commit Message${colors.reset}`);
  console.log('');
  
  console.log('4. The worker will automatically commit and push!');
  console.log('');
  
  log.title('🎯 Daily Workflow:');
  console.log('');
  console.log(`• Your daily branches will be: ${colors.bright}dev_${initials}_YYYY-MM-DD${colors.reset}`);
  console.log('• The worker automatically creates new daily branches at midnight');
  console.log('• Commits require valid conventional format (feat/fix/docs/etc)');
  console.log('• Message file is cleared after successful push');
  console.log('');
  
  log.title('📁 Files Created/Updated:');
  console.log('');
  console.log('• .vscode/settings.json - VS Code environment settings');
  console.log('• .vscode/tasks.json - VS Code task shortcuts');
  console.log('• package.json - NPM scripts');
  console.log(`• run-cs-devops-agent-${initials}.sh - Personal run script`);
  console.log(`• .${agentName.toLowerCase()}-commit-msg - Commit message file`);
  console.log(`• ${agentName.toUpperCase()}_CHANGELOG.md - Change tracking`);
  console.log(`• ${agentName.toUpperCase()}.md - House rules for ${agentName}`);
  console.log('• .env.example - Configuration template');
  console.log('');
  
  log.title('🔧 Debugging:');
  console.log('');
  console.log('Run with debug output:');
  console.log(`   ${colors.green}npm run cs-devops-agent:debug${colors.reset}`);
  console.log(`   ${colors.yellow}OR${colors.reset}`);
  console.log(`   ${colors.green}./run-cs-devops-agent-${initials}.sh --debug${colors.reset}`);
  console.log('');
  
  log.title('📖 Environment Variables:');
  console.log('');
  console.log('See .env.example for all configuration options');
  console.log('');
  
  log.header();
}

// Run the setup
main().catch(console.error);