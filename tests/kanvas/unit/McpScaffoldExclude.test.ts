/**
 * MCP tools with exclude and setup_changes - AC2
 *
 * Tests that:
 * 1. kit_commit accepts exclude parameter and passes it to gitService.commit
 * 2. kit_start_session's response includes setup_changes parsed from git status
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Proxy stub for zod
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' ? undefined : (..._a: any[]) => zodChain()),
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));

// Mock execa module
const mockExecaFn = jest.fn();
jest.mock('execa', () => ({
  __esModule: true,
  default: mockExecaFn,
  execa: mockExecaFn,
}));

const mockedExeca = mockExecaFn as jest.MockedFunction<any>;

type Handler = (args: any) => Promise<any>;

interface Harness {
  handlers: Map<string, Handler>;
  gitService: {
    commit: jest.Mock<any>;
    getCurrentBranchName: jest.Mock<any>;
  };
}

function buildHarness(over: {
  gitService?: {
    commit?: (sessionId: string, message: string, repoName?: string, exclude?: string[]) => Promise<any>;
    getCurrentBranchName?: (worktreePath: string) => Promise<string | null>;
  };
} = {}): Harness {
  const handlers = new Map<string, Handler>();
  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };

  const gitService = {
    commit: over.gitService?.commit || jest.fn(async () => ({
      success: true,
      data: {
        hash: 'abc123def456',
        shortHash: 'abc123',
        message: 'Test commit',
        author: 'Test User',
        date: '2026-01-01T00:00:00Z',
        files: [{ path: 'src/app.ts', status: 'modified' }],
        filesChanged: 1,
      },
    })),
    getCurrentBranchName: over.gitService?.getCurrentBranchName || jest.fn(async () => 'main'),
  };

  const binder: any = {
    getSession: () => ({ worktreePath: '/test/worktree' }),
    getWorktreePath: () => '/test/worktree',
    getWorktreePathForRepo: () => '/test/worktree',
    getReposForSession: () => [],
    getPrimaryRepoNameIfSecondary: () => undefined,
    listSessions: () => [],
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
      debugLog: {
        warn: jest.fn(),
        error: jest.fn(),
      },
      databaseService: {
        recordCommit: jest.fn(),
        recordSessionEvent: jest.fn(),
      },
      agentInstanceService: {
        listInstances: () => ({
          success: true,
          data: [{
            sessionId: 'sess_1',
            config: { branchName: 'main', baseBranch: 'development' },
          }],
        }),
        updateInstanceStatus: jest.fn(),
      },
      postCommitRebase: jest.fn(async () => ({ ok: true, rewrote: false, commitsIntegrated: 0, message: 'No rebase needed' })),
      emitCommitCompleted: jest.fn(),
    },
    undefined
  );

  return { handlers, gitService };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

let repoDir: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kit-mcp-exclude-'));
  repoDir = join(tmpRoot, 'MyApp');
  mkdirSync(repoDir, { recursive: true });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('kit_commit with exclude', () => {
  it('accepts exclude parameter in schema', async () => {
    const h = buildHarness();
    
    // Mock git status for divergence check
    mockedExeca.mockResolvedValue({ stdout: '' });

    const result = await h.handlers.get('kit_commit')!({
      session_id: 'sess_1',
      message: 'Test commit',
      cwd: repoDir,
      exclude: ['houserules.md', 'uv.lock'],
    });

    const out = parse(result);
    expect(out.commitHash).toBe('abc123def456');
  });

  it('passes exclude to gitService.commit', async () => {
    const excludePaths = ['houserules.md', '.vscode/settings.json', 'uv.lock'];
    const h = buildHarness();

    // Mock git status for divergence check
    mockedExeca.mockResolvedValue({ stdout: '' });

    await h.handlers.get('kit_commit')!({
      session_id: 'sess_1',
      message: 'Test commit',
      cwd: repoDir,
      exclude: excludePaths,
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_1',
      'Test commit',
      undefined,
      excludePaths
    );
  });

  it('calls gitService.commit without exclude when parameter is omitted', async () => {
    const h = buildHarness();

    // Mock git status for divergence check
    mockedExeca.mockResolvedValue({ stdout: '' });

    await h.handlers.get('kit_commit')!({
      session_id: 'sess_1',
      message: 'Test commit',
      cwd: repoDir,
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_1',
      'Test commit',
      undefined,
      undefined
    );
  });

  it('passes exclude to gitService.commit for a specific repo', async () => {
    const h = buildHarness();

    // Mock git status for divergence check
    mockedExeca.mockResolvedValue({ stdout: '' });

    await h.handlers.get('kit_commit')!({
      session_id: 'sess_1',
      message: 'Test commit',
      cwd: repoDir,
      repo: 'secondary',
      exclude: ['uv.lock'],
    });

    expect(h.gitService.commit).toHaveBeenCalledWith(
      'sess_1',
      'Test commit',
      'secondary',
      ['uv.lock']
    );
  });
});

describe('kit_start_session with setup_changes', () => {
  it('includes setup_changes in success response', async () => {
    // Mock git status --porcelain --untracked-files=all output
    const mockPorcelain = `?? houserules.md
 M .gitignore
?? uv.lock
`;

    // Mock execa for git status
    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    // Mock for branch detection
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    // Mock for branch listing
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    expect(out.ok).toBe(true);
    expect(out.setup_changes).toBeDefined();
    expect(Array.isArray(out.setup_changes)).toBe(true);
    
    // Should include the untracked and modified files
    expect(out.setup_changes).toContain('houserules.md');
    expect(out.setup_changes).toContain('.gitignore');
    expect(out.setup_changes).toContain('uv.lock');
  });

  it('parses porcelain v1 format correctly', async () => {
    const mockPorcelain = `?? new-file.txt
MM modified-file.ts
R100 old-name.md -> new-name.md
`;

    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    expect(out.setup_changes).toContain('new-file.txt');
    expect(out.setup_changes).toContain('modified-file.ts');
    // For renames, should use the new name (after '->')
    expect(out.setup_changes).toContain('new-name.md');
  });

  it('returns empty array when git status fails', async () => {
    // Mock git status to fail
    mockedExeca.mockRejectedValueOnce(new Error('git status failed'));
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
  });

  it('returns empty array for observer sessions (no worktree)', async () => {
    const mockPorcelain = '?? file.txt\n';

    // Observer sessions don't have a worktree, so git status should not be called
    // or should fail gracefully
    mockedExeca.mockRejectedValueOnce(new Error('No worktree'));

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Review task',
      isolation: 'observer',
    });

    const out = parse(result);
    
    expect(out.ok).toBe(true);
    expect(out.isolation).toBe('observer');
    expect(out.setup_changes).toEqual([]);
  });

  it('handles empty porcelain output (clean worktree)', async () => {
    const mockPorcelain = '';

    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    expect(out.ok).toBe(true);
    expect(out.setup_changes).toEqual([]);
  });

  it('handles rename format "a -> b" correctly', async () => {
    const mockPorcelain = 'R100 source/file.md -> dest/file.md\n';

    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    // Should extract the destination path (after '->')
    expect(out.setup_changes).toContain('dest/file.md');
    expect(out.setup_changes).not.toContain('source/file.md');
  });
});

describe('kit_start_session setup_changes edge cases', () => {
  it('handles paths with spaces correctly', async () => {
    const mockPorcelain = '?? file with spaces.txt\n';

    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    expect(out.setup_changes).toContain('file with spaces.txt');
  });

  it('deduplicates paths when same file appears multiple times', async () => {
    // This shouldn't happen in normal porcelain output, but test robustness
    const mockPorcelain = '?? file.txt\n?? file.txt\n';

    mockedExeca.mockResolvedValueOnce({ stdout: mockPorcelain });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main' });
    mockedExeca.mockResolvedValueOnce({ stdout: 'main\ndevelopment' });

    const h = buildHarness();

    const result = await h.handlers.get('kit_start_session')!({
      repo_path: repoDir,
      task: 'Test task',
    });

    const out = parse(result);
    
    // Should only have one entry
    expect(out.setup_changes.filter((p: string) => p === 'file.txt')).toHaveLength(1);
  });
});
