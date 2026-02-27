<!-- HOUSERULES_VERSION: 2.1.0 -->
<!-- LAST_UPDATED: 2026-02-27 -->
<!-- CHECKSUM: auto-generated-on-commit -->

# House Rules for SeKondBrain Kanvas (DevOpsAgent)

**Version:** 2.1.0
**Last Updated:** 2026-02-27
**Project:** SeKondBrain Kanvas - AI Agent Dashboard for DevOps
**App Version:** 1.1.1
**Stack:** Electron + React + TypeScript (Frontend) | Python FastAPI (Backend)

---

## COMPACTION-SAFE SUMMARY

> **READ THIS FIRST after any context compaction or session restart.**
>
> This project is an **Electron desktop app** (SeKondBrain Kanvas) that manages AI coding agents
> across repositories. It has 30+ Electron services, a React renderer with Zustand stores,
> a Python FastAPI backend (ai-backend submodule), and a contract system for multi-agent coordination.
>
> **Non-negotiable rules (always apply):**
> 1. Check contracts in `House_Rules_Contracts/` BEFORE making any change
> 2. Declare file edits in `.file-coordination/active-edits/` BEFORE editing
> 3. Never duplicate existing features/endpoints/types - REUSE them
> 4. All commits use conventional format: `type(scope): subject`
> 5. Tests are mandatory for new features and bug fixes (TDD)
> 6. Temp/debug files go in `local_deploy/` only (gitignored)
> 7. Update contracts AFTER making changes
> 8. Hold file locks for entire session - release only on close
> 9. Read `infrastructure/infrastructure.md` before creating any infra
> 10. **NO EMBEDDED SQL** - All SQL goes through `SQL_CONTRACT.json` and `DatabaseService`
> 11. **CONTRACT-FIRST** for API/SQL/schema changes - read & amend the contract BEFORE writing code
> 12. This file version is **2.1.0** - the house-rules-manager uses this for updates

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File Coordination Protocol](#file-coordination-protocol)
3. [Contract System](#contract-system)
4. [Project Structure](#project-structure)
5. [Service Registry](#service-registry)
6. [IPC Channel Domains](#ipc-channel-domains)
7. [Type System](#type-system)
8. [Testing Policy](#testing-policy)
9. [Commit Policy](#commit-policy)
10. [Session Management & Multi-Agent Coordination](#session-management--multi-agent-coordination)
11. [Architecture Decision Records](#architecture-decision-records)
12. [Code Quality Standards](#code-quality-standards)
13. [Security & Logging](#security--logging)
14. [Context Persistence & Recovery](#context-persistence--recovery)
15. [DevOps Agent Automation](#devops-agent-automation)

---

## 1. Architecture Overview

### System Architecture

```
SeKondBrain Kanvas
├── electron/               # Electron main process (TypeScript)
│   ├── index.ts            # Main process entry point
│   ├── preload.ts          # Context bridge (70KB+ - IPC bridge to renderer)
│   ├── ipc/index.ts        # IPC handler registration
│   ├── services/           # 30+ service modules
│   │   ├── analysis/       # AST parsing, code analysis, schema extraction
│   │   └── *.ts            # Core services (see Service Registry)
│   └── config/modes/       # 8 YAML AI mode configurations
├── renderer/               # React frontend (TypeScript)
│   ├── App.tsx             # Root component
│   ├── components/
│   │   ├── features/       # 23 feature components
│   │   ├── layouts/        # MainLayout, Sidebar, TabBar, StatusBar
│   │   ├── composites/     # SplitPane
│   │   ├── ui/             # DiffViewer, KanvasLogo
│   │   └── primitives/     # Base UI elements
│   ├── hooks/              # 5 custom hooks (IPC, subscriptions, keyboard)
│   ├── store/              # 6 Zustand stores (session, agent, ui, etc.)
│   └── styles/             # CSS/Tailwind
├── shared/                 # Shared between main & renderer
│   ├── types.ts            # All TypeScript types (~720 lines)
│   ├── ipc-channels.ts     # IPC channel constants (~520 lines)
│   ├── agent-instructions.ts
│   ├── agent-protocol.ts
│   ├── analysis-types.ts
│   └── feature-utils.ts
├── ai-backend/             # Python FastAPI backend (git submodule)
│   ├── src/api/            # 19 API endpoint modules
│   ├── src/services/       # 23 service directories
│   ├── src/middleware/      # Auth, rate limiting, observability
│   └── House_Rules_Contracts/  # Backend-specific contracts
├── House_Rules_Contracts/  # Contract system files
├── src/                    # Legacy Node.js CLI scripts (27 files)
├── tests/                  # Test suite
│   └── kanvas/             # Kanvas-specific tests
│       ├── unit/           # 13 unit tests
│       ├── integration/    # 6 integration tests
│       ├── components/     # 8 component tests
│       └── e2e/            # 6 E2E tests (Playwright)
└── scripts/                # Automation scripts
    └── contract-automation/  # Contract generation/validation
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop | Electron | Cross-platform desktop shell |
| Frontend | React + TypeScript | UI components |
| State | Zustand | Client state management |
| Styling | Tailwind CSS | Utility-first CSS (dark theme) |
| IPC | Electron IPC + contextBridge | Main/renderer communication |
| Backend | Python FastAPI | AI services, memory, skills |
| Database | SQLite (Electron) + Alembic (Backend) | Local persistence + migrations |
| Git | execa / child_process | Git operations |
| File Watch | chokidar | File system monitoring |
| AI | Groq SDK / OpenAI SDK | LLM integration |
| Testing | Jest + Playwright | Unit/integration/E2E |
| Build | electron-vite + electron-builder | Build and packaging |

---

## 2. File Coordination Protocol

**CRITICAL: This protocol is MANDATORY. Violations cause merge conflicts and lost work.**

### Before Editing ANY Files:

1. **DECLARE YOUR INTENT FIRST**
   Create a file at `.file-coordination/active-edits/<your-name>-<session>.json`:
   ```json
   {
     "agent": "<your-name>",
     "session": "<session-id>",
     "files": ["electron/services/GitService.ts", "shared/types.ts"],
     "operation": "edit",
     "reason": "Adding rebase support to GitService",
     "declaredAt": "2026-02-14T10:00:00Z",
     "estimatedDuration": 300
   }
   ```

2. **CHECK FOR CONFLICTS**
   - Read ALL files in `.file-coordination/active-edits/`
   - If ANY other agent has declared the same files:
     - **STOP IMMEDIATELY** - DO NOT proceed
     - **ASK THE USER** for explicit permission
     - Report: which files, which agent, what they're doing
     - Wait for user decision: override, wait, or choose alternatives

3. **ONLY EDIT DECLARED FILES** - Never edit files you haven't declared

4. **HOLD LOCKS FOR ENTIRE SESSION** - Do NOT release after committing

5. **RELEASE ONLY WHEN SESSION CLOSES**
   - Move declaration to `.file-coordination/completed-edits/`
   - Update `infrastructure/infrastructure.md` if infra was created

### Why Locks Must Stay Active
- Releasing early lets another agent claim the same files
- Both sessions will conflict at merge time
- Hold locks until session is merged and worktree removed

---

## 3. Contract System

**CRITICAL: ALL coding agents MUST follow the Contract System before making ANY changes.**

### What is the Contract System?

The Contract System is the **single source of truth** for all project components. It prevents duplicate features, conflicting changes, and wasted work across multiple agents.

### Contract Files

All contracts are in `House_Rules_Contracts/`:

| Contract File | Purpose | Check Before... |
|---------------|---------|----------------|
| `DATABASE_SCHEMA_CONTRACT.md` | Database tables, columns, indexes, migrations | Creating/modifying database schema |
| `SQL_CONTRACT.json` | Reusable SQL queries with parameters | Writing any SQL query |
| `API_CONTRACT.md` | All API endpoints and specifications | Creating/modifying API endpoints |
| `THIRD_PARTY_INTEGRATIONS.md` | External service integrations | Integrating third-party services |
| `FEATURES_CONTRACT.md` | All features and specifications | Implementing any feature |
| `INFRA_CONTRACT.md` | Environment variables and infrastructure | Adding configuration/env vars |
| `EVENTS_CONTRACT.md` | Events, pub-sub, analytics events | Creating/modifying events |
| `CSS_DESIGN_TOKENS_CONTRACT.md` | Styles, themes, design tokens | Adding styles or tokens |
| `PROMPTS_CONTRACT.md` | Prompt templates, AI modes, skills | Creating/modifying AI prompts |
| `TESTS_CONTRACT.md` | Test suites, fixtures, helpers | Writing tests or fixtures |
| `DEVOPS_AGENT_INSTRUCTIONS.md` | Instructions for contract maintenance | Generating/updating contracts |

**Backend contracts** are in `ai-backend/House_Rules_Contracts/` and include:
- `EVENTS_CONTRACT.md` - Event bus / pub-sub definitions
- `openapi/v1/core-ai-backend.openapi.json` - OpenAPI spec
- `events/v1/*.schema.json` - Event schemas

### Contract Types (TypeScript)

The system supports these contract types (from `shared/types.ts`):
- `api` - API endpoints (OpenAPI, GraphQL, REST)
- `schema` - Database schemas, TypeScript types, JSON schemas
- `events` - Event bus / pub-sub events
- `css` - Styles, themes, design tokens
- `features` - Feature flags and toggles
- `infra` - Infrastructure contracts
- `integrations` - Third-party service integrations
- `admin` - Admin capabilities
- `sql` - Reusable SQL queries
- `prompts` - Prompt templates, skill configs, mode YAML files
- `e2e` / `unit` / `integration` / `fixtures` - Test contracts

### Mandatory Workflow

```
BEFORE making ANY change:
1. IDENTIFY what you're changing (database, API, SQL, feature, etc.)
2. READ the relevant contract file FIRST
3. SEARCH for existing implementation — REUSE before creating new
4. For API/SQL/schema changes: AMEND the contract BEFORE writing code
5. IMPLEMENT according to the contract
6. AFTER changes: UPDATE the contract with final state

⚠️  NEVER write raw SQL in application code — use SQL_CONTRACT.json + DatabaseService
⚠️  NEVER create/modify an API endpoint without reading API_CONTRACT.md first
⚠️  NEVER alter database schema without reading DATABASE_SCHEMA_CONTRACT.md first

Contract updates MUST include:
- Date stamp (YYYY-MM-DD)
- Version increment (semver)
- Changelog entry
- Impact assessment (breaking/non-breaking)
- Cross-references to related contracts
```

### Cross-References

Contracts are interconnected:
- `DATABASE_SCHEMA_CONTRACT` <-> `SQL_CONTRACT` (tables <-> queries)
- `SQL_CONTRACT` <-> `API_CONTRACT` (queries <-> endpoints)
- `API_CONTRACT` <-> `FEATURES_CONTRACT` (endpoints <-> features)
- `THIRD_PARTY_INTEGRATIONS` <-> `INFRA_CONTRACT` (services <-> API keys)
- `FEATURES_CONTRACT` <-> ALL (features use everything)

**When updating one contract, check if related contracts need updates too.**

### Contract Generation (Kanvas Feature)

Kanvas has built-in contract generation via:
- `ContractDetectionService.ts` - Detects contract-affecting changes in commits
- `ContractGenerationService.ts` - AI-powered contract generation from code analysis
- `ContractRegistryService.ts` - JSON registry for tracking contracts per feature

IPC channels for contracts:
- `contract:discover-features` - Scan repo for features
- `contract:generate-all` / `contract:generate-single` - Generate contracts
- `contract:analyze-commit` / `contract:analyze-staged` - Detect contract changes
- `registry:*` - Contract registry management

---

## 4. Project Structure

```
DevOpsAgent/
├── electron/                  # Electron main process
│   ├── services/              # 30+ services (see Service Registry)
│   ├── services/analysis/     # Code analysis services
│   ├── ipc/                   # IPC handler registration
│   └── config/modes/          # AI mode YAML configs (8 files)
├── renderer/                  # React frontend
│   ├── components/features/   # 23 feature components
│   ├── components/layouts/    # Layout components
│   ├── hooks/                 # Custom React hooks
│   ├── store/                 # Zustand stores (6 files)
│   └── styles/                # CSS/Tailwind
├── shared/                    # Shared types & IPC channels
├── ai-backend/                # Python FastAPI (git submodule)
├── House_Rules_Contracts/     # Contract system files
├── src/                       # Legacy Node.js CLI tools
├── tests/                     # Test suite (Jest + Playwright)
├── scripts/                   # Automation scripts
├── docs/                      # Documentation (22+ files)
├── adr/                       # Architecture Decision Records
├── infrastructure/            # Infrastructure documentation
├── local_deploy/              # LOCAL ONLY - gitignored (worktrees, logs, temp)
├── .kanvas/                   # Runtime data (sessions, heartbeats)
├── .S9N_KIT_DevOpsAgent/      # Agent toolkit (contracts, coordination)
└── .file-coordination/        # Multi-agent file coordination
```

### Critical Path Rules

- **`local_deploy/`** - ALL temp/debug/local-only files go here (gitignored)
  - Worktrees: `local_deploy/worktrees/`
  - Session locks: `local_deploy/session-locks/`
  - Logs: `local_deploy/logs/`
  - Instructions: `local_deploy/instructions/`
- **`infrastructure/`** - MUST READ before creating any infrastructure
- **Existing files** stay in place - structured organization for NEW code only
- **New modules** follow: `ModuleName/src/featurename/` + `ModuleName/test/featurename/`

---

## 5. Service Registry

### Electron Services (`electron/services/`)

| Service | File | Purpose | Key Methods |
|---------|------|---------|-------------|
| **SessionService** | `SessionService.ts` | Session lifecycle | create, list, get, close, claim |
| **GitService** | `GitService.ts` (47KB) | Git operations | status, commit, push, merge, branches, worktree |
| **WatcherService** | `WatcherService.ts` (20KB) | File watching & auto-commit | start, stop, isWatching |
| **RebaseWatcherService** | `RebaseWatcherService.ts` (14KB) | Rebase monitoring | start, stop, forceCheck |
| **ContractDetectionService** | `ContractDetectionService.ts` (12KB) | Contract violation detection | analyzeCommit, analyzeStaged |
| **ContractGenerationService** | `ContractGenerationService.ts` (107KB) | AI contract generation | discoverFeatures, generateAll |
| **ContractRegistryService** | `ContractRegistryService.ts` (15KB) | Contract registry | init, getFeature, updateFeature |
| **DatabaseService** | `DatabaseService.ts` (26KB) | SQLite persistence | query, insert, update |
| **LockService** | `LockService.ts` (13KB) | File locking | declare, release, check |
| **MergeConflictService** | `MergeConflictService.ts` (23KB) | Conflict detection/resolution | getFiles, analyze, resolve |
| **MergeService** | `MergeService.ts` (10KB) | Merge execution | preview, execute, abort |
| **AIService** | `AIService.ts` (11KB) | LLM integration | chat, stream |
| **AIConfigRegistry** | `AIConfigRegistry.ts` (14KB) | AI configuration | getModes, getMode, reload |
| **ConfigService** | `ConfigService.ts` (5KB) | App configuration | get, set, getAll |
| **ActivityService** | `ActivityService.ts` (9KB) | Activity logging | log, getEntries, getTimeline |
| **CommitAnalysisService** | `CommitAnalysisService.ts` (24KB) | AI commit messages | analyzeStaged, generateMessage |
| **HeartbeatService** | `HeartbeatService.ts` (7KB) | Agent heartbeat | start, stop, getStatus |
| **AgentInstanceService** | `AgentInstanceService.ts` (55KB) | Agent instance mgmt | create, launch, list, delete |
| **AgentListenerService** | `AgentListenerService.ts` (11KB) | Agent event listening | register, unregister |
| **QuickActionService** | `QuickActionService.ts` (4KB) | Quick actions | openTerminal, openVSCode |
| **SessionRecoveryService** | `SessionRecoveryService.ts` (7KB) | Session recovery | scanRepo, recover |
| **RepoCleanupService** | `RepoCleanupService.ts` (11KB) | Repository cleanup | analyze, execute |
| **VersionService** | `VersionService.ts` (4KB) | Version management | get, bump |
| **TerminalLogService** | `TerminalLogService.ts` (4KB) | Terminal logging | log, getLogs |
| **DebugLogService** | `DebugLogService.ts` (9KB) | Debug logging | getRecent, export |
| **BaseService** | `BaseService.ts` (2KB) | Base class | emit, log |

### Analysis Services (`electron/services/analysis/`)

| Service | Purpose |
|---------|---------|
| **ASTParserService** | Abstract syntax tree parsing |
| **APIExtractorService** | API endpoint extraction |
| **SchemaExtractorService** | Database schema extraction |
| **RepositoryAnalysisService** | Full repository analysis |
| **EventTrackerService** | Event tracking |
| **DependencyGraphService** | Dependency graph generation |
| **InfraParserService** | Infrastructure parsing (Terraform, K8s, Docker) |

### Zustand Stores (`renderer/store/`)

| Store | Purpose |
|-------|---------|
| `sessionStore.ts` | Session state and CRUD |
| `agentStore.ts` | Agent instances and status |
| `activityStore.ts` | Activity log entries |
| `conflictStore.ts` | Merge conflict state |
| `contractStore.ts` | Contract generation state |
| `uiStore.ts` | UI state (modals, sidebar, theme) |

---

## 6. IPC Channel Domains

All IPC channels are defined in `shared/ipc-channels.ts`. The naming convention is `{domain}:{action}`.

| Domain | Channels | Purpose |
|--------|----------|---------|
| `session:*` | create, list, get, close, claim, update + events | Session lifecycle |
| `git:*` | status, commit, push, merge, branches, worktree ops, rebase, fetch | Git operations |
| `watcher:*` | start, stop, status + file/commit events | File watching |
| `lock:*` | declare, release, check, list, force-release + events | File coordination |
| `config:*` / `credential:*` | get, set, getAll, has | Configuration |
| `ai:*` | chat, stream, modes, config + stream events | AI/LLM integration |
| `log:*` | get, clear, get-commits, get-timeline + events | Activity logging |
| `dialog:*` | openDirectory, showMessage | OS dialogs |
| `agent:*` | list, get, sessions, initialize + events | Agent listening |
| `instance:*` | create, validate-repo, launch, list, delete, restart + events | Agent instances |
| `recovery:*` | scan-repo, scan-all, recover, delete-orphaned | Session recovery |
| `cleanup:*` | analyze, execute, quick, kanvas | Repo cleanup |
| `rebase-watcher:*` | start, stop, pause, resume, force-check + events | Auto-rebase |
| `contract:*` | analyze, detect, discover, generate, save/load + events | Contract system |
| `registry:*` | init, get-repo, get-feature, update, list + events | Contract registry |
| `analysis:*` | scan, parse, analyze, build-graph, extract + events | Code analysis |
| `conflict:*` | get-files, analyze, resolve, preview, rebase + events | Merge conflicts |
| `commit:*` | analyze-staged, generate-message, enhance | Commit analysis |
| `debug-log:*` | get-recent, export, clear, stats | Debug logging |
| `version:*` | get, bump, get-settings, set-settings | Version management |
| `merge:*` | preview, execute, abort | Merge workflow |
| `terminal:*` | log, clear, get-logs | Terminal logging |
| `shell:*` | open-terminal, open-vscode, open-finder, copy-path | Quick actions |
| `file:*` | read-content | File reading |
| `app:*` | getVersion, quit | App lifecycle |

**When adding new IPC channels:** Follow the `{domain}:{action}` convention. Add to both `shared/ipc-channels.ts` (constant + REQUEST_CHANNELS or EVENT_CHANNELS array) and `electron/preload.ts` (context bridge).

---

## 7. Type System

All shared types are in `shared/types.ts`. Key type families:

| Family | Key Types | Used By |
|--------|-----------|---------|
| **Session** | `Session`, `SessionStatus`, `AgentType`, `CreateSessionRequest`, `CloseSessionRequest` | SessionService, AgentInstanceService |
| **Git** | `GitStatus`, `GitFileChange`, `GitCommit`, `GitCommitWithFiles`, `CommitDiffDetail`, `BranchInfo` | GitService, CommitsTab |
| **File Lock** | `FileLock`, `AutoFileLock`, `RepoLockSummary`, `LockChangeEvent`, `FileConflict` | LockService, FileCoordinationPanel |
| **Activity** | `ActivityLogEntry`, `LogType` | ActivityService, ActivityLog |
| **Watcher** | `FileChangeEvent`, `CommitTriggerEvent`, `CommitCompleteEvent` | WatcherService |
| **AI/Chat** | `ChatMessage`, `ChatStreamChunk`, `ChatRole` | AIService, ChatPanel |
| **Config** | `AppConfig`, `BranchManagementSettings`, `Credentials` | ConfigService |
| **Agent** | `AgentInstance`, `AgentInstanceConfig`, `InstanceStatus`, `RepoValidation`, `KanvasConfig` | AgentInstanceService |
| **Contract** | `Contract`, `ContractType`, `ContractStatus`, `APIContract`, `SchemaContract`, `EventsContract`, etc. | ContractDetectionService, ContractGenerationService |
| **Contract Gen** | `DiscoveredFeature`, `ContractGenerationOptions`, `ContractGenerationProgress`, `GeneratedContractJSON` | ContractGenerationService |
| **Merge** | `MergePreview`, `MergeResult` | MergeService, MergeWorkflowModal |
| **Heartbeat** | `HeartbeatStatus` | HeartbeatService, HeartbeatIndicator |
| **Version** | `RepoVersionInfo`, `RepoVersionSettings` | VersionService |
| **IPC** | `IpcResult<T>` | All services (standard response wrapper) |

**When adding new types:** Add to `shared/types.ts` in the appropriate section. Use the existing `IpcResult<T>` wrapper for all IPC responses.

---

## 8. Testing Policy

### Test-Driven Development (TDD) is MANDATORY

For ALL new features and bug fixes:
1. **RED** - Write a failing test first
2. **GREEN** - Write minimal code to pass
3. **REFACTOR** - Improve while keeping tests green

### Test Locations

| Test Type | Location | Framework | Config |
|-----------|----------|-----------|--------|
| Unit | `tests/kanvas/unit/` | Jest | `jest.kanvas.config.cjs` |
| Integration | `tests/kanvas/integration/` | Jest | `jest.kanvas.config.cjs` |
| Component | `tests/kanvas/components/` | Jest + React Testing Library | `jest.kanvas.config.cjs` |
| E2E | `tests/kanvas/e2e/` | Playwright | `playwright.config.ts` |
| Legacy unit | `tests/unit/` | Jest | `jest.config.cjs` |
| Legacy integration | `tests/integration/` | Jest | `jest.config.cjs` |

### Existing Test Files (DO NOT DUPLICATE)

**Unit Tests (13):**
- `ContractDetectionService.test.ts`, `ContractGenerationService.test.ts`
- `GitService.commits.test.ts`, `SmartScan.test.ts`
- `WatcherService.contractCheck.test.ts`, `RebaseWatcherService.test.ts`
- `agent-instructions.test.ts`, `FeatureTableStats.test.ts`
- `AIConfigRegistry.test.ts`, `VersionUtils.test.ts`
- `FeatureDiscovery.test.ts`, `uiStore.test.ts`
- `MergeConflictService.test.ts`

**Integration Tests (6):**
- `ContractGenerationE2E.test.ts`, `ContractGenerationService.integration.test.ts`
- `ContractGenerationService.realai.test.ts`, `FeatureContractsComprehensive.test.ts`
- `LinkedInContractTest.test.ts`, `MergeConflictService.realai.test.ts`

**Component Tests (8):**
- `CommitsTab.test.tsx`, `DiffViewer.test.tsx`, `TaskInput.test.tsx`
- `RepoSelector.test.tsx`, `UniversalCommitsView.test.tsx`
- `InstructionsModal.test.tsx`, `CreateAgentWizard.test.tsx`, `AgentTypeSelector.test.tsx`

### Test Rules

- **Naming:** `<ServiceOrComponent>.test.ts(x)` for Kanvas tests
- **Legacy naming:** `YYYYMMDD_<short-slug>_spec.js`
- **Stub external services** - avoid real I/O unless explicitly needed
- **Deterministic** - no flaky tests; use seeds and fake timers
- **Extend existing tests** for the same functionality (don't create parallel test files)
- **Bug fixes MUST** include a regression test

### When Tests Are Optional
- Pure infrastructure code (build scripts, deployment configs)
- Configuration files (unless they contain logic)
- Documentation files
- Auto-generated code (but test the generator)

---

## 9. Commit Policy

### Commit Message Format

```
type(scope): subject line (max 72 characters)

Contracts: [SQL:T/F, API:T/F, DB:T/F, 3RD:T/F, FEAT:T/F, INFRA:T/F]

[WHY - 2 lines explaining motivation]
This change was needed because [specific problem or requirement].
[Additional context about why this approach was chosen].

[WHAT - Each item identifies files changed and what was done]
- File(s): path/to/file.ts - Specific change made
- File(s): path/to/other.ts - Another change

Resolves: [Task ID or Issue Number]
```

### Commit Types (REQUIRED)

| Type | Use When |
|------|----------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix or error correction |
| `refactor:` | Code restructuring, no behavior change |
| `docs:` | Documentation updates |
| `test:` | Adding or modifying tests |
| `chore:` | Maintenance (configs, deps, cleanup) |
| `style:` | Formatting only, no functional change |
| `infra:` | Infrastructure changes (servers, Docker, deployment) |

### Contract Flags (MANDATORY in commits)

Every commit MUST include contract flags:
- `SQL:T/F` - SQL_CONTRACT.json modified
- `API:T/F` - API_CONTRACT.md modified
- `DB:T/F` - DATABASE_SCHEMA_CONTRACT.md modified
- `3RD:T/F` - THIRD_PARTY_INTEGRATIONS.md modified
- `FEAT:T/F` - FEATURES_CONTRACT.md modified
- `INFRA:T/F` - INFRA_CONTRACT.md modified

### Commit Rules
- Present tense ("add" not "added")
- Subject line under 72 characters
- Always explain WHY, not just WHAT
- Never include bash commands in commit messages
- Never commit sensitive data (.env, credentials, API keys)
- Atomic commits (one logical change per commit)

### Commit Message File
- **Location:** `.claude-commit-msg` (project root)
- **Action:** Write to this file; the DevOps agent processes it
- **Session-specific:** `.devops-commit-<session-id>.msg`

---

## 10. Session Management & Multi-Agent Coordination

### Session Lifecycle

Each agent session gets:
- Unique session ID
- Dedicated git worktree (in `local_deploy/worktrees/`)
- Isolated branch
- Own commit message file
- File lock declarations

### Branch Naming

| Pattern | Use Case |
|---------|----------|
| `agent/<agent-name>/<task-name>` | Agent feature branches |
| `dev_sdd_YYYY-MM-DD` | Daily development branches |
| `<agent>/<session-id>/<task>` | Session branches |
| `backup_kit/<sessionId>` | Safe backup before auto-fix operations |

### Coordination Files

| File/Directory | Purpose |
|----------------|---------|
| `.file-coordination/active-edits/` | Currently locked files |
| `.file-coordination/completed-edits/` | Released locks |
| `.kanvas/sessions/` | Session runtime data |
| `.kanvas/activity/` | Activity logs |
| `.kanvas/heartbeats/` | Agent heartbeat data |
| `.kanvas/agents/` | Agent state |
| `.S9N_KIT_DevOpsAgent/contracts/` | Contract registry JSON |
| `.devops-session.json` | Session configuration |

### Multi-Agent Handshake (Prep/Ack Protocol)

For advanced multi-agent scenarios:

1. **Write prep file** -> `.ac-prep/<agent>.json`
2. **Wait for ack** -> `.ac/ack/<agent>.json`
3. **Check status:** `ok` (proceed), `blocked` (wait/narrow scope), `queued` (wait turn)
4. **After edits** -> write commit message
5. **On alert** -> `.git/.ac/alerts/<agent>.md` -> re-scope

### Shard System

Shards live in `.ac-shards.json`. Strategies:
- `block` - Prevent overlapping edits (default)
- `branch` - Create agent-specific branches
- `queue` - Queue based on priority and timestamp

### Environment Variables

```bash
# Core settings
AC_MSG_FILE=".claude-commit-msg"
AC_BRANCH_PREFIX="dev_sdd_"
AC_PUSH=true
AC_CLEAR_MSG_WHEN="push"
AC_MSG_DEBOUNCE_MS=3000

# Session-specific
DEVOPS_SESSION_ID="abc-123"
AGENT_NAME="claude"
AGENT_WORKTREE="claude-abc-123-task"

# Infrastructure tracking
AC_TRACK_INFRA=true
AC_INFRA_DOC_PATH="/infrastructure/infrastructure.md"
```

---

## 11. Architecture Decision Records

**Any "Architecturally Significant" change MUST have an ADR.**

What qualifies:
- Adding a new persistence layer
- Changing the multi-agent coordination protocol
- Adding a new major service or component
- Changing the testing strategy
- Modifying the contract system

**Workflow:**
1. Create `adr/XXXX-title-of-decision.md`
2. Use template: Context, Decision, Consequences
3. Submit as part of your PR

**Existing ADR:** `adr/0001-contract-system.md`

---

## 12. Code Quality Standards

### No Embedded SQL (MANDATORY)

**NEVER write raw SQL strings directly in service code, components, or IPC handlers.**

All SQL queries MUST be:
1. **Defined in `SQL_CONTRACT.json`** — Every query has a named entry with parameters, description, and expected return type
2. **Executed through `DatabaseService`** — Use `DatabaseService.query()`, `.insert()`, `.update()` methods
3. **Parameterized** — Never concatenate values into SQL strings (prevents SQL injection)

```typescript
// BAD - Embedded SQL in service code
const rows = db.prepare(`SELECT * FROM commits WHERE session_id = '${sessionId}'`).all();

// BAD - Raw SQL in IPC handler
ipcMain.handle('get-commits', (_, sid) => db.exec(`SELECT * FROM commits WHERE session_id = ?`, [sid]));

// GOOD - Use DatabaseService with named query from SQL_CONTRACT
const rows = await this.db.getCommitsForSession(sessionId);
```

**Why:** Embedded SQL scatters data access logic across the codebase, makes schema migrations dangerous (no single place to find all queries), and bypasses the contract system.

### Contract-First for API, SQL, and Schema Changes (MANDATORY)

Before making ANY change to API endpoints, SQL queries, or database schema:

1. **READ the relevant contract FIRST:**
   - API change → Read `API_CONTRACT.md`
   - SQL query → Read `SQL_CONTRACT.json`
   - Database schema → Read `DATABASE_SCHEMA_CONTRACT.md`

2. **AMEND the contract** with your proposed change before writing code

3. **IMPLEMENT** according to the amended contract

4. **VERIFY** the implementation matches the contract

```
❌ Wrong order: Write code → Maybe update contract later
✅ Right order: Read contract → Amend contract → Write code → Verify match
```

This ensures all agents share a consistent understanding of the data layer and prevents conflicting changes to shared interfaces.

### TypeScript Standards (Electron + Renderer)

- **Strict mode** - No `any` types, proper interfaces
- **Types in `shared/types.ts`** - Single source for shared types
- **IPC responses** use `IpcResult<T>` wrapper
- **Service pattern:** Extend `BaseService`, use `emit()` for events

### Code Organization

- Single Responsibility - each function does one thing
- DRY - extract common logic into utilities
- Functions > 50 lines should be broken down
- Group imports: Node built-ins -> External deps -> Internal modules

### Error Handling

```typescript
// Always provide meaningful error messages
if (!session) {
  throw new Error(`Session not found: ${sessionId}. Check session:list for available sessions.`);
}

// Use IpcResult for IPC responses
return { success: false, error: { code: 'SESSION_NOT_FOUND', message: '...' } };
```

### Performance

- Use async operations (avoid `Sync` variants)
- Use `--no-pager` for git commands
- Batch operations when possible
- Implement retry logic for network operations

### AI Mode Configurations

8 YAML configs in `electron/config/modes/`:
- `code_analysis.yaml` - Code analysis prompts
- `commit_message.yaml` - Commit message generation
- `contract_detection.yaml` - Contract change detection
- `contract_generator.yaml` (48KB) - Contract generation prompts
- `devops_assistant.yaml` - DevOps assistant mode
- `merge_conflict_resolver.yaml` - Conflict resolution
- `pr_review.yaml` - PR review
- `repository_analysis.yaml` - Repository analysis

---

## 13. Security & Logging

### Security Rules

**NEVER commit or log:**
- API keys, tokens, or credentials
- Full file contents (use hashes or excerpts)
- User credentials or passwords
- Sensitive configuration values

**Input validation:**
- Prevent directory traversal (reject `../`)
- Validate paths are within allowed directories
- Never concatenate user input into shell commands

**Command injection prevention:**
```typescript
// BAD - vulnerable to injection
execSync(`git checkout ${userBranch}`);

// GOOD - use array arguments
execFileSync('git', ['checkout', userBranch]);
```

### Logging Policy

**Log location:** `local_deploy/logs/` (NEVER commit logs)
- Format: `devops-agent-YYYY-MM-DD.log`
- Levels: DEBUG, INFO, WARN, ERROR
- All logs include UTC timestamps

**What to log:**
- Session creation/destruction
- Git operations (commits, pushes, pulls)
- Infrastructure changes
- Error conditions and recovery attempts
- Agent coordination events

**Debug mode:**
```bash
DEBUG=true LOG_LEVEL=debug
```

---

## 14. Context Persistence & Recovery

### Crash Recovery (`temp_todo.md`)

**Purpose:** Maintain session continuity across crashes or disconnections.

**Location:** `temp_todo.md` (project root)

**Recovery Process:**
1. On session start, check `temp_todo.md`
2. If data exists, ask user: "Found previous session context. Continue?"
3. If yes, resume from "Next Steps"
4. If no, clear and start fresh

**Format:**
```markdown
# Current Session Context
Last Updated: YYYY-MM-DDTHH:MM:SSZ

## Task Overview
[What the user asked for]

## Current Status
[Step we're on, completed items, pending items]

## Execution Plan
- [ ] Step 1: Description
- [x] Step 2: Description (completed)

## Next Steps
[What should happen next]
```

### Context Compaction Survival

**This houserules file is designed to survive LLM context compaction.**

Key design decisions:
1. **Compaction-Safe Summary** at the top contains all non-negotiable rules
2. **Version number** in header allows automated update detection
3. **Table of Contents** enables quick navigation after reloading
4. **Self-contained sections** don't depend on other sections for meaning
5. **Service Registry** provides quick lookup without reading source files
6. **IPC Channel Domains** table gives overview without reading `ipc-channels.ts`

**After context compaction, an agent should:**
1. Re-read this file (especially the Compaction-Safe Summary)
2. Check `temp_todo.md` for session state
3. Check `.file-coordination/active-edits/` for held locks
4. Resume work with full awareness of project rules

---

## 15. DevOps Agent Automation

### Contract Automation Scripts

Located in `scripts/contract-automation/`:

| Script | Purpose |
|--------|---------|
| `generate-contracts.js` | Scan codebase, extract contract info |
| `update-contracts.js` | Update existing contracts |
| `validate-commit.js` | Validate commit messages + contract flags |
| `check-compliance.js` | Check code/contract sync |

### Contract Generation (Kanvas Built-in)

Kanvas provides GUI-driven contract generation:
1. **Discover features** - `contract:discover-features` IPC
2. **Generate contracts** - `contract:generate-all` IPC
3. **Track changes** - `contract:analyze-commit` IPC
4. **Registry management** - `registry:*` IPC channels

### Compliance Checking

```bash
# Check all contracts match code
node scripts/contract-automation/check-compliance.js

# Strict mode for CI/CD (exits 1 on discrepancy)
node scripts/contract-automation/check-compliance.js --strict

# Validate commit message
node scripts/contract-automation/validate-commit.js --check-staged --auto-fix
```

### CI/CD Integration

Contract validation runs on pull requests via `.github/workflows/contract-tests.yml`.

### LLM Integration

Available for contract generation and analysis:
- Groq SDK (default: `llama-3.1-70b-versatile`)
- OpenAI SDK (alternative)
- Configured via `OPENAI_API_KEY` environment variable

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.1.0 | 2026-02-27 | Added no-embedded-SQL rule and contract-first mandate for API/SQL/schema changes |
| 2.0.0 | 2026-02-14 | Major overhaul: added Kanvas architecture, service registry, IPC domains, type system, compaction-safe design, version tracking |
| 1.3.0 | 2024-12-16 | Added DevOps Agent change workflow, contract flags, validation |
| 1.0.0 | 2024-12-02 | Initial contract system, file coordination protocol |

---

**This is a living document. Update it when adding major features or changing architecture.**
**The house-rules-manager (`src/house-rules-manager.js`) reads the version from this file to detect when repos need updating.**
