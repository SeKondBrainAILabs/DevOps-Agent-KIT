# DevOps Agent 🚀 v1.7.2

[![npm version](https://badge.fury.io/js/s9n-devops-agent.svg)](https://badge.fury.io/js/s9n-devops-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue)](https://github.com/SecondBrainAICo/CS_DevOpsAgent)

An intelligent Git automation system with multi-agent support, enhanced branch management, real-time file coordination, and seamless integration with AI coding assistants like Claude, GitHub Copilot, and Cursor.

## 🆕 What's New in v1.7.2

### Version Display Fix
- **🔢 Consistent Versioning**: Fixed all version numbers to display correctly across all components
- **📦 Session Coordinator**: Updated to show v1.7.2 in copyright banner

### v1.7.1 - Update Check Visibility Improvements
- **🔍 Visible Update Check**: Now shows "Checking for DevOps Agent updates..." when checking npm
- **✅ Up-to-Date Confirmation**: Displays confirmation when your version is current  
- **✗ Offline Handling**: Shows helpful error message if update check fails

### v1.7.0 - Major Release: Enhanced Branch Management System

### Major Release: Enhanced Branch Management System

- **🔀 Dual Merge Support**: Sessions merge to BOTH daily branch AND target branch (e.g., main)
- **📅 Weekly Consolidation**: Automated rollup of daily branches into weekly branches
- **🧹 Orphaned Session Cleanup**: Automatic detection and cleanup of inactive sessions
- **🌲 Hierarchical Branching**: Clear structure: `session/* → daily/* → weekly/* → target`
- **🔒 Critical Lock Timing Fix**: File locks now held for entire session lifetime (not just during editing)
- **✅ Comprehensive Testing**: 10/10 automated tests passing + E2E validation with 2 parallel agents
- **📚 Enhanced Documentation**: Complete branch management guide and testing strategy

### File Coordination Improvements
- **⏱️ Correct Lock Timing**: Locks held until session closes/merges (prevents race conditions)
- **🛑 Stop-and-Ask Policy**: Agents must ask user permission before editing declared files
- **📊 Detailed Conflict Reports**: Shows which agent, which files, and what they're working on
- **🔐 Session-Lifetime Protection**: Files protected from other agents until changes are merged

## 🔗 Quick Links

- **GitHub Repository**: [https://github.com/SecondBrainAICo/CS_DevOpsAgent](https://github.com/SecondBrainAICo/CS_DevOpsAgent)
- **NPM Package**: [https://www.npmjs.com/package/s9n-devops-agent](https://www.npmjs.com/package/s9n-devops-agent)
- **Issues & Support**: [GitHub Issues](https://github.com/SecondBrainAICo/CS_DevOpsAgent/issues)
- **Documentation**: [GitHub Wiki](https://github.com/SecondBrainAICo/CS_DevOpsAgent/wiki)

## Features ✨

### Core Features
- **🤖 Multi-Agent Support**: Work with Claude, GitHub Copilot, Cursor, and other AI coding assistants
- **📁 Git Worktree Management**: Isolated workspaces for each session to prevent conflicts
- **🔄 Automatic Commits & Push**: Monitors changes and commits with proper messages
- **📅 Daily Version Rollover**: Automatic version management with customizable increments
- **🎯 Session Management**: Create, manage, and track multiple development sessions
- **⚙️ VS Code Integration**: Seamlessly integrates with VS Code tasks
- **🏷️ Smart Branching**: Automatic branch creation with configurable naming patterns

### File Coordination (v1.3.0) 🆕
- **🟧 Undeclared Edit Detection**: Orange alerts when agents edit files without declaring them
- **🔴 Conflict Detection**: Red alerts when multiple agents try to edit the same files
- **📝 Declaration Protocol**: Agents must declare files before editing to prevent conflicts
- **⚡ Real-time Monitoring**: Detects violations within 2 seconds
- **📋 Actionable Instructions**: Provides copy-paste commands to correct agent behavior
- **🔒 Advisory Locks**: File-level coordination without blocking legitimate work

### Infrastructure
- **🔐 Safe Concurrent Development**: Multiple agents can work simultaneously without conflicts
- **🐋 Docker Auto-Restart**: Automatically restart Docker containers after code push (v1.2.0)

## Installation 📦

> **📖 Detailed Guide**: See [INSTALLATION_GUIDE.md](docs/INSTALLATION_GUIDE.md) for complete setup instructions

### Quick Install (NPM Package)

```bash
# Install globally (recommended)
npm install -g s9n-devops-agent

# Verify installation
s9n-devops-agent --help
```

### What Gets Installed

The NPM package installs:
- ✅ **CLI Binary**: `s9n-devops-agent` command available globally
- ✅ **Core Files**: Worker, session manager, and utilities in npm's global node_modules
- ✅ **Dependencies**: `chokidar` for file watching, `execa` for git operations
- ❌ **No Project Modifications**: Your project stays clean until you run setup

### From Source (For Contributors)

```bash
# Clone and setup for development
git clone https://github.com/SecondBrainAICo/CS_DevOpsAgent.git
cd CS_DevOpsAgent

# Install dependencies
npm install

# Link globally for development
npm link

# Run tests
npm test
```

## Quick Start 🚀

### One-Command Setup & Start

```bash
# Just run npm start - it handles everything!
npm start

# On first run, it will:
# ✅ Set up house rules for AI agents
# ✅ Configure file coordination system
# ✅ Set up your developer initials
# ✅ Configure version strategy
# ✅ Start the session manager
```

That's it! No separate setup commands needed.

### Alternative Setup Methods

```bash
# Navigate to your project
cd /path/to/your/project

# Run the interactive setup wizard (for manual setup)
s9n-devops-agent setup

# Or start a session directly
s9n-devops-agent start
```

### Working with AI Assistants

When you start a session, you'll receive instructions to paste into your AI assistant:

```
I'm working in a DevOps-managed session with the following setup:
- Session ID: 8a3s-45b1
- Working Directory: /path/to/worktree
- Task: implement-api

CRITICAL FIRST STEP:
1. Read and follow the house rules: cat "/path/to/worktree/houserules.md"
2. Switch to the working directory: cd "/path/to/worktree"

FILE COORDINATION PROTOCOL (from house rules):
Before editing ANY files, you MUST:
- Declare your intent in .file-coordination/active-edits/<agent>-8a3s-45b1.json
- Check for conflicts with other agents
- Only edit files you've declared
- Release files when done

Write commit messages to: .devops-commit-8a3s-45b1.msg
The DevOps agent will automatically commit and push changes.
```

## House Rules & File Coordination System 📚🔒

### House Rules System (NEW!)

The DevOps Agent automatically manages "house rules" that teach AI agents your project conventions:

**Features:**
- **Auto-Creation**: Created automatically on first run
- **Smart Updates**: Updates only DevOps sections, preserves your custom rules
- **Version Tracking**: Each section independently versioned with checksums
- **Self-Healing**: Automatically recreates if deleted
- **CI/CD Ready**: Works in automated environments

**House Rules Commands:**
```bash
# Check status
npm run house-rules:status

# Update or create
npm run house-rules:update

# Health check and repair
npm run house-rules:repair
```

### File Coordination System

Prevents multiple AI agents from editing the same files simultaneously:

1. **Declaration Phase**: Agents declare which files they'll modify
2. **Conflict Check**: System checks if files are already being edited
3. **Session-Lifetime Locks**: 🔒 **CRITICAL** - Locks held for ENTIRE session, not just during editing
4. **Release Only on Close**: Locks released ONLY when session closes/merges (prevents race conditions)
5. **Real-time Monitoring**: Detects violations within 2 seconds
6. **Alert System**: 
   - 🟧 **Orange Alert**: Files edited without declaration
   - 🔴 **Red Alert**: Files being edited by another agent
   - 🛑 **Stop-and-Ask**: Agents must get user permission to override
7. **Copy-Paste Instructions**: Provides exact commands to correct agent behavior

#### Why Locks Stay Active During Entire Session:
- ❌ **Problem**: Releasing locks after commit allows another agent to edit same files
- 💥 **Result**: Both sessions conflict when merging
- ✅ **Solution**: Hold locks until session is merged and worktree removed
- 🎯 **Benefit**: Zero race conditions, no duplicate work

**Coordination Commands:**
```bash
# Check if files are available
./scripts/coordination/check-file-availability.sh src/main.js src/utils.js

# Declare intent to edit files
./scripts/coordination/declare-file-edits.sh <agent-name> <session-id> file1.js file2.js

# Release files after editing
./scripts/coordination/release-file-edits.sh <agent-name> <session-id>

# Run file locking demo
./test_scripts/multi-agent/test-file-locking.sh
```

### For AI Agents

Agents should follow this protocol:

```json
// Before editing, create: .file-coordination/active-edits/<agent>-<session>.json
{
  "agent": "claude",
  "session": "8a3s-45b1",
  "files": ["src/main.js", "src/utils.js"],
  "operation": "edit",
  "reason": "Implementing authentication feature",
  "declaredAt": "2025-09-30T12:00:00Z",
  "estimatedDuration": 300
}
```

### Alert Examples

#### Undeclared Edit Alert (🟧 Orange)
```
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧
🟧  UNDECLARED FILE EDIT DETECTED!
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧

❌ File "src/main.js" was modified WITHOUT declaration!
📋 COPY THIS INSTRUCTION TO YOUR CODING AGENT:
[Instructions on how to declare the file]
```

#### Conflict Alert (🔴 Red)
```
🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴
🔴  FILE CONFLICT DETECTED!
🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴

❌ File "src/main.js" is being edited by: claude-session-abc123
[Instructions on how to resolve]
```

## Commands 📝

### Session Management

```bash
# Start interactive session manager
s9n-devops-agent start

# List all active sessions
s9n-devops-agent list

# Create a new session
s9n-devops-agent create --task "feature-name" --agent claude

# Close an active session
s9n-devops-agent close <session-id>

# Clean up stale sessions
s9n-devops-agent cleanup
```

### Direct Operations

```bash
# Run the worker directly (for CI/CD)
s9n-devops-agent worker

# Manage worktrees
s9n-devops-agent worktree create
s9n-devops-agent worktree list

# Run setup wizard
s9n-devops-agent setup
```

## Configuration 🔧

> **📖 Complete Configuration Guide**: See [INSTALLATION_GUIDE.md](docs/INSTALLATION_GUIDE.md#configuration-files)

### Environment Variables

```bash
# Branch naming prefix
export AC_BRANCH_PREFIX="dev_initials_"

# Enable auto-push (default: true)
export AC_PUSH=true

# Enable debug logging
export AC_DEBUG=true

# Set timezone for daily rollover
export AC_TZ="America/New_York"

# Version configuration
export AC_VERSION_PREFIX="v0."
export AC_VERSION_START_MINOR="20"
export AC_VERSION_INCREMENT="1"  # 1 = 0.01, 10 = 0.1
```

### Configuration Files

**Global Configuration** (`~/.devops-agent/settings.json`):
- Developer initials and email
- Default timezone settings
- Created on first setup

**Project Configuration** (`local_deploy/project-settings.json`):
- Version numbering strategy
- Auto-merge settings
- Docker restart configuration
- Created per project

**House Rules** (`docs/houserules.md`):
- Instructions for AI assistants
- Testing requirements
- Commit message format
- Multi-agent coordination rules
- **Must be created manually** ([see template](docs/INSTALLATION_GUIDE.md#house-rules-setup))

## Workflow Example 💡

1. **Start a Session**:
   ```bash
   s9n-devops-agent start
   # Select: N) Create a new session
   # Enter task: implement-authentication
   ```

2. **Copy Instructions to AI Assistant**:
   - The tool provides instructions to paste into Claude/Copilot
   - The AI works in the isolated worktree

3. **AI Makes Changes**:
   - AI writes code in the worktree directory
   - Creates commit message in `.devops-commit-{session-id}.msg`

4. **Automatic Processing**:
   - Agent detects changes
   - Reads commit message
   - Commits and pushes automatically

5. **Close Session**:
   ```bash
   s9n-devops-agent close
   ```

## VS Code Integration 🔌

Add to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start DevOps Agent",
      "type": "shell",
      "command": "s9n-devops-agent",
      "args": ["start"],
      "problemMatcher": [],
      "isBackground": true
    }
  ]
}
```

## Advanced Features 🔬

### Docker Container Auto-Restart (v1.2.0+)

Automatically restart Docker containers after pushing code changes:

```bash
# During session creation, if docker-compose is detected:
s9n-devops-agent start
# -> Auto-restart Docker containers after push? (y/N): y
# -> Rebuild containers on restart? (y/N): n
# -> Specific service to restart (leave empty for all): app
```

**Features:**
- Detects docker-compose files automatically
- Optional container rebuild on restart
- Target specific services or restart all
- Non-blocking: Docker failures don't affect git workflow
- Works with Docker Compose v1 and v2

**Supported docker-compose files:**
- docker-compose.yml / docker-compose.yaml
- compose.yml / compose.yaml
- docker-compose.dev.yml / docker-compose.local.yml

### Multi-Agent Collaboration

Multiple AI assistants can work on different features simultaneously:

```bash
# Terminal 1: Claude working on API
s9n-devops-agent create --task "api-endpoints" --agent claude

# Terminal 2: Copilot working on frontend
s9n-devops-agent create --task "ui-components" --agent copilot

# Each gets their own worktree and branch
```

### Custom Version Strategies

Configure daily version increments:
- `0.01` increments: v0.20 → v0.21 → v0.22
- `0.1` increments: v0.20 → v0.30 → v0.40
- `0.2` increments: v0.20 → v0.40 → v0.60

### Automatic Daily Rollover

At midnight (configurable timezone):
1. Merges current day's work into version branch
2. Creates new version branch (e.g., v0.21)
3. Creates new daily branch
4. Preserves work continuity

## Platform Compatibility 🖥️

- ✅ **Git Platforms**: GitHub, GitLab, Bitbucket, Gitea, self-hosted Git
- ✅ **Operating Systems**: macOS, Linux, Windows (WSL recommended)
- ✅ **AI Assistants**: Claude, GitHub Copilot, Cursor, Cody, any AI that can write files
- ✅ **Node.js**: Version 16.0.0 or higher

## Troubleshooting 🔍

> **📖 Detailed Troubleshooting**: See [INSTALLATION_GUIDE.md](docs/INSTALLATION_GUIDE.md#troubleshooting)

### Common Issues

**After npm install - command not found**:
```bash
# Check npm global bin directory
npm bin -g
# Add to PATH if needed
export PATH="$PATH:$(npm bin -g)"
```

**Setup wizard issues**:
```bash
# Ensure you're in a git repository
git init
# Run setup in project directory
cd /your/project && s9n-devops-agent setup
```

**Agent not detecting changes**:
```bash
# Enable debug mode
AC_DEBUG=true s9n-devops-agent start
# Check message file exists and has content
ls -la .devops-commit-*.msg
```

**Multi-agent conflicts**:
```bash
# Check coordination files
ls -la .ac-prep/ .ac/ack/
# Clear if stuck
rm -rf .ac-prep .ac
```

## Contributing 🤝

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Release Notes 📢

### Latest: v1.7.2 (January 10, 2025)

For complete release history, feature details, and upgrade guides:
- **[v1.7.x Release Notes](docs/RELEASE_NOTES_v1.7.md)** - Comprehensive documentation for v1.7.x series
- **[CHANGELOG.md](CHANGELOG.md)** - Full version history
- **[GitHub Releases](https://github.com/SecondBrainAICo/CS_DevOpsAgent/releases)** - Official releases with binaries

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support 💬

- 🐛 Issues: [GitHub Issues](https://github.com/SecondBrainAICo/CS_DevOpsAgent/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/SecondBrainAICo/CS_DevOpsAgent/discussions)
- 📖 Documentation: [GitHub Wiki](https://github.com/SecondBrainAICo/CS_DevOpsAgent/wiki)
- 📦 NPM Package: [s9n-devops-agent](https://www.npmjs.com/package/s9n-devops-agent)

## Acknowledgments 🙏

Built with ❤️ by [SeKondBrain Labs](https://secondbrain.ai)

Special thanks to all contributors and the open-source community.

---

**Copyright © 2024 SeKondBrain Labs. All rights reserved.**
