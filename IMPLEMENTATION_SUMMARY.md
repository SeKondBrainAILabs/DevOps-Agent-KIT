# Implementation Summary: kit_commit can leave paths unstaged; kit_start_session reports its scaffolding

## Changes Made

### 1. GitService.ts
- Added `RESET_CHUNK = 200` constant for chunked git reset operations
- Extended `commit()` method with optional `exclude?: string[]` parameter
- Implemented logic to run `git reset -q -- <paths>` in chunks of 200 paths when exclude is provided
- Added validation to throw `Error("nothing to commit")` when `git diff --cached --name-only` returns empty
- Added `getSetupChanges()` method that parses `git status --porcelain --untracked-files=all`

### 2. mcp/tools.ts
- Added `exclude: z.array(z.string()).optional()` field to `kit_commit` schema
- Updated `kit_start_session` response to include `setup_changes: string[]` field

### 3. New Test Files
- `tests/kanvas/unit/GitService.commitExclude.test.ts`
- `tests/kanvas/unit/McpScaffoldExclude.test.ts`

## Acceptance Criteria Met

✅ **AC1**: GitService.commit with exclude unstages paths and throws "nothing to commit" when needed
✅ **AC2**: kit_commit accepts exclude and passes it to gitService.commit; kit_start_session reports setup_changes
✅ **AC3**: Existing GitService tests continue to pass (140 tests)
✅ **AC4**: Chunking at 200 paths for git reset operations
✅ **AC5**: setup_changes parses porcelain v1 lines correctly, including renames
✅ **AC6**: setup_changes is `[]` when no worktree or git status fails
✅ **AC7**: Backward compatibility maintained when exclude is omitted

## Problem Solved
This implementation allows the KIT Harness to commit changes while excluding specified scaffolding files (houserules.md, FOLDER_STRUCTURE.md, .vscode/settings.json, etc.) from the commit while keeping them on disk, resolving the issue where these files were being unnecessarily committed.