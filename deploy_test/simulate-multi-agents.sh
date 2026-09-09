#!/usr/bin/env zsh
# Multi-Session Agent Simulator
# Simulates multiple AI agents working concurrently in separate processes
# Date: September 28, 2025
# Author: SeKondBrain AI

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Simulation configuration
SIMULATION_DIR="/tmp/multi-agent-sim-$$"
LOG_DIR="$SIMULATION_DIR/logs"
PIDS_FILE="$SIMULATION_DIR/pids"
REPO_DIR="$SIMULATION_DIR/test-repo"

# Agent configurations
typeset -A AGENTS
AGENTS[claude]="6:services,webapp:feat: Implement authentication service"
AGENTS[copilot]="5:scripts,config:chore: Update build scripts"
AGENTS[cursor]="8:docs:docs: Update API documentation"
AGENTS[warp]="7:tests:test: Add integration tests"

# Logging functions
log_info() { echo -e "${CYAN}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[✓]${NC} $*"; }
log_error() { echo -e "${RED}[✗]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $*"; }
log_agent() {
    local agent=$1
    shift
    local color=""
    case "$agent" in
        claude) color=$BLUE ;;
        copilot) color=$GREEN ;;
        cursor) color=$MAGENTA ;;
        warp) color=$YELLOW ;;
        *) color=$CYAN ;;
    esac
    echo -e "${color}[$agent]${NC} $*"
}

# Cleanup function
cleanup() {
    log_info "Cleaning up simulation..."
    
    # Kill all agent processes
    if [[ -f "$PIDS_FILE" ]]; then
        while IFS= read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                log_info "Stopped process $pid"
            fi
        done < "$PIDS_FILE"
    fi
    
    # Remove simulation directory
    if [[ -d "$SIMULATION_DIR" ]]; then
        rm -rf "$SIMULATION_DIR"
        log_info "Removed simulation directory"
    fi
    
    log_success "Cleanup complete"
}

# Setup trap for cleanup
trap cleanup EXIT INT TERM

# Initialize simulation environment
setup_simulation() {
    log_info "Setting up multi-agent simulation environment..."
    
    # Create directories
    mkdir -p "$SIMULATION_DIR"
    mkdir -p "$LOG_DIR"
    mkdir -p "$REPO_DIR"
    touch "$PIDS_FILE"
    
    # Initialize test repository
    cd "$REPO_DIR"
    git init -q
    git config user.name "Test User"
    git config user.email "test@example.com"
    
    # Create initial project structure
    mkdir -p src/{services,webapp,api}
    mkdir -p scripts docs tests config
    
    # Create some initial files
    echo "# Test Project" > README.md
    echo "console.log('app');" > src/webapp/app.js
    echo "module.exports = {};" > src/services/auth.js
    echo "#!/bin/bash" > scripts/build.sh
    echo "{}" > package.json
    
    # Initial commit
    git add -A
    git commit -q -m "Initial commit"
    
    # Copy coordination setup script
    cp "$ORIG_DIR/setup-prep-handshake.sh" .
    chmod +x setup-prep-handshake.sh
    
    # Run setup
    ./setup-prep-handshake.sh
    
    log_success "Simulation environment ready at: $REPO_DIR"
}

# Simulate an individual agent session
simulate_agent() {
    local agent=$1
    local config=$2
    local log_file="$LOG_DIR/${agent}.log"
    
    # Parse configuration
    IFS=':' read -r priority shards task <<< "$config"
    
    # Start agent simulation in background
    {
        echo "[$(date)] Starting $agent agent simulation" >> "$log_file"
        echo "Priority: $priority, Shards: $shards, Task: $task" >> "$log_file"
        
        # Change to repo directory
        cd "$REPO_DIR"
        
        # Set agent environment
        export AGENT_NAME="$agent"
        
        # Random initial delay (0-3 seconds)
        local delay=$((RANDOM % 3))
        sleep $delay
        echo "[$(date)] Initial delay: ${delay}s" >> "$log_file"
        
        # Request permission
        echo "[$(date)] Requesting permission..." >> "$log_file"
        ./agent-prep.sh "$task" "${shards}/**" "$priority" >> "$log_file" 2>&1
        
        # Check for acknowledgment (poll for up to 10 seconds)
        local wait_time=0
        local max_wait=10
        local ack_file=".ac/ack/${agent}.json"
        
        while [[ $wait_time -lt $max_wait ]]; do
            if [[ -f "$ack_file" ]]; then
                echo "[$(date)] Acknowledgment received!" >> "$log_file"
                cat "$ack_file" >> "$log_file"
                break
            fi
            sleep 1
            ((wait_time++))
        done
        
        if [[ ! -f "$ack_file" ]]; then
            echo "[$(date)] WARNING: No acknowledgment received after ${max_wait}s" >> "$log_file"
        fi
        
        # Simulate work (2-5 seconds)
        local work_time=$((RANDOM % 3 + 2))
        echo "[$(date)] Simulating work for ${work_time}s..." >> "$log_file"
        sleep $work_time
        
        # Make some changes based on shard
        if [[ "$shards" == *"services"* ]]; then
            echo "// $agent was here at $(date)" >> src/services/auth.js
            git add src/services/auth.js
        elif [[ "$shards" == *"webapp"* ]]; then
            echo "// $agent was here at $(date)" >> src/webapp/app.js
            git add src/webapp/app.js
        elif [[ "$shards" == *"docs"* ]]; then
            echo "## $agent update at $(date)" >> README.md
            git add README.md
        elif [[ "$shards" == *"scripts"* ]]; then
            echo "# $agent was here at $(date)" >> scripts/build.sh
            git add scripts/build.sh
        elif [[ "$shards" == *"tests"* ]]; then
            echo "// $agent test at $(date)" > tests/test-${agent}.js
            git add tests/test-${agent}.js
        fi
        
        # Create commit message
        echo "$task - by $agent at $(date)" > .claude-commit-msg
        
        # Attempt to commit
        if git diff --cached --quiet; then
            echo "[$(date)] No changes to commit" >> "$log_file"
        else
            git commit -q -F .claude-commit-msg >> "$log_file" 2>&1
            echo "[$(date)] Changes committed successfully" >> "$log_file"
        fi
        
        # Check for alerts
        local alert_file=".git/.ac/alerts/${agent}.md"
        if [[ -f "$alert_file" ]]; then
            echo "[$(date)] ALERT DETECTED:" >> "$log_file"
            cat "$alert_file" >> "$log_file"
        fi
        
        # Random final delay (0-2 seconds)
        sleep $((RANDOM % 2))
        
        echo "[$(date)] Agent simulation complete" >> "$log_file"
        
    } &
    
    # Store PID for cleanup
    local pid=$!
    echo "$pid" >> "$PIDS_FILE"
    log_agent "$agent" "Started (PID: $pid)"
    
    return 0
}

# Monitor agent activity
monitor_simulation() {
    local duration=${1:-30}  # Monitor for 30 seconds by default
    local start_time=$(date +%s)
    local elapsed=0
    
    log_info "Monitoring agent activity for ${duration} seconds..."
    echo ""
    
    while [[ $elapsed -lt $duration ]]; do
        clear
        echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
        echo -e "${CYAN}║     Multi-Agent Coordination Monitor           ║${NC}"
        echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${YELLOW}Time Elapsed:${NC} ${elapsed}s / ${duration}s"
        echo ""
        
        # Show active prep requests
        echo -e "${BLUE}▶ Active Prep Requests:${NC}"
        for file in "$REPO_DIR"/.ac-prep/*.json(N); do
            if [[ -f "$file" ]]; then
                local agent=$(basename "$file" .json)
                if [[ "$agent" != "_template" ]]; then
                    if command -v jq >/dev/null 2>&1; then
                        local task=$(jq -r '.task' "$file" 2>/dev/null)
                        local priority=$(jq -r '.priority' "$file" 2>/dev/null)
                        echo "  • $agent: $task (Priority: $priority)"
                    else
                        echo "  • $agent"
                    fi
                fi
            fi
        done
        echo ""
        
        # Show acknowledgments
        echo -e "${GREEN}▶ Acknowledgments:${NC}"
        for file in "$REPO_DIR"/.ac/ack/*.json(N); do
            if [[ -f "$file" ]]; then
                local agent=$(basename "$file" .json)
                if [[ "$agent" != "_template" ]]; then
                    if command -v jq >/dev/null 2>&1; then
                        local status=$(jq -r '.status' "$file" 2>/dev/null)
                        echo "  • $agent: $status"
                    else
                        echo "  • $agent"
                    fi
                fi
            fi
        done
        echo ""
        
        # Show alerts
        echo -e "${RED}▶ Alerts:${NC}"
        if [[ -d "$REPO_DIR"/.git/.ac/alerts ]]; then
            for file in "$REPO_DIR"/.git/.ac/alerts/*.md(N); do
                if [[ -f "$file" ]]; then
                    local agent=$(basename "$file" .md)
                    echo "  ⚠ Alert for $agent"
                fi
            done
        fi
        echo ""
        
        # Show recent commits
        echo -e "${MAGENTA}▶ Recent Commits:${NC}"
        cd "$REPO_DIR"
        git log --oneline -5 2>/dev/null | sed 's/^/  /'
        cd - >/dev/null
        echo ""
        
        # Show log tail for each agent
        echo -e "${CYAN}▶ Agent Activity:${NC}"
        for agent in ${(k)AGENTS}; do
            local log_file="$LOG_DIR/${agent}.log"
            if [[ -f "$log_file" ]]; then
                local last_line=$(tail -1 "$log_file" 2>/dev/null | sed 's/\[.*\] //')
                log_agent "$agent" "$last_line"
            fi
        done
        
        sleep 2
        elapsed=$(($(date +%s) - start_time))
    done
    
    echo ""
    log_success "Monitoring complete"
}

# Generate simulation report
generate_report() {
    log_info "Generating simulation report..."
    
    local report_file="$SIMULATION_DIR/report.md"
    
    cat > "$report_file" << EOF
# Multi-Agent Coordination Simulation Report
Generated: $(date)

## Simulation Configuration
- Agents: ${#AGENTS[@]}
- Repository: $REPO_DIR
- Duration: ~30 seconds

## Agent Details
EOF

    for agent in ${(k)AGENTS}; do
        local config="${AGENTS[$agent]}"
        IFS=':' read -r priority shards task <<< "$config"
        cat >> "$report_file" << EOF

### $agent
- Priority: $priority
- Shards: $shards
- Task: $task
EOF
    done

    cat >> "$report_file" << EOF

## Activity Log Summary
EOF

    for agent in ${(k)AGENTS}; do
        local log_file="$LOG_DIR/${agent}.log"
        if [[ -f "$log_file" ]]; then
            echo "" >> "$report_file"
            echo "### $agent Activity" >> "$report_file"
            echo '```' >> "$report_file"
            tail -10 "$log_file" >> "$report_file"
            echo '```' >> "$report_file"
        fi
    done

    # Add commit history
    echo "" >> "$report_file"
    echo "## Commit History" >> "$report_file"
    echo '```' >> "$report_file"
    cd "$REPO_DIR"
    git log --oneline >> "$report_file" 2>/dev/null
    cd - >/dev/null
    echo '```' >> "$report_file"
    
    # Check for conflicts
    echo "" >> "$report_file"
    echo "## Conflict Detection" >> "$report_file"
    local conflict_count=0
    for file in "$REPO_DIR"/.git/.ac/alerts/*.md(N); do
        if [[ -f "$file" ]]; then
            ((conflict_count++))
            echo "- Alert: $(basename "$file" .md)" >> "$report_file"
        fi
    done
    
    if [[ $conflict_count -eq 0 ]]; then
        echo "✓ No conflicts detected" >> "$report_file"
    else
        echo "⚠ $conflict_count conflict(s) detected" >> "$report_file"
    fi
    
    log_success "Report saved to: $report_file"
    echo ""
    echo "Report Preview:"
    echo "─────────────────────────────────────"
    head -30 "$report_file"
    echo "─────────────────────────────────────"
    echo ""
    echo "Full report: $report_file"
}

# Main simulation
main() {
    local ORIG_DIR=$(pwd)
    
    echo -e "\n${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   Multi-Agent Coordination System Simulator      ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}\n"
    
    log_info "Simulating ${#AGENTS[@]} agents working concurrently..."
    echo ""
    
    # Setup simulation environment
    setup_simulation
    
    # Start all agents concurrently (simulating separate terminal sessions)
    log_info "Launching agent simulations..."
    for agent in ${(k)AGENTS}; do
        simulate_agent "$agent" "${AGENTS[$agent]}"
        # Small delay between agent starts to simulate realistic scenario
        sleep 0.5
    done
    
    echo ""
    log_success "All agents launched"
    echo ""
    
    # Monitor the simulation
    monitor_simulation 20
    
    # Wait for all agents to complete
    log_info "Waiting for agents to complete..."
    while IFS= read -r pid; do
        if kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null || true
        fi
    done < "$PIDS_FILE"
    
    log_success "All agents completed"
    echo ""
    
    # Generate report
    generate_report
    
    # Final summary
    echo -e "\n${GREEN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}           Simulation Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}\n"
    
    log_info "Check logs at: $LOG_DIR"
    log_info "Repository at: $REPO_DIR"
    
    # Prompt to keep environment for inspection
    echo ""
    read -p "Keep simulation environment for inspection? (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        trap - EXIT  # Remove cleanup trap
        log_info "Environment preserved at: $SIMULATION_DIR"
        log_info "Remember to manually clean up: rm -rf $SIMULATION_DIR"
    else
        cleanup
    fi
}

# Run if not sourced
if [[ "${(%):-%x}" == "${0}" ]]; then
    main "$@"
fi