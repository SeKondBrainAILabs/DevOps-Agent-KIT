# Kanvas for Kit - DevOps Agent

**Desktop dashboard for managing AI coding agents across your repositories**

DevOps Agent monitors Claude, Cursor, Copilot, Cline, Aider, Warp, and other AI agents working on your codebase. It handles git operations, prevents conflicts, tracks changes, generates contracts, and keeps multiple agents coordinated — all from a single desktop app.

Version: **2.3.0**

---

## Installation

### Desktop App (Recommended)

Download the latest release for your platform:

- **macOS:** `.dmg` or `.zip`
- **Windows:** `.exe` installer or portable `.zip`
- **Linux:** `.AppImage` or `.deb`

[Download Latest Release](https://github.com/SeKondBrainAILabs/CS_DevOpsAgent/releases)

### Developer Setup

```bash
# Clone the repo
git clone https://github.com/SeKondBrainAILabs/CS_DevOpsAgent.git
cd CS_DevOpsAgent

# Run the setup script
./setup.sh
```

The setup script installs dependencies (including native modules like `better-sqlite3`), initializes git submodules, and configures your environment.

**Options:**
- **[d] Development Mode** — Starts the app with hot-reloading (`npm run dev`)
- **[i] Build & Install** — Builds a release version and installs to Applications

### Manual Build

```bash
npm install --legacy-peer-deps
npm run build
npx electron-builder --mac   # or --win, --linux
```

Output goes to `release/`.

---

## Features

### First-Time Onboarding
Guided 4-step walkthrough on first launch — covers what Kanvas is, how sessions and worktrees work, the rebase/merge/ship workflow, and getting started. Can be replayed anytime from Settings.

### Multi-Agent Dashboard
Monitor multiple AI agents across repositories from a single interface. See agent status, heartbeats, and activity in real time. Supports Claude, Cursor, Copilot, Cline, Aider, and Warp.

### Session Management
Create isolated worktree-based sessions for each task. Each session gets its own branch, file watcher, and activity log. Multi-repo sessions coordinate work across primary and secondary repositories with linked branches.

### Auto-Commit & File Watching
Chokidar-based file watchers detect changes and trigger automatic commits as agents work. AI-enhanced commit messages analyze diffs and generate conventional commit descriptions. Post-commit hooks trigger rebase checks and contract detection.

### Rebase & Sync
Automatic rebase watcher monitors remote branches and rebases on-demand, daily, or weekly. AI-powered conflict resolution uses a two-phase pipeline (triage + reasoning LLM) with safety guards: confidence thresholds, backup branches, and post-resolution validation. A last-sync indicator shows when each session was last rebased.

### Merge Workflow
Preview merges before executing — see conflicts, changed files, untracked blockers, and cross-session file overlaps. Resolve conflicts with AI assistance or manually. Stash recovery handles work-in-progress during merges.

### File Coordination & Locking
Multi-agent file locking prevents simultaneous edits to the same file. Auto-locking detects when agents modify files. Conflicts between sessions are detected and surfaced. Locks expire after 24 hours of inactivity.

### Contract Generation
Scans repositories feature-by-feature to generate contract documentation (API, schema, events, CSS, infrastructure, tests, seed data). AI-powered feature discovery identifies logical features beyond folder structure. Outputs Markdown and JSON to `House_Rules_Contracts/`. Incremental mode only regenerates changed contracts.

### Contract Detection
Monitors commits for changes to contract-related files — OpenAPI specs, GraphQL schemas, Protobuf definitions, database schemas, TypeScript interfaces, and test files. Flags breaking vs. non-breaking changes automatically.

### Repository Analysis
Deep codebase analysis powered by tree-sitter AST parsing:
- **API Extraction** — Express, Fastify, OpenAPI, GraphQL, Protobuf endpoints
- **Schema Extraction** — Prisma, TypeORM, Sequelize, Drizzle, SQL, Zod schemas
- **Event Tracking** — EventEmitter, RxJS, Redis Pub/Sub, Kafka, RabbitMQ, Socket.IO flows
- **Dependency Graphs** — Import/export analysis, circular dependency detection
- **Infrastructure Parsing** — Terraform, Kubernetes, Docker Compose resources

### Seed Data Management
Generate seed data contracts from feature files (migrations, fixtures, configs). Merge per-feature contracts into a unified execution plan with topological sorting. Execute with idempotency (checksum-based skip) and rollback support.

### MCP Server
Built-in HTTP-based Model Context Protocol server on localhost for coding agents. Exposes tools for git operations, file locking, activity logging, and repo management. Agents connect via streamable HTTP transport with per-connection state.

### AI Integration
LLM integration via Groq API (Llama 3.3 70B, Kimi K2, Qwen 3 32B, Llama 3.1 8B). Used for commit message generation, merge conflict resolution, contract generation, and feature discovery. Mode-based YAML prompt configuration at `~/.kanvas/modes/`.

### Activity & Debug Logging
Real-time activity feed with SQLite persistence. Terminal log view for service-level output. Debug log export for troubleshooting. All logs are searchable and filterable by session.

### Auto-Updates
Built-in auto-updater via electron-updater. Checks GitHub Releases for new versions, downloads in the background, and installs on restart.

### Session Recovery & Cleanup
Recovers orphaned sessions from repository `.S9N_KIT_DevOpsAgent/` directories. Cleans up stale worktrees, merged branches, and outdated Kanvas files.

---

## Usage

### 1. Create a Session

1. Click **"+ New Session"** in the sidebar
2. Select your repository (single or multi-repo)
3. Choose agent type (Claude, Cursor, Copilot, Cline, Aider, Warp)
4. Enter a branch name and task description
5. Click **Create**

### 2. Get Agent Instructions

1. Click on your session
2. Go to the **Prompt** tab
3. Click **"Copy Full Instructions"**
4. Paste into your AI agent

### 3. Monitor Progress

- **Activity** — Live feed of commits, file changes, and events
- **Commits** — Full commit history with file-level diffs
- **Files** — Changed files with lock status
- **Contracts** — API/schema contract changes and generation
- **Terminal** — Service-level log output

### 4. Merge & Close

1. Click **Merge** on a session
2. Review the merge preview (conflicts, blockers, overlaps)
3. Resolve any conflicts (AI-assisted or manual)
4. Execute the merge
5. Close the session to clean up the worktree

---

## Agent Protocol

Kanvas is a **dashboard** — agents report into it, not the other way around. Communication uses a file-based protocol in each repository:

```
.S9N_KIT_DevOpsAgent/
├── agents/           # Agent registration files
├── sessions/         # Session status
├── activity/         # Activity logs
├── commands/         # Kanvas → Agent commands
├── heartbeats/       # Agent heartbeat files
├── coordination/     # File locking
│   ├── active-edits/
│   └── completed-edits/
├── config.json       # Repo-specific config
└── houserules.md     # Team-shared rules
```

Agents can also connect via the MCP server for tool access (git, locks, activity logging).

---

## Architecture

```
├── electron/                # Main process
│   ├── index.ts             # Electron entry point
│   ├── ipc/index.ts         # IPC handler registration
│   ├── preload.ts           # Renderer bridge
│   ├── services/            # 30+ services
│   │   ├── SessionService        # Session lifecycle
│   │   ├── GitService            # Git operations
│   │   ├── WatcherService        # File watching & auto-commit
│   │   ├── RebaseWatcherService  # Remote sync & auto-rebase
│   │   ├── MergeService          # Merge workflow
│   │   ├── MergeConflictService  # AI conflict resolution
│   │   ├── LockService           # File coordination
│   │   ├── ContractDetectionService
│   │   ├── ContractGenerationService
│   │   ├── ContractRegistryService
│   │   ├── SeedDataExecutionService
│   │   ├── AgentListenerService  # Agent registration
│   │   ├── AgentInstanceService  # Agent creation
│   │   ├── McpServerService      # MCP server
│   │   ├── AIService             # LLM integration
│   │   ├── CommitAnalysisService # AI commit messages
│   │   ├── ConfigService         # App config
│   │   ├── ActivityService       # Activity logging
│   │   ├── DatabaseService       # SQLite persistence
│   │   ├── AutoUpdateService     # App updates
│   │   ├── WorkerBridgeService   # Background worker
│   │   └── analysis/             # AST, API, Schema, Events, Deps, Infra
│   └── config/              # Default configuration
├── renderer/                # React frontend
│   ├── components/
│   │   ├── features/        # Session detail, commits, merge, contracts
│   │   ├── layouts/         # Main layout, sidebar, status bar
│   │   └── ui/              # Shared UI components
│   ├── hooks/               # Custom React hooks
│   └── store/               # Zustand state management
├── shared/                  # Shared between main & renderer
│   ├── types.ts             # All TypeScript types
│   ├── ipc-channels.ts      # IPC channel constants
│   ├── agent-protocol.ts    # Agent communication protocol
│   └── analysis-types.ts    # Analysis service types
├── ai-backend/              # AI config submodule
├── tests/kanvas/unit/       # Unit tests
├── House_Rules_Contracts/   # Generated contract documents
└── .github/workflows/       # CI/CD pipelines
    ├── release.yml          # Build & publish on v* tags
    ├── ci.yml               # Test & build on push
    └── contract-tests.yml   # Contract automation tests
```

### Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Desktop** | Electron 33, electron-vite, electron-builder |
| **Frontend** | React 19, TypeScript, TailwindCSS, Zustand |
| **Backend** | Node.js 20, TypeScript, better-sqlite3 |
| **AI** | Groq API (Llama 3.3 70B, Kimi K2, Qwen 3 32B) |
| **Analysis** | tree-sitter (AST), custom extractors |
| **Agent Comms** | MCP SDK (HTTP transport), file-based protocol |
| **Distribution** | GitHub Releases, electron-updater |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot-reload |
| `npm run build` | Build for production |
| `npm test` | Run all tests |
| `npx jest --config jest.kanvas.config.cjs --no-coverage` | Run Kanvas unit tests |

---

## Releasing

Releases are built automatically by GitHub Actions when a version tag is pushed:

```bash
# 1. Bump version in package.json
# 2. Commit and push
# 3. Tag and push
git tag v2.3.0
git push origin v2.3.0
```

The release workflow builds for macOS (DMG + ZIP), Windows (NSIS + portable), and Linux (AppImage + deb), then publishes to GitHub Releases.

Code signing and Apple notarization are enabled when the corresponding secrets are configured (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`, etc.).

---

## Troubleshooting

### Build Errors

```bash
rm -rf node_modules dist release
npm install --legacy-peer-deps
npm run build
```

### "Authentication failed" for submodule

You need access to the private `Core_Ai_Backend` repo.

```bash
brew install gh   # or: sudo apt install gh
gh auth login
./setup.sh
```

### "ModuleNotFoundError: No module named 'distutils'"

Python 3.12+ removed distutils:
```bash
pip3 install setuptools
```

### Native module errors

```bash
npx electron-rebuild
```

---

## Requirements

- **Node.js** 20+
- **Python** 3.x with setuptools
- **Git** 2.x
- **GitHub access** to SeKondBrainAILabs repos

---

## License

MIT - SeKondBrain AI Labs

## Support

- [GitHub Issues](https://github.com/SeKondBrainAILabs/CS_DevOpsAgent/issues)
