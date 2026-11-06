/**
 * MCP kit_commit exclude and kit_start_session setup_changes - Unit tests
 * Tests for AC2: kit_commit accepts exclude and passes it to gitService.commit;
 * without it the call is unchanged. kit_start_session's response includes 
 * setup_changes parsed from git status --porcelain --untracked-files=all.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Proxy stub: every schema method chains
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

type Handler = (args: any) => Promise<any>;

interface Harness {
  handlers: Map<string, Handler>;
  gitService: {
    commit: jest.Mock<any>;
  };
}

function buildHarness(): Harness {
  const handlers = new Map<string, Handler>();
  const gitService = {
    commit: jest.fn(async () => ({
      success: true,
      data: {
        hash: 'abc123def',
        shortHash: 'abc123',
        message: 'Test commit',
        author: 'Test Author',
        date: '2026-01-21T10:00:00Z',
        files: [],
        filesChanged: 0,
      },
    })),
  };

  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };

  const binder: any = {
    getWorktreePathForRepo: () => '/test/worktree',
    getPrimaryRepoNameIfSecondary: () => undefined,
  };

  const { registerTools } = require('../../../electron/services/mcp/tools');
  registerTools(
    server,
    binder,
    {
      gitService,
      activityService: {
        log: jest.fn(),
      },
      databaseService: {
        recordCommit: jest.fn(),
        recordSessionEvent: jest.fn(),
      },
      sessionOrchestrator: {
        expandSessionAliases: (id: string) => [id],
      },
      emitCommitCompleted: jest.fn(),
      debugLog: { warn: jest.fn() },
    },
    undefined
  );

  return { handlers, gitService };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('kit_commit — exclude parameter', () => {
  it('passes exclude array to gitService.commit', async () => {
    const h = buildHarness();
    const excludePaths = ['houserules.md', '.vscode/settings.json'];

    const result = await h.handlers.get('kit_commit')!({
      session_id: 'sess_test',
      message: 'Test commit',
      cwd: '/test/worktree',
      exclude: excludePaths,
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_test',
      'Test commit',
      undefined,
      excludePaths
    );
  });

  it('calls gitService.commit without exclude when parameter omitted', async () => {
    const h = buildHarness();

    const result = await h.handlers.get('kit_commit')!({
      session_id: 'sess_test',
      message: 'Test commit',
      cwd: '/test/worktree',
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_test',
      'Test commit',
      undefined
    );
  });

  it('calls gitService.commit with undefined exclude when not provided', async () => {
    const h = buildHarness();

    const result = await h.handlers.get('kit_commit')!({
      session_id: 'sess_test',
      message: 'Test commit',
      cwd: '/test/worktree',
      exclude: undefined,
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_test',
      'Test commit',
      undefined,
      undefined
    );
  });
});

describe('kit_start_session — setup_changes', () => {
  let tmpRoot: string;
  let repoDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'kit-setup-'));
    repoDir = join(tmpRoot, 'test-repo');
    mkdirSync(repoDir, { recursive: true });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('includes setup_changes in success response', async () => {
    // Mock execa for git status
    const mockExecaFn = jest.fn();
    jest.mock('execa', () => ({
      __esModule: true,
      default: mockExecaFn,
      execa: mockExecaFn,
    }));

    // Create some files in the worktree
    writeFileSync(join(repoDir, 'houserules.md'), '# House Rules');
    writeFileSync(join(repoDir, 'new-file.txt'), 'content');

    // Mock git status --porcelain --untracked-files=all
    mockExecaFn.mockResolvedValueOnce({
      stdout: '?? houserules.md\n?? new-file.txt\n M .gitignore',
    } as never);

    // Rebuild harness to pick up the mock
    const handlers = new Map<string, Handler>();
    const gitService = {
      commit: jest.fn(),
    };

    const server: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    };

    const binder: any = {
      getWorktreePathForRepo: () => repoDir,
    };

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(
      server,
      binder,
      {
        gitService,
        activityService: { log: jest.fn() },
        databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
        sessionOrchestrator: {
          startSession: jest.fn(async () => ({
            success: true,
            data: { id: 'inst1', sessionId: 'sess1', status: 'waiting', worktreePath: repoDir },
          })),
          expandSessionAliases: (id: string) => [id],
        },
        emitCommitCompleted: jest.fn(),
        debugLog: { warn: jest.fn() },
      },
      undefined
    );

    const result = await handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'test task',
    });

    const parsed = parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.setup_changes).toBeDefined();
    expect(Array.isArray(parsed.setup_changes)).toBe(true);
  });

  it('parses porcelain output correctly for setup_changes', async () => {
    const mockExecaFn = jest.fn();
    jest.mock('execa', () => ({
      __esModule: true,
      default: mockExecaFn,
      execa: mockExecaFn,
    }));

    mockExecaFn.mockResolvedValueOnce({
      stdout: '?? new-file.txt\n M modified.txt\nR  old.txt -> renamed.txt',
    } as never);

    const handlers = new Map<string, Handler>();
    const gitService = { commit: jest.fn() };

    const server: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    };

    const binder: any = { getWorktreePathForRepo: () => repoDir };

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(
      server,
      binder,
      {
        gitService,
        activityService: { log: jest.fn() },
        databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
        sessionOrchestrator: {
          startSession: jest.fn(async () => ({
            success: true,
            data: { id: 'inst1', sessionId: 'sess1', status: 'waiting', worktreePath: repoDir },
          })),
          expandSessionAliases: (id: string) => [id],
        },
        emitCommitCompleted: jest.fn(),
        debugLog: { warn: jest.fn() },
      },
      undefined
    );

    const result = await handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'test task',
    });

    const parsed = parse(result);
    expect(parsed.setup_changes).toContain('new-file.txt');
    expect(parsed.setup_changes).toContain('modified.txt');
    expect(parsed.setup_changes).toContain('renamed.txt');
  });

  it('returns empty array when git status fails', async () => {
    const mockExecaFn = jest.fn();
    jest.mock('execa', () => ({
      __esModule: true,
      default: mockExecaFn,
      execa: mockExecaFn,
    }));

    // Mock git status to fail
    mockExecaFn.mockRejectedValueOnce(new Error('git status failed') as never);

    const handlers = new Map<string, Handler>();
    const gitService = { commit: jest.fn() };

    const server: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    };

    const binder: any = { getWorktreePathForRepo: () => repoDir };

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(
      server,
      binder,
      {
        gitService,
        activityService: { log: jest.fn() },
        databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
        sessionOrchestrator: {
          startSession: jest.fn(async () => ({
            success: true,
            data: { id: 'inst1', sessionId: 'sess1', status: 'waiting', worktreePath: repoDir },
          })),
          expandSessionAliases: (id: string) => [id],
        },
        emitCommitCompleted: jest.fn(),
        debugLog: { warn: jest.fn() },
      },
      undefined
    );

    const result = await handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'test task',
    });

    const parsed = parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.setup_changes).toEqual([]);
  });

  it('returns empty array when there are no changes', async () => {
    const mockExecaFn = jest.fn();
    jest.mock('execa', () => ({
      __esModule: true,
      default: mockExecaFn,
      execa: mockExecaFn,
    }));

    mockExecaFn.mockResolvedValueOnce({ stdout: '' } as never);

    const handlers = new Map<string, Handler>();
    const gitService = { commit: jest.fn() };

    const server: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    };

    const binder: any = { getWorktreePathForRepo: () => repoDir };

    const { registerTools } = require('../../../electron/services/mcp/tools');
    registerTools(
      server,
      binder,
      {
        gitService,
        activityService: { log: jest.fn() },
        databaseService: { recordCommit: jest.fn(), recordSessionEvent: jest.fn() },
        sessionOrchestrator: {
          startSession: jest.fn(async () => ({
            success: true,
            data: { id: 'inst1', sessionId: 'sess1', status: 'waiting', worktreePath: repoDir },
          })),
          expandSessionAliases: (id: string) => [id],
        },
        emitCommitCompleted: jest.fn(),
        debugLog: { warn: jest.fn() },
      },
      undefined
    );

    const result = await handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'test task',
    });

    const parsed = parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.setup_changes).toEqual([]);
  });
});
