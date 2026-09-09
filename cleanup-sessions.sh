#!/usr/bin/env bash

# ============================================================================
# CLEANUP SCRIPT - Remove all worktrees and sessions
# ============================================================================

echo "🧹 Cleaning up all DevOps Agent sessions and worktrees..."
echo

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. List current worktrees
echo -e "${YELLOW}Current worktrees:${NC}"
git worktree list
echo

# 2. Remove git worktrees
echo -e "${YELLOW}Removing git worktrees...${NC}"
git worktree prune

# Remove specific worktrees if they exist
for worktree in $(git worktree list --porcelain | grep "worktree" | cut -d' ' -f2 | grep -v "$(git rev-parse --show-toplevel)$"); do
    if [[ "$worktree" == *"worktrees"* ]] || [[ "$worktree" == *"local_deploy"* ]]; then
        echo "Removing worktree: $worktree"
        git worktree remove -f "$worktree" 2>/dev/null || true
    fi
done

# 3. Clean up local_deploy directories
echo -e "${YELLOW}Cleaning local_deploy directories...${NC}"
rm -rf local_deploy/worktrees/* 2>/dev/null
rm -rf local_deploy/session-locks/* 2>/dev/null
rm -rf local_deploy/sessions/* 2>/dev/null
rm -rf local_deploy/instructions/* 2>/dev/null
rm -f local_deploy/claude-sessions.json 2>/dev/null
rm -f local_deploy/.devops-sessions.json 2>/dev/null

# 4. Clean up any worktrees in wrong locations
echo -e "${YELLOW}Cleaning up misplaced worktrees...${NC}"
rm -rf .worktrees 2>/dev/null
rm -rf .session-locks 2>/dev/null
rm -rf .claude-sessions.json 2>/dev/null
rm -rf .devops-sessions 2>/dev/null
rm -rf .claude-instructions 2>/dev/null

# 5. Clean up git branches
echo -e "${YELLOW}Cleaning up session branches...${NC}"
for branch in $(git branch | grep -E "claude/|warp/|agent/" | tr -d ' '); do
    echo "Deleting branch: $branch"
    git branch -D "$branch" 2>/dev/null || true
done

# 6. Create clean local_deploy structure
echo -e "${YELLOW}Creating clean directory structure...${NC}"
mkdir -p local_deploy/worktrees
mkdir -p local_deploy/session-locks
mkdir -p local_deploy/sessions
mkdir -p local_deploy/instructions
mkdir -p local_deploy/logs

echo -e "${GREEN}✅ Cleanup complete!${NC}"
echo
echo "You can now start fresh with:"
echo "  npm start                  # Interactive session manager"
echo "  ./start-devops-session.sh  # Same as npm start"
echo