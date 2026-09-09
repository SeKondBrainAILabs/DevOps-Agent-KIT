#!/usr/bin/env node

/**
 * ============================================================================
 * HELP SYSTEM - Contextual Help for DevOps Agent v2.0
 * ============================================================================
 * 
 * Provides comprehensive, context-aware help throughout the application.
 * Users can access help with [?] option or dedicated help commands.
 * 
 * ============================================================================
 */

import { showHelp, colors, status } from './ui-utils.js';

// ============================================================================
// HELP CONTENT
// ============================================================================

export const helpTopics = {
  sessions: {
    title: 'Sessions',
    content: {
      'What is a Session?': `
  A session is an isolated workspace where one AI agent works on
  a specific task. Think of it like giving each AI assistant their
  own office to work in.
  
  Each session includes:
  ${status.point} Git Worktree: Separate folder with full git history
  ${status.point} Dedicated Branch: Auto-named based on task and date
  ${status.point} File Locks: Prevents other agents from editing same files
  ${status.point} Auto-Monitoring: Watches for changes and commits automatically`,
      
      'Why Use Sessions?': `
  Sessions prevent chaos when working with AI assistants:
  
  ${status.checkmark} No conflicts: Each agent has its own workspace
  ${status.checkmark} Safe experimentation: Isolated from your main code
  ${status.checkmark} Easy cleanup: Close session to merge and remove worktree
  ${status.checkmark} Multi-agent: Run multiple AI assistants simultaneously`,
      
      'Workflow': `
  ${colors.cyan}1.${colors.reset} Create session ${colors.dim}→${colors.reset} Get isolated workspace
  ${colors.cyan}2.${colors.reset} Give AI instructions ${colors.dim}→${colors.reset} Paste to Claude/Cursor
  ${colors.cyan}3.${colors.reset} AI works safely ${colors.dim}→${colors.reset} DevOps Agent commits automatically
  ${colors.cyan}4.${colors.reset} Close session ${colors.dim}→${colors.reset} Merges to main, cleans up worktree`,
      
      'Common Commands': `
  ${colors.green}s9n-devops-agent start${colors.reset}    - Create new session
  ${colors.green}s9n-devops-agent list${colors.reset}     - Show all sessions
  ${colors.green}s9n-devops-agent close${colors.reset}    - Close active session`
    }
  },

  worktrees: {
    title: 'Git Worktrees',
    content: {
      'What are Worktrees?': `
  Git worktrees let you have multiple working directories for the
  same repository. DevOps Agent uses them to give each session
  its own isolated workspace.
  
  ${status.folder} Main repo: /your/project
  ${status.folder} Session 1: /your/project/local_deploy/worktrees/abc1
  ${status.folder} Session 2: /your/project/local_deploy/worktrees/def2`,
      
      'Why Worktrees?': `
  ${status.checkmark} Work on multiple features simultaneously
  ${status.checkmark} Each AI agent gets its own space
  ${status.checkmark} No need to stash or switch branches
  ${status.checkmark} All worktrees share git history (efficient)`,
      
      'Automatic Management': `
  You don't need to manage worktrees manually. DevOps Agent:
  ${status.point} Creates worktree when you start a session
  ${status.point} Monitors it for changes
  ${status.point} Removes it when you close the session
  ${status.point} Cleans up abandoned worktrees automatically`
    }
  },

  fileCoordination: {
    title: 'File Coordination',
    content: {
      'What is File Coordination?': `
  File coordination prevents multiple AI agents from editing
  the same files simultaneously. It's like a "reserved" sign
  on files being worked on.`,
      
      'How It Works': `
  ${colors.cyan}1.${colors.reset} Agent declares files before editing
     Creates: .file-coordination/active-edits/agent-session.json
  
  ${colors.cyan}2.${colors.reset} System checks for conflicts
     Looks for other agents editing same files
  
  ${colors.cyan}3.${colors.reset} Agent works on declared files
     Other agents see files are locked
  
  ${colors.cyan}4.${colors.reset} Session closes, locks released
     Files available for other agents`,
      
      'Declaration Format': `
  {
    "agent": "claude",
    "session": "abc1-23d4",
    "files": ["src/auth.js", "tests/auth.test.js"],
    "reason": "Implementing JWT authentication",
    "declaredAt": "2024-10-31T12:00:00Z"
  }`,
      
      'Alert System': `
  ${colors.yellow}${status.warning} Orange Alert${colors.reset} - File edited without declaration
  ${colors.red}${status.error} Red Alert${colors.reset} - File being edited by another agent
  
  Both alerts provide copy-paste instructions to fix the issue.`
    }
  },

  branches: {
    title: 'Branch Management',
    content: {
      'Branch Hierarchy': `
  DevOps Agent uses hierarchical branching for organization:
  
  session/task_abc1 ${colors.dim}→${colors.reset} Session branch (your AI works here)
         ${colors.dim}↓${colors.reset}
  daily/dev_sdd_2024-10-31 ${colors.dim}→${colors.reset} Daily branch (merged on close)
         ${colors.dim}↓${colors.reset}
  weekly/2024-W44 ${colors.dim}→${colors.reset} Weekly branch (consolidated Sunday)
         ${colors.dim}↓${colors.reset}
  main ${colors.dim}→${colors.reset} Production branch`,
      
      'Why This Structure?': `
  ${status.checkmark} ${colors.bright}Organized History${colors.reset} - Easy to see what was done when
  ${status.checkmark} ${colors.bright}Easy Rollbacks${colors.reset} - Revert to any day or week
  ${status.checkmark} ${colors.bright}Clear Progress${colors.reset} - Track development over time
  ${status.checkmark} ${colors.bright}Safe Merging${colors.reset} - Changes flow through tested layers`,
      
      'Auto-Merging': `
  ${colors.green}On Session Close:${colors.reset}
    ${status.point} Merges session branch to daily branch
    ${status.point} Merges daily branch to main (configurable)
    ${status.point} Removes session branch and worktree
  
  ${colors.green}Weekly Consolidation:${colors.reset}
    ${status.point} Runs every Sunday at midnight
    ${status.point} Merges all daily branches into weekly branch
    ${status.point} Cleans up old daily branches`
    }
  },

  houseRules: {
    title: 'House Rules',
    content: {
      'What are House Rules?': `
  House rules are instructions for AI assistants in docs/houserules.md.
  They teach AI agents about your project's conventions, testing
  requirements, and coding standards.`,
      
      'What They Include': `
  ${status.point} Commit message format and conventions
  ${status.point} Testing requirements (what tests to run)
  ${status.point} Code style preferences
  ${status.point} File organization rules
  ${status.point} Multi-agent coordination protocols
  ${status.point} Project-specific guidelines`,
      
      'Auto-Management': `
  ${colors.green}DevOps Agent manages house rules for you:${colors.reset}
  
  ${status.checkmark} Creates on first setup
  ${status.checkmark} Updates DevOps sections automatically
  ${status.checkmark} Preserves your custom rules
  ${status.checkmark} Self-heals if deleted
  ${status.checkmark} Version tracked per section`,
      
      'Commands': `
  ${colors.green}npm run house-rules:status${colors.reset}  - Check status
  ${colors.green}npm run house-rules:update${colors.reset}  - Update/create
  ${colors.green}npm run house-rules:repair${colors.reset}  - Health check`
    }
  },

  versions: {
    title: 'Version Strategies',
    content: {
      'Daily Versioning': `
  DevOps Agent auto-increments versions daily. Choose your style:
  
  ${colors.cyan}Option 1:${colors.reset} v0.20 → v0.21 → v0.22  (0.01 increments)
    ${colors.dim}Best for: Frequent daily releases${colors.reset}
  
  ${colors.cyan}Option 2:${colors.reset} v0.20 → v0.30 → v0.40  (0.1 increments)
    ${colors.dim}Best for: Weekly milestone tracking${colors.reset}
  
  ${colors.cyan}Option 3:${colors.reset} v0.20 → v0.40 → v0.60  (0.2 increments)
    ${colors.dim}Best for: Bi-weekly sprints${colors.reset}`,
      
      'Why Daily Versions?': `
  ${status.checkmark} Clear timeline of development
  ${status.checkmark} Easy to reference specific days
  ${status.checkmark} Automatic version bumps (no manual work)
  ${status.checkmark} Aligned with daily branch structure`,
      
      'Configuration': `
  Set in local_deploy/project-settings.json:
  
  {
    "versionPrefix": "v0.",
    "versionStartMinor": "20",
    "versionIncrement": "1"
  }
  
  ${colors.dim}Increment: 1 = 0.01, 10 = 0.1, 20 = 0.2${colors.reset}`
    }
  },

  multiAgent: {
    title: 'Multi-Agent Collaboration',
    content: {
      'Working with Multiple AIs': `
  DevOps Agent lets multiple AI assistants work simultaneously
  without conflicts. Each gets their own session and workspace.`,
      
      'Example Workflow': `
  ${colors.cyan}Terminal 1:${colors.reset} Claude working on backend API
    ${colors.dim}s9n-devops-agent create --task api --agent claude${colors.reset}
  
  ${colors.cyan}Terminal 2:${colors.reset} Cursor working on frontend UI
    ${colors.dim}s9n-devops-agent create --task ui --agent cursor${colors.reset}
  
  ${status.checkmark} Each agent has isolated workspace
  ${status.checkmark} File coordination prevents conflicts
  ${status.checkmark} Both can work independently`,
      
      'Safety Mechanisms': `
  ${colors.green}File Locking:${colors.reset}
    Agents declare files before editing. System alerts on conflicts.
  
  ${colors.green}Session Isolation:${colors.reset}
    Separate worktrees mean no accidental interference.
  
  ${colors.green}Merge Coordination:${colors.reset}
    Changes merge to daily branch in order, tested at each step.`,
      
      'Best Practices': `
  ${status.point} Divide work by feature or component
  ${status.point} Use clear, descriptive task names
  ${status.point} Monitor file coordination alerts
  ${status.point} Close sessions promptly when done`
    }
  },

  docker: {
    title: 'Docker Integration',
    content: {
      'Auto-Restart Feature': `
  DevOps Agent can automatically restart Docker containers
  after pushing code changes. Great for testing immediately.`,
      
      'How to Enable': `
  During session creation, when docker-compose is detected:
  
  ${colors.cyan}?${colors.reset} Auto-restart Docker containers after push? ${colors.dim}(y/N)${colors.reset}: y
  ${colors.cyan}?${colors.reset} Rebuild containers on restart? ${colors.dim}(y/N)${colors.reset}: n
  ${colors.cyan}?${colors.reset} Specific service to restart ${colors.dim}(or empty for all)${colors.reset}: app`,
      
      'Supported Files': `
  ${status.checkmark} docker-compose.yml / docker-compose.yaml
  ${status.checkmark} compose.yml / compose.yaml
  ${status.checkmark} docker-compose.dev.yml
  ${status.checkmark} docker-compose.local.yml`,
      
      'Behavior': `
  ${colors.green}On Every Push:${colors.reset}
    1. Git push completes successfully
    2. Docker restart command runs
    3. Containers restart with new code
    4. DevOps Agent continues monitoring
  
  ${colors.yellow}Note:${colors.reset} Docker failures don't affect git workflow.`
    }
  },

  troubleshooting: {
    title: 'Troubleshooting',
    content: {
      'Session Not Found': `
  ${colors.red}Error:${colors.reset} "Session abc1 not found"
  
  ${colors.cyan}Possible causes:${colors.reset}
    ${status.point} Session already closed
    ${status.point} Session expired (inactive >24h)
    ${status.point} Wrong session ID
  
  ${colors.cyan}Solutions:${colors.reset}
    1. List sessions: ${colors.green}s9n-devops-agent list${colors.reset}
    2. Check closed: ${colors.green}s9n-devops-agent list --all${colors.reset}
    3. Create new: ${colors.green}s9n-devops-agent start${colors.reset}`,
      
      'Agent Not Detecting Changes': `
  ${colors.red}Problem:${colors.reset} Files changed but not committed
  
  ${colors.cyan}Debug steps:${colors.reset}
    1. Check commit message file exists:
       ${colors.dim}ls -la .devops-commit-*.msg${colors.reset}
    
    2. Verify file has content:
       ${colors.dim}cat .devops-commit-abc1.msg${colors.reset}
    
    3. Enable debug mode:
       ${colors.dim}AC_DEBUG=true s9n-devops-agent start${colors.reset}
    
    4. Check agent is running:
       ${colors.dim}ps aux | grep cs-devops-agent-worker${colors.reset}`,
      
      'Merge Conflicts': `
  ${colors.red}Problem:${colors.reset} Conflicts when closing session
  
  ${colors.cyan}Why it happens:${colors.reset}
    ${status.point} Someone else modified same files in main
    ${status.point} Daily branch diverged from main
  
  ${colors.cyan}How to resolve:${colors.reset}
    1. Agent pauses and shows conflict files
    2. Manually resolve conflicts in worktree
    3. Mark as resolved
    4. Agent completes merge`,
      
      'Performance Issues': `
  ${colors.red}Problem:${colors.reset} Agent slow or high CPU usage
  
  ${colors.cyan}Solutions:${colors.reset}
    ${status.point} Reduce AC_DEBOUNCE_MS for faster commits
    ${status.point} Exclude large directories from watch
    ${status.point} Close unused sessions
    ${status.point} Clean up old worktrees: ${colors.green}npm run devops:cleanup${colors.reset}`
    }
  }
};

// ============================================================================
// HELP FUNCTIONS
// ============================================================================

/**
 * Show help for a specific topic
 */
export async function showTopicHelp(topicKey) {
  const topic = helpTopics[topicKey];
  
  if (!topic) {
    console.log(`${colors.red}Unknown help topic: ${topicKey}${colors.reset}`);
    console.log(`\nAvailable topics: ${Object.keys(helpTopics).join(', ')}`);
    return;
  }
  
  await showHelp(topic.title, topic.content);
}

/**
 * Show help menu with all topics
 */
export async function showHelpMenu() {
  console.log();
  console.log(`${colors.bright}${colors.cyan}DevOps Agent Help${colors.reset}`);
  console.log();
  console.log('Available help topics:');
  console.log();
  
  const topics = [
    { key: 'sessions', desc: 'Understanding sessions and workflows' },
    { key: 'worktrees', desc: 'Git worktrees and isolation' },
    { key: 'fileCoordination', desc: 'Multi-agent file coordination' },
    { key: 'branches', desc: 'Branch hierarchy and management' },
    { key: 'houseRules', desc: 'House rules for AI agents' },
    { key: 'versions', desc: 'Version strategies and daily versioning' },
    { key: 'multiAgent', desc: 'Working with multiple AI assistants' },
    { key: 'docker', desc: 'Docker container integration' },
    { key: 'troubleshooting', desc: 'Common issues and solutions' },
  ];
  
  topics.forEach((topic, index) => {
    console.log(`  ${colors.cyan}${index + 1})${colors.reset} ${colors.bright}${topic.key}${colors.reset}`);
    console.log(`     ${colors.dim}${topic.desc}${colors.reset}`);
    console.log();
  });
  
  console.log(`Enter topic number, name, or 'q' to quit:`);
  console.log();
}

/**
 * Interactive help browser
 */
export async function helpBrowser() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  while (true) {
    await showHelpMenu();
    
    const answer = await new Promise((resolve) => {
      readline.question('> ', resolve);
    });
    
    const cleaned = answer.trim().toLowerCase();
    
    if (cleaned === 'q' || cleaned === 'quit' || cleaned === 'exit') {
      readline.close();
      break;
    }
    
    // Check if it's a number
    const num = parseInt(cleaned);
    if (!isNaN(num) && num >= 1 && num <= Object.keys(helpTopics).length) {
      const topicKey = Object.keys(helpTopics)[num - 1];
      await showTopicHelp(topicKey);
      continue;
    }
    
    // Check if it's a topic name
    if (helpTopics[cleaned]) {
      await showTopicHelp(cleaned);
      continue;
    }
    
    console.log(`${colors.red}Unknown topic. Try again.${colors.reset}`);
  }
}

/**
 * Quick help for specific context
 */
export function quickHelp(context) {
  const quickHelps = {
    setup: `${colors.cyan}💡 Setup Help:${colors.reset}
  Configuring DevOps Agent for your project. You'll set:
  ${status.point} Developer initials (for branch naming)
  ${status.point} Version strategy (how versions increment)
  ${status.point} Timezone (for daily rollover)
  
  Press [?] at any prompt for detailed help on that topic.`,
    
    sessionCreate: `${colors.cyan}💡 Session Creation Help:${colors.reset}
  Creating an isolated workspace for an AI agent.
  ${status.point} Task name becomes part of branch name
  ${status.point} Each session gets its own git worktree
  ${status.point} File locks prevent conflicts with other agents
  
  Type '?' at any prompt for more information.`,
    
    versionStrategy: `${colors.cyan}💡 Version Strategy Help:${colors.reset}
  Choose how version numbers increment each day:
  ${colors.bright}0.01 increments:${colors.reset} v0.20 → v0.21 (daily releases)
  ${colors.bright}0.1 increments:${colors.reset}  v0.20 → v0.30 (weekly milestones)
  ${colors.bright}0.2 increments:${colors.reset}  v0.20 → v0.40 (bi-weekly sprints)
  
  For full details: s9n-devops-agent help versions`,
  };
  
  return quickHelps[context] || '';
}

export default {
  helpTopics,
  showTopicHelp,
  showHelpMenu,
  helpBrowser,
  quickHelp,
};
