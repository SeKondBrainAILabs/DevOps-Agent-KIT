/**
 * Agent Setup Instructions Templates
 * Generated instructions for each agent type
 */

import type { AgentType, AgentInstanceConfig, RepoEntry } from './types';

export interface InstructionVars {
  repoPath: string;
  repoName: string;
  branchName: string;
  sessionId: string;
  taskDescription: string;
  systemPrompt: string;
  contextPreservation: string;
  rebaseFrequency: string;
  mcpUrl?: string;
  // Multi-repo fields
  multiRepoEntries?: RepoEntry[];
  commitScope?: 'all' | 'per-repo';
}

/**
 * Get setup instructions for a specific agent type
 */
export function getAgentInstructions(
  agentType: AgentType,
  vars: InstructionVars
): string {
  const templates: Record<AgentType, (vars: InstructionVars) => string> = {
    claude: getClaudeInstructions,
    cursor: getCursorInstructions,
    copilot: getCopilotInstructions,
    cline: getClineInstructions,
    aider: getAiderInstructions,
    warp: getWarpInstructions,
    custom: getCustomInstructions,
  };

  return templates[agentType](vars);
}

/**
 * Generate the comprehensive prompt for Claude Code agent
 * Balanced format: concise but preserves essential guidance
 */
export function generateClaudePrompt(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  return `# SESSION ${shortSessionId}

# ⚠️ CRITICAL: WRONG DIRECTORY = WASTED WORK ⚠️
WORKDIR: ${vars.repoPath}
YOU MUST WORK ONLY IN THIS DIRECTORY - NOT THE MAIN REPO

🛑 FIRST: Run \`pwd\` and show me the output to prove you're in the worktree
🛑 DO NOT proceed until you confirm you're in: ${vars.repoPath}

BRANCH: ${vars.branchName}
TASK: ${task}

## MANDATORY FIRST RESPONSE
Before doing ANY other work, you MUST respond with:
✓ Current directory: [output of pwd]
✓ Houserules read: [yes/no - if yes, summarize key rules]
✓ File locks checked: [yes/no]

## 1. SETUP (run first)
\`\`\`bash
cd "${vars.repoPath}"
pwd  # Verify correct location before any changes

# ⚠️ CRITICAL: Read house rules BEFORE making any changes!
cat houserules.md 2>/dev/null || echo "No houserules.md - create one as you learn the codebase"

# Read folder structure (separate from houserules)
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md found"

# Check for House Rules Contracts (project documentation)
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs - read relevant ones before making changes"
\`\`\`

📋 **HOUSE RULES** (\`houserules.md\`) contain project-specific patterns, conventions, testing requirements, and gotchas.
If houserules.md exists, you MUST follow its rules. If it doesn't exist, create one as you work.

📁 **FOLDER STRUCTURE** (\`FOLDER_STRUCTURE.md\`) documents the project layout and where files should be placed.
Read it before creating new files or directories. Update it when you add new top-level directories.

📄 **HOUSE RULES CONTRACTS** in \`House_Rules_Contracts/\` contain detailed API, schema, infrastructure,
and integration documentation. Read relevant contracts before modifying related code.

## 2. CONTEXT FILE (critical - survives context compaction)
Create immediately so you can recover after compaction:
\`\`\`bash
cat > .claude-session-${shortSessionId}.md << 'EOF'
# Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Files to Re-read After Compaction
1. This file: .claude-session-${shortSessionId}.md
2. House rules: houserules.md
3. Folder structure: FOLDER_STRUCTURE.md
4. File locks: .file-coordination/active-edits/

## Progress (update as you work)
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit

## Key Findings (add to houserules.md too)
- e.g. "Uses Zustand for state" or "Tests need build first"

## Notes (context for after compaction)
- e.g. "Working on AuthService.ts" or "Blocked on X"
EOF
\`\`\`

## 3. AFTER CONTEXT COMPACTION
If you see "context compacted", IMMEDIATELY:
1. cd "${vars.repoPath}"
2. cat .claude-session-${shortSessionId}.md
3. cat houserules.md
4. cat FOLDER_STRUCTURE.md
5. ls .file-coordination/active-edits/

## 4. FILE LOCKS (before editing any file)
\`\`\`bash
ls .file-coordination/active-edits/  # Check for conflicts first
# Replace <FILES> with actual files you're editing:
cat > .file-coordination/active-edits/claude-${shortSessionId}.json << 'EOF'
{"agent":"claude","session":"${shortSessionId}","files":["<file1.ts>","<file2.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 5. HOUSE RULES (read first, update as you learn)
Update houserules.md with patterns you discover (conventions, architecture, testing, gotchas):
\`\`\`bash
# Replace <CATEGORY> and <RULE> with actual findings:
cat >> houserules.md << 'EOF'

## <CATEGORY> - Claude ${shortSessionId}
- <RULE OR PATTERN>
EOF
\`\`\`

## 6. COMMITS${vars.mcpUrl ? `
🔧 **USE MCP TOOL: \`kanvas_commit\`** to commit changes. This is the preferred method.
- DO NOT write .devops-commit files. DO NOT run \`git commit\` directly.
- The MCP tool handles staging, committing, recording, and optionally pushing.
- Example: \`kanvas_commit({ session_id: "${vars.sessionId}", message: "feat: add auth", push: false })\`

### Available MCP Tools
| Tool | Description |
|------|-------------|
| \`kanvas_commit\` | Stage + commit + record + push |
| \`kanvas_get_session_info\` | Session config and metadata |
| \`kanvas_log_activity\` | Log to Kanvas dashboard timeline |
| \`kanvas_lock_file\` | Declare file edit intent (replaces manual file locks) |
| \`kanvas_unlock_file\` | Release file locks |
| \`kanvas_get_commit_history\` | Recent commits for session branch |
| \`kanvas_request_review\` | Signal work ready for review |` : `
📝 **Write commit messages to: \`.devops-commit-${shortSessionId}.msg\`** (this session's file)
⚠️ DO NOT use .claude-commit-msg - use the session-specific file above!`}
**One story = one commit.** If given multiple stories, complete and commit each separately.

### ⚠️ IMPORTANT: Git Attribution
Commits should be attributed to the USER, not to Claude/AI:
- NEVER change git config user.name or user.email
- NEVER use --author flag to set author to Claude
- The user's existing git identity will be used automatically
- NEVER add "Co-Authored-By: Claude" footers - commits are USER's work assisted by AI

${vars.multiRepoEntries && vars.multiRepoEntries.length > 1 ? `
## MULTI-REPO SESSION
This session spans multiple repositories. Your primary repo is listed above.

| Repo | Role | Branch | Path |
|------|------|--------|------|
${vars.multiRepoEntries.map(r => `| ${r.repoName} | ${r.role} | ${r.branchName} | ${r.worktreePath} |`).join('\n')}

**Commit scope**: ${vars.commitScope === 'per-repo' ? 'Commit each repo independently' : 'Commit all repos together using `kanvas_commit_all`'}

### Multi-Repo MCP Tools
- \`kanvas_commit({ session_id, message, repo: "repoName" })\` — commit in a specific repo
- \`kanvas_commit_all({ session_id, message })\` — commit across ALL repos at once
- \`kanvas_lock_file({ session_id, files, repo: "repoName" })\` — lock files in a specific repo
- \`kanvas_get_commit_history({ session_id, repo: "repoName" })\` — history for a specific repo

When no \`repo\` parameter is specified, operations target the **primary** repo.
Secondary repo branches use the naming convention: \`From_{PrimaryRepoName}_{DDMMYY}\`.
` : ''}---
⛔ STOP: Run setup commands, read houserules.md, then await instructions.`;
}

function getClaudeInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const rebaseNote = vars.rebaseFrequency !== 'never'
    ? `- Rebase frequency: ${vars.rebaseFrequency}`
    : '';

  // Get the comprehensive prompt
  const agentPrompt = generateClaudePrompt(vars);

  return `## Setup Claude Code for ${vars.repoName}

### Session Info
- **Session ID**: \`${shortSessionId}\`
- **Working Directory**: \`${vars.repoPath}\`
- **Branch**: \`${vars.branchName}\`

### Quick Start

1. **Open a terminal** and navigate to the working directory:
\`\`\`bash
cd "${vars.repoPath}"
\`\`\`

2. **Checkout the working branch**:
\`\`\`bash
git checkout ${vars.branchName}
\`\`\`

3. **Start Claude Code**:
\`\`\`bash
claude
\`\`\`

### Alternative: One-liner
\`\`\`bash
cd "${vars.repoPath}" && git checkout ${vars.branchName} && claude
\`\`\`

---

### Prompt for Claude Code

Copy and paste this ENTIRE prompt when starting your session:

\`\`\`
${agentPrompt}
\`\`\`

---

### Context Preservation

The prompt above includes instructions to create a session context file:
\`.claude-session-${shortSessionId}.md\`

This file will persist your session context and can be re-read after context compaction.

**Key files to update as you work:**
1. \`.claude-session-${shortSessionId}.md\` - Update progress and notes
2. \`.devops-commit-${shortSessionId}.msg\` - Write commit messages here

${vars.contextPreservation ? `
### Custom House Rules

If needed, update \`houserules.md\` with your project rules:

\`\`\`bash
cat >> "${vars.repoPath}/houserules.md" << 'EOF'

## Session-Specific Notes
${vars.contextPreservation}
EOF
\`\`\`
` : ''}
---

### Git Workflow
- **Working directory**: \`${vars.repoPath}\`
- **Working branch**: \`${vars.branchName}\`
- **Base branch**: The branch this was created from
${rebaseNote ? `- **Rebase**: ${vars.rebaseFrequency}` : ''}

Your activity will appear in Kanvas once Claude starts working.
`;
}

function getCursorInstructions(vars: InstructionVars): string {
  return `## Setup Cursor for ${vars.repoName}

### Quick Start

1. **Open Cursor IDE**

2. **Open the repository folder**:
   - File → Open Folder
   - Select: \`${vars.repoPath}\`

3. **Configure Kanvas reporting** (optional):
   - Open Settings (Cmd/Ctrl + ,)
   - Search for "Kanvas"
   - Set Session ID: \`${vars.sessionId}\`

### Workspace Settings
Add to \`.vscode/settings.json\`:
\`\`\`json
{
  "kanvas.sessionId": "${vars.sessionId}",
  "kanvas.enabled": true
}
\`\`\`

### Task
${vars.taskDescription}

### Branch
Make sure you're on: \`${vars.branchName}\`

\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

---

Cursor activity will appear in Kanvas when the extension is configured.
`;
}

function getCopilotInstructions(vars: InstructionVars): string {
  return `## Setup GitHub Copilot for ${vars.repoName}

### Prerequisites
- VS Code with GitHub Copilot extension installed
- Active GitHub Copilot subscription

### Quick Start

1. **Open VS Code**

2. **Open the repository**:
\`\`\`bash
code "${vars.repoPath}"
\`\`\`

3. **Checkout the branch**:
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

4. **Install Kanvas Reporter extension** (optional):
   - Open Extensions (Cmd/Ctrl + Shift + X)
   - Search for "Kanvas Reporter"
   - Install and configure with Session ID: \`${vars.sessionId}\`

### Task
${vars.taskDescription}

### Manual Activity Reporting
If not using the extension, you can report activity manually by creating files in:
\`${vars.repoPath}/.kanvas/activity/\`

---

Start coding with Copilot and your activity will be tracked.
`;
}

function getClineInstructions(vars: InstructionVars): string {
  return `## Setup Cline for ${vars.repoName}

### Prerequisites
- VS Code with Cline extension installed
- API key configured (Anthropic, OpenAI, etc.)

### Quick Start

1. **Open VS Code**:
\`\`\`bash
code "${vars.repoPath}"
\`\`\`

2. **Open Cline panel** (Cmd/Ctrl + Shift + P → "Cline: Open")

3. **Configure Kanvas integration**:
   - Open Cline Settings
   - Add custom environment:
\`\`\`json
{
  "KANVAS_SESSION_ID": "${vars.sessionId}",
  "KANVAS_REPO_PATH": "${vars.repoPath}"
}
\`\`\`

### Task
Paste this into Cline:
\`\`\`
${vars.taskDescription}

Working in branch: ${vars.branchName}
\`\`\`

### Branch Setup
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

---

Cline will autonomously work on the task. Activity appears in Kanvas.
`;
}

function getAiderInstructions(vars: InstructionVars): string {
  return `## Setup Aider for ${vars.repoName}

### Prerequisites
- Aider installed (\`pip install aider-chat\`)
- API key configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)

### Quick Start

1. **Navigate to repository**:
\`\`\`bash
cd "${vars.repoPath}"
\`\`\`

2. **Checkout the branch**:
\`\`\`bash
git checkout ${vars.branchName}
\`\`\`

3. **Start Aider with Kanvas reporting**:
\`\`\`bash
KANVAS_SESSION_ID="${vars.sessionId}" aider
\`\`\`

### Alternative: Using Aider flags
\`\`\`bash
aider --env KANVAS_SESSION_ID="${vars.sessionId}"
\`\`\`

### Task
Once Aider starts, describe your task:
\`\`\`
${vars.taskDescription}
\`\`\`

### Useful Aider Commands
- \`/add <file>\` - Add files to context
- \`/drop <file>\` - Remove files from context
- \`/commit\` - Commit changes
- \`/diff\` - Show pending changes

---

Aider commits will appear in Kanvas automatically.
`;
}

function getWarpInstructions(vars: InstructionVars): string {
  return `## Setup Warp AI for ${vars.repoName}

### Prerequisites
- Warp terminal installed
- Warp AI enabled in settings

### Quick Start

1. **Open Warp**

2. **Navigate to repository**:
\`\`\`bash
cd "${vars.repoPath}"
\`\`\`

3. **Set Kanvas environment**:
\`\`\`bash
export KANVAS_SESSION_ID="${vars.sessionId}"
export KANVAS_REPO_PATH="${vars.repoPath}"
\`\`\`

4. **Checkout the branch**:
\`\`\`bash
git checkout ${vars.branchName}
\`\`\`

### Warp Workflow (Optional)
Create a workflow for this project:
\`\`\`yaml
name: ${vars.repoName} Dev Session
command: |
  cd "${vars.repoPath}"
  export KANVAS_SESSION_ID="${vars.sessionId}"
  git checkout ${vars.branchName}
\`\`\`

### Task
${vars.taskDescription}

---

Use Warp AI (# key) to get help with your task. Activity tracked via git commits.
`;
}

function getCustomInstructions(vars: InstructionVars): string {
  return `## Custom Agent Setup for ${vars.repoName}

### Kanvas Integration

To integrate a custom agent with Kanvas, you have two options:

#### Option 1: Environment Variables
Set these environment variables before starting your agent:
\`\`\`bash
export KANVAS_SESSION_ID="${vars.sessionId}"
export KANVAS_REPO_PATH="${vars.repoPath}"
export KANVAS_BRANCH="${vars.branchName}"
\`\`\`

#### Option 2: File-Based Reporting
Write activity to the Kanvas directory:

**Register Agent** - Create \`${vars.repoPath}/.kanvas/agents/<agent-id>.json\`:
\`\`\`json
{
  "agentId": "your-agent-id",
  "agentType": "custom",
  "agentName": "Your Agent Name",
  "version": "1.0.0",
  "pid": 12345,
  "startedAt": "${new Date().toISOString()}",
  "capabilities": ["code-generation", "file-watching"]
}
\`\`\`

**Report Session** - Create \`${vars.repoPath}/.kanvas/sessions/${vars.sessionId}.json\`:
\`\`\`json
{
  "sessionId": "${vars.sessionId}",
  "agentId": "your-agent-id",
  "agentType": "custom",
  "task": "${vars.taskDescription}",
  "branchName": "${vars.branchName}",
  "worktreePath": "${vars.repoPath}",
  "repoPath": "${vars.repoPath}",
  "status": "active",
  "created": "${new Date().toISOString()}",
  "updated": "${new Date().toISOString()}",
  "commitCount": 0
}
\`\`\`

**Log Activity** - Append to \`${vars.repoPath}/.kanvas/activity/${vars.sessionId}.log\`:
\`\`\`json
{"agentId":"your-agent-id","sessionId":"${vars.sessionId}","type":"info","message":"Started working on task","timestamp":"${new Date().toISOString()}"}
\`\`\`

**Heartbeat** - Update \`${vars.repoPath}/.kanvas/heartbeats/<agent-id>.beat\`:
\`\`\`
${new Date().toISOString()}
\`\`\`

### Task
${vars.taskDescription}

### Branch
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

---

Your custom agent's activity will appear in Kanvas when files are written correctly.
`;
}

/**
 * Get a brief description for each agent type
 */
export function getAgentTypeDescription(agentType: AgentType): string {
  const descriptions: Record<AgentType, string> = {
    claude: 'Claude Code - Full AI coding assistant with terminal access',
    cursor: 'Cursor IDE - AI-powered code editing and completion',
    copilot: 'GitHub Copilot - AI pair programmer in VS Code',
    cline: 'Cline - Autonomous coding agent for VS Code',
    aider: 'Aider - Git-aware AI pair programming in terminal',
    warp: 'Warp - AI-powered terminal with natural language commands',
    custom: 'Custom Agent - Any tool with Kanvas integration',
  };

  return descriptions[agentType];
}

/**
 * Get the launch method for each agent type
 */
export function getAgentLaunchMethod(agentType: AgentType): 'cli' | 'ide' | 'terminal' | 'manual' {
  const methods: Record<AgentType, 'cli' | 'ide' | 'terminal' | 'manual'> = {
    claude: 'cli',
    cursor: 'ide',
    copilot: 'ide',
    cline: 'ide',
    aider: 'cli',
    warp: 'terminal',
    custom: 'manual',
  };

  return methods[agentType];
}

/**
 * Check if agent can be auto-launched from Kanvas
 */
export function canAutoLaunch(agentType: AgentType): boolean {
  // Only DevOps Agent (our built-in) can be auto-launched
  // External agents require manual setup
  return false;
}
