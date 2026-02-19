# Tests Contract

**Last Updated:** 2026-02-19
**Version:** 1.0.0
**Status:** Initial Template

---

## Purpose

This contract documents **all test suites, test patterns, fixtures, and testing conventions** in the project. Coding agents **MUST check this file before writing tests** to:
- Reuse existing test fixtures and helpers instead of duplicating
- Follow established testing patterns and conventions
- Avoid redundant test coverage
- Maintain consistent test structure across the codebase
- Ensure proper test isolation and cleanup

This contract covers four test categories:
- **Unit tests** (`unit`) — isolated service/function tests
- **Integration tests** (`integration`) — cross-service interaction tests
- **E2E tests** (`e2e`) — full workflow/scenario tests
- **Test fixtures** (`fixtures`) — shared mock data and test helpers

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2026-02-19 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |

---

## Testing Stack

| Property | Value | Notes |
|----------|-------|-------|
| **Test Runner** | Jest | Via `ts-jest` for TypeScript |
| **Assertion Library** | Jest (built-in) | `expect()` API |
| **DOM Testing** | `@testing-library/react` | For React component tests |
| **Mock Framework** | Jest mocks | `jest.fn()`, `jest.mock()` |
| **Coverage Tool** | Jest coverage | `--coverage` flag |
| **E2E Framework** | [TBD] | [Playwright/Cypress if needed] |

---

## Test Directory Structure

```
tests/
├── kanvas/                    # Kanvas-specific tests
│   ├── setup.ts               # Test environment setup (mock API, Electron mocks)
│   ├── unit/                  # Unit tests for individual services
│   │   ├── WorkerBridgeService.test.ts
│   │   ├── [ServiceName].test.ts
│   │   └── ...
│   ├── integration/           # Integration tests (multi-service)
│   │   └── ...
│   └── e2e/                   # End-to-end workflow tests
│       └── ...
├── fixtures/                  # Shared test data and factories
│   └── ...
└── helpers/                   # Shared test utilities
    └── ...
```

---

## Test Configuration

### Jest Config

**File:** `jest.config.ts` (or `package.json` → `jest`)

**Key settings:**
- `setupFilesAfterFramework`: `['tests/kanvas/setup.ts']`
- `testMatch`: `['**/tests/**/*.test.ts']`
- `transform`: ts-jest for `.ts`/`.tsx` files
- `moduleNameMapper`: path aliases matching `tsconfig.json`

### Test Setup File

**File:** `tests/kanvas/setup.ts`

This file provides:
- `mockApi` — full mock of `window.api` (Electron preload bridge)
- `mockIpcRenderer` — mock of Electron's `ipcRenderer`
- `@testing-library/jest-dom` matchers
- Auto `jest.clearAllMocks()` in `beforeEach`

**Exported mocks:**
```typescript
export { mockApi, mockIpcRenderer };
```

---

## Unit Tests

### Purpose
Test individual services, functions, and utilities in isolation. Each unit test file should test one module.

### Naming Convention

| Element | Convention | Example |
|---------|-----------|---------|
| Test file | `[ModuleName].test.ts` | `WorkerBridgeService.test.ts` |
| Describe block | `'[ModuleName] - [Aspect]'` | `'WorkerBridgeService - Worker Status via IPC'` |
| Test case | `'should [expected behavior]'` | `'should return worker status with expected fields'` |

### Unit Test Template

```typescript
/**
 * Unit Tests for [ServiceName]
 * Tests [what aspect] via [testing approach]
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockApi } from '../setup';

describe('[ServiceName] - [Aspect]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should [expected behavior]', () => {
    // Arrange
    const input = { /* test data */ };

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toEqual(expectedOutput);
  });

  it('should handle [edge case]', () => {
    // ...
  });
});
```

### Unit Test Registry

| Test File | Module Under Test | Test Count | Coverage |
|-----------|-------------------|------------|----------|
| `WorkerBridgeService.test.ts` | WorkerBridgeService | 7 | [X]% |
| [Add rows as tests are created] | | | |

---

## Integration Tests

### Purpose
Test interactions between multiple services, verifying that they work together correctly. Focus on service boundaries and data flow.

### Naming Convention

| Element | Convention | Example |
|---------|-----------|---------|
| Test file | `[Feature].integration.test.ts` | `ContractGeneration.integration.test.ts` |
| Describe block | `'[Feature] Integration'` | `'Contract Generation Integration'` |

### Integration Test Template

```typescript
/**
 * Integration Tests for [Feature]
 * Tests interaction between [ServiceA] and [ServiceB]
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('[Feature] Integration', () => {
  let serviceA: ServiceA;
  let serviceB: ServiceB;

  beforeEach(async () => {
    // Set up real services with controlled dependencies
    serviceA = new ServiceA();
    serviceB = new ServiceB(serviceA);
    await serviceB.initialize();
  });

  afterEach(async () => {
    // Clean up
    await serviceB.dispose();
  });

  it('should [describe cross-service behavior]', async () => {
    // Trigger action on Service A
    await serviceA.doSomething();

    // Verify effect on Service B
    expect(serviceB.state).toEqual(expectedState);
  });
});
```

### Integration Test Registry

| Test File | Services Tested | Test Count | Status |
|-----------|----------------|------------|--------|
| [Add rows as tests are created] | | | |

---

## E2E Tests

### Purpose
Test complete user workflows from end to end, simulating real user interactions with the application.

### Naming Convention

| Element | Convention | Example |
|---------|-----------|---------|
| Test file | `[Workflow].e2e.test.ts` | `SessionLifecycle.e2e.test.ts` |
| Describe block | `'E2E: [Workflow Name]'` | `'E2E: Session Lifecycle'` |

### E2E Test Template

```typescript
/**
 * E2E Tests for [Workflow]
 * Simulates: [User journey description]
 */

describe('E2E: [Workflow Name]', () => {
  it('should complete [workflow] successfully', async () => {
    // Step 1: [Action]
    // Step 2: [Action]
    // Step 3: [Verification]
  });

  it('should handle [failure scenario] gracefully', async () => {
    // ...
  });
});
```

### E2E Test Registry

| Test File | Workflow | Steps | Status |
|-----------|---------|-------|--------|
| [Add rows as tests are created] | | | |

---

## Test Fixtures

### Purpose
Provide reusable mock data, factory functions, and test helpers that multiple test files can share. Prevents duplication of test setup code.

### Fixture Categories

#### Mock Data

| Fixture | File | Description | Used By |
|---------|------|-------------|---------|
| `mockSession` | `fixtures/session.ts` | Sample session object | Session tests |
| `mockAgent` | `fixtures/agent.ts` | Sample agent config | Agent tests |
| `mockCommit` | `fixtures/git.ts` | Sample commit data | Git/Watcher tests |
| [Add rows as fixtures are created] | | | |

#### Factory Functions

| Factory | File | Description | Parameters |
|---------|------|-------------|------------|
| `createMockSession()` | `fixtures/session.ts` | Creates session with overrides | `Partial<Session>` |
| `createMockAgent()` | `fixtures/agent.ts` | Creates agent with overrides | `Partial<Agent>` |
| [Add rows as factories are created] | | | |

#### Test Helpers

| Helper | File | Description |
|--------|------|-------------|
| `waitFor(condition)` | `helpers/async.ts` | Polls until condition is true |
| `mockMainWindow()` | `helpers/electron.ts` | Creates mock BrowserWindow |
| [Add rows as helpers are created] | | | |

### Fixture Template

```typescript
/**
 * Test Fixtures for [Domain]
 * Provides reusable mock data and factory functions
 */

// Static mock data
export const mockEntity = {
  id: 'test-id-001',
  name: 'Test Entity',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

// Factory function with overrides
export function createMockEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    ...mockEntity,
    id: `test-id-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}
```

---

## Testing Patterns

### Mock Pattern: IPC Mock API

Tests use the `mockApi` from `tests/kanvas/setup.ts` to mock Electron IPC:

```typescript
import { mockApi } from '../setup';

// Mock resolves with custom value
(mockApi.service.method as jest.Mock).mockResolvedValueOnce({ custom: 'data' });

// Verify the mock was called
expect(mockApi.service.method).toHaveBeenCalledWith(expectedArgs);
```

### Mock Pattern: Service Dependencies

```typescript
// Create mock of dependency
const mockGitService = {
  getStatus: jest.fn().mockResolvedValue({ files: [] }),
  getLog: jest.fn().mockResolvedValue({ commits: [] }),
};

// Inject into service under test
const watcher = new WatcherService(mockGitService as unknown as GitService);
```

### Async Testing Pattern

```typescript
it('should handle async operations', async () => {
  // Use async/await with expect
  const result = await service.asyncMethod();
  expect(result.success).toBe(true);

  // Or use expect with resolves/rejects
  await expect(service.asyncMethod()).resolves.toEqual({ success: true });
  await expect(service.failingMethod()).rejects.toThrow('Expected error');
});
```

### Cleanup Pattern

```typescript
describe('Service with resources', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService();
  });

  afterEach(async () => {
    // Always clean up watchers, intervals, connections
    await service.dispose();
  });
});
```

---

## Coverage Requirements

### Targets

| Test Type | Minimum Coverage | Ideal Coverage |
|-----------|-----------------|----------------|
| Unit tests | 70% per service | 90%+ |
| Integration tests | Key workflows | All service boundaries |
| E2E tests | Critical paths | Happy path + error paths |

### Running Tests

```bash
# Run all Kanvas tests
npm run test:kanvas

# Run with coverage
npm run test:kanvas -- --coverage

# Run specific test file
npx jest tests/kanvas/unit/WorkerBridgeService.test.ts

# Run tests matching pattern
npx jest --testPathPattern="unit" --verbose
```

---

## Notes for Coding Agents

### CRITICAL RULES:

1. **ALWAYS check this contract before writing tests**
2. **SEARCH for existing fixtures** — don't recreate mock data that exists
3. **REUSE test helpers** — shared utilities prevent duplication
4. **FOLLOW naming conventions** — consistent naming enables discovery
5. **ISOLATE tests** — each test must work independently (no order dependency)
6. **CLEAN UP resources** — dispose watchers, timers, connections in `afterEach`
7. **UPDATE this contract** after creating new test files or fixtures
8. **CROSS-REFERENCE:**
   - `tests/kanvas/setup.ts` for available mocks
   - `FEATURES_CONTRACT.md` for features requiring tests
   - `API_CONTRACT.md` for endpoint test requirements

### Workflow:

```
BEFORE writing tests:

1. Read TESTS_CONTRACT.md
2. Check existing fixtures for reusable mock data
3. Check test helpers for reusable utilities
4. If fixture/helper exists → import and reuse
5. If writing new tests:
   - Follow the naming convention
   - Use the appropriate template (unit/integration/e2e)
   - Add cleanup in afterEach
   - Register in the test registry table
   - Update this contract
6. Run full test suite to verify no regressions
```

### Common Mistakes to Avoid:

- Duplicating mock data that already exists in fixtures
- Not cleaning up timers/watchers (causes test leaks)
- Tests depending on execution order
- Using `setTimeout` in tests (use `jest.useFakeTimers()` or `waitFor`)
- Hardcoding file paths (use `path.join` with `__dirname`)
- Not resetting mocks between tests

---

## Initial Population Instructions

**For DevOps Agent / Coding Agents:**

1. **Inventory existing test files:**
   - Glob for `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`
   - Document each file in the appropriate registry table

2. **Identify shared fixtures:**
   - Search for repeated mock objects across test files
   - Extract to shared fixture files
   - Document in the fixtures table

3. **Identify shared helpers:**
   - Search for repeated test utility functions
   - Extract to shared helper files
   - Document in the helpers table

4. **Check coverage:**
   - Run `npm run test:kanvas -- --coverage`
   - Document current coverage per module

5. **Identify test gaps:**
   - Cross-reference with FEATURES_CONTRACT.md
   - List features without test coverage

**Search Patterns:**
- Test files: `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`
- Setup files: `**/setup.ts`, `**/setupTests.ts`
- Fixture files: `**/fixtures/**`, `**/mocks/**`
- Helper files: `**/helpers/**`, `**/utils/**` (in test directories)

---

*This contract is a living document. Update it with every test addition or change.*
