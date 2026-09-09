# Changelog

All notable changes to s9n-devops-agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.21] - 2026-05-30

### Fixed
- **Conflict Resolution dialog shows `origin/main` as base branch** — `errorDetails.baseBranch` comes from session data with the legacy `origin/` prefix. Now stripped in the footer, advanced details, and when passed to `generatePreviews`.
- **Stash-pop conflict shows empty "Conflicted Files" + useless "Auto-Fix with AI" button** — When the rebase itself succeeds but re-applying stashed uncommitted changes fails (stash pop conflict), the conflicted files list was empty (because no rebase conflicts existed) and "Auto-Fix with AI" would find nothing to fix. The dialog now detects this case (`errorMessage` contains "stash pop had conflicts") and shows a "Re-apply Stashed Changes" button that retries `git stash pop` directly, with a fallback to manual fix instructions.
- **`git stash pop` now available via IPC** — Added `GIT_STASH_POP` channel, IPC handler, and `window.api.git.stashPop()` preload binding so the dialog can retry stash pop without requiring a terminal.

## [2.6.20] - 2026-05-29

### Fixed
- **"Restarting..." pill stuck after restart** — The success path assumed the old session component would unmount when the new session replaced it. But there's a timing gap between `restartInstance` returning and the `SESSION_REMOVED` IPC event re-rendering the list — during that gap `restarting` stayed `true` with nothing to clear it. Now always calls `setRestarting(false)` after the await resolves regardless of whether the component unmounts.

## [2.6.19] - 2026-05-29

### Fixed
- **Auto-update never shows pill after startup** — The update check only ran once, 3 seconds after launch. If the app was already open when a new version was published, the notification never appeared. Added a periodic check every 30 minutes so long-running sessions catch new releases without requiring a restart.
- **"AI could not auto-resolve any files" in Merge Workflow** — When the session branch was in a mid-rebase state (detached HEAD after a failed auto-rebase), the Merge Workflow's AI conflict step called `generateResolutionPreviews` which tried to start a fresh rebase on top of the stuck one. Git rejected it immediately, returning zero conflicts, so `resolvable.length === 0` → error. Fixed: both `generateResolutionPreviews` and `rebaseWithResolution` now abort any in-progress rebase before starting.
- **Merge Workflow shows `origin/main` as target** — The `MergeWorkflowModal` component state was seeded from session props without stripping the legacy `origin/` prefix, so the UI header, dropdown, and error logs all showed `origin/main` instead of `main`. Both `useState` initializer and the `setTargetBranch` re-sync on open now strip the prefix.

## [2.6.18] - 2026-05-29

### Fixed
- **Conflict dialog: detached HEAD / empty currentBranch** — When the conflict resolution dialog opens after a failed auto-rebase, git is mid-rebase (detached HEAD), causing `git branch --show-current` to return empty. `generateResolutionPreviews` and `rebaseWithResolution` now abort any in-progress rebase before checking the current branch, ensuring git is on a named branch before the next rebase attempt starts.
- **Cascade of backup tags** — Each retry from the conflict dialog was creating a new backup tag and launching a new rebase on top of an unaborted previous one. The pre-flight abort prevents this runaway accumulation.
- **MergeWorkflowModal `targetBranch` state retains `origin/` prefix** — Component state was initialized and re-synced from session props without stripping the legacy prefix, so error logs always showed `origin/main` even when the service had already stripped it. Both `useState` initializer and `setTargetBranch` call now strip `origin/`.

## [2.6.17] - 2026-05-29

### Fixed
- **"Resolution Failed - Failed to fetch origin/Development"** — `MergeConflictService.generateResolutionPreviews` and `rebaseWithResolution` both received the `targetBranch` with an `origin/` prefix (e.g. `origin/Development`) from session data stored before the prefix-stripping fixes. Added `.replace(/^origin\//, '')` at the top of both entry points so git fetch and rebase use the bare branch name. This is the same fix applied in v2.6.12–2.6.14 to GitService, MergeService, and AgentInstanceService — now complete for the conflict resolution path.

## [2.6.16] - 2026-05-29

### Added
- **DebugLogService logging for auto-update, MCP calls, and git failures** — All update check results (checking, available, up-to-date, errors) now appear in the exported debug log under source `AutoUpdate`. MCP tool call failures log under `McpTool`. Expired MCP sessions and stale cleanup log under `McpServer`. This makes failures visible in the debug log export rather than silently disappearing into `console.log`.

### Fixed
- **Auto-update redirect chain** — GitHub serves 2 redirects before `latest-mac.yml` content. Previous code only followed one, reading an empty body on the second so no update was ever detected. Now follows the full chain (up to 5 hops).

## [2.6.15] - 2026-05-29

### Fixed
- **Auto-update notification not appearing** — GitHub serves two 302 redirects before the `latest-mac.yml` content (`/releases/latest/download/` → `/releases/download/v{n}/` → CDN). The previous implementation only followed one redirect, so the second fetch got an empty 302 body, `parseVersion` returned null, and no update was detected. Replaced with a recursive redirect follower that handles up to 5 hops.

## [2.6.14] - 2026-05-29

### Fixed
- **Restart timed out on large repos** — Safety timeout in `SessionDetailView` was 30 seconds. Restarts on large repos (commit + worktree + setup) legitimately take 60-90s and were always hitting the timeout. Increased to 120 seconds.
- **`origin/` prefix in restart flow** — `createBranchIfNeeded` and session data config now strip the `origin/` prefix from `baseBranch` (e.g. `origin/Development` → `Development`) so branch creation doesn't fail when the stored base branch has the prefix.

## [2.6.13] - 2026-05-29

### Fixed
- **MCP `kit_lock_file` transport/deserialization error** — Session timeout was 5 minutes; agents idle for longer (thinking, running tests) had their transport cleaned up. The next MCP call arrived with an expired session ID, received a bare `400` HTTP response instead of a JSON-RPC error, and the client reported it as a deserialization error. Fixed: (1) session timeout extended to 30 minutes, (2) expired-session response is now a proper JSON-RPC `-32001` error so clients can reinitialize cleanly.

## [2.6.11] - 2026-05-29

### Fixed
- **Auto-update check on unsigned macOS builds** — Replaced `electron-updater` / Squirrel.Mac with a direct HTTPS fetch of `latest-mac.yml` from GitHub Releases. Squirrel.Mac requires a Developer ID certificate to call `checkForUpdates()` at all; without one it throws silently and the update pill never appeared. The new implementation works without code signing: fetches the yml, parses the version, compares with semver, fires the same `UPDATE_AVAILABLE` IPC event. The install step opens the GitHub releases page in the browser so the user can download the DMG.

## [2.6.10] - 2026-05-29

### Changed
- Version bump to test auto-update end-to-end from v2.6.9.

## [2.6.9] - 2026-05-29

### Changed
- Version bump to test auto-update install flow end-to-end from v2.6.8 (which has the install fallback fix).

## [2.6.8] - 2026-05-29

### Fixed
- **Auto-update check failing silently** — `publish.repo` in `package.json` still pointed to the old `CS_DevOpsAgent` repo name. Updated to `DevOps-Agent-KIT` so `electron-updater` hits the correct GitHub API endpoint and the update notification pill now appears.
- **Auto-update install fallback** — `quitAndInstall()` fails on macOS without a Developer ID code signature. Added a fallback that opens the GitHub releases page in the browser so users can manually download the DMG.

## [2.6.7] - 2026-05-29

### Fixed
- **Sync Failed "Branch 'origin/main' not found on remote"** — `rebaseOntoBaseBranch` and `performRebaseWithAI` in `GitService` now strip the `origin/` prefix from `baseBranch` before calling `git fetch origin <branch>`. Sessions where `baseBranch` was stored as `"origin/main"` were causing fetch to run `git fetch origin origin/main`, which fails.

## [2.6.6] - 2026-05-29

### Changed
- Version bump to validate auto-update notification flow end-to-end.

## [2.6.5] - 2026-05-29

### Added
- **Auto-update notification UI** — StatusBar now shows a live update pill when a new version is available. Clicking downloads the update; once downloaded it turns blue ("Restart to update vX.X.X") and installs on click. The backend (`AutoUpdateService`) was already wired but had no renderer UI.

## [2.6.4] - 2026-05-29

### Fixed
- **Merge: `origin/main` target branch** — merges now strip the `origin/` prefix from target branches, fixing "couldn't find remote ref origin/main" for sessions where `baseBranch` was stored with the prefix. Branch picker dropdown also cleaned up to never produce `origin/main` entries.
- **Merge: missing remote branch detection** — `previewMerge` and `executeMerge` now detect when the target branch doesn't exist on the remote and return an actionable error message (including the actual remote default branch name) instead of a cryptic git fatal error.
- **AI conflict resolution: kimi-k2 model unavailable** — updated kimi-k2 model ID to `moonshotai/kimi-k2-instruct` (removed stale `-0905` version suffix). `AIService.sendWithMode` now falls back to `llama-3.3-70b` on 404/model-not-found errors so conflict resolution no longer silently fails.
- **Merge conflict resolver default model** — changed from `kimi-k2` to `llama-3.3-70b` so the AI pipeline works reliably even when kimi-k2 is unavailable.
- **RebaseWatcher race condition** — `isRebasing` flag is now set synchronously before the fire-and-forget `performAutoRebase` call, preventing two concurrent rebases from starting.
- **RebaseWatcher permanent pause on transient errors** — watcher now only pauses (`isPaused=true`) for conflict or auth errors. Network timeouts, git lock errors, and other transient failures now let the next poll cycle retry automatically.
- **Restarting button stuck** — `handleRestartSession` now throws on failure so `SessionDetailView` resets the spinner. Added 30-second safety timeout as a backstop.
- **Spurious `git merge --abort` after failed pull** — removed no-op merge abort that ran before any merge had started.

## [2.6.3] - 2026-05-26

### Added
- **Stateless `/rpc` MCP endpoint** — Codex and other `type:"http"` plain JSON-RPC clients now connect to `/rpc` instead of the stateful `/mcp` endpoint, eliminating JSON-RPC deserialize errors. Each new session's `.mcp.json` includes both `kit` (streamable-http) and `kit-rpc` (http) entries.
- **SSE keep-alive pings** — The `/sse` endpoint now writes a `: ping` comment every 25 seconds, preventing `mcp-remote` from dropping the Claude Desktop connection with a Body Timeout Error after ~5 minutes of idle.

### Fixed
- **CommitsTab shows on merged/deleted worktrees** — When `git` fails to spawn (e.g. worktree directory no longer exists), the Commits tab now falls back to DB-recorded commits instead of showing an error.
- **View Commits button** — Switching to the universal commits view was silently blocked when a session was selected. Fixed view priority order in App.tsx.
- **Chrome extension MCP calls visible in MCP tab** — `getMcpCallLog` was returning stale in-memory entries, missing calls made by external clients (Chrome extension, remote agents). Now always reads from the database.
- **Agent push-to-main blocked** — Added explicit ⛔ rules to both the Claude fallback block and the Codex prompt: agents must never push to `main`/base branch directly. Merging is human-initiated via Kanvas. If MCP and direct git both fail, agent must stop and report.
- **Merge auto-commit excludes session files** — The pre-merge auto-commit no longer stages Kanvas session/runtime files (`.claude-session-*.md`, `.codex-session-*.md`, `.S9N_KIT_DevOpsAgent/config.json`, `.mcp.json`). `ensureAgentArtifactsIgnored` now adds all KIT patterns to `.gitignore`, not just the agent directory.
- **`kit_commit` MCP emits COMMIT_COMPLETED** — The `CommitsTab` now updates in real time when a coding agent commits via MCP, without waiting for the 10-second poll interval.
- **Neutral UI copy** — Instructional text in `InstructionsModal` and session setup docs now says "coding agent" instead of "Claude Code", making the UI agent-agnostic.

### Security
- **Agent push-to-main investigation** — Root-caused an incident where a Codex agent pushed directly to `main` when `kit_commit` kept failing. The agent used the git fallback from session instructions and invented a `HEAD:main` push strategy. Now blocked at the instruction level with explicit prohibition text.

## [2.0.18-dev.3] - 2026-01-06

### Added
- **Base Branch Selection**: When starting a session, you can now choose which branch to base your work on (rebase from), instead of defaulting to HEAD.
- **Recursive Contract Search**: Setup now finds contract files across the entire repository (not just in root) and offers to merge duplicates into `House_Rules_Contracts`.
- **Versioning Setup in Wizard**: The setup wizard (`npm run setup`) now explicitly checks and helps configure the project versioning strategy if missing.
- **Credentials Persistence**: Moved credentials storage to `~/.devops-agent/credentials.json` to persist API keys across package updates.

### Fixed
- **Update Checker**: Fixed update check to correctly handle development versions (dev tags) and prevent suggesting downgrades to stable when on a dev build.
- **Setup Flow**: Improved flow to ensure all critical configurations (versioning, API keys) are addressed.

### 🐛 Fixed
- 🔧 **Bin Path**: Fixed incorrect `bin` path in `package.json` (removed leading `./`) to ensure executable works correctly when installed

## [1.7.2] - 2025-01-10

### 🔧 Fixed
- 🔢 **Version Display**: Fixed session-coordinator.js to show correct version (was showing 1.4.8)
- 📝 **README**: Updated header to reflect v1.7.2
- 📦 **Start Script**: Updated version banner to v1.7.2
- ✅ **Consistency**: All components now display matching version numbers

### 💡 Why
- User reported seeing v1.4.8 after updating to v1.7.1
- Old version number was hardcoded in session coordinator CLI banner
- Ensures users see correct version across all entry points

## [1.7.1] - 2025-01-10

### ✨ Added
- 🔍 **Visible Update Check**: Shows "Checking for DevOps Agent updates..." message when checking npm registry
- ✅ **Up-to-Date Confirmation**: Displays confirmation message when version is current
- ✗ **Offline Handling**: Shows helpful message if update check fails due to network/npm issues

### 🔄 Changed
- Update check now provides transparent feedback instead of running silently
- Users can see when version check happens and its result

### 💡 Why
- Previously update check ran invisibly in background, causing confusion
- Users couldn't tell if check was happening or if they were up to date
- Better transparency builds trust and reduces support questions

## [1.7.0] - 2025-01-10

### 🚨 CRITICAL FIX
- 🔒 **File Lock Timing**: Fixed critical race condition where locks were released after commit instead of after session close
- ⏱️ **Session-Lifetime Locks**: Locks now held for ENTIRE session until merge/worktree removal
- 🛑 **Stop-and-Ask Protocol**: Agents must explicitly request user permission to edit files locked by other agents
- 💥 **Prevents Merge Conflicts**: Eliminates race conditions where two agents edit same files in parallel sessions

### ✨ Added - Enhanced Branch Management
- 🔀 **Dual Merge Support**: Merges to both daily branch (`manus_MMDD_*`) and main branch
- 📅 **Weekly Consolidation**: Automatic weekly branch cleanup and consolidation
- 🧹 **Orphan Session Cleanup**: Detects and cleans up stale session branches
- 🌳 **Hierarchical Branching**: `session → daily → main` branch structure
- ✅ **Comprehensive Tests**: 7 automated test cases covering all merge scenarios
- 📊 **Enhanced Status Display**: Shows both daily and main merge status

### 🔄 Changed
- House rules updated to clarify file lock lifetime requirements
- Session close now releases locks only after successful merge
- Enhanced-close-session script handles dual merges automatically
- Documentation updated with lock timing best practices

### 🐛 Fixed
- Prevents overlapping edits when agents finish at different times
- Eliminates duplicate work from parallel edits to same files
- Removes race condition in file coordination system

### 💡 Why This Matters
- **Before**: Agent A finishes editing and releases locks → Agent B starts editing same files → Both conflict when merging
- **After**: Agent A holds locks until session merged → Agent B blocked from editing → Zero conflicts
- **Impact**: Enables true parallel multi-agent workflows without manual conflict resolution

### 📚 Documentation
- Updated README with session-lifetime lock behavior
- Added file coordination best practices
- Documented stop-and-ask protocol for conflict resolution
- Created comprehensive test results and analysis documents

## [1.4.3] - 2025-10-08

### Fixed
- 🔒 **Shared File Coordination**: Fixed file-coordination to use `local_deploy/.file-coordination/` instead of per-worktree coordination
- 🤝 **Multi-Agent Lock Visibility**: All agents now see each other's file locks across all worktrees
- 📍 **Repository Root Detection**: Added smart repo root detection that works from worktrees and submodules

### Added
- 🐋 **Docker Never Option**: Added "Never" option (Y/N/A/Never) to Docker configuration prompts
- 💾 **Persistent Docker Settings**: Docker preferences now saved to `local_deploy/project-settings.json` when using Always/Never
- 🔄 **Automatic Version Check**: Agent now checks npm registry for updates once per day
- 📦 **Update Notifications**: Shows available updates with install command when newer version exists
- 🗂️ **Project Cleanup**: Moved old houserules to `archive/` folder for cleaner root directory
- 📚 **Documentation Organization**: Moved `HOUSERULES_README.md` and `IMPLEMENTATION_SUMMARY.md` to `docs/` folder

### Changed
- File coordination instructions now show full path to shared lock directory
- Docker prompt includes "Always" option to remember settings across sessions
- Version checking happens automatically on session creation (with 24-hour cooldown)
- Archive folder excluded from npm package

### Why
- **File Coordination Fix**: Previously each worktree had its own `.file-coordination/` folder, so agents couldn't see each other's locks. Moving to shared `local_deploy/.file-coordination/` ensures all agents coordinate properly.
- **Docker Settings**: Users were asked about Docker on every session. Now they can choose "Always" to configure once, or "Never" to stop being asked.
- **Version Checking**: Keeps users informed of updates without being intrusive (once per day check).
- **Project Organization**: Cleaner root directory makes it easier to understand project structure.

## [1.4.2] - 2025-10-08

### Fixed
- 🔧 **Comprehensive File Watcher Ignore Patterns**: Massively expanded ignored paths to prevent EMFILE (too many open files) errors
- 📁 **Database and Migrations**: Now ignores `migrations/` and `database/` folders which can contain thousands of files
- 🗄️ **Archived Worktrees**: Ignores `archived_*_worktree/` and `archived_*/**` patterns from DevOpsAgent
- 🐍 **Python Artifacts**: Added `.pytest_cache/`, `.mypy_cache/`, `*.egg-info/`, `*.pyo`, `*.pyd`
- 📦 **Additional Dependencies**: Added `bower_components/` ignore pattern
- 🏗️ **Build Artifacts**: Added `out/`, `.output/`, `public/build/` patterns
- 📊 **Test Coverage**: Added `.nyc_output/`, `htmlcov/`, `.coverage`, `lcov-report/`
- 💾 **Cache Directories**: Added `.parcel-cache/`, `.eslintcache`, `.stylelintcache`
- 🔒 **Lock Files**: Expanded to include `poetry.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`
- 📝 **IDE Files**: Added `.fleet/`, `.vs/`, `*.swp`, `*.swo`, `*~`
- 🎬 **Media Files**: Ignores video and archive files (`.mp4`, `.avi`, `.mov`, `.pdf`, `.zip`, `.tar`, `.gz`, `.7z`)
- 🍎 **macOS Files**: Added `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `Thumbs.db`
- 🔐 **Environment Files**: Added `.env.local`, `.env.*.local`

### Why
- Client environments with large `coverage/`, `database/`, `migrations/`, and archived worktree directories were hitting system file descriptor limits
- Chokidar was attempting to watch thousands of unnecessary files causing "EMFILE: too many open files" errors
- More comprehensive ignore patterns = better performance and stability across diverse project structures
- Prevents wasted resources watching files that should never trigger commits (lock files, cache, build artifacts, etc.)

## [1.4.1] - 2025-10-08

### Fixed
- 🔍 **Recursive Docker Compose Detection**: Enhanced to search subdirectories like `Infrastructure/docker/` up to 3 levels deep
- 📂 **Infrastructure Folder Support**: Now checks both `Infrastructure/` and `infrastructure/` at project root and parent directory
- 🔄 **Regex Matching**: Uses flexible pattern matching for `docker-compose*.yml/yaml` files
- 🚫 **Smart Directory Exclusion**: Avoids searching `node_modules`, `.git`, `dist`, `build` during recursive search
- 🔁 **Deduplication**: Prevents listing the same Docker compose file multiple times

### Changed
- Added `searchDockerFilesRecursive()` helper function with depth limit and directory exclusions
- Updated `findDockerComposeFiles()` to include recursive search across multiple candidate directories

### Why
- Users were not able to detect Docker compose files nested in subdirectories like `Infrastructure/docker/`
- Previous detection only checked specific top-level files without recursive search
- Better Docker detection = better session setup experience

## [1.4.0] - 2025-10-08

### Added
- 📋 **Interactive House Rules Setup**: First-time setup now prompts for folder structure preference
- 📁 **Folder Structure Choice**: Choose between structured (modular) or flexible organization
- 📄 **Template Files**: Automatically copies `houserules_core.md` or `houserules_structured.md` + `folders.md`
- 🏗️ **Infrastructure Template**: Auto-creates `infrastructure/infrastructure.md` with comprehensive template
- ♾️ **Always Auto-Merge**: New "Always" option (Y/N/A) saves auto-merge settings permanently
- 🤖 **24x7 Operation Support**: Settings persist across sessions for hands-off operation
- 📚 **Multiple House Rules Versions**: Core, structured, traditional, and improved variants
- 📖 **House Rules README**: Complete guide explaining different versions and use cases

### Changed
- House rules setup now integrated into first session creation flow
- Auto-merge prompt enhanced with three options: Yes (session), No, Always (permanent)
- Settings saved to `local_deploy/project-settings.json` when Always selected
- Session coordinator checks for existing house rules before prompting
- House rules manager intelligently detects project root when running as submodule

### Why
- Users need flexibility to choose organizational style that fits their project
- 24x7 running agents require permanent settings to avoid repeated prompts
- Different projects have different needs (new vs existing, small vs large)
- Automatic infrastructure documentation prevents port conflicts and resource collisions
- Always option enables true hands-off operation with automatic daily rollover

## [1.3.3] - 2025-10-03

### Added
- 🐋 **Enhanced Docker Detection**: Now searches parent directory and parent/Infrastructure folder for docker-compose files
- 💬 **User Prompting**: When no Docker config found, prompts user to manually specify docker-compose file path
- 📍 **Location Labels**: Shows where each docker-compose file was found (project/parent/Infrastructure)

### Changed
- `findDockerComposeFiles()` now searches multiple locations for better multi-repo support
- Session coordinator provides helpful guidance when Docker config not auto-detected
- Supports common multi-repo patterns (frontend/backend with shared networking)

### Why
- Multi-repo projects often keep docker-compose at parent level for container networking
- Enables single compose file to orchestrate multiple related projects
- Better user experience with clear prompts instead of silent failures

## [1.3.2] - 2025-10-02

### Changed
- 🎯 **Improved User Experience**: Changed "Instructions for Claude/Cline" to "Instructions for Your Coding Agent" for broader compatibility
- ⏱️ **Better Instruction Flow**: Moved copy-paste instructions to appear AFTER agent initialization and interactive commands  
- 🔍 **House Rules Search**: Enhanced to search repository-wide, excluding DevOpsAgent directories
- 📁 **Backup Organization**: House rules backups now stored in `DevopsAgent_Backups/` folder
- 🏠 **Parent Directory Detection**: Improved detection when running as submodule in `Scripts_Dev` or similar directories

### Fixed
- 🔧 House rules manager now correctly finds parent project's house rules when running as submodule
- 📊 CLI output now returns clean JSON for status commands
- ⏰ Instructions display timing for better user experience
- 🚫 Prevents using DevOpsAgent's own template house rules file

## [1.3.1] - 2025-10-02

### Added
- 🧪 Comprehensive file locking demonstration test (`test-file-locking.sh`)
- 📁 Better script organization - coordination scripts moved to `scripts/coordination/`
- 🔒 Visual demonstration of how file locking prevents conflicts between agents

### Changed  
- 📦 Improved commit message format in house rules (includes WHY and file tracking)
- 🔧 Coordination scripts now handle empty directories correctly
- 🎨 Enhanced test output with color-coded results and clear explanations

### Fixed
- 🐛 Fixed glob expansion issues when no JSON files exist in coordination directories
- 🔍 Fixed false positive conflicts in empty active-edits directory
- ✅ All coordination scripts now properly handle edge cases

### Removed
- 🧹 Cleaned up coordination alert files from repository (now properly git-ignored)
- 🗑️ Removed unnecessary test branches and worktrees

## [1.3.0] - 2025-09-30

### Added
- 🟧 Real-time undeclared edit detection with orange alerts
- 🔴 File conflict detection with red alerts for actual conflicts  
- 📋 Copy-paste instructions for correcting agent behavior
- ⚡ 2-second detection interval for near-instant feedback
- 🔒 File-level advisory locks to prevent simultaneous edits
- Enhanced file monitor (`file-monitor-enhanced.cjs`) for real-time detection
- File coordinator (`file-coordinator.cjs`) for managing declarations and conflicts
- Setup script for file coordination system (`setup-file-coordination.sh`)
- Helper scripts: `check-file-availability.sh`, `declare-file-edits.sh`, `release-file-edits.sh`
- Comprehensive test suite for coordination system (`test-file-coordination.sh`)
- Updated house rules with mandatory file coordination protocol
- Session coordinator now includes coordination instructions for agents

### Changed
- House rules now include file coordination protocol at the top
- Session setup instructions now include file declaration requirements
- Alert colors: Orange for undeclared edits, Red for actual conflicts
- Module files renamed to `.cjs` extension for CommonJS compatibility

### Fixed
- Multiple agents can now work safely without file conflicts
- Reduced merge conflicts through proactive coordination
- Prevention of wasted work from simultaneous edits

## [1.2.0] - 2025-09-30

### Added
- Automatic Docker container restart after push
- Docker utilities module for container management
- Session-level Docker configuration options
- Support for docker-compose v1 and v2
- Configurable container rebuild on restart
- Service-specific restart capability
- Non-blocking Docker operations (failures don't affect git workflow)

### Changed
- Session coordinator now detects docker-compose files automatically
- Session creation prompts for Docker restart preferences when compose files detected

## [1.1.0] - 2025-09-30

### Added
- Dynamic agent name display in instructions based on selected AI agent
- Comprehensive repository cloning instructions in README
- Quick Links section in README with repository, NPM, and documentation links
- Publishing guide (PUBLISHING.md) with detailed NPM publishing instructions
- Support for multiple AI development agents (Claude, Cursor, Cline, GitHub Copilot, etc.)

### Changed
- Package renamed from `cs-devops-agent` to `s9n-devops-agent`
- Instructions now agent-agnostic - adapts to any AI development agent
- Improved documentation with clearer installation options
- Updated all references from "Claude/Cline" to generic "AI Development Agent"
- Shell script now extracts and displays actual agent type from session data

### Fixed
- Instructions now properly capitalize agent names
- Session manager displays appropriate agent name instead of hard-coded "Claude"

## [1.0.0] - 2025-09-29

### Initial Release
- Multi-agent support for concurrent development sessions
- Git worktree management for isolated workspaces
- Automatic commit and push functionality
- Session management with create, list, and close operations
- VS Code integration
- Daily version rollover with customizable increments
- Smart branching with configurable naming patterns
- Interactive session manager UI
- Support for Claude, GitHub Copilot, Cursor, and other AI assistants
- Comprehensive test suite
- Binary build support for multiple platforms

[1.4.3]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/SecondBrainAICo/CS_DevOpsAgent/releases/tag/v1.0.0
