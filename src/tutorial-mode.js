#!/usr/bin/env node

/**
 * ============================================================================
 * TUTORIAL MODE - Interactive Learning for DevOps Agent v2.0
 * ============================================================================
 * 
 * Provides hands-on, interactive tutorial to help new users understand
 * DevOps Agent concepts through guided examples and practice.
 * 
 * Modules:
 * 1. Understanding Sessions
 * 2. Creating Your First Session
 * 3. Working with AI Assistants
 * 4. Multi-Agent Workflow
 * 5. Advanced Features
 * 
 * ============================================================================
 */

import {
  showWelcome,
  sectionTitle,
  explain,
  tip,
  confirm,
  choose,
  prompt,
  success,
  info,
  warn,
  colors,
  status,
  drawSection,
  progressStep
} from './ui-utils.js';
import { showTopicHelp } from './help-system.js';

// ============================================================================
// TUTORIAL STATE
// ============================================================================

const tutorialState = {
  currentModule: 0,
  completed: [],
  startTime: null,
};

// ============================================================================
// TUTORIAL MODULES
// ============================================================================

/**
 * Module 1: Understanding Sessions
 */
async function module1_understandingSessions() {
  sectionTitle('Module 1: Understanding Sessions');
  
  explain(`
Welcome to DevOps Agent! Let's start by understanding the core concept: ${colors.bright}sessions${colors.reset}.

Think of a session as giving an AI assistant its own private office to work in.
Each session is completely isolated from others, preventing conflicts and chaos.
  `);
  
  console.log();
  console.log(`${colors.bright}What makes up a session?${colors.reset}`);
  console.log();
  console.log(`${status.folder} ${colors.cyan}Git Worktree${colors.reset}`);
  console.log(`   A separate directory with full git history`);
  console.log(`   Example: local_deploy/worktrees/abc1-23d4/`);
  console.log();
  console.log(`${status.branch} ${colors.cyan}Dedicated Branch${colors.reset}`);
  console.log(`   Auto-named based on task and date`);
  console.log(`   Example: session/implement-auth_abc1_2024-10-31`);
  console.log();
  console.log(`${status.lock} ${colors.cyan}File Locks${colors.reset}`);
  console.log(`   Prevents other agents from editing same files`);
  console.log(`   Released when session closes`);
  console.log();
  console.log(`${status.robot} ${colors.cyan}Auto-Monitoring${colors.reset}`);
  console.log(`   Watches for changes and commits automatically`);
  console.log(`   You never run git commands manually`);
  console.log();
  
  const viewExample = await confirm('Would you like to see a real-world example?', true);
  
  if (viewExample) {
    console.log();
    drawSection('Example Workflow', [
      `${colors.bright}Scenario:${colors.reset} You want Claude to implement authentication`,
      ``,
      `${status.arrow} ${colors.cyan}Step 1:${colors.reset} Create session`,
      `  ${colors.dim}s9n-devops-agent start${colors.reset}`,
      `  ${colors.dim}Task: implement-authentication${colors.reset}`,
      ``,
      `${status.arrow} ${colors.cyan}Step 2:${colors.reset} Session created`,
      `  ${colors.dim}Workspace: local_deploy/worktrees/abc1/`,
      `  ${colors.dim}Branch: session/implement-authentication_abc1${colors.reset}`,
      ``,
      `${status.arrow} ${colors.cyan}Step 3:${colors.reset} Give instructions to Claude`,
      `  ${colors.dim}(Copy-paste provided instructions)${colors.reset}`,
      ``,
      `${status.arrow} ${colors.cyan}Step 4:${colors.reset} Claude works in isolation`,
      `  ${colors.dim}Writes code in the worktree directory`,
      `  ${colors.dim}DevOps Agent auto-commits and pushes${colors.reset}`,
      ``,
      `${status.arrow} ${colors.cyan}Step 5:${colors.reset} Close session when done`,
      `  ${colors.dim}Merges to daily branch, then to main`,
      `  ${colors.dim}Cleans up worktree directory${colors.reset}`,
    ]);
  }
  
  console.log();
  const learnMore = await confirm('Want to see the detailed help for sessions?', false);
  if (learnMore) {
    await showTopicHelp('sessions');
  }
  
  tutorialState.completed.push('module1');
  success('Module 1 complete! You understand what sessions are.');
}

/**
 * Module 2: Creating Your First Session
 */
async function module2_creatingFirstSession() {
  sectionTitle('Module 2: Creating Your First Session');
  
  explain(`
Now let's walk through creating a session step by step.
I'll show you what happens at each stage.
  `);
  
  console.log();
  progressStep(1, 5, 'Start the session manager');
  console.log();
  console.log(`   Command: ${colors.green}s9n-devops-agent start${colors.reset}`);
  console.log();
  console.log(`   ${colors.dim}This opens an interactive menu${colors.reset}`);
  console.log();
  
  await confirm('Press Enter to continue', true);
  
  progressStep(2, 5, 'Choose to create a new session');
  console.log();
  console.log(`   You'll see options like:`);
  console.log(`   ${colors.bright}N)${colors.reset} Create a new session`);
  console.log(`   ${colors.bright}1)${colors.reset} Resume existing session (if any exist)`);
  console.log();
  
  await confirm('Press Enter to continue', true);
  
  progressStep(3, 5, 'Enter task name');
  console.log();
  console.log(`   ${colors.cyan}?${colors.reset} Enter task/feature name: ${colors.dim}api-authentication${colors.reset}`);
  console.log();
  tip('Use descriptive names. They become part of your branch name.');
  console.log();
  
  await confirm('Press Enter to continue', true);
  
  progressStep(4, 5, 'Select AI agent type');
  console.log();
  console.log(`   ${colors.bright}1)${colors.reset} Claude (Anthropic)`);
  console.log(`   ${colors.bright}2)${colors.reset} Cursor`);
  console.log(`   ${colors.bright}3)${colors.reset} GitHub Copilot`);
  console.log(`   ${colors.bright}4)${colors.reset} Cline (VS Code)`);
  console.log(`   ${colors.bright}5)${colors.reset} Warp`);
  console.log(`   ${colors.bright}6)${colors.reset} Other`);
  console.log();
  console.log(`   ${colors.cyan}?${colors.reset} Your choice: ${colors.dim}1${colors.reset}`);
  console.log();
  
  await confirm('Press Enter to continue', true);
  
  progressStep(5, 5, 'Session created!');
  console.log();
  console.log(`   ${status.success} Session created: ${colors.cyan}abc1-23d4${colors.reset}`);
  console.log(`   ${status.folder} Workspace: ${colors.dim}local_deploy/worktrees/abc1-23d4/${colors.reset}`);
  console.log(`   ${status.branch} Branch: ${colors.dim}session/api-authentication_abc1${colors.reset}`);
  console.log();
  console.log(`   ${colors.bright}Next: Copy instructions to your AI assistant${colors.reset}`);
  console.log();
  
  const practiceNow = await confirm('Would you like to practice creating a real session now?', false);
  
  if (practiceNow) {
    info('Great! Exit this tutorial and run: s9n-devops-agent start');
    info('Then come back to continue the tutorial when ready.');
    console.log();
  }
  
  tutorialState.completed.push('module2');
  success('Module 2 complete! You know how to create sessions.');
}

/**
 * Module 3: Working with AI Assistants
 */
async function module3_workingWithAI() {
  sectionTitle('Module 3: Working with AI Assistants');
  
  explain(`
After creating a session, you need to give instructions to your AI assistant.
DevOps Agent provides perfectly formatted instructions to copy-paste.
  `);
  
  console.log();
  console.log(`${colors.bright}The instructions tell the AI:${colors.reset}`);
  console.log();
  console.log(`${status.checkmark} ${colors.cyan}Where to work${colors.reset}`);
  console.log(`   The exact worktree directory path`);
  console.log();
  console.log(`${status.checkmark} ${colors.cyan}What rules to follow${colors.reset}`);
  console.log(`   Read the house rules file first`);
  console.log();
  console.log(`${status.checkmark} ${colors.cyan}How to declare files${colors.reset}`);
  console.log(`   Prevent conflicts with other agents`);
  console.log();
  console.log(`${status.checkmark} ${colors.cyan}How to commit changes${colors.reset}`);
  console.log(`   Write messages to special file`);
  console.log();
  
  const showInstructions = await confirm('See example instructions?', true);
  
  if (showInstructions) {
    console.log();
    drawSection('Example Instructions for Claude', [
      `${status.robot} DevOps Session Configuration`,
      ``,
      `Session ID: ${colors.cyan}abc1-23d4${colors.reset}`,
      `Task: api-authentication`,
      ``,
      `${colors.bright}${status.point} STEP 1: Read house rules${colors.reset} ${colors.red}(CRITICAL!)${colors.reset}`,
      `   cat "docs/houserules.md"`,
      ``,
      `${colors.bright}${status.point} STEP 2: Switch to workspace${colors.reset}`,
      `   cd "local_deploy/worktrees/abc1-23d4"`,
      ``,
      `${colors.bright}${status.point} STEP 3: Declare files before editing${colors.reset}`,
      `   Create: .file-coordination/active-edits/claude-abc1.json`,
      ``,
      `${colors.bright}${status.point} STEP 4: Write commits${colors.reset}`,
      `   After changes: write to .devops-commit-abc1.msg`,
      `   DevOps Agent auto-commits and pushes`,
    ]);
  }
  
  console.log();
  console.log(`${colors.bright}What happens automatically:${colors.reset}`);
  console.log();
  console.log(`${status.checkmark} DevOps Agent ${colors.cyan}watches${colors.reset} the worktree directory`);
  console.log(`${status.checkmark} When commit message file changes, it ${colors.cyan}commits${colors.reset}`);
  console.log(`${status.checkmark} After commit, it ${colors.cyan}pushes${colors.reset} to GitHub`);
  console.log(`${status.checkmark} On session close, it ${colors.cyan}merges${colors.reset} to daily & main`);
  console.log();
  
  tutorialState.completed.push('module3');
  success('Module 3 complete! You know how to work with AI assistants.');
}

/**
 * Module 4: Multi-Agent Workflow
 */
async function module4_multiAgent() {
  sectionTitle('Module 4: Multi-Agent Workflow');
  
  explain(`
One of DevOps Agent's powerful features is running multiple AI assistants
simultaneously without conflicts. Let's see how this works.
  `);
  
  console.log();
  console.log(`${colors.bright}Scenario: Two features at once${colors.reset}`);
  console.log();
  
  drawSection('Terminal 1: Claude on Backend', [
    `${colors.cyan}s9n-devops-agent create --task api --agent claude${colors.reset}`,
    ``,
    `${status.folder} Workspace: local_deploy/worktrees/abc1/`,
    `${status.lock} Files locked: src/api/*.js, tests/api/*.js`,
    `${status.commit} Status: Working on API endpoints`,
  ]);
  
  console.log();
  
  drawSection('Terminal 2: Cursor on Frontend', [
    `${colors.cyan}s9n-devops-agent create --task ui --agent cursor${colors.reset}`,
    ``,
    `${status.folder} Workspace: local_deploy/worktrees/def2/`,
    `${status.lock} Files locked: src/components/*.tsx, src/styles/*.css`,
    `${status.commit} Status: Working on UI components`,
  ]);
  
  console.log();
  console.log(`${colors.bright}How conflicts are prevented:${colors.reset}`);
  console.log();
  console.log(`${status.point} ${colors.cyan}File Coordination${colors.reset}`);
  console.log(`   Each agent declares which files they'll edit`);
  console.log(`   System alerts if two agents try to edit the same file`);
  console.log();
  console.log(`${status.point} ${colors.cyan}Isolated Workspaces${colors.reset}`);
  console.log(`   Separate directories mean no accidental interference`);
  console.log();
  console.log(`${status.point} ${colors.cyan}Sequential Merging${colors.reset}`);
  console.log(`   Changes merge to daily branch in order`);
  console.log(`   Each merge is tested before the next`);
  console.log();
  
  const learnMore = await confirm('Learn more about file coordination?', false);
  if (learnMore) {
    await showTopicHelp('fileCoordination');
  }
  
  tutorialState.completed.push('module4');
  success('Module 4 complete! You understand multi-agent collaboration.');
}

/**
 * Module 5: Advanced Features
 */
async function module5_advancedFeatures() {
  sectionTitle('Module 5: Advanced Features');
  
  explain(`
DevOps Agent has several advanced features that make development smoother.
Let's explore the most useful ones.
  `);
  
  console.log();
  
  const topics = [
    {
      label: 'Branch Hierarchy',
      description: 'session → daily → weekly → main structure'
    },
    {
      label: 'House Rules',
      description: 'Teaching AI agents your project conventions'
    },
    {
      label: 'Version Strategies',
      description: 'Automatic daily version incrementing'
    },
    {
      label: 'Docker Integration',
      description: 'Auto-restart containers after push'
    },
    {
      label: 'Weekly Consolidation',
      description: 'Automatic cleanup and rollup'
    }
  ];
  
  for (const [index, topic] of topics.entries()) {
    console.log(`${status.point} ${colors.bright}${topic.label}${colors.reset}`);
    console.log(`   ${colors.dim}${topic.description}${colors.reset}`);
    console.log();
  }
  
  const exploreMore = await confirm('Explore these features in detail?', true);
  
  if (exploreMore) {
    const choice = await choose('Which feature interests you most?', [
      'Branch Hierarchy & Merging',
      'House Rules System',
      'Version Strategies',
      'Docker Integration',
      'All of them!'
    ]);
    
    const helpTopics = ['branches', 'houseRules', 'versions', 'docker', null];
    
    if (choice === 4) {
      info('Great! Check out the comprehensive help:');
      console.log(`   ${colors.green}s9n-devops-agent help${colors.reset}`);
      console.log();
      console.log('Or read the documentation:');
      console.log(`   ${colors.cyan}docs/V2_IMPLEMENTATION_GUIDE.md${colors.reset}`);
    } else {
      await showTopicHelp(helpTopics[choice]);
    }
  }
  
  tutorialState.completed.push('module5');
  success('Module 5 complete! You know about advanced features.');
}

// ============================================================================
// TUTORIAL COMPLETION
// ============================================================================

async function showCompletion() {
  console.log();
  console.log();
  console.log(colors.bright + colors.green + '═'.repeat(70) + colors.reset);
  console.log();
  console.log(`   ${status.success} ${colors.bright}Tutorial Complete!${colors.reset}`);
  console.log();
  console.log(colors.green + '═'.repeat(70) + colors.reset);
  console.log();
  
  const duration = Math.floor((Date.now() - tutorialState.startTime) / 1000 / 60);
  console.log(`You completed all 5 modules in ${colors.cyan}${duration} minutes${colors.reset}!`);
  console.log();
  
  console.log(`${colors.bright}What you learned:${colors.reset}`);
  console.log(`  ${status.checkmark} Understanding Sessions`);
  console.log(`  ${status.checkmark} Creating Your First Session`);
  console.log(`  ${status.checkmark} Working with AI Assistants`);
  console.log(`  ${status.checkmark} Multi-Agent Workflow`);
  console.log(`  ${status.checkmark} Advanced Features`);
  console.log();
  
  console.log(`${colors.bright}Next steps:${colors.reset}`);
  console.log();
  console.log(`  ${status.rocket} ${colors.green}Create your first real session:${colors.reset}`);
  console.log(`     s9n-devops-agent start`);
  console.log();
  console.log(`  ${status.book} ${colors.cyan}Browse help topics:${colors.reset}`);
  console.log(`     s9n-devops-agent help`);
  console.log();
  console.log(`  ${status.folder} ${colors.cyan}Read the documentation:${colors.reset}`);
  console.log(`     docs/V2_IMPLEMENTATION_GUIDE.md`);
  console.log();
  
  const setupNow = await confirm('Run setup wizard now?', false);
  
  if (setupNow) {
    console.log();
    info('Great! Running setup wizard...');
    console.log();
    // Note: In full implementation, this would call the setup wizard
    console.log(`${colors.dim}s9n-devops-agent setup${colors.reset}`);
  } else {
    console.log();
    success('Tutorial complete! Happy coding with DevOps Agent! 🚀');
  }
}

// ============================================================================
// MAIN TUTORIAL RUNNER
// ============================================================================

/**
 * Run the complete interactive tutorial
 */
export async function runTutorial() {
  tutorialState.startTime = Date.now();
  
  showWelcome('2.0.0');
  
  console.log(`${status.book} ${colors.bright}Interactive Tutorial${colors.reset}`);
  console.log();
  explain(`
This tutorial will teach you everything you need to know about DevOps Agent.
It takes about 10-15 minutes and includes hands-on examples.

You can exit anytime with Ctrl+C and resume later.
  `);
  
  const ready = await confirm('Ready to start?', true);
  
  if (!ready) {
    info('No problem! Run this tutorial anytime with: s9n-devops-agent tutorial');
    return;
  }
  
  console.log();
  
  // Run all modules
  try {
    await module1_understandingSessions();
    console.log();
    
    await module2_creatingFirstSession();
    console.log();
    
    await module3_workingWithAI();
    console.log();
    
    await module4_multiAgent();
    console.log();
    
    await module5_advancedFeatures();
    console.log();
    
    await showCompletion();
    
  } catch (error) {
    if (error.message === 'User cancelled') {
      console.log();
      warn('Tutorial paused. Run again with: s9n-devops-agent tutorial');
      console.log();
      console.log(`Progress saved: ${tutorialState.completed.length}/5 modules complete`);
    } else {
      throw error;
    }
  }
}

/**
 * Quick tutorial - condensed version
 */
export async function runQuickTutorial() {
  showWelcome('2.0.0');
  
  console.log(`${status.rocket} ${colors.bright}Quick Start Tutorial (5 minutes)${colors.reset}`);
  console.log();
  
  explain(`
This quick tutorial covers the essentials to get you started immediately.
  `);
  
  console.log();
  console.log(`${colors.bright}In 3 simple steps:${colors.reset}`);
  console.log();
  console.log(`${status.point} ${colors.cyan}Create a session${colors.reset}`);
  console.log(`   Isolated workspace for AI to work in`);
  console.log(`   ${colors.dim}Command: s9n-devops-agent start${colors.reset}`);
  console.log();
  console.log(`${status.point} ${colors.cyan}Give instructions to AI${colors.reset}`);
  console.log(`   Copy-paste provided instructions to Claude/Cursor`);
  console.log(`   AI works in the session workspace`);
  console.log();
  console.log(`${status.point} ${colors.cyan}Close session when done${colors.reset}`);
  console.log(`   Automatically merges to main and cleans up`);
  console.log(`   ${colors.dim}Command: s9n-devops-agent close${colors.reset}`);
  console.log();
  
  const fullTutorial = await confirm('Want the full tutorial with examples?', true);
  
  if (fullTutorial) {
    await runTutorial();
  } else {
    success('Quick tutorial complete! Run setup: s9n-devops-agent setup');
  }
}

// Run tutorial if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTutorial().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export default {
  runTutorial,
  runQuickTutorial,
};
