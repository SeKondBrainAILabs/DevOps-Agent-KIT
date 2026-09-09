/**
 * Agent Setup Instructions Templates
 * Generated instructions for each agent type
 */

import type { AgentType, AgentInstanceConfig, RepoEntry } from './types';

export interface InstructionVars {
  repoPath: string;
  repoName: string;
  branchName: string;
  baseBranch?: string;
  sessionId: string;
  taskDescription: string;
  systemPrompt: string;
  contextPreservation: string;
  rebaseFrequency: string;
  mcpUrl?: string;
  /** Stateless JSON-RPC endpoint for Codex / type:"http" clients (/rpc) */
  rpcUrl?: string;
  // Custom agent MCP opt-in
  customMcpEnabled?: boolean;
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
    codex: getCodexInstructions,
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
${vars.mcpUrl ? `
## 🔌 MCP SERVER CONNECTION
This session has a KIT MCP server configured at: \`${vars.mcpUrl}\`
MCP config is provided via \`.mcp.json\` and \`.claude/settings.json\` in this worktree.
If using global config: check \`~/.claude/settings.json\` (install via KIT Settings > MCP tab).
You should have these MCP tools available:
\`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`

**⚠️ These are MCP protocol tools, NOT bash commands. Do NOT try to run them in a terminal.**
**If you do NOT see these tools in your available tools list, the MCP connection failed — use the FALLBACK instructions in each section below.**
` : ''}
## MANDATORY FIRST RESPONSE${vars.mcpUrl ? `
🛑 **Step 0 — REGISTER YOUR CONNECTION (do this FIRST, before pwd, before anything else):**
Call the MCP tool \`kit_log_activity\` with:
\`\`\`
session_id="${vars.sessionId}"
type="session"
message="Session connected — starting setup"
\`\`\`
This is REQUIRED. The KIT dashboard shows "Waiting for agent to connect…" until this call lands. Seeing the tool in your list is NOT enough — you must invoke it. If the call fails (tool not available / 404), the MCP connection is broken — use the fallbacks below and tell the user.
` : ''}
Then respond with:
✓ Current directory: [output of pwd]
✓ Houserules read: [yes/no - if yes, summarize key rules]
✓ File locks checked: [yes/no]${vars.mcpUrl ? `
✓ MCP tools available: [yes/no — confirm you see: kit_commit, kit_commit_all, kit_get_session_info, kit_log_activity, kit_lock_file, kit_unlock_file, kit_get_commit_history, kit_request_review, kit_merge, kit_rebase]
✓ kit_log_activity registration call succeeded: [yes/no — required from Step 0 above]` : ''}

## 🛑 MERGE POLICY — MAIN IS PROTECTED (S9N-6394)
**You may NEVER merge into \`main\` / \`master\` (direct push OR PR) unless CI is green.**

Before any merge into main:
1. Run \`gh pr checks <PR-number>\` (or \`gh run list --branch <source-branch> --limit 1\`)
2. Every required check must be \`SUCCESS\`. **PENDING or FAILURE = stop.**
3. Never merge a \`WIP:\` / \`[Kanvas]\` / \`[Kanvas Restart]\` auto-checkpoint commit into main. Squash/interactive-rebase to clean tips first.
4. After merge, verify: \`gh run watch --exit-status\` on the triggered main run. If it goes red, **revert immediately** (\`git revert <merge-sha> && git push\`).

The KIT MergeService also enforces this at the code level — a red or pending CI blocks \`merge:execute\` and returns an error. But the prompt rule is the primary contract; the code gate is belt-and-suspenders. **Never bypass with \`--force\` / \`--no-verify\` unless the user explicitly authorizes.**

If the target repo has a pre-push hook (\`typecheck\`, \`gate\`, tests), let it run — do not skip it.

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

## 4. FILE LOCKS (before editing any file)${vars.mcpUrl ? `
🔧 **PREFERRED: Use MCP tool \`kit_lock_file\`** to declare file edit intent.
- Call \`kit_lock_file\` MCP tool with: session_id="${vars.sessionId}", files=["file1.ts","file2.ts"]
- When done, call \`kit_unlock_file\` MCP tool to release locks.
- The MCP tool checks for conflicts with other agents automatically.

### ⚠️ FALLBACK: If MCP tools are NOT available
` : ''}Use filesystem locks:
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
### ⚠️ COMMIT FREQUENTLY — this is required, not optional
- **Commit after every meaningful change** (a function written, a file completed, a bug fixed, a test passing). Don't batch a whole task into one commit at the end.
- A good cadence is a commit every few minutes of work, or whenever you finish a logical unit. Small, frequent commits make your work recoverable and reviewable.
- KIT runs a periodic auto-save (~every 5 min) as a safety net, but those are generic "WIP" commits — YOUR commits with real messages are what matter. Don't rely on the safety net.
- Before pausing, switching files, or ending the session: commit.

🔧 **PREFERRED: Use MCP tool \`kit_commit\`** to commit changes.
- These are **MCP protocol tools** available via your MCP server connection.
- ⛔ They are NOT bash commands — do NOT run \`kit_commit\` or \`kit_commit_all\` in a terminal.
- ⛔ DO NOT use \`type\`, \`which\`, or \`grep\` to find them — they are MCP tools, not executables.
- Call them as MCP tools with the parameters shown below.
- The MCP tool handles staging, committing, recording, and optionally pushing.

**Your session_id for ALL MCP tool calls: \`${vars.sessionId}\`**

### Available MCP Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| \`kit_commit\` | session_id, message, **cwd**, push (optional) | Stage + commit + record + push |
| \`kit_commit_all\` | session_id, message, **cwd**, push (optional) | Commit across all repos (multi-repo) |
| \`kit_get_session_info\` | session_id | Session config and metadata |
| \`kit_log_activity\` | session_id, type, message | Log to KIT dashboard timeline |
| \`kit_lock_file\` | session_id, files, **cwd** | Declare file edit intent |
| \`kit_unlock_file\` | session_id, files | Release file locks |
| \`kit_get_commit_history\` | session_id | Recent commits for session branch |
| \`kit_request_review\` | session_id, summary, **cwd** | Signal work ready for review |

⚠️ **\`cwd\` is REQUIRED on \`kit_commit\`, \`kit_commit_all\`, \`kit_lock_file\`, and \`kit_request_review\`.**
Pass the output of \`pwd\` (your current shell directory). KIT verifies it matches this session's worktree (\`${vars.repoPath}\`) AND that the worktree is on branch \`${vars.branchName || 'YOUR_SESSION_BRANCH'}\`. If you have \`cd\`'d elsewhere or run \`git checkout\`/detached HEAD, the call is **rejected** with a correction message — your work would otherwise be committed to the wrong place or lost. Always \`cd\` back into the worktree and stay on your session branch before committing.

### ⚠️ FALLBACK: If MCP tools are NOT in your available tools list
If the \`kit_commit\` MCP tool is not listed in your tools (MCP connection failed):
1. Stage and commit directly: \`git add -A && git commit -m "your message"\`
2. Or write commit message to \`.devops-commit-${shortSessionId}.msg\` or \`.claude-commit-msg\` — the KIT watcher will auto-commit.

⛔ **CRITICAL GIT PUSH RULES (read even if MCP is working):**
- If you need to push manually, ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- **NEVER** push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch directly
- **NEVER** use \`HEAD:main\` or \`HEAD:master\` in a push command
- Merging to the base branch is done by the human via Kanvas — NOT by the agent
- If you cannot commit via MCP or git, STOP and ask the user — do not invent alternative push strategies` : `
📝 **To commit**, either:
1. Stage and commit directly: \`git add -A && git commit -m "your message"\`
2. Or write your commit message to \`.devops-commit-${shortSessionId}.msg\` or \`.claude-commit-msg\` — the KIT watcher will auto-commit.

⛔ **CRITICAL GIT PUSH RULES:**
- ONLY push to your session branch — NEVER to \`main\`, \`master\`, or any base/production branch
- Merging to the base branch is done by the human via Kanvas — NOT by the agent
- If you cannot commit, STOP and ask the user — do not invent alternative push strategies`}

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

**Commit scope**: ${vars.commitScope === 'per-repo' ? 'Commit each repo independently' : 'Commit all repos together using the `kit_commit_all` MCP tool'}

### Multi-Repo MCP Tools (these are MCP protocol tools, NOT bash commands)
| Tool | Extra Parameters | Description |
|------|-----------------|-------------|
| \`kit_commit\` | **cwd**, repo (optional) | Commit in a specific repo |
| \`kit_commit_all\` | **cwd** | Commit across ALL repos at once |
| \`kit_lock_file\` | **cwd**, repo (optional) | Lock files in a specific repo |
| \`kit_get_commit_history\` | repo (optional) | History for a specific repo |

When no \`repo\` parameter is specified, operations target the **primary** repo.
⚠️ \`cwd\` (output of \`pwd\`) is REQUIRED on \`kit_commit\`/\`kit_commit_all\`/\`kit_lock_file\`. KIT rejects the call if you are not in the correct worktree on the correct branch.

### ⚠️ Branch naming — read carefully
- **Primary repo**: use the branch name shown in the table above — do NOT invent or rename it.
- **Secondary (child) repos only**: branches follow \`Upgrade_From_{PrimaryRepoName}\` (no date suffix).
- 🚫 DO NOT apply the \`Upgrade_From_*\` pattern to the primary repo. That naming exists solely to trace child-repo commits back to the primary repo's session. Using it on the primary creates a confusing self-referential branch.

### ⚠️ FALLBACK: If MCP tools are NOT available
If \`kit_commit_all\` is not in your tools list, commit each repo manually:
\`\`\`bash
# For each repo, cd to its worktree path and commit
cd /path/to/repo-worktree && git add -A && git commit -m "your message"
\`\`\`
` : ''}---
⛔ STOP: Run setup commands, read houserules.md, then await instructions.`;
}

/**
 * Generate the standalone prompt for OpenAI Codex CLI agent.
 * Formatted for Codex's task-based workflow — not Claude's conversation style.
 * References ~/.codex/config.json for MCP, uses codex-session-* files.
 */
export function generateCodexPrompt(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  return `# SESSION ${shortSessionId}

# ⚠️ CRITICAL: WRONG DIRECTORY = WASTED WORK ⚠️
WORKDIR: ${vars.repoPath}
YOU MUST WORK ONLY IN THIS DIRECTORY - NOT THE MAIN REPO

BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete the SETUP steps below, then STOP and wait for the user to explicitly say to begin.
Do NOT infer that pasting this prompt is permission to start working.
${(vars.rpcUrl || vars.mcpUrl) ? `
## 🔌 MCP SERVER CONNECTION
This session has a KIT MCP server.
- **Stateless JSON-RPC endpoint (use this):** \`${vars.rpcUrl || vars.mcpUrl}\`
- MCP config is provided via \`.mcp.json\` in this worktree (auto-detected by Codex).
- If not auto-detected, add to \`~/.codex/config.json\`:
\`\`\`json
{ "mcpServers": { "kit": { "type": "http", "url": "${vars.rpcUrl || vars.mcpUrl}" } } }
\`\`\`
Available MCP tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`

**⚠️ These are MCP protocol tools — NOT bash commands. Do not run them in a terminal.**

🛑 **REGISTER FIRST**: Before any setup steps, call the MCP tool \`kit_log_activity\` with \`session_id="${vars.sessionId}"\`, \`type="session"\`, \`message="Session connected — starting setup"\`. The KIT dashboard stays on "Waiting for agent to connect…" until this lands. Seeing the tool listed is not enough — you must invoke it.
` : ''}
## 🛑 MERGE POLICY — MAIN IS PROTECTED (S9N-6394)
**You may NEVER merge into \`main\` / \`master\` (direct push OR PR) unless CI is green.**

Before any merge into main:
1. Run \`gh pr checks <PR-number>\` (or \`gh run list --branch <source-branch> --limit 1\`)
2. Every required check must be \`SUCCESS\`. **PENDING or FAILURE = stop.**
3. Never merge a \`WIP:\` / \`[Kanvas]\` / \`[Kanvas Restart]\` auto-checkpoint commit into main. Squash/interactive-rebase to clean tips first.
4. After merge, verify: \`gh run watch --exit-status\` on the triggered main run. If it goes red, **revert immediately** (\`git revert <merge-sha> && git push\`).

The KIT MergeService also enforces this at the code level — a red or pending CI blocks \`merge:execute\` and returns an error. But the prompt rule is the primary contract; the code gate is belt-and-suspenders. **Never bypass with \`--force\` / \`--no-verify\` unless the user explicitly authorizes.**

If the target repo has a pre-push hook (\`typecheck\`, \`gate\`, tests), let it run — do not skip it.

## 1. SETUP (run first)
\`\`\`bash
cd "${vars.repoPath}"
pwd
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs - read relevant ones before making changes"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .codex-session-${shortSessionId}.md << 'EOF'
# Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)${vars.mcpUrl ? `
🔧 **PREFERRED: Use MCP tool \`kit_lock_file\`** with session_id="${vars.sessionId}", files=["file.ts"]
Release with \`kit_unlock_file\` when done.

### ⚠️ FALLBACK: If MCP tools are not available` : ''}
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/codex-${shortSessionId}.json << 'EOF'
{"agent":"codex","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS${vars.mcpUrl ? `
🔧 **PREFERRED: Use MCP tool \`kit_commit\`** (NOT a bash command — MCP protocol only)
**session_id for all MCP calls: \`${vars.sessionId}\`**
⚠️ **COMMIT FREQUENTLY** — commit after every meaningful change (a logical unit, a passing test, a fixed bug), not once at the end. Aim for a commit every few minutes of work. KIT auto-saves WIP every ~5 min as a safety net, but your real, message-bearing commits are what count — commit before pausing or ending the session.
⚠️ **\`kit_commit\`, \`kit_commit_all\`, \`kit_lock_file\`, \`kit_request_review\` REQUIRE a \`cwd\` parameter** — pass the output of \`pwd\`. KIT verifies it equals this session's worktree (\`${vars.repoPath}\`) on branch \`${vars.branchName || 'YOUR_SESSION_BRANCH'}\` and REJECTS the call otherwise. Never commit from a different directory or after \`git checkout\` to another branch — \`cd\` back first.

### ⚠️ FALLBACK: If MCP tools are not available` : ''}
\`\`\`bash
git add -A && git commit -m "your message"
# Push ONLY to your session branch:
git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}
\`\`\`

⛔ **CRITICAL GIT PUSH RULES — READ BEFORE ANY PUSH:**
- ONLY push to your session branch (\`${vars.branchName || 'YOUR_SESSION_BRANCH'}\`)
- **NEVER** push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch directly
- **NEVER** use \`HEAD:main\` or \`HEAD:master\` in any git push command
- Merging to the base branch is done by the human via Kanvas — NOT by the agent
- If MCP commit fails and direct git also fails, **STOP and tell the user** — do not invent alternative strategies
${vars.multiRepoEntries && vars.multiRepoEntries.length > 1 ? `
## MULTI-REPO SESSION
| Repo | Role | Branch | Path |
|------|------|--------|------|
${vars.multiRepoEntries.map(r => `| ${r.repoName} | ${r.role} | ${r.branchName} | ${r.worktreePath} |`).join('\n')}
` : ''}
---
⛔ STOP: Run setup commands above, read houserules.md, then await explicit user instructions before starting any implementation work.`;
}

function getClaudeInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const rebaseNote = vars.rebaseFrequency !== 'never'
    ? `- Rebase frequency: ${vars.rebaseFrequency}`
    : '';

  // Get the comprehensive prompt
  const agentPrompt = generateClaudePrompt(vars);

  return `## Setup Coding Agent for ${vars.repoName}

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

3. **Start your coding agent**:
\`\`\`bash
claude
\`\`\`

### Alternative: One-liner
\`\`\`bash
cd "${vars.repoPath}" && git checkout ${vars.branchName} && claude
\`\`\`

---

### Prompt for your Coding Agent

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
2. Commit via: MCP tool \`kit_commit\`, or \`git commit\`, or write to \`.devops-commit-${shortSessionId}.msg\` / \`.claude-commit-msg\`

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

Your activity will appear in KIT once Claude starts working.
`;
}

function getCursorInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  const mcpSetupSection = vars.mcpUrl ? `
### KIT MCP Setup
Cursor auto-detects \`.mcp.json\` in the project root (KIT creates this automatically).

If not auto-detected, add via **Cursor Settings → MCP → Add Server**:
- Name: \`kit\`
- Type: \`Streamable HTTP\`
- URL: \`${vars.mcpUrl}\`

Or add \`.mcp.json\` to the project root:
\`\`\`json
{ "mcpServers": { "kit": { "type": "streamable-http", "url": "${vars.mcpUrl}" } } }
\`\`\`

Available MCP tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`
` : '';

  const agentPrompt = `# SESSION ${shortSessionId}
WORKDIR: ${vars.repoPath}
BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete setup steps below, then STOP and wait for the user to explicitly say to begin.
${vars.mcpUrl ? `
## 🔌 MCP SERVER CONNECTION
KIT MCP server: \`${vars.mcpUrl}\`
Config via \`.mcp.json\` in project root (auto-created by KIT) or Cursor Settings → MCP.
Available tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`
**These are MCP protocol tools — NOT bash commands.**
` : ''}
## 1. SETUP (run in Cursor terminal)
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .cursor-session-${shortSessionId}.md << 'EOF'
# Cursor Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_lock_file\` with session_id="${vars.sessionId}", files=["file.ts"]
Release with \`kit_unlock_file\` when done.

FALLBACK:` : ''}
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/cursor-${shortSessionId}.json << 'EOF'
{"agent":"cursor","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_commit\` (NOT a bash command — MCP protocol only)
**session_id for all MCP calls: \`${vars.sessionId}\`**

FALLBACK:` : ''}
Use Cursor's Source Control panel or:
\`\`\`bash
git add -A && git commit -m "your message"
\`\`\`

⛔ CRITICAL GIT PUSH RULES:
- ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- NEVER push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch
- Merging to base branch is done by the human via Kanvas — NOT by the agent

⛔ STOP: Run setup commands, read houserules.md, then await explicit user instructions before starting any implementation work.`;

  return `## Setup Cursor for ${vars.repoName}

### Quick Start

1. **Open Cursor** and open the folder:
\`\`\`bash
cursor "${vars.repoPath}"
\`\`\`

2. **Enable Agent mode**: Cmd+I → open Composer → toggle "Agent" in the top-right

3. **Checkout branch** (in Cursor's integrated terminal):
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

4. **Read house rules**:
\`\`\`bash
cat houserules.md 2>/dev/null
\`\`\`
${mcpSetupSection}
---

### Prompt to paste into Cursor Composer (Agent mode)

Copy and paste the ENTIRE block below into the Cursor Composer input:

\`\`\`
${agentPrompt}
\`\`\`

---

**After Cursor confirms setup** (directory verified, houserules read, context file created), explicitly tell it to start work.

Activity will appear in the KIT dashboard once the MCP server is connected.
`;
}

function getCopilotInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  const mcpSetupSection = vars.mcpUrl ? `
### KIT MCP Setup
VS Code Copilot auto-detects \`.mcp.json\` in the project root (KIT creates this automatically).

If not auto-detected, add to VS Code settings (\`Cmd+,\` → search "mcp"):
\`\`\`json
{
  "mcp.servers": {
    "kit": { "type": "http", "url": "${vars.mcpUrl}" }
  }
}
\`\`\`

Available MCP tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`
` : '';

  const agentPrompt = `# SESSION ${shortSessionId}
WORKDIR: ${vars.repoPath}
BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete setup steps below, then STOP and wait for the user to explicitly say to begin.
${vars.mcpUrl ? `
## 🔌 MCP SERVER CONNECTION
KIT MCP server: \`${vars.mcpUrl}\`
Config via \`.mcp.json\` in project root (auto-detected by VS Code) or VS Code settings → mcp.servers.
Available tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`
**These are MCP protocol tools — NOT bash commands.**
` : ''}
## 1. SETUP (run in VS Code terminal)
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .copilot-session-${shortSessionId}.md << 'EOF'
# Copilot Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_lock_file\` with session_id="${vars.sessionId}", files=["file.ts"]
Release with \`kit_unlock_file\` when done.

FALLBACK:` : ''}
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/copilot-${shortSessionId}.json << 'EOF'
{"agent":"copilot","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_commit\` (NOT a bash command — MCP protocol only)
**session_id for all MCP calls: \`${vars.sessionId}\`**

FALLBACK:` : ''}
Use VS Code Source Control panel or:
\`\`\`bash
git add -A && git commit -m "your message"
\`\`\`

⛔ CRITICAL GIT PUSH RULES:
- ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- NEVER push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch
- Merging to base branch is done by the human via Kanvas — NOT by the agent

⛔ STOP: Run setup commands, read houserules.md, then await explicit user instructions before starting any implementation work.`;

  return `## Setup GitHub Copilot for ${vars.repoName}

### Quick Start

1. **Open VS Code**:
\`\`\`bash
code "${vars.repoPath}"
\`\`\`

2. **Enable Agent mode**: Cmd+Shift+I → open Copilot Chat → set mode to "Agent" in the dropdown

3. **Checkout branch** (in VS Code terminal):
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

4. **Read house rules**:
\`\`\`bash
cat houserules.md 2>/dev/null
\`\`\`
${mcpSetupSection}
---

### Prompt to paste into Copilot Chat (Agent mode)

Copy and paste the ENTIRE block below into the Copilot Chat "Agent" input:

\`\`\`
${agentPrompt}
\`\`\`

---

**After Copilot confirms setup** (directory verified, houserules read, context file created), explicitly tell it to start work.

Activity will appear in the KIT dashboard once the MCP server is connected.
`;
}

function getClineInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  const mcpSetupSection = vars.mcpUrl ? `
### KIT MCP Setup
Cline supports MCP natively. KIT auto-creates \`.mcp.json\` in the project root (Cline discovers it automatically).

If not auto-detected, add via **Cline Settings → MCP Servers → Add**:
- Name: \`kit\`
- Type: \`Streamable HTTP\`
- URL: \`${vars.mcpUrl}\`

Available MCP tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`

**session_id for all MCP calls: \`${vars.sessionId}\`**
` : '';

  const agentPrompt = `# SESSION ${shortSessionId}
WORKDIR: ${vars.repoPath}
BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete setup steps below, then STOP and wait for the user to explicitly say to begin.
${vars.mcpUrl ? `
## 🔌 MCP SERVER CONNECTION
KIT MCP server: \`${vars.mcpUrl}\`
Config via \`.mcp.json\` in project root (auto-detected by Cline) or Cline Settings → MCP Servers.
Available tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`
**These are MCP protocol tools — NOT bash commands.**
` : ''}
## 1. SETUP (run in terminal)
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .cline-session-${shortSessionId}.md << 'EOF'
# Cline Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_lock_file\` with session_id="${vars.sessionId}", files=["file.ts"]
Release with \`kit_unlock_file\` when done.

FALLBACK:` : ''}
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/cline-${shortSessionId}.json << 'EOF'
{"agent":"cline","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS${vars.mcpUrl ? `
🔧 PREFERRED: Use MCP tool \`kit_commit\` (NOT a bash command — MCP protocol only)
**session_id for all MCP calls: \`${vars.sessionId}\`**
Or use the \`kit_commit\` MCP tool directly from Cline's MCP panel.

FALLBACK:` : ''}
\`\`\`bash
git add -A && git commit -m "your message"
\`\`\`

⛔ CRITICAL GIT PUSH RULES:
- ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- NEVER push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch
- Merging to base branch is done by the human via Kanvas — NOT by the agent

⛔ STOP: Run setup commands, read houserules.md, then await explicit user instructions before starting any implementation work.`;

  return `## Setup Cline for ${vars.repoName}

### Quick Start

1. **Open VS Code**:
\`\`\`bash
code "${vars.repoPath}"
\`\`\`

2. **Open Cline**: Click the robot icon in the sidebar, or Cmd+Shift+P → "Cline: Open in New Tab"

3. **Checkout branch** (in VS Code terminal):
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

4. **Read house rules**:
\`\`\`bash
cat houserules.md 2>/dev/null
\`\`\`
${mcpSetupSection}
---

### Prompt to paste as the first message in Cline's task input

Copy and paste the ENTIRE block below into Cline's task input:

\`\`\`
${agentPrompt}
\`\`\`

---

**After Cline confirms setup** (directory verified, houserules read, context file created), explicitly tell it to start work.

Activity will appear in the KIT dashboard once the MCP server is connected.
`;
}

function getAiderInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  const agentPrompt = `# SESSION ${shortSessionId}
WORKDIR: ${vars.repoPath}
BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete setup steps below, then STOP and wait for the user to explicitly say to begin.

Note: Aider does not natively support MCP. KIT tracks your activity via git commits automatically.

## 1. SETUP (confirm after pasting this)
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .aider-session-${shortSessionId}.md << 'EOF'
# Aider Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/aider-${shortSessionId}.json << 'EOF'
{"agent":"aider","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS
Use the \`/commit\` command or:
\`\`\`bash
git add -A && git commit -m "your message"
\`\`\`

⛔ CRITICAL GIT PUSH RULES:
- ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- NEVER push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch
- Merging to base branch is done by the human via Kanvas — NOT by the agent

## Useful Aider Commands
- \`/add <file>\` — add files to context
- \`/commit\` — commit changes
- \`/diff\` — show pending changes
- \`/undo\` — undo last commit

⛔ STOP: Run setup commands, read houserules.md, then await explicit user instructions before starting any implementation work.`;

  return `## Setup Aider for ${vars.repoName}

### Quick Start

1. **Open a terminal** and navigate to the repo:
\`\`\`bash
cd "${vars.repoPath}" && git checkout ${vars.branchName}
\`\`\`

2. **Read house rules**:
\`\`\`bash
cat houserules.md 2>/dev/null
\`\`\`

3. **Start Aider**:
\`\`\`bash
cd "${vars.repoPath}" && git checkout ${vars.branchName} && aider --model claude-3-5-sonnet-20241022
\`\`\`

Note: Aider does not natively support MCP. KIT tracks your activity via git commits automatically — no extra setup needed.

---

### Prompt to paste into Aider chat

Once Aider starts, paste the ENTIRE block below as your first message:

\`\`\`
${agentPrompt}
\`\`\`

---

**After Aider confirms setup** (directory verified, houserules read, context file created), explicitly tell it to start work.

Aider commits appear in KIT automatically via the git watcher.
`;
}

function getWarpInstructions(vars: InstructionVars): string {
  const shortSessionId = vars.sessionId.replace('sess_', '').slice(0, 8);
  const task = vars.taskDescription || vars.branchName || 'development';

  const agentPrompt = `# SESSION ${shortSessionId}
WORKDIR: ${vars.repoPath}
BRANCH: ${vars.branchName}
TASK: ${task}

# 🛑 DO NOT START IMPLEMENTATION YET
Complete setup steps below, then STOP and wait for the user to explicitly say to begin.

Note: Warp does not natively support MCP. KIT tracks your activity via git commits automatically.

## 1. SETUP (run these commands first)
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
cat houserules.md 2>/dev/null || echo "No houserules.md"
cat FOLDER_STRUCTURE.md 2>/dev/null || echo "No FOLDER_STRUCTURE.md"
ls House_Rules_Contracts/ 2>/dev/null && echo "Found contract docs"
\`\`\`

## 2. CONTEXT FILE
\`\`\`bash
cat > .warp-session-${shortSessionId}.md << 'EOF'
# Warp Session ${shortSessionId}
Dir: ${vars.repoPath}
Branch: ${vars.branchName}
Task: ${task}

## Progress
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit
EOF
\`\`\`

## 3. FILE LOCKS (before editing any file)
\`\`\`bash
ls .file-coordination/active-edits/
cat > .file-coordination/active-edits/warp-${shortSessionId}.json << 'EOF'
{"agent":"warp","session":"${shortSessionId}","files":["<file1.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 4. COMMITS
\`\`\`bash
git add -A && git commit -m "your message"
\`\`\`

⛔ CRITICAL GIT PUSH RULES:
- ONLY push to your session branch: \`git push origin HEAD:${vars.branchName || 'YOUR_SESSION_BRANCH'}\`
- NEVER push to \`${vars.baseBranch || 'main'}\`, \`main\`, \`master\`, or any base/production branch
- Merging to base branch is done by the human via Kanvas — NOT by the agent

## Warp AI Tips
- Use the \`#\` key or Cmd+I for natural language commands
- Use "Warp Drive" to save and reuse command workflows
- Warp AI can help you understand errors and suggest fixes

⛔ STOP: Run setup commands, read houserules.md, then await explicit user instructions before starting any implementation work.`;

  return `## Setup Warp AI for ${vars.repoName}

### Quick Start

1. **Open Warp terminal** and navigate to the repo:
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

2. **Read house rules**:
\`\`\`bash
cat houserules.md 2>/dev/null
\`\`\`

3. **Use Warp AI**: Press \`#\` or Cmd+I to activate natural language mode. Use Warp Drive to save workflows.

Note: Warp does not natively support MCP. KIT tracks your activity via git commits automatically — no extra setup needed.

---

### Setup commands to run (paste into Warp)

\`\`\`bash
cd "${vars.repoPath}" && git checkout ${vars.branchName} && cat houserules.md 2>/dev/null
\`\`\`

### Prompt to guide your Warp AI session

Paste the ENTIRE block below into Warp AI (# key) as your starting instructions:

\`\`\`
${agentPrompt}
\`\`\`

---

**After Warp confirms setup** (directory verified, houserules read, context file created), explicitly tell it to start work.

Commits appear in KIT automatically via the git watcher.
`;
}

function getCodexInstructions(vars: InstructionVars): string {
  const mcpSection = vars.mcpUrl ? `
### KIT MCP Setup
KIT auto-creates \`.mcp.json\` in the project root — Codex picks this up automatically.

If not auto-detected, add to \`~/.codex/config.json\`:
\`\`\`json
{ "mcpServers": { "kit": { "type": "http", "url": "${vars.mcpUrl}" } } }
\`\`\`

Available MCP tools: \`kit_commit\`, \`kit_commit_all\`, \`kit_get_session_info\`, \`kit_log_activity\`, \`kit_lock_file\`, \`kit_unlock_file\`, \`kit_get_commit_history\`, \`kit_request_review\`, \`kit_merge\`, \`kit_rebase\`

**session_id for all MCP calls: \`${vars.sessionId}\`**
` : `
### Activity Tracking (No MCP)
\`\`\`bash
export KANVAS_SESSION_ID="${vars.sessionId}"
\`\`\`
`;

  // Build the prompt block that the user pastes into Codex
  const codexPromptBlock = generateCodexPrompt(vars);

  return `## Codex Agent Setup for ${vars.repoName}

### 1. Navigate to the working directory
\`\`\`bash
cd "${vars.repoPath}"
git checkout ${vars.branchName}
\`\`\`

### 2. Start Codex
\`\`\`bash
codex
\`\`\`

> **Don't use \`--approval-mode full-auto\`** when pasting this prompt — Codex will start working without waiting. Start Codex normally, paste the prompt, and then explicitly tell it to begin once it has confirmed setup.
${mcpSection}
### 3. Paste this prompt into Codex

Copy and paste the ENTIRE block below when the Codex session opens:

\`\`\`
${codexPromptBlock}
\`\`\`

---

**After Codex confirms setup** (directory, houserules read), explicitly tell it to start work, e.g. *"Go ahead and start on the task."*

Activity will appear in the KIT dashboard once the MCP server is connected.
`;
}

function getCustomInstructions(vars: InstructionVars): string {
  const mcpSection = vars.customMcpEnabled && vars.mcpUrl ? `
### MCP Server (Detected as Supported)
Connect your agent to KIT's MCP server for full dashboard integration:

**MCP Server URL:** \`${vars.mcpUrl}\`
**Session ID:** \`${vars.sessionId}\`

Configure your agent to use this MCP server URL. Once connected the following
tools become available:
- \`kit_log_commit\` — record commits with context
- \`kit_get_session\` — read current session state
- \`kit_update_status\` — push status updates to KIT dashboard
` : '';

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

Your custom agent's activity will appear in KIT when files are written correctly.
${mcpSection}`;
}

/**
 * Get a brief description for each agent type
 */
export function getAgentTypeDescription(agentType: AgentType): string {
  const descriptions: Record<AgentType, string> = {
    claude: 'Claude Code - Full AI coding assistant with terminal access',
    codex: 'Codex CLI - OpenAI\'s autonomous coding agent with MCP support',
    cursor: 'Cursor IDE - AI-powered code editing and completion',
    copilot: 'GitHub Copilot - AI pair programmer in VS Code',
    cline: 'Cline - Autonomous coding agent for VS Code',
    aider: 'Aider - Git-aware AI pair programming in terminal',
    warp: 'Warp - AI-powered terminal with natural language commands',
    custom: 'Custom Agent - Any tool with KIT integration',
  };

  return descriptions[agentType];
}

/**
 * Get the launch method for each agent type
 */
export function getAgentLaunchMethod(agentType: AgentType): 'cli' | 'ide' | 'terminal' | 'manual' {
  const methods: Record<AgentType, 'cli' | 'ide' | 'terminal' | 'manual'> = {
    claude: 'cli',
    codex: 'cli',
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
