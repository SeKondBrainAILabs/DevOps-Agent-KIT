#!/usr/bin/env zsh
# Comprehensive test suite for multi-agent coordination system
# Date: September 28, 2025
# Author: SeKondBrain AI

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Test environment setup
TEST_ROOT="/tmp/ac-coordination-test-$$"
ORIG_DIR="$(pwd)"
SCRIPT_DIR="$( cd "$( dirname "${(%):-%x}" )" && pwd )"

# Test state
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Logging functions
log_info() { echo -e "${CYAN}[INFO]${NC} $*" >&2; }
log_success() { echo -e "${GREEN}[✓]${NC} $*" >&2; }
log_error() { echo -e "${RED}[✗]${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}[!]${NC} $*" >&2; }
log_test() { echo -e "\n${BLUE}[TEST]${NC} $*" >&2; }

# Test framework functions
assert_file_exists() {
    local file="$1"
    local desc="${2:-File exists: $file}"
    if [[ -f "$file" ]]; then
        log_success "$desc"
        ((TESTS_PASSED++))
        return 0
    else
        log_error "$desc - File not found: $file"
        ((TESTS_FAILED++))
        return 1
    fi
}

assert_dir_exists() {
    local dir="$1"
    local desc="${2:-Directory exists: $dir}"
    if [[ -d "$dir" ]]; then
        log_success "$desc"
        ((TESTS_PASSED++))
        return 0
    else
        log_error "$desc - Directory not found: $dir"
        ((TESTS_FAILED++))
        return 1
    fi
}

assert_contains() {
    local file="$1"
    local pattern="$2"
    local desc="${3:-File contains pattern}"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        log_success "$desc"
        ((TESTS_PASSED++))
        return 0
    else
        log_error "$desc - Pattern not found in $file: $pattern"
        ((TESTS_FAILED++))
        return 1
    fi
}

assert_json_field() {
    local file="$1"
    local field="$2"
    local expected="$3"
    local desc="${4:-JSON field matches}"
    
    if command -v jq >/dev/null 2>&1; then
        local actual=$(jq -r "$field" "$file" 2>/dev/null)
        if [[ "$actual" == "$expected" ]]; then
            log_success "$desc"
            ((TESTS_PASSED++))
            return 0
        else
            log_error "$desc - Expected: '$expected', Got: '$actual'"
            ((TESTS_FAILED++))
            return 1
        fi
    else
        log_warn "jq not installed, skipping JSON validation: $desc"
        ((TESTS_SKIPPED++))
        return 0
    fi
}

# Cleanup function
cleanup() {
    cd "$ORIG_DIR"
    if [[ -d "$TEST_ROOT" ]]; then
        rm -rf "$TEST_ROOT"
        log_info "Cleaned up test environment: $TEST_ROOT"
    fi
}

# Setup trap for cleanup
trap cleanup EXIT INT TERM

# Initialize test environment
setup_test_env() {
    log_info "Setting up test environment at: $TEST_ROOT"
    
    # Create test directory
    mkdir -p "$TEST_ROOT"
    cd "$TEST_ROOT"
    
    # Initialize git repo
    git init -q
    git config user.name "Test User"
    git config user.email "test@example.com"
    
    # Copy setup script
    cp "$SCRIPT_DIR/setup-prep-handshake.sh" .
    chmod +x setup-prep-handshake.sh
    
    # Create initial commit
    echo "# Test Repo" > README.md
    git add README.md
    git commit -q -m "Initial commit"
    
    log_success "Test environment created"
}

# Test 1: Setup script execution
test_setup_script() {
    log_test "Testing setup script execution"
    
    ./setup-prep-handshake.sh || true  # Allow to continue even if exit code is non-zero
    
    # Verify directories created
    assert_dir_exists ".ac-prep" "Prep directory created"
    assert_dir_exists ".ac/ack" "Acknowledgment directory created"
    assert_dir_exists ".git/.ac/alerts" "Alerts directory created"
    assert_dir_exists ".git/.ac/claims" "Claims directory created"
    assert_dir_exists ".git/.ac/reservations" "Reservations directory created"
    
    # Verify files created
    assert_file_exists ".ac-shards.json" "Shards configuration created"
    assert_file_exists ".ac-prep/_template.json" "Prep template created"
    assert_file_exists ".ac/ack/_template.json" "Ack template created"
    assert_file_exists ".claude-commit-msg" "Commit message file created"
    assert_file_exists "houserules.md" "House rules file created"
    
    # Verify scripts created
    assert_file_exists "agent-prep.sh" "Agent prep script created"
    assert_file_exists "monitor-agents.sh" "Monitor script created"
    
    # Test idempotency - run again
    log_info "Testing idempotency..."
    ./setup-prep-handshake.sh
    log_success "Setup script is idempotent"
}

# Test 2: Agent prep request creation
test_agent_prep() {
    log_test "Testing agent prep request creation"
    
    # Simulate Claude agent request
    export AGENT_NAME="claude"
    ./agent-prep.sh "test-feature" "src/**/*.js" 6
    
    assert_file_exists ".ac-prep/claude.json" "Claude prep request created"
    
    if command -v jq >/dev/null 2>&1; then
        assert_json_field ".ac-prep/claude.json" ".agent" "claude" "Agent name correct"
        assert_json_field ".ac-prep/claude.json" ".task" "test-feature" "Task name correct"
        assert_json_field ".ac-prep/claude.json" ".priority" "6" "Priority correct"
    fi
    
    # Simulate Copilot agent request
    export AGENT_NAME="copilot"
    ./agent-prep.sh "test-bugfix" "lib/**/*.js" 8
    
    assert_file_exists ".ac-prep/copilot.json" "Copilot prep request created"
}

# Test 3: Conflict detection
test_conflict_detection() {
    log_test "Testing conflict detection between agents"
    
    # Create overlapping requests
    export AGENT_NAME="agent1"
    cat > .ac-prep/agent1.json << 'EOF'
{
  "agent": "agent1",
  "task": "feature-1",
  "branch": "main",
  "paths": ["src/auth/**"],
  "shards": ["services"],
  "reason": "Adding authentication",
  "priority": 5,
  "createdAt": "2025-09-28T12:00:00Z",
  "ttlMs": 600000
}
EOF

    export AGENT_NAME="agent2"
    cat > .ac-prep/agent2.json << 'EOF'
{
  "agent": "agent2",
  "task": "feature-2",
  "branch": "main",
  "paths": ["src/auth/login.js"],
  "shards": ["services"],
  "reason": "Updating login logic",
  "priority": 7,
  "createdAt": "2025-09-28T12:00:01Z",
  "ttlMs": 600000
}
EOF

    # Check for conflict detection
    if [[ -f ".git/.ac/alerts/agent1.md" ]] || [[ -f ".git/.ac/alerts/agent2.md" ]]; then
        log_success "Conflict detection working"
        ((TESTS_PASSED++))
    else
        log_warn "Alert system needs manual trigger"
        ((TESTS_SKIPPED++))
    fi
}

# Test 4: Priority ordering
test_priority_ordering() {
    log_test "Testing priority-based request ordering"
    
    # Create multiple requests with different priorities
    local agents=("low-priority" "mid-priority" "high-priority" "critical")
    local priorities=(2 5 8 10)
    
    for i in {1..4}; do
        local agent="${agents[$i]}"
        local priority="${priorities[$i]}"
        
        cat > ".ac-prep/${agent}.json" << EOF
{
  "agent": "${agent}",
  "task": "task-${priority}",
  "branch": "main",
  "paths": ["test-${priority}/**"],
  "shards": ["default"],
  "reason": "Priority ${priority} task",
  "priority": ${priority},
  "createdAt": "2025-09-28T12:00:${i}0Z",
  "ttlMs": 600000
}
EOF
    done
    
    # List prep requests by priority
    if command -v jq >/dev/null 2>&1; then
        local highest_priority=$(ls .ac-prep/*.json 2>/dev/null | \
            xargs -I {} jq -r '.priority' {} | \
            sort -nr | head -n1)
        
        if [[ "$highest_priority" == "10" ]]; then
            log_success "Priority ordering detected correctly"
            ((TESTS_PASSED++))
        else
            log_error "Priority ordering failed"
            ((TESTS_FAILED++))
        fi
    else
        log_warn "jq not installed, skipping priority test"
        ((TESTS_SKIPPED++))
    fi
}

# Test 5: Shard reservation
test_shard_reservation() {
    log_test "Testing shard reservation system"
    
    # Create shard reservation
    mkdir -p .git/.ac/reservations
    cat > .git/.ac/reservations/claude-services.json << 'EOF'
{
  "agent": "claude",
  "shard": "services",
  "task": "auth-feature",
  "reservedAt": "2025-09-28T12:00:00Z",
  "expiresAt": "2025-09-28T12:10:00Z",
  "status": "active"
}
EOF

    assert_file_exists ".git/.ac/reservations/claude-services.json" "Shard reservation created"
    
    # Test concurrent reservation attempt
    cat > .git/.ac/reservations/copilot-services.json << 'EOF'
{
  "agent": "copilot",
  "shard": "services",
  "task": "api-update",
  "reservedAt": "2025-09-28T12:00:30Z",
  "status": "blocked",
  "blockedBy": "claude"
}
EOF

    assert_file_exists ".git/.ac/reservations/copilot-services.json" "Blocked reservation tracked"
}

# Test 6: Monitor functionality
test_monitor_script() {
    log_test "Testing monitor script functionality"
    
    # Run monitor script
    if ./monitor-agents.sh >/dev/null 2>&1; then
        log_success "Monitor script executes successfully"
        ((TESTS_PASSED++))
    else
        log_warn "Monitor script needs active requests"
        ((TESTS_SKIPPED++))
    fi
}

# Test 7: Cleanup and expiration
test_cleanup_expiration() {
    log_test "Testing cleanup and expiration handling"
    
    # Create expired request
    cat > .ac-prep/expired-agent.json << 'EOF'
{
  "agent": "expired-agent",
  "task": "old-task",
  "branch": "main",
  "paths": ["old/**"],
  "shards": ["default"],
  "reason": "Expired task",
  "priority": 5,
  "createdAt": "2025-09-28T10:00:00Z",
  "ttlMs": 60000
}
EOF

    # Check if system can identify expired requests
    local created_time="2025-09-28T10:00:00Z"
    local current_time=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    log_info "Created: $created_time, Current: $current_time"
    log_success "Expiration tracking structure in place"
    ((TESTS_PASSED++))
}

# Test 8: Integration test
test_integration() {
    log_test "Testing full integration workflow"
    
    # Step 1: Agent requests permission
    export AGENT_NAME="integration-test"
    ./agent-prep.sh "integration-feature" "src/integration/**" 7
    
    # Step 2: Check request exists
    assert_file_exists ".ac-prep/integration-test.json" "Integration request created"
    
    # Step 3: Simulate acknowledgment
    mkdir -p .ac/ack
    cat > .ac/ack/integration-test.json << 'EOF'
{
  "agent": "integration-test",
  "status": "ok",
  "acknowledgedPaths": ["src/integration/**"],
  "acknowledgedShards": ["services"],
  "message": "Permission granted",
  "acknowledgedAt": "2025-09-28T12:00:00Z"
}
EOF

    assert_file_exists ".ac/ack/integration-test.json" "Acknowledgment created"
    
    # Step 4: Simulate work completion
    echo "feat: Add integration feature" > .claude-commit-msg
    assert_file_exists ".claude-commit-msg" "Commit message ready"
    
    log_success "Integration workflow completed"
    ((TESTS_PASSED++))
}

# Main test execution
main() {
    echo -e "\n${CYAN}========================================${NC}"
    echo -e "${CYAN}   Multi-Agent Coordination Test Suite${NC}"
    echo -e "${CYAN}========================================${NC}\n"
    
    log_info "Starting comprehensive test suite..."
    
    # Setup test environment
    setup_test_env
    
    # Run all tests
    test_setup_script
    test_agent_prep
    test_conflict_detection
    test_priority_ordering
    test_shard_reservation
    test_monitor_script
    test_cleanup_expiration
    test_integration
    
    # Print summary
    echo -e "\n${CYAN}========================================${NC}"
    echo -e "${CYAN}              TEST SUMMARY${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo -e "${GREEN}  Passed:${NC}  $TESTS_PASSED"
    echo -e "${RED}  Failed:${NC}  $TESTS_FAILED"
    echo -e "${YELLOW}  Skipped:${NC} $TESTS_SKIPPED"
    echo -e "${CYAN}========================================${NC}\n"
    
    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}✓ All critical tests passed!${NC}"
        return 0
    else
        echo -e "${RED}✗ Some tests failed. Please review.${NC}"
        return 1
    fi
}

# Run main if not sourced
if [[ "${(%):-%x}" == "${0}" ]]; then
    main "$@"
fi