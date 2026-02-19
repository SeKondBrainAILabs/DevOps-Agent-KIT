# Events Contract

**Last Updated:** 2026-02-19
**Version:** 1.0.0
**Status:** Initial Template

---

## Purpose

This contract documents **all events, messages, and pub-sub patterns** in the project. Coding agents **MUST check this file before creating new events** to:
- Reuse existing event definitions
- Maintain consistent event naming and structure
- Avoid duplicate or conflicting event types
- Ensure backward compatibility of event payloads
- Track event producers and consumers

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2026-02-19 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |

---

## Event System Overview

### Architecture

| Property | Value | Notes |
|----------|-------|-------|
| **Pattern** | Event Bus / Pub-Sub | Loosely coupled communication |
| **Transport** | IPC / MessagePort / File-based | Depends on process boundary |
| **Serialization** | JSON | Structured message payloads |
| **Delivery** | At-least-once | Consumers must be idempotent |
| **Ordering** | Per-producer ordering | No global ordering guarantee |

### Event Categories

| Category | Prefix | Description |
|----------|--------|-------------|
| File System | `file:*` | File change, create, delete events |
| Git | `git:*` | Commit, branch, merge events |
| Agent | `agent:*` | Agent lifecycle, status, command events |
| Session | `session:*` | Session create, update, destroy events |
| Contract | `contract:*` | Contract detection, generation events |
| Heartbeat | `heartbeat:*` | Health check and liveness events |
| UI | `ui:*` | User interaction and navigation events |
| System | `system:*` | App lifecycle, error, recovery events |
| Analytics | `analytics:*` | Product analytics, feature usage, user behavior events |

---

## Common Event Envelope

All events MUST include these fields:

```typescript
interface EventEnvelope {
  type: string;           // Routing key (dot or colon notation)
  timestamp: string;      // ISO-8601 UTC
  source: string;         // Producing service/process name
  sessionId?: string;     // Associated session (if applicable)
  correlationId?: string; // For tracing related events
}
```

---

## Events

### Event Template

#### `[category]:[action]`

**Added:** [YYYY-MM-DD]
**Last Modified:** [YYYY-MM-DD]
**Status:** `active` | `deprecated` | `beta`

**Description:**
[What this event signals and when it fires]

**Producer(s):**
- `[ServiceName]` — [when/why it emits this event]

**Consumer(s):**
- `[ServiceName]` — [what it does when receiving this event]

**Payload Schema:**

```typescript
{
  type: '[category]:[action]';
  // event-specific fields
  field1: string;  // Description
  field2: number;  // Description
}
```

**Example Payload:**

```json
{
  "type": "file:changed",
  "timestamp": "2026-02-19T10:00:00Z",
  "source": "WorkerBridge",
  "sessionId": "session-123",
  "field1": "value",
  "field2": 42
}
```

**Implementation Details:**
- **Emitter file:** `electron/services/[Service].ts`
- **Handler file:** `electron/services/[Service].ts`
- **IPC Channel:** `[channel-name]` (if renderer-bound)

**Error Handling:**
- [How failures are handled]
- [Retry strategy if applicable]

---

## Example Events

<!-- ======================================================================= -->
<!-- NOTE: The following are EXAMPLES. Replace with actual project events.    -->
<!-- ======================================================================= -->

### File System Events

#### `file:changed`

**Added:** 2026-02-19
**Status:** `active`

**Description:**
Fires when a monitored file in a worktree is created, modified, or deleted.

**Producer(s):**
- `FileMonitor` (utility process) — chokidar watcher detects filesystem change

**Consumer(s):**
- `WatcherService` — triggers commit pipeline, updates activity log
- `ContractDetectionService` — checks if changed file affects contracts

**Payload:**

```typescript
{
  type: 'file-changed';
  sessionId: string;
  filePath: string;
  changeType: 'add' | 'change' | 'unlink';
}
```

---

#### `heartbeat:update`

**Added:** 2026-02-19
**Status:** `active`

**Description:**
Fires when an agent heartbeat file is updated, indicating the agent is alive.

**Producer(s):**
- `HeartbeatMonitor` (utility process) — watches heartbeat JSON files

**Consumer(s):**
- `HeartbeatService` — updates agent connection status, resets timeout timer

**Payload:**

```typescript
{
  type: 'heartbeat-update';
  sessionId: string;
  data: {
    timestamp: number;
    agentPid?: number;
    status?: string;
  };
}
```

---

#### `heartbeat:timeout`

**Added:** 2026-02-19
**Status:** `active`

**Description:**
Fires when an agent heartbeat has not been received within the timeout window (default 5 minutes).

**Producer(s):**
- `HeartbeatMonitor` (utility process) — timeout interval check

**Consumer(s):**
- `HeartbeatService` — marks agent as disconnected, notifies renderer

**Payload:**

```typescript
{
  type: 'heartbeat-timeout';
  sessionId: string;
}
```

---

## IPC Events (Main ↔ Renderer)

### IPC Channel Registry

| Channel | Direction | Description | Payload Type |
|---------|-----------|-------------|--------------|
| `[IPC.CHANNEL]` | Main → Renderer | [Description] | [Type] |

**See Also:** `shared/ipc-channels.ts` for the full IPC channel enum.

---

## Worker Protocol Events (Main ↔ Utility Process)

### Worker → Main Events

| Event Type | Description | Payload |
|------------|-------------|---------|
| `file-changed` | File system change detected | `{ sessionId, filePath, changeType }` |
| `commit-msg-detected` | Commit message file appeared | `{ sessionId, commitMsgFilePath }` |
| `rebase-remote-status` | Remote branch comparison result | `{ sessionId, behind, ahead, remoteBranch, localBranch }` |
| `heartbeat-update` | Agent heartbeat received | `{ sessionId, data }` |
| `heartbeat-timeout` | Agent heartbeat timed out | `{ sessionId }` |
| `agent-file-event` | Agent directory change | `{ subtype, action, filePath }` |
| `pong` | Health check response | `{}` |
| `error` | Worker error | `{ source, message }` |
| `ready` | Worker process initialized | `{ pid }` |

### Main → Worker Commands

| Command Type | Description | Payload |
|--------------|-------------|---------|
| `start-file-monitor` | Begin watching worktree | `{ sessionId, worktreePath, ... }` |
| `stop-file-monitor` | Stop watching worktree | `{ sessionId }` |
| `start-rebase-monitor` | Begin remote polling | `{ sessionId, repoPath, ... }` |
| `stop-rebase-monitor` | Stop remote polling | `{ sessionId }` |
| `start-heartbeat-monitor` | Begin heartbeat watch | `{ sessionId, heartbeatPath }` |
| `stop-heartbeat-monitor` | Stop heartbeat watch | `{ sessionId }` |
| `start-agent-monitor` | Begin agent dir watch | `{ kanvasDir }` |
| `stop-agent-monitor` | Stop agent dir watch | `{ kanvasDir }` |
| `start-kanvas-heartbeat` | Begin writing Kanvas heartbeat | `{ kanvasDir, ... }` |
| `stop-kanvas-heartbeat` | Stop writing Kanvas heartbeat | `{ kanvasDir }` |
| `ping` | Health check | `{}` |

**See Also:** `electron/worker/worker-protocol.ts` for full TypeScript definitions.

---

## Analytics Events (Feature-Produced)

Analytics events track **user behavior, feature usage, and product metrics**. Every feature SHOULD emit analytics events to measure adoption, engagement, and conversion. These events are used for product dashboards, funnel analysis, and user segmentation.

### Analytics Event Envelope

All analytics events extend the common envelope with analytics-specific fields:

```typescript
interface AnalyticsEvent extends EventEnvelope {
  type: `analytics:${string}`;

  // Event properties (what happened)
  event: string;           // Human-readable event name: "Session Created", "Contract Generated"
  properties: {
    feature: string;       // Feature ID from FEATURES_CONTRACT (e.g., "session-management")
    action: string;        // Specific action: "created", "viewed", "clicked", "completed"
    category: string;      // Event category: "engagement", "conversion", "error", "performance"
    label?: string;        // Optional descriptive label
    value?: number;        // Optional numeric value (e.g., duration, count)
    metadata?: Record<string, unknown>; // Additional context
  };

  // People properties (who did it)
  people: {
    distinctId: string;    // Anonymous or identified user ID
    traits?: {
      plan?: string;       // User's plan/tier
      role?: string;       // User role in org
      orgId?: string;      // Organization ID
      appVersion?: string; // App version
      platform?: string;   // OS/platform
      sessionCount?: number; // Total sessions this user has created
      firstSeen?: string;  // ISO-8601 first interaction date
      lastSeen?: string;   // ISO-8601 most recent interaction date
    };
  };
}
```

### People Properties

People properties enable **user segmentation and cohort analysis**. They are set once and updated incrementally.

| Property | Type | Description | Updated When |
|----------|------|-------------|--------------|
| `distinctId` | string | Stable anonymous ID (per install) | First launch |
| `plan` | string | Subscription tier | Plan change |
| `role` | string | User role (developer, lead, admin) | Role change |
| `orgId` | string | Organization identifier | Org setup |
| `appVersion` | string | Current app version | App update |
| `platform` | string | OS platform (darwin, win32, linux) | First launch |
| `sessionCount` | number | Cumulative session count | Session create |
| `firstSeen` | string | First interaction timestamp | First launch |
| `lastSeen` | string | Most recent interaction | Every session |

### Feature Analytics Event Template

Each feature should define its analytics events:

#### `analytics:[feature]:[action]`

**Feature:** [Feature ID from FEATURES_CONTRACT]
**Category:** `engagement` | `conversion` | `error` | `performance`

**Description:**
[What this event measures and why it matters]

**Properties:**

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `feature` | string | YES | Feature identifier | `"session-management"` |
| `action` | string | YES | User action | `"created"` |
| `category` | string | YES | Event category | `"conversion"` |
| `value` | number | NO | Numeric metric | `1200` (ms) |

**People Properties Updated:**
- `sessionCount` → incremented by 1
- `lastSeen` → updated to current timestamp

---

### Example Analytics Events

#### `analytics:session:created`

**Feature:** Session Management
**Category:** `conversion`

**Description:**
Fires when a user creates a new agent session. Key conversion metric.

**Properties:**
```json
{
  "feature": "session-management",
  "action": "created",
  "category": "conversion",
  "metadata": {
    "repoName": "my-project",
    "baseBranch": "main",
    "agentType": "claude"
  }
}
```

**People Properties Updated:**
- `sessionCount` → +1
- `lastSeen` → now

---

#### `analytics:contract:generated`

**Feature:** Contract Generation
**Category:** `engagement`

**Description:**
Fires when a contract is generated (single or batch).

**Properties:**
```json
{
  "feature": "contract-generation",
  "action": "generated",
  "category": "engagement",
  "value": 3500,
  "metadata": {
    "contractType": "api",
    "featureCount": 5,
    "durationMs": 3500
  }
}
```

---

#### `analytics:agent:heartbeat-lost`

**Feature:** Agent Monitoring
**Category:** `error`

**Description:**
Fires when an agent's heartbeat times out, indicating potential crash or disconnect.

**Properties:**
```json
{
  "feature": "agent-monitoring",
  "action": "heartbeat-lost",
  "category": "error",
  "metadata": {
    "sessionId": "session-123",
    "lastHeartbeatAge": 310000,
    "agentType": "claude"
  }
}
```

---

### Analytics Event Registry

| Event Name | Feature | Category | Trigger | Key Metric |
|------------|---------|----------|---------|------------|
| `analytics:session:created` | Session Management | conversion | New session | Activation rate |
| `analytics:session:completed` | Session Management | conversion | Session merged | Completion rate |
| `analytics:session:abandoned` | Session Management | error | Session deleted without merge | Drop-off rate |
| `analytics:contract:generated` | Contract Generation | engagement | Contract generated | Feature adoption |
| `analytics:agent:connected` | Agent Monitoring | engagement | Agent heartbeat first seen | Agent adoption |
| `analytics:agent:heartbeat-lost` | Agent Monitoring | error | Heartbeat timeout | Reliability |
| `analytics:merge:executed` | Merge Workflow | conversion | Branch merged | Workflow completion |
| `analytics:rebase:auto-triggered` | Rebase Watcher | engagement | Auto-rebase fired | Automation usage |
| `analytics:app:launched` | System | engagement | App opened | DAU/MAU |
| `analytics:app:updated` | System | conversion | Auto-update installed | Update adoption |
| [Add rows as events are defined] | | | | |

### Funnel Definitions

#### Session Lifecycle Funnel

```
analytics:app:launched
  → analytics:session:created
    → analytics:agent:connected
      → analytics:session:completed (merge)
```

**Drop-off points to monitor:**
- Launched but no session created → Onboarding issue
- Session created but no agent connected → Agent setup issue
- Agent connected but session not completed → Workflow issue

---

## Event Design Patterns

### Naming Convention

**Format:** `[category]:[action]` or `[category].[subcategory].[action]`

**Rules:**
- Use lowercase with hyphens for multi-word actions: `file-changed`, `commit-msg-detected`
- Category is the domain: `file`, `git`, `agent`, `session`, `heartbeat`
- Action is past tense for events: `changed`, `created`, `detected`, `timeout`
- Action is imperative for commands: `start`, `stop`, `restart`, `ping`

### Versioning

- **Non-breaking** (new optional fields): Keep same event type
- **Breaking** (renamed/removed fields, semantic changes): Create new version suffix or new event type
- **Deprecation**: Mark old event as `deprecated`, add migration notes

---

## Notes for Coding Agents

### CRITICAL RULES:

1. **ALWAYS read this contract before creating new events**
2. **SEARCH for existing events** that serve the same purpose
3. **REUSE existing event types** — don't create duplicates
4. **NEVER change event payload structure** without version bump
5. **UPDATE this contract immediately** after creating/modifying events
6. **DOCUMENT all producers and consumers** for every event
7. **CROSS-REFERENCE:**
   - `worker-protocol.ts` for Worker ↔ Main events
   - `shared/ipc-channels.ts` for Main ↔ Renderer channels
   - `FEATURES_CONTRACT.md` for feature-specific events
8. **ENSURE idempotency** — consumers must handle duplicate events safely

### Workflow:

```
1. Read EVENTS_CONTRACT.md
2. Search for existing events by category and purpose
3. If exact match found → use it, add your service to consumers
4. If similar event found → consider extending payload (backward-compatible)
5. If creating new event:
   - Follow naming convention
   - Define full payload schema
   - Document producer(s) and consumer(s)
   - Add to appropriate category
   - Update this contract
6. Update changelog and version number
```

---

## Initial Population Instructions

**For DevOps Agent / Coding Agents:**

When populating this template for the first time:

1. **Scan for IPC channels:**
   - Search `shared/ipc-channels.ts` for all channel definitions
   - Search `mainWindow.webContents.send(` for renderer-bound events
   - Search `ipcMain.handle(` and `ipcMain.on(` for renderer-originating events

2. **Scan for worker protocol events:**
   - Review `electron/worker/worker-protocol.ts`
   - Document all command and event types

3. **Scan for internal service events:**
   - Search for `.emit(` and `.on(` patterns in services
   - Search for callback/hook patterns between services

4. **Scan for file-based events:**
   - Agent heartbeat files
   - Session status files
   - Activity log files

5. **Document each event:**
   - Type/name, payload schema, producer(s), consumer(s)
   - Add to appropriate category
   - Cross-reference implementation files

---

*This contract is a living document. Update it with every event change.*
