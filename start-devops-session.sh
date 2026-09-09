#!/usr/bin/env zsh

# ============================================================================
# INTERACTIVE DEVOPS SESSION STARTER (v2.0)
# ============================================================================
# 
# Enhanced user experience for starting DevOps agent sessions.
# 
# What this does:
# - Guides you through creating or resuming sessions
# - Generates beautiful instructions for your AI assistant
# - Monitors your session automatically
# 
# Why it matters:
# - Simple, visual interface
# - No manual git commands needed
# - Automatic conflict detection
# 
# Usage: ./start-devops-session.sh
# ============================================================================

# Colors for output (using printf for better compatibility)
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;36m'
MAGENTA=$'\033[0;35m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
NC=$'\033[0m' # No Color
BG_BLUE=$'\033[44m'
BG_GREEN=$'\033[42m'
BG_YELLOW=$'\033[43m'

# Get the directory where this script is located (compatible with both bash and zsh)
if [[ -n "${BASH_SOURCE[0]}" ]]; then
    # Running in bash
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
else
    # Running in zsh
    SCRIPT_DIR="${0:A:h}"
fi
SRC_DIR="$SCRIPT_DIR/src"

# Function to display copyright
show_copyright() {
    echo
    echo "======================================================================"
    echo
    echo "  CS_DevOpsAgent - Intelligent Git Automation System"
    echo "  Version 1.7.2 | Build 20251010.03"
    echo "  "
    echo "  Copyright (c) 2025 SeKondBrain AI Labs Limited"
    echo "  Author: Sachin Dev Duggal"
    echo "  "
    echo "  Licensed under the MIT License"
    echo "  This software is provided 'as-is' without any warranty."
    echo "  See LICENSE file for full license text."
    echo "======================================================================"
    echo
}

# Function to display header
show_header() {
    echo
    echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}${BOLD}              DevOps Agent Session Manager v2.0                 ${NC}${BLUE}║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo
    echo -e "${DIM}Intelligent Git automation with AI agent coordination${NC}"
    echo
}

# NOTE: display_instructions function removed - session coordinator handles this now
# to prevent duplicate copy-paste instructions

# Function to list existing sessions
list_sessions() {
    local sessions_dir="local_deploy/session-locks"
    
    if [[ ! -d "$sessions_dir" ]] || [[ -z "$(ls -A $sessions_dir 2>/dev/null)" ]]; then
        echo -e "${YELLOW}No existing sessions found.${NC}"
        return 1
    fi
    
    echo -e "${BOLD}Existing Sessions:${NC}"
    echo
    
    local i=1
    local session_files=()
    
    for lock_file in "$sessions_dir"/*.lock; do
        [[ ! -f "$lock_file" ]] && continue
        
        local session_data=$(cat "$lock_file")
        local session_id=$(echo "$session_data" | grep -o '"sessionId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local task=$(echo "$session_data" | grep -o '"task"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local status=$(echo "$session_data" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local created=$(echo "$session_data" | grep -o '"created"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        
        # Color code based on status
        local status_color="${GREEN}"
        [[ "$status" == "stopped" ]] && status_color="${YELLOW}"
        [[ "$status" == "inactive" ]] && status_color="${RED}"
        
        echo -e "  ${BOLD}$i)${NC} Session: ${BLUE}${session_id}${NC}"
        echo -e "     Task: ${task}"
        echo -e "     Status: ${status_color}${status}${NC}"
        echo -e "     Created: ${created}"
        echo
        
        session_files+=("$lock_file")
        ((i++))
    done
    
    return 0
}

# Function to create a new session
create_new_session() {
    echo
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}📝 Create New Session${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "${DIM}What:${NC} Your session gets an isolated workspace"
    echo -e "${DIM}Why:${NC} Prevents conflicts with other AI agents"
    echo -e "${DIM}How:${NC} Creates git worktree + branch + file locks"
    echo
    
    # Ask for task name
    echo -e "${BOLD}Task/Feature Name:${NC}"
    echo -e "${DIM}Examples: implement-auth, build-api, fix-login-bug${NC}"
    echo -n "➜ "
    read task_name
    
    if [[ -z "$task_name" ]]; then
        task_name="development"
        echo -e "${YELLOW}Using default: development${NC}"
    fi
    
    echo
    
    # Ask for agent type
    echo -e "${BOLD}AI Agent Type:${NC}"
    echo -e "  ${GREEN}1)${NC} Claude (Anthropic)"
    echo -e "  ${GREEN}2)${NC} Cursor"
    echo -e "  ${GREEN}3)${NC} GitHub Copilot"
    echo -e "  ${GREEN}4)${NC} Cline (VS Code)"
    echo -e "  ${GREEN}5)${NC} Warp"
    echo -e "  ${GREEN}6)${NC} Other"
    echo -n "➜ Your choice [1-6, default: 1]: "
    read agent_choice
    
    case "$agent_choice" in
        2) agent_type="cursor" ;;
        3) agent_type="copilot" ;;
        4) agent_type="cline" ;;
        5) agent_type="warp" ;;
        6) agent_type="other" ;;
        *) agent_type="claude" ;;
    esac
    
    echo
    echo -e "${GREEN}✓${NC} Creating session: ${BOLD}${task_name}${NC} (Agent: ${BLUE}${agent_type}${NC})"
    echo
    
    # Run the session coordinator to create AND START the session
    # Keep current directory to ensure session is created for the right repo
    node "$SRC_DIR/session-coordinator.js" create-and-start --task "$task_name" --agent "$agent_type"
}

# Function to prompt for session selection
select_session() {
    echo
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}🚀 Session Selection${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "  ${BOLD}${MAGENTA}0)${NC} 🤖 Kora (Smart Assistant)"
    echo -e "  ${BOLD}${GREEN}N)${NC} Create a ${BOLD}new${NC} session"
    
    # List existing sessions
    local sessions_dir="local_deploy/session-locks"
    local session_files=()
    
    if [[ -d "$sessions_dir" ]] && [[ -n "$(ls -A $sessions_dir 2>/dev/null)" ]]; then
        echo
        echo -e "${BOLD}Or select an existing session:${NC}"
        echo
        
        local i=1
        for lock_file in "$sessions_dir"/*.lock; do
            [[ ! -f "$lock_file" ]] && continue
            
            local session_data=$(cat "$lock_file")
            local session_id=$(echo "$session_data" | grep -o '"sessionId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
            local task=$(echo "$session_data" | grep -o '"task"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
            
            echo -e "  ${BOLD}$i)${NC} ${BLUE}${session_id}${NC} - ${task}"
            session_files+=("$lock_file")
            ((i++))
        done
    fi
    
    echo
    echo -e "  ${BOLD}${RED}Q)${NC} Quit - Exit the session manager"
    echo
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -n "➜ Your choice: "
    read choice
    
    # Handle the choice
    if [[ "$choice" == "0" ]]; then
        # Start Smart Assistant
        echo
        echo -e "${MAGENTA}Starting Smart Assistant...${NC}"
        node "$SRC_DIR/agent-chat.js"
        return 0
    elif [[ "$choice" =~ ^[Qq]$ ]]; then
        # Quit the session manager
        echo
        echo -e "${GREEN}Goodbye! Exiting DevOps Session Manager.${NC}"
        exit 0
    elif [[ "$choice" =~ ^[Nn]$ ]]; then
        # Create new session
        create_new_session
        return 0
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -ge 1 ]] && [[ "$choice" -le "${#session_files[@]}" ]]; then
        # Use existing session
        # Debug: Show what we're trying to access
        echo -e "${DIM}[Debug] Choice: $choice, Array size: ${#session_files[@]}${NC}"
        echo -e "${DIM}[Debug] Array contents: ${session_files[@]}${NC}"
        
        # In zsh, arrays are 1-indexed, so $choice maps directly
        local selected_file="${session_files[$choice]}"
        
        echo -e "${DIM}[Debug] Selected file: $selected_file${NC}"
        
        # Validate that the file exists
        if [[ ! -f "$selected_file" ]]; then
            echo -e "${RED}Error: Session file not found: $selected_file${NC}"
            echo -e "${YELLOW}All files in array:${NC}"
            for idx in "${!session_files[@]}"; do
                echo -e "  [$idx] = ${session_files[$idx]}"
            done
            return 1
        fi
        
        local session_data=$(cat "$selected_file")
        
        # Validate session data was read
        if [[ -z "$session_data" ]]; then
            echo -e "${RED}Error: Could not read session data from: $selected_file${NC}"
            return 1
        fi
        
        local session_id=$(echo "$session_data" | grep -o '"sessionId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local worktree_path=$(echo "$session_data" | grep -o '"worktreePath"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local task=$(echo "$session_data" | grep -o '"task"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        local branch_name=$(echo "$session_data" | grep -o '"branchName"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')
        
        # Validate we got a session ID
        if [[ -z "$session_id" ]]; then
            echo -e "${RED}Error: Could not extract session ID from file: $selected_file${NC}"
            echo -e "${YELLOW}File contents:${NC}"
            cat "$selected_file"
            return 1
        fi
        
        echo
        echo -e "${GREEN}✓${NC} Resuming session: ${BOLD}${session_id}${NC}"
        echo -e "${DIM}Task: ${task}${NC}"
        
        # Instructions will be displayed by the session coordinator
        # No need to display them here to avoid duplication
        
        echo
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${BOLD}🤖 Starting DevOps Agent Monitoring${NC}"
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo
        echo -e "${DIM}Press Ctrl+C to stop monitoring${NC}"
        
        # Start the agent for this session
        # Keep current directory to ensure agent runs in the right repo
        node "$SRC_DIR/session-coordinator.js" start "$session_id"
        return 0
    else
        echo -e "${RED}Invalid choice. Please try again.${NC}"
        return 1
    fi
}

# Function to setup house rules and file coordination
setup_house_rules() {
    local ROOT="$1"
    local COORD_DIR="$ROOT/.file-coordination"
    
    # Check if we need to update existing house rules (even if coordination is set up)
    if [[ -f "$SCRIPT_DIR/src/house-rules-manager.js" ]]; then
        # Check status of house rules
        local STATUS=$(node "$SCRIPT_DIR/src/house-rules-manager.js" status 2>/dev/null || echo '{"needsUpdate": false, "exists": true}')
        local NEEDS_UPDATE=$(echo "$STATUS" | grep -o '"needsUpdate"[[:space:]]*:[[:space:]]*true' || echo "")
        local EXISTS=$(echo "$STATUS" | grep -o '"exists"[[:space:]]*:[[:space:]]*true' || echo "")
        
        # Check if house rules were deleted (coordination exists but house rules don't)
        if [[ -d "$COORD_DIR" ]] && [[ -z "$EXISTS" ]]; then
            echo -e "${YELLOW}⚠ House rules file appears to be missing!${NC}"
            echo "The file coordination system is set up, but house rules are gone."
            echo
            echo -n "Recreate house rules? (Y/n): "
            read RECREATE
            if [[ "${RECREATE}" != "n" ]] && [[ "${RECREATE}" != "N" ]]; then
                echo -e "${BLUE}Recreating house rules...${NC}"
                node "$SCRIPT_DIR/src/house-rules-manager.js" update 2>/dev/null
                echo -e "${GREEN}✓ House rules recreated!${NC}"
                echo
            fi
        elif [[ -n "$NEEDS_UPDATE" ]]; then
            echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo -e "${BOLD}House Rules Update Available${NC}"
            echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo
            echo "The DevOps Agent has updated house rules sections."
            echo "Your custom rules will be preserved."
            echo
            echo -n "Update house rules now? (Y/n): "
            read UPDATE_CHOICE
            
            if [[ "${UPDATE_CHOICE}" != "n" ]] && [[ "${UPDATE_CHOICE}" != "N" ]]; then
                echo -e "${BLUE}Updating house rules...${NC}"
                node "$SCRIPT_DIR/src/house-rules-manager.js" update
                echo -e "${GREEN}✓ House rules updated!${NC}"
                echo
            fi
        fi
    fi
    
    # Check if coordination system is already set up
    if [[ -d "$COORD_DIR" ]] && [[ -f "$ROOT/check-file-availability.sh" ]]; then
        return 0  # Already set up
    fi
    
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}First-time Setup: House Rules & File Coordination${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
    echo
    echo "House rules help AI agents understand your project conventions and"
    echo "prevent conflicts when multiple agents work on the same codebase."
    echo
    
    # NOTE: House rules creation is now handled by session-coordinator's ensureHouseRulesSetup()
    # This provides the interactive prompt for structured vs flexible organization
    # We only need to ensure file coordination directory exists here
    
    # Create file coordination directory if it doesn't exist
    mkdir -p "$COORD_DIR/active-edits" "$COORD_DIR/completed-edits" "$COORD_DIR/conflicts"
    
    # House rules will be created by session-coordinator when needed
    # with the proper structured/flexible prompt
}

# Main function
main() {
    # Show copyright first
    show_copyright
    
    # Then show the header
    show_header
    
    # Check if we're in a git repository
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        echo -e "${RED}Error: Not in a git repository${NC}"
        echo "Please run this from within a git repository."
        exit 1
    fi
    
    # Get repo root
    REPO_ROOT=$(git rev-parse --show-toplevel)
    cd "$REPO_ROOT"
    
    # Check and setup house rules on first run
    setup_house_rules "$REPO_ROOT"
    
    echo -e "${BOLD}Welcome to DevOps Agent${NC}"
    echo
    echo -e "${GREEN}✓${NC} Isolated workspaces for each AI agent"
    echo -e "${GREEN}✓${NC} Automatic git commits and pushes"
    echo -e "${GREEN}✓${NC} File coordination prevents conflicts"
    echo -e "${GREEN}✓${NC} Beautiful instructions for your agent"
    echo
    echo -e "${DIM}💡 New to DevOps Agent? Run: s9n-devops-agent tutorial${NC}"
    echo
    
    # Run Kora (Smart Assistant)
    # This replaces the old menu system with the unified chat interface
    node "$SRC_DIR/agent-chat.js" "$@"
}

# Handle Ctrl+C gracefully
trap 'echo -e "\n${YELLOW}Session terminated by user${NC}"; exit 0' INT

# Run main function
main "$@"