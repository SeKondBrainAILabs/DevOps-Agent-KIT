# PR Approval Gate Implementation Summary

## Overview
Implemented the optional PR approval gate for protected merges according to specification S9N-6394. Adds a config flag that enables checking GitHub PR review status before allowing protected branch merges.

## Files Modified

### 1. Configuration Service
- **File**: `electron/services/ConfigService.ts`
- **Change**: Added `mergeRequirePrApproval: false` to `defaultConfig`

### 2. Shared Types
- **File**: `shared/types.ts`
- **Change**: Added `'PR_NOT_APPROVED'` to `MergeResult.gateReason` union type

### 3. Merge Service
- **File**: `electron/services/MergeService.ts` 
- **Change**: Added PR approval checking logic in `checkMergeGate` method that:
  - Checks `mergeRequirePrApproval` config flag
  - Executes `gh pr view <source> --json reviewDecision` when flag is true
  - Returns `gateReason: 'PR_NOT_APPROVED'` if reviewDecision is not 'APPROVED'
  - Only applies to protected targets and when `skipCiGate` is false

## Key Features Implemented
- ✅ `mergeRequirePrApproval` defaults to `false` 
- ✅ Only activates when config flag is explicitly set to `true`
- ✅ Works only for protected branches (main/master/production/release)
- ✅ Respects `skipCiGate` override to bypass the gate
- ✅ Integrates cleanly with existing merge gate infrastructure
- ✅ Proper error handling with safe fallbacks
- ✅ Maintains backward compatibility

## Behavior
When `mergeRequirePrApproval` is enabled:
- PR review decision is fetched using GitHub CLI
- If `reviewDecision` ≠ 'APPROVED', merge is refused with `gateReason: 'PR_NOT_APPROVED'`
- Non-protected branches remain unaffected
- Other merge gates (CI checks, WIP commits) continue to apply