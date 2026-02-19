# House Rules Contracts - CS_DevOpsAgent

**Repository:** CS_DevOpsAgent  
**Created:** 2024-12-16  
**Version:** 1.0.0  
**Purpose:** Single source of truth for all DevOps Agent components to prevent duplication and conflicts

---

## Overview

This folder contains **contract files** that document all aspects of the CS_DevOpsAgent project. These contracts serve as a **mandatory reference** for all coding agents before making changes to database schema, SQL queries, API endpoints, third-party integrations, features, or infrastructure configuration.

The contract system ensures that multiple AI agents can work on the same codebase without creating duplicate features, conflicting changes, or breaking existing functionality.

---

## Why Contracts Exist

### The Problem

When multiple coding agents work on the same codebase **without coordination**, they will create duplicate features with different names, create duplicate API endpoints for the same functionality, write duplicate SQL queries doing the same thing, integrate the same third-party service multiple times, make conflicting database changes that break each other, create duplicate environment variables with different names, overwrite each other's code unknowingly, and break existing functionality without realizing it.

### The Solution

Contracts provide a single source of truth that all agents must check before coding. This enables agents to discover existing functionality before building new, reuse existing code instead of duplicating, know exactly what exists and how to use it, avoid conflicts and breaking changes, coordinate changes across the codebase, maintain consistency and quality, and save time by not rebuilding what exists.

---

## Contract Files

| Contract File | Purpose | When to Check |
|---------------|---------|---------------|
| **[DATABASE_SCHEMA_CONTRACT.md](./DATABASE_SCHEMA_CONTRACT.md)** | All database tables, columns, indexes, migrations | Before creating/modifying database schema |
| **[SQL_CONTRACT.json](./SQL_CONTRACT.json)** | Reusable SQL queries with parameters and usage | Before writing any SQL query |
| **[API_CONTRACT.md](./API_CONTRACT.md)** | All API endpoints with full specifications | Before creating/modifying API endpoints |
| **[THIRD_PARTY_INTEGRATIONS.md](./THIRD_PARTY_INTEGRATIONS.md)** | External service integrations and binding modules | Before integrating third-party services |
| **[FEATURES_CONTRACT.md](./FEATURES_CONTRACT.md)** | All features with specifications and dependencies | Before implementing any feature |
| **[INFRA_CONTRACT.md](./INFRA_CONTRACT.md)** | Environment variables and infrastructure config | Before adding configuration/env vars |
| **[DEVOPS_AGENT_INSTRUCTIONS.md](./DEVOPS_AGENT_INSTRUCTIONS.md)** | Instructions for generating and maintaining contracts | For DevOps Agent to populate contracts |
| **[EVENTS_CONTRACT.md](./EVENTS_CONTRACT.md)** | Events, messages, pub-sub patterns, and analytics events | Before creating/modifying events or event handlers |
| **[CSS_DESIGN_TOKENS_CONTRACT.md](./CSS_DESIGN_TOKENS_CONTRACT.md)** | Styles, themes, design tokens, CSS conventions | Before adding styles, colors, or design tokens |
| **[PROMPTS_CONTRACT.md](./PROMPTS_CONTRACT.md)** | Prompt templates, AI mode configs, skill definitions | Before creating/modifying AI prompts or modes |
| **[TESTS_CONTRACT.md](./TESTS_CONTRACT.md)** | Test suites, fixtures, helpers, and testing patterns | Before writing tests or creating test fixtures |

---

## Quick Reference

**Before you code, ask yourself:**

- 📋 "Does this feature already exist?" → Check `FEATURES_CONTRACT.md`
- 🔌 "Does this API endpoint already exist?" → Check `API_CONTRACT.md`
- 🗄️ "Does this database table already exist?" → Check `DATABASE_SCHEMA_CONTRACT.md`
- 📝 "Does this SQL query already exist?" → Check `SQL_CONTRACT.json`
- 🌐 "Is this service already integrated?" → Check `THIRD_PARTY_INTEGRATIONS.md`
- ⚙️ "Does this env variable already exist?" → Check `INFRA_CONTRACT.md`
- 📨 "Does this event already exist?" → Check `EVENTS_CONTRACT.md`
- 🎨 "Does this design token exist?" → Check `CSS_DESIGN_TOKENS_CONTRACT.md`
- 🤖 "Does this prompt template exist?" → Check `PROMPTS_CONTRACT.md`
- 🧪 "Does this test fixture exist?" → Check `TESTS_CONTRACT.md`

**If YES → REUSE IT**  
**If NO → CREATE IT and DOCUMENT IT**

---

## Detailed Usage Examples

### Example 1: Adding a New API Endpoint

**Scenario:** You need to add an endpoint to retrieve DevOps Agent execution logs.

**Step 1: Check API_CONTRACT.md**

```bash
# Search for existing log-related endpoints
grep -i "log" House_Rules_Contracts/API_CONTRACT.md
```

**Step 2: Analyze Results**

If you find:
```markdown
#### `GET /api/v1/logs`
**Description:** Retrieves system logs
```

**Decision:** REUSE this endpoint. Don't create a duplicate.

**Step 3: Update "Used By" Section**

```markdown
**Used By:**
- `monitoring-service` - System monitoring
- `devops-agent` - Agent execution logs  ← ADD THIS
```

**Step 4: If No Existing Endpoint, CREATE and DOCUMENT**

```markdown
#### `GET /api/v1/devops/executions/{id}/logs`

**Description:** Retrieves execution logs for a specific DevOps Agent run

**Authentication Required:** YES  
**Required Roles:** `admin`, `devops`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | YES | Execution ID |

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | NO | Log level filter (info, warn, error) |
| `limit` | integer | NO | Number of logs to return (default: 100) |

**Response (200 OK):**
\```json
{
  "success": true,
  "data": {
    "execution_id": "exec_123",
    "logs": [
      {
        "timestamp": "2024-12-16T10:30:00Z",
        "level": "info",
        "message": "Contract generation started",
        "metadata": {}
      }
    ]
  }
}
\```

**Implementation:**
- Controller: `src/api/controllers/DevOpsController.js::getExecutionLogs()`
- Service: `src/services/DevOpsService.js::getExecutionLogs()`
- SQL Query: `get_execution_logs` (from SQL_CONTRACT.json)

**Used By:**
- `devops-dashboard` - Displays execution logs
```

---

### Example 2: Adding a New Database Table

**Scenario:** You need to store DevOps Agent execution history.

**Step 1: Check DATABASE_SCHEMA_CONTRACT.md**

```bash
# Search for existing execution-related tables
grep -i "execution" House_Rules_Contracts/DATABASE_SCHEMA_CONTRACT.md
```

**Step 2: Analyze Results**

If you find:
```markdown
### Table: agent_executions
**Purpose:** Stores agent execution history
```

**Decision:** REUSE this table. Check if it has the columns you need.

**Step 3: If Missing Columns, Document the Change**

```markdown
### Table: agent_executions

**Last Modified:** 2024-12-16  
**Version:** 1.1.0

#### Schema Definition

\```sql
CREATE TABLE agent_executions (
    id SERIAL PRIMARY KEY,
    agent_type VARCHAR(50) NOT NULL,
    execution_id VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    logs_path TEXT,  -- ← NEW COLUMN ADDED
    error_message TEXT,
    metadata JSONB
);
\```

**Changelog:**
- **2024-12-16 v1.1.0:** Added `logs_path` column to store log file location
- **2024-12-02 v1.0.0:** Initial table creation
```

**Step 4: If No Existing Table, CREATE and DOCUMENT**

```markdown
### Table: devops_contract_scans

**Created:** 2024-12-16  
**Last Modified:** 2024-12-16  
**Version:** 1.0.0  
**Purpose:** Stores results of contract generation scans

#### Schema Definition

\```sql
CREATE TABLE devops_contract_scans (
    id SERIAL PRIMARY KEY,
    execution_id VARCHAR(100) NOT NULL,
    repository VARCHAR(255) NOT NULL,
    scan_type VARCHAR(50) NOT NULL,
    features_found INTEGER DEFAULT 0,
    apis_found INTEGER DEFAULT 0,
    tables_found INTEGER DEFAULT 0,
    queries_found INTEGER DEFAULT 0,
    integrations_found INTEGER DEFAULT 0,
    env_vars_found INTEGER DEFAULT 0,
    scan_results JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES agent_executions(execution_id)
);
\```

**Used By (Modules):**
- `devops-agent` - Stores scan results
- `contract-automation` - Retrieves historical scans

**Indexes:**
- `idx_execution_id` on `execution_id`
- `idx_repository` on `repository`

**Relationships:**
- References `agent_executions.execution_id`
```

---

### Example 3: Adding a Reusable SQL Query

**Scenario:** You need to query execution logs by status.

**Step 1: Check SQL_CONTRACT.json**

```bash
# Search for existing execution queries
cat House_Rules_Contracts/SQL_CONTRACT.json | jq '.queries | keys[]' | grep -i execution
```

**Step 2: Analyze Results**

If you find:
```json
"get_execution_by_id": {
  "sql": "SELECT * FROM agent_executions WHERE execution_id = $1"
}
```

**Decision:** Check if you can reuse or extend this query.

**Step 3: If You Need a Different Query, CREATE and DOCUMENT**

Add to `SQL_CONTRACT.json`:

```json
{
  "queries": {
    "get_executions_by_status": {
      "id": "get_executions_by_status",
      "name": "Get Executions By Status",
      "description": "Retrieves all agent executions filtered by status",
      "sql": "SELECT id, agent_type, execution_id, status, started_at, completed_at FROM agent_executions WHERE status = $1 ORDER BY started_at DESC LIMIT $2",
      "operation_type": "SELECT",
      "parameters": [
        {
          "name": "status",
          "type": "string",
          "required": true,
          "description": "Execution status (pending, running, completed, failed)",
          "example": "completed"
        },
        {
          "name": "limit",
          "type": "integer",
          "required": true,
          "description": "Maximum number of results",
          "example": 50
        }
      ],
      "returns": {
        "type": "array",
        "description": "Array of execution records"
      },
      "used_by_modules": [
        {
          "module": "devops-service",
          "file": "src/services/DevOpsService.js",
          "function": "getExecutionsByStatus",
          "usage": "Retrieves completed executions for dashboard"
        }
      ],
      "performance_notes": "Indexed on status column for fast filtering",
      "created": "2024-12-16",
      "version": "1.0.0"
    }
  }
}
```

**Step 4: Use the Query in Your Code**

```javascript
// src/services/DevOpsService.js
const SQL_QUERIES = require('../contracts/SQL_CONTRACT.json').queries;

async function getExecutionsByStatus(status, limit = 50) {
  const query = SQL_QUERIES.get_executions_by_status;
  const result = await db.query(query.sql, [status, limit]);
  return result.rows;
}
```

---

### Example 4: Adding a Third-Party Integration

**Scenario:** You need to integrate Slack for DevOps notifications.

**Step 1: Check THIRD_PARTY_INTEGRATIONS.md**

```bash
# Search for existing Slack integration
grep -i "slack" House_Rules_Contracts/THIRD_PARTY_INTEGRATIONS.md
```

**Step 2: Analyze Results**

If you find:
```markdown
### Slack (Team Communication)
**Status:** Active
```

**Decision:** REUSE the existing integration. Check the binding module location.

**Step 3: Update "Used By" Section**

```markdown
**Used By Modules:**
| Module | File | Usage |
|--------|------|-------|
| notification-service | `src/services/NotificationService.js` | Sends alerts |
| devops-agent | `src/integrations/slack/DevOpsNotifier.js` | Execution status updates ← ADD THIS |
```

**Step 4: If No Existing Integration, CREATE and DOCUMENT**

```markdown
### Groq (LLM API)

**Purpose:** AI-powered code analysis and contract generation

**Status:** Active  
**Added:** 2024-12-16  
**Version:** 1.0.0

**Authentication:**
- Method: API Key
- Key Location: `GROQ_API_KEY` (see INFRA_CONTRACT.md)
- Documentation: https://console.groq.com/docs

**Binding Module:**
- Location: `src/integrations/groq/`
- Main File: `src/integrations/groq/GroqClient.js`
- Initialization: `new GroqClient(process.env.GROQ_API_KEY)`

**API Endpoints Used:**
| Endpoint | Purpose | Rate Limit |
|----------|---------|------------|
| `POST /v1/chat/completions` | LLM inference | 30 req/min |

**Used By Modules:**
| Module | File | Usage |
|--------|------|-------|
| contract-automation | `scripts/contract-automation/analyze-with-llm.js` | Contract analysis |
| devops-agent | `src/services/ContractAnalyzer.js` | Code documentation |

**Error Handling:**
- Rate limit exceeded: Exponential backoff with max 3 retries
- API errors: Log and fallback to local scanning
- Timeout: 30 seconds per request

**Cost Optimization:**
- Use `llama-3.1-70b-versatile` for complex analysis
- Use `llama-3.1-8b-instant` for simple validation
- Cache results to avoid redundant calls

**Dependencies:**
- npm package: `openai` (OpenAI-compatible client)
- Version: `^4.0.0`

**Example Usage:**
\```javascript
const GroqClient = require('./integrations/groq/GroqClient');

const client = new GroqClient(process.env.GROQ_API_KEY);
const result = await client.analyzeCode(codeSnippet, 'llama-3.1-70b-versatile');
\```
```

---

### Example 5: Adding a New Feature

**Scenario:** You need to add automated contract compliance checking.

**Step 1: Check FEATURES_CONTRACT.md**

```bash
# Search for existing contract-related features
grep -i "contract" House_Rules_Contracts/FEATURES_CONTRACT.md
```

**Step 2: Analyze Results**

If you find:
```markdown
**Feature ID:** [F-001] - Contract Generation
**Status:** Active
```

**Decision:** Check if compliance checking is part of this feature or needs to be separate.

**Step 3: If It's a New Feature, CREATE and DOCUMENT**

```markdown
## Feature Overview

### Feature ID: [F-003] - Contract Compliance Checking

**Feature Name:** Automated Contract Compliance Checking  
**Status:** Active  
**Priority:** High  
**Owner Module:** `contract-automation`  
**Completion:** 100%  
**Created:** 2024-12-16  
**Last Updated:** 2024-12-16  
**Version:** 1.0.0

**Description:**

This feature provides automated validation to ensure that the codebase remains in sync with the contract files. It scans the entire repository to detect discrepancies such as features in code but missing from contracts, API endpoints not documented, database tables not tracked, SQL queries not registered, third-party services not documented, and environment variables not cataloged.

**User Story:**

As a DevOps Agent, I want to automatically check if contracts are up-to-date so that I can alert developers when code changes are not properly documented in the contract system.

**Acceptance Criteria:**

1. The system can scan the codebase and extract all features, APIs, database tables, SQL queries, third-party integrations, and environment variables.
2. The system can compare discovered items against the contract files and identify missing or extra items.
3. The system generates a detailed report showing all discrepancies with specific file locations.
4. The system supports both text and JSON output formats for integration with CI/CD pipelines.
5. The system can run in strict mode and exit with an error code if discrepancies are found.
6. The compliance check can be executed via command line with configurable options.

**Dependencies:**

- **Features:** [F-001] - Contract Generation (must exist first)
- **APIs:** None (command-line tool)
- **Database:** `devops_contract_scans` table (for storing compliance results)
- **SQL Queries:** None (uses direct file system scanning)
- **Third-party Services:** None
- **Environment Variables:** None

**Related Contracts:**

- `scripts/contract-automation/check-compliance.js` - Implementation
- `DEVOPS_AGENT_INSTRUCTIONS.md` - Usage instructions

**API Endpoints:**

None (command-line tool)

**Technical Implementation:**

- **Location:** `scripts/contract-automation/check-compliance.js`
- **Technology:** Node.js
- **Execution:** `node scripts/contract-automation/check-compliance.js [--strict] [--report=json]`

**Usage Example:**

\```bash
# Run compliance check
node scripts/contract-automation/check-compliance.js

# Run in strict mode (exit with error if issues found)
node scripts/contract-automation/check-compliance.js --strict

# Generate JSON report
node scripts/contract-automation/check-compliance.js --report=json > compliance-report.json
\```

**Changelog:**

- **2024-12-16 v1.0.0:** Initial implementation with full scanning capabilities
```

---

### Example 6: Adding Environment Variables

**Scenario:** You need to add a Groq API key for LLM integration.

**Step 1: Check INFRA_CONTRACT.md**

```bash
# Search for existing API key variables
grep -i "api_key" House_Rules_Contracts/INFRA_CONTRACT.md
```

**Step 2: Analyze Results**

If you find similar variables like `OPENAI_API_KEY`, use the same naming pattern.

**Step 3: CREATE and DOCUMENT**

Add to `INFRA_CONTRACT.md`:

```markdown
### LLM Integration

| Variable | Type | Required | Default | Description | Example |
|----------|------|----------|---------|-------------|---------|
| `GROQ_API_KEY` | string | YES | - | Groq API key for LLM-powered contract analysis | `gsk_abc123...` |
| `GROQ_MODEL` | string | NO | `llama-3.1-70b-versatile` | Default Groq model to use | `llama-3.1-8b-instant` |
| `GROQ_TIMEOUT` | integer | NO | `30000` | Request timeout in milliseconds | `60000` |

**Used By:**
- `scripts/contract-automation/analyze-with-llm.js` - Contract analysis
- `src/services/ContractAnalyzer.js` - Code documentation

**Setup Instructions:**

1. Sign up at https://console.groq.com
2. Generate an API key
3. Add to `.env` file:
   \```
   GROQ_API_KEY=your_key_here
   GROQ_MODEL=llama-3.1-70b-versatile
   \```
4. Never commit `.env` to version control
```

---

## Workflow: Making a Change

### Step-by-Step Process

**1. Understand the Change Request**

- What is the goal?
- Which contracts are affected?
- What type of change is it? (Feature, API, Database, etc.)

**2. Consult the Contracts**

- Navigate to `House_Rules_Contracts/`
- Read the relevant contract files
- Search for existing implementations

**3. Analyze and Decide**

- **If component exists:** REUSE it, update "Used By" section
- **If component doesn't exist:** CREATE it, document immediately

**4. Implement the Change**

- Write the code following project standards
- Use components as defined in contracts
- Ensure proper error handling

**5. Update the Contracts**

- Add changelog entry with date
- Increment version number
- Document impact (breaking/non-breaking)
- Add cross-references

**6. Commit with Proper Format**

```
feat(scope): Brief description

Contracts: [SQL:T, API:T, DB:F, 3RD:F, FEAT:T, INFRA:F]

[WHY] Explanation of motivation

[WHAT]
- File(s): path/to/file.js - Description
- File(s): House_Rules_Contracts/API_CONTRACT.md - Updated
```

---

## Contract Validation

### Pre-Commit Validation

Before committing, run:

```bash
node scripts/contract-automation/validate-commit.js --check-staged --auto-fix
```

This validates that your contract flags match actual file changes.

### Periodic Compliance Check

Run weekly or after major changes:

```bash
node scripts/contract-automation/check-compliance.js --strict
```

This ensures contracts stay in sync with the codebase.

---

## Benefits

### For the Project

The contract system provides automated contract generation, commit validation that catches mistakes before they're pushed, compliance checking that prevents drift between code and contracts, LLM enhancement for rich documentation automatically generated, and CI/CD integration for automated validation on pull requests.

### For Agents

Agents receive clear guidance through scripts that tell them what to do, automated checks that eliminate manual validation, auto-fix capabilities that correct mistakes automatically, and fast feedback that immediately indicates when something is wrong.

### For Users

Users benefit from higher quality as contracts stay in sync with code, faster development through automation that saves time, better coordination as multiple agents work without conflicts, and visibility that ensures they always know what's in the codebase.

---

## Status

| Contract | Status | Completion | Last Updated |
|----------|--------|------------|--------------|
| DATABASE_SCHEMA_CONTRACT.md | Template | 0% | 2024-12-16 |
| SQL_CONTRACT.json | Template | 0% | 2024-12-16 |
| API_CONTRACT.md | Template | 0% | 2024-12-16 |
| THIRD_PARTY_INTEGRATIONS.md | Template | 0% | 2024-12-16 |
| FEATURES_CONTRACT.md | Template | 0% | 2024-12-16 |
| INFRA_CONTRACT.md | Template | 0% | 2024-12-16 |
| EVENTS_CONTRACT.md | Template | 0% | 2026-02-19 |
| CSS_DESIGN_TOKENS_CONTRACT.md | Template | 0% | 2026-02-19 |
| PROMPTS_CONTRACT.md | Template | 0% | 2026-02-19 |
| TESTS_CONTRACT.md | Template | 0% | 2026-02-19 |

**Next Steps:**

1. DevOps Agent executes contract generation (see `DEVOPS_AGENT_INSTRUCTIONS.md`)
2. Review and validate generated contracts
3. Fill in missing information
4. Begin using contracts for all development

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2024-12-16 | 1.0.0 | Initial contract system creation with comprehensive examples |

---

*These contracts are living documents. Update them with every change.*
