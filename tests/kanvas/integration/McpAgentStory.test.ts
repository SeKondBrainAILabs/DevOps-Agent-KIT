/**
 * MCP Agent Story Integration Tests
 *
 * End-to-end scenarios simulating how coding agents use MCP tools.
 * Uses real temp git repos to verify the full flow.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { McpSessionBinder } from '../../../electron/services/mcp/session-binder';

// ============================================================================
// Mock ALL dependencies of tools.ts to avoid heavy module resolution
// ============================================================================
function zodChain(): any {
  const c: any = {};
  ['string', 'number', 'boolean', 'array', 'object', 'enum', 'record',
    'optional', 'default', 'describe', 'unknown'].forEach(m => { c[m] = (..._a: any[]) => zodChain(); });
  c.then = undefined;
  return c;
}
jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

// Capture tool registrations
const registeredTools: Map<string, { schema: any; handler: Function }> = new Map();

const mockMcpServer = {
  tool: jest.fn((name: string, _desc: string, schema: any, handler: Function) => {
    registeredTools.set(name, { schema, handler });
  }),
  resource: jest.fn(),
};

const { registerTools } = require('../../../electron/services/mcp/tools');

// ============================================================================
// Test helpers
// ============================================================================

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  // Create initial commit
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function callTool(name: string, args: Record<string, any>) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

// ============================================================================
// Tests
// ============================================================================

describe('MCP Agent Story - Integration', () => {
  let tempDir: string;
  let binder: McpSessionBinder;
  let deps: any;
  const SESSION_ID = 'sess_integration_test_001';

  // Mocks that track calls for verification
  let commitCalls: any[] = [];
  let activityLogs: any[] = [];
  let lockDeclarations: any[] = [];
  let dbCommits: any[] = [];

  beforeAll(() => {
    tempDir = createTempGitRepo();
  });

  afterAll(() => {
    // Cleanup is handled by OS tmpdir cleanup
  });

  beforeEach(() => {
    registeredTools.clear();
    jest.clearAllMocks();
    commitCalls = [];
    activityLogs = [];
    lockDeclarations = [];
    dbCommits = [];

    binder = new McpSessionBinder();
    binder.registerSession(SESSION_ID, tempDir);

    deps = {
      gitService: {
        commit: (jest.fn() as any).mockImplementation(async (_sid: string, msg: string) => {
          const hash = Math.random().toString(36).substring(2, 14);
          commitCalls.push({ sessionId: _sid, message: msg, hash });
          return {
            success: true,
            data: { hash, shortHash: hash.substring(0, 7), filesChanged: 2 },
          };
        }),
        push: (jest.fn() as any).mockResolvedValue({ success: true }),
        getCommitHistory: (jest.fn() as any).mockImplementation(async () => ({
          success: true,
          data: commitCalls.map((c, i) => ({
            hash: c.hash,
            shortHash: c.hash.substring(0, 7),
            message: c.message,
            author: 'test',
            date: new Date(Date.now() - i * 60000).toISOString(),
            filesChanged: 2,
          })),
        })),
      },
      activityService: {
        log: jest.fn((_sid: string, type: string, msg: string, details: any) => {
          activityLogs.push({ sessionId: _sid, type, message: msg, details });
        }),
      },
      lockService: {
        checkConflicts: (jest.fn() as any).mockResolvedValue({ success: true, data: [] }),
        declareFiles: (jest.fn() as any).mockImplementation(async (_sid: string, files: string[]) => {
          lockDeclarations.push({ sessionId: _sid, files });
          return { success: true };
        }),
        releaseFiles: (jest.fn() as any).mockResolvedValue({ success: true }),
        forceReleaseLock: (jest.fn() as any).mockResolvedValue({ success: true }),
      },
      databaseService: {
        recordCommit: jest.fn((_sid: string, hash: string, msg: string, files: number) => {
          dbCommits.push({ sessionId: _sid, hash, message: msg, filesChanged: files });
        }),
        recordSessionEvent: jest.fn(),
      },
      agentInstanceService: {
        listInstances: (jest.fn() as any).mockReturnValue({
          success: true,
          data: [{
            sessionId: SESSION_ID,
            config: {
              agentType: 'claude',
              branchName: 'feat/mcp-test',
              baseBranch: 'main',
              taskDescription: 'Integration test task',
              repoPath: tempDir,
            },
            createdAt: new Date().toISOString(),
          }],
        }),
      },
    };

    registerTools(mockMcpServer as any, binder, deps);
  });

  // ==========================================================================
  // Story 1: Setup → First Commit
  // ==========================================================================
  describe('Story: Setup → First Commit', () => {
    it('should complete full setup-to-commit flow', async () => {
      // 1. Read session info
      const infoResult = await callTool('kanvas_get_session_info', {
        session_id: SESSION_ID,
      });
      const info = parseResult(infoResult);
      expect(info.sessionId).toBe(SESSION_ID);
      expect(info.worktreePath).toBe(tempDir);
      expect(info.agentType).toBe('claude');

      // 2. Lock files
      const lockResult = await callTool('kanvas_lock_file', {
        session_id: SESSION_ID,
        files: ['src/auth.ts', 'src/utils.ts'],
        reason: 'Implementing auth feature',
      });
      const lockData = parseResult(lockResult);
      expect(lockData.locked).toBe(true);
      expect(lockData.conflicts).toEqual([]);
      expect(lockDeclarations).toHaveLength(1);
      expect(lockDeclarations[0].files).toEqual(['src/auth.ts', 'src/utils.ts']);

      // 3. Commit
      const commitResult = await callTool('kanvas_commit', {
        session_id: SESSION_ID,
        message: 'feat: add user authentication',
        push: false,
      });
      const commitData = parseResult(commitResult);
      expect(commitData.commitHash).toBeDefined();
      expect(commitData.filesChanged).toBe(2);
      expect(commitData.pushed).toBe(false);

      // Verify database recording
      expect(dbCommits).toHaveLength(1);
      expect(dbCommits[0].message).toBe('feat: add user authentication');

      // 4. Unlock files
      const unlockResult = await callTool('kanvas_unlock_file', {
        session_id: SESSION_ID,
      });
      const unlockData = parseResult(unlockResult);
      expect(unlockData.unlocked).toBe(true);
      expect(unlockData.files).toBe('all');
    });
  });

  // ==========================================================================
  // Story 2: Multi-Commit Workflow
  // ==========================================================================
  describe('Story: Multi-Commit Workflow', () => {
    it('should handle multiple commits with activity logging and review', async () => {
      // 1. Commit A
      const commitA = await callTool('kanvas_commit', {
        session_id: SESSION_ID,
        message: 'feat: add login form',
      });
      expect(parseResult(commitA).commitHash).toBeDefined();

      // 2. Log activity
      const logResult = await callTool('kanvas_log_activity', {
        session_id: SESSION_ID,
        type: 'info',
        message: 'Login form tests passing, moving to API integration',
      });
      expect(parseResult(logResult).logged).toBe(true);

      // 3. Commit B
      const commitB = await callTool('kanvas_commit', {
        session_id: SESSION_ID,
        message: 'feat: add login API endpoint',
      });
      expect(parseResult(commitB).commitHash).toBeDefined();

      // 4. Get history (should show 2 commits)
      const historyResult = await callTool('kanvas_get_commit_history', {
        session_id: SESSION_ID,
      });
      const history = parseResult(historyResult);
      expect(history.commits).toHaveLength(2);
      expect(history.commits[0].message).toBe('feat: add login form');
      expect(history.commits[1].message).toBe('feat: add login API endpoint');

      // 5. Request review
      const reviewResult = await callTool('kanvas_request_review', {
        session_id: SESSION_ID,
        summary: 'Implemented login form and API endpoint with JWT auth',
      });
      const review = parseResult(reviewResult);
      expect(review.logged).toBe(true);
      expect(review.summary).toContain('JWT auth');

      // Verify activity timeline
      expect(activityLogs.length).toBeGreaterThanOrEqual(4); // 2 commits + 1 log + 1 review
    });
  });

  // ==========================================================================
  // Story 3: Lock Conflict
  // ==========================================================================
  describe('Story: Lock Conflict', () => {
    it('should detect lock conflicts between sessions', async () => {
      const SESSION_B = 'sess_conflict_test_002';
      binder.registerSession(SESSION_B, tempDir + '-other');

      // Session A locks src/index.ts
      const lockA = await callTool('kanvas_lock_file', {
        session_id: SESSION_ID,
        files: ['src/index.ts'],
      });
      expect(parseResult(lockA).locked).toBe(true);

      // Session B tries the same file → conflict
      deps.lockService.checkConflicts.mockResolvedValueOnce({
        success: true,
        data: [{
          file: 'src/index.ts',
          heldBy: 'claude',
          sessionId: SESSION_ID,
        }],
      });

      const lockB = await callTool('kanvas_lock_file', {
        session_id: SESSION_B,
        files: ['src/index.ts'],
      });
      const conflictData = parseResult(lockB);
      expect(conflictData.locked).toBe(false);
      expect(conflictData.conflicts).toHaveLength(1);
      expect(conflictData.conflicts[0].file).toBe('src/index.ts');
      expect(conflictData.conflicts[0].heldBy).toBe('claude');
    });
  });

  // ==========================================================================
  // Story 4: Session Discovery
  // ==========================================================================
  describe('Story: Session Discovery', () => {
    it('should provide session metadata for agent discovery', async () => {
      const result = await callTool('kanvas_get_session_info', {
        session_id: SESSION_ID,
      });

      const info = parseResult(result);
      expect(info.sessionId).toBe(SESSION_ID);
      expect(info.worktreePath).toBe(tempDir);
      expect(info.agentType).toBe('claude');
      expect(info.branchName).toBe('feat/mcp-test');
      expect(info.baseBranch).toBe('main');
      expect(info.task).toBe('Integration test task');
      expect(info.repoPath).toBe(tempDir);
    });
  });

  // ==========================================================================
  // Story 5: Houserules Discovery
  // ==========================================================================
  describe('Story: Houserules Discovery', () => {
    it('should find houserules.md at worktree root (single file, not duplicated)', () => {
      // houserules.md lives at repo/worktree root — NOT inside .S9N_KIT_DevOpsAgent/
      const houserulesPath = join(tempDir, 'houserules.md');
      writeFileSync(houserulesPath, '# House Rules\n\n## Code Style\n- Use TypeScript strict mode\n');

      expect(existsSync(houserulesPath)).toBe(true);
      const content = readFileSync(houserulesPath, 'utf-8');
      expect(content).toContain('TypeScript strict mode');

      // Verify there is NO duplicate inside the kit dir
      const kitHouserules = join(tempDir, '.S9N_KIT_DevOpsAgent', 'houserules.md');
      expect(existsSync(kitHouserules)).toBe(false);
    });

    it('should find FOLDER_STRUCTURE.md as a separate file from houserules', () => {
      // Folder structure is a separate file at repo/worktree root
      const folderStructurePath = join(tempDir, 'FOLDER_STRUCTURE.md');
      writeFileSync(folderStructurePath, '# Folder Structure\n\n## Project Layout\n- src/\n- tests/\n');

      expect(existsSync(folderStructurePath)).toBe(true);
      const content = readFileSync(folderStructurePath, 'utf-8');
      expect(content).toContain('Folder Structure');
      expect(content).toContain('Project Layout');
    });

    it('should find House_Rules_Contracts/ at worktree root', () => {
      // Create contracts dir at worktree root (as Phase 4 now does)
      const contractsDir = join(tempDir, 'House_Rules_Contracts');
      mkdirSync(contractsDir, { recursive: true });
      writeFileSync(join(contractsDir, 'API_CONTRACT.md'), '# API Contract\n');
      writeFileSync(join(contractsDir, 'DATABASE_SCHEMA_CONTRACT.md'), '# Schema\n');

      expect(existsSync(contractsDir)).toBe(true);
      expect(existsSync(join(contractsDir, 'API_CONTRACT.md'))).toBe(true);
    });
  });

  // ==========================================================================
  // Story 6: MCP Config Discovery
  // ==========================================================================
  describe('Story: MCP Config Discovery', () => {
    it('should generate valid .mcp.json for claude agents', () => {
      const mcpConfigPath = join(tempDir, '.mcp.json');
      const mcpConfig = {
        mcpServers: {
          kanvas: {
            type: 'streamable-http',
            url: 'http://127.0.0.1:39100/mcp',
          },
        },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      expect(parsed.mcpServers.kanvas.type).toBe('streamable-http');
      expect(parsed.mcpServers.kanvas.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });
  });

  // ==========================================================================
  // Story 7: Error Handling
  // ==========================================================================
  describe('Story: Error Handling', () => {
    it('should return clean errors for unknown sessions across all tools', async () => {
      const tools = [
        { name: 'kanvas_commit', args: { session_id: 'unknown', message: 'test' } },
        { name: 'kanvas_get_session_info', args: { session_id: 'unknown' } },
        { name: 'kanvas_log_activity', args: { session_id: 'unknown', type: 'info', message: 'test' } },
        { name: 'kanvas_lock_file', args: { session_id: 'unknown', files: ['test.ts'] } },
        { name: 'kanvas_unlock_file', args: { session_id: 'unknown' } },
        { name: 'kanvas_get_commit_history', args: { session_id: 'unknown' } },
        { name: 'kanvas_request_review', args: { session_id: 'unknown', summary: 'test' } },
      ];

      for (const { name, args } of tools) {
        const result = await callTool(name, args);
        const data = parseResult(result);
        expect(data.error).toContain('Unknown session');
      }
    });

    it('should handle git commit failure gracefully', async () => {
      deps.gitService.commit.mockResolvedValueOnce({
        success: false,
        error: { message: 'Nothing to commit, working tree clean' },
      });

      const result = await callTool('kanvas_commit', {
        session_id: SESSION_ID,
        message: 'feat: empty commit',
      });

      const data = parseResult(result);
      expect(data.error).toBe('Nothing to commit, working tree clean');
    });

    it('should handle push failure non-fatally', async () => {
      deps.gitService.push.mockRejectedValueOnce(new Error('Remote rejected'));

      const result = await callTool('kanvas_commit', {
        session_id: SESSION_ID,
        message: 'feat: push will fail',
        push: true,
      });

      const data = parseResult(result);
      // Commit succeeds even though push failed
      expect(data.commitHash).toBeDefined();
      expect(data.pushed).toBe(false);
    });
  });
});
