# Folder Structure

This document outlines the standard folder structure for this project.
All files **MUST** be placed in their respective folders as described below.
You may create new module and feature subfolders following the established patterns,
but **MUST** update this document when doing so.

## Project Layout
```
├── houserules.md                  # Team coding rules and conventions
├── FOLDER_STRUCTURE.md            # This file — folder layout reference
├── House_Rules_Contracts/         # Contract documentation
│   ├── API_CONTRACT.md            # API endpoints and interfaces
│   ├── DATABASE_SCHEMA_CONTRACT.md # Database schema definitions
│   ├── EVENTS_CONTRACT.md         # Event system documentation
│   ├── FEATURES_CONTRACT.md       # Feature specifications
│   ├── INFRA_CONTRACT.md          # Infrastructure documentation
│   ├── THIRD_PARTY_INTEGRATIONS.md # External service integrations
│   ├── ADMIN_CONTRACT.md          # Admin panel contracts
│   ├── SQL_CONTRACT.md            # SQL queries and migrations
│   ├── CSS_CONTRACT.md            # Styling conventions
│   ├── PROMPTS_CONTRACT.md        # AI prompt templates
│   ├── E2E_TESTS_CONTRACT.md      # End-to-end test contracts
│   ├── UNIT_TESTS_CONTRACT.md     # Unit test contracts
│   ├── INTEGRATION_TESTS_CONTRACT.md # Integration test contracts
│   └── FIXTURES_CONTRACT.md       # Test fixtures contracts
├── .S9N_KIT_DevOpsAgent/          # DevOps agent runtime data (gitignored)
│   ├── agents/                    # Agent registration files
│   ├── sessions/                  # Session status files
│   ├── activity/                  # Activity logs
│   ├── commands/                  # Kanvas → Agent commands
│   ├── heartbeats/                # Agent heartbeat files
│   ├── coordination/              # File locking/coordination
│   │   ├── active-edits/
│   │   └── completed-edits/
│   └── config.json                # Repo-specific config
├── .mcp.json                      # MCP server config (auto-generated)
└── .agent-config                  # Agent session config (auto-generated)
```

## Rules
- Do not create new top-level directories without updating this file
- Follow existing module/feature sub-folder patterns
- Keep runtime/generated files gitignored

---
*This file was auto-generated. Feel free to customize it for your project.*
