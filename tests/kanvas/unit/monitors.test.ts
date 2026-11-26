/**
 * Unit Tests for Worker Monitor Classes
 * Tests FileMonitor, RebaseMonitor, HeartbeatMonitor, AgentMonitor, KanvasHeartbeatWriter
 *
 * Strategy: Since monitors take an `emit` callback, we test lifecycle + event emission.
 * Native modules (chokidar, fs, child_process) are mocked via jest.mock().
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { WorkerEvent } from '../../../electron/worker/worker-protocol';

// ─── Type helpers ───────────────────────────────────────────────────
type EmitFn = (event: WorkerEvent) => void;
type ChokidarHandler = (...args: unknown[]) => void;

// ─── Shared mock watcher factory ────────────────────────────────────
function createMockWatcher() {
  const handlers: Record<string, ChokidarHandler[]> = {};
  const watcher = {
    on: jest.fn((event: string, handler: ChokidarHandler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return watcher;
    }) as jest.Mock,
    close: jest.fn().mockResolvedValue(undefined as never) as jest.Mock,
    simulate: (event: string, ...args: unknown[]) => {
      for (const handler of handlers[event] || []) {
        handler(...args);
      }
    },
  };
  return watcher;
}

// ─── Mock chokidar ──────────────────────────────────────────────────
let currentMockWatcher = createMockWatcher();
const allCreatedWatchers: ReturnType<typeof createMockWatcher>[] = [];

const mockChokidarWatch = jest.fn(() => {
  allCreatedWatchers.push(currentMockWatcher);
  return currentMockWatcher;
});

jest.mock('chokidar', () => ({
  default: {
    watch: mockChokidarWatch,
  },
  watch: mockChokidarWatch,
}));

// ─── Mock fs ────────────────────────────────────────────────────────
const mockReadFile = jest.fn() as jest.Mock;
const mockWriteFile = jest.fn().mockResolvedValue(undefined as never) as jest.Mock;
const mockMkdir = jest.fn().mockResolvedValue(undefined as never) as jest.Mock;
const mockRealpath = jest.fn() as jest.Mock;

jest.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    realpath: mockRealpath,
  },
}));

// ─── Mock child_process / util ──────────────────────────────────────
const mockExecFileAsync = jest.fn() as jest.Mock;

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { FileMonitor } from '../../../electron/worker/monitors/FileMonitor';
import { HeartbeatMonitor } from '../../../electron/worker/monitors/HeartbeatMonitor';
import { AgentMonitor } from '../../../electron/worker/monitors/AgentMonitor';
import { KanvasHeartbeatWriter } from '../../../electron/worker/monitors/KanvasHeartbeatWriter';
import { RebaseMonitor } from '../../../electron/worker/monitors/RebaseMonitor';

// ═════════════════════════════════════════════════════════════════════
// FileMonitor
// ═════════════════════════════════════════════════════════════════════

describe('FileMonitor', () => {
  let emitFn: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    currentMockWatcher = createMockWatcher();
    emitFn = jest.fn();
  });

  it('should start watching a session and track it', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');
    expect(monitor.activeCount).toBe(1);
  });

  it('should stop watching a session', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');
    const watcher = currentMockWatcher;
    monitor.stop('sess-1');
    expect(monitor.activeCount).toBe(0);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('should emit file-changed events on file add/change/unlink', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');

    currentMockWatcher.simulate('add', '/repo/worktree/src/index.ts');
    expect(emitFn).toHaveBeenCalledWith({
      type: 'file-changed',
      sessionId: 'sess-1',
      filePath: '/repo/worktree/src/index.ts',
      changeType: 'add',
    });

    currentMockWatcher.simulate('change', '/repo/worktree/src/index.ts');
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file-changed', changeType: 'change' })
    );

    currentMockWatcher.simulate('unlink', '/repo/worktree/src/index.ts');
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file-changed', changeType: 'unlink' })
    );
  });

  it('should emit commit-msg-detected when commit message file appears', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');

    currentMockWatcher.simulate('add', '/repo/.commit-msg');
    expect(emitFn).toHaveBeenCalledWith({
      type: 'commit-msg-detected',
      sessionId: 'sess-1',
      commitMsgFilePath: '/repo/.commit-msg',
    });
  });

  it('should also detect claude commit message file', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');

    currentMockWatcher.simulate('change', '/repo/.claude-commit-msg');
    expect(emitFn).toHaveBeenCalledWith({
      type: 'commit-msg-detected',
      sessionId: 'sess-1',
      commitMsgFilePath: '/repo/.claude-commit-msg',
    });
  });

  it('should NOT emit commit-msg-detected on unlink of commit msg file', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/repo/.commit-msg', '/repo/.claude-commit-msg');
    emitFn.mockClear(); // Clear log events from start()

    currentMockWatcher.simulate('unlink', '/repo/.commit-msg');
    expect(emitFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'commit-msg-detected' })
    );
  });

  it('should stop previous watcher when starting same session', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    const watcher1 = currentMockWatcher;

    monitor.start('sess-1', '/repo/wt1', '/repo/.cm', '/repo/.ccm');
    currentMockWatcher = createMockWatcher();
    monitor.start('sess-1', '/repo/wt2', '/repo/.cm', '/repo/.ccm');

    expect(watcher1.close).toHaveBeenCalled();
    expect(monitor.activeCount).toBe(1);
  });

  it('should track multiple sessions independently', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/wt1', '/cm1', '/ccm1');
    currentMockWatcher = createMockWatcher();
    monitor.start('sess-2', '/repo/wt2', '/cm2', '/ccm2');
    expect(monitor.activeCount).toBe(2);
  });

  it('should stopAll watchers', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    const w1 = currentMockWatcher;
    monitor.start('sess-1', '/repo/wt1', '/cm1', '/ccm1');
    currentMockWatcher = createMockWatcher();
    const w2 = currentMockWatcher;
    monitor.start('sess-2', '/repo/wt2', '/cm2', '/ccm2');

    monitor.stopAll();
    expect(monitor.activeCount).toBe(0);
    expect(w1.close).toHaveBeenCalled();
    expect(w2.close).toHaveBeenCalled();
  });

  it('should emit error event on watcher error', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo/worktree', '/cm', '/ccm');

    currentMockWatcher.simulate('error', new Error('Watch failed'));
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', source: 'FileMonitor' })
    );
  });

  it('should handle stop for non-existent session gracefully', () => {
    const monitor = new FileMonitor(emitFn as EmitFn);
    expect(() => monitor.stop('nonexistent')).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════
// HeartbeatMonitor
// ═════════════════════════════════════════════════════════════════════

describe('HeartbeatMonitor', () => {
  let emitFn: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    currentMockWatcher = createMockWatcher();
    emitFn = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start monitoring a heartbeat file', () => {
    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/sess-1.json');
    expect(monitor.activeCount).toBe(1);
  });

  it('should stop monitoring', () => {
    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/sess-1.json');
    const watcher = currentMockWatcher;
    monitor.stop('sess-1');
    expect(monitor.activeCount).toBe(0);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('should emit heartbeat-update on file add/change', async () => {
    const heartbeatData = {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      timestamp: '2026-02-21T12:00:00Z',
      status: 'active',
    };
    mockReadFile.mockResolvedValue(JSON.stringify(heartbeatData) as never);

    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/sess-1.json');

    // Simulate file change
    currentMockWatcher.simulate('change');

    // Let the async read resolve
    await jest.advanceTimersByTimeAsync(0);

    expect(emitFn).toHaveBeenCalledWith({
      type: 'heartbeat-update',
      sessionId: 'sess-1',
      data: heartbeatData,
    });
  });

  it('should emit heartbeat-timeout after 5 minutes of inactivity', async () => {
    const heartbeatData = { sessionId: 'sess-1', timestamp: '2026-02-21T12:00:00Z' };
    mockReadFile.mockResolvedValue(JSON.stringify(heartbeatData) as never);

    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/sess-1.json');

    // Trigger an initial heartbeat so lastHeartbeatTs is set
    currentMockWatcher.simulate('add');
    await jest.advanceTimersByTimeAsync(0);

    // Advance time past the 5-minute timeout
    jest.advanceTimersByTime(5 * 60 * 1000 + 30_000);

    expect(emitFn).toHaveBeenCalledWith({
      type: 'heartbeat-timeout',
      sessionId: 'sess-1',
    });
  });

  it('should handle malformed heartbeat file gracefully', async () => {
    mockReadFile.mockResolvedValue('not json' as never);

    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/sess-1.json');

    currentMockWatcher.simulate('change');
    await jest.advanceTimersByTimeAsync(0);

    // Should not crash, and should not emit heartbeat-update
    expect(emitFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'heartbeat-update' })
    );
  });

  it('should stopAll and clear check interval', () => {
    const monitor = new HeartbeatMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/hb/1.json');
    currentMockWatcher = createMockWatcher();
    monitor.start('sess-2', '/hb/2.json');

    monitor.stopAll();
    expect(monitor.activeCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// AgentMonitor
// ═════════════════════════════════════════════════════════════════════

describe('AgentMonitor', () => {
  let emitFn: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    emitFn = jest.fn();
    allCreatedWatchers.length = 0;

    // Make each chokidar.watch() call return a fresh watcher
    mockChokidarWatch.mockImplementation(() => {
      const w = createMockWatcher();
      allCreatedWatchers.push(w);
      return w;
    });
  });

  it('should start watching 4 agent subdirectories', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');

    expect(monitor.activeCount).toBe(1);
    expect(allCreatedWatchers.length).toBe(4); // agents, sessions, heartbeats, activity
  });

  it('should stop all watchers', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');
    monitor.stop();

    expect(monitor.activeCount).toBe(0);
    for (const w of allCreatedWatchers) {
      expect(w.close).toHaveBeenCalled();
    }
  });

  it('should emit agent-file-event for JSON files', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');

    // First watcher (agents dir)
    allCreatedWatchers[0].simulate('add', '/home/user/.S9N_KIT_DevOpsAgent/agents/agent-1.json');

    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent-file-event',
        action: 'add',
        filePath: '/home/user/.S9N_KIT_DevOpsAgent/agents/agent-1.json',
      })
    );
  });

  it('should not emit events for non-JSON files', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');
    emitFn.mockClear(); // Clear log events from start()

    allCreatedWatchers[0].simulate('add', '/home/user/.S9N_KIT_DevOpsAgent/agents/readme.txt');
    expect(emitFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-file-event' })
    );
  });

  it('should close previous watchers on re-start', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');
    const firstBatch = [...allCreatedWatchers];

    monitor.start('/home/user2');

    for (const w of firstBatch) {
      expect(w.close).toHaveBeenCalled();
    }
  });

  it('should emit change and unlink events', () => {
    const monitor = new AgentMonitor(emitFn as EmitFn);
    monitor.start('/home/user');

    allCreatedWatchers[1].simulate('change', '/path/sessions/s.json');
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-file-event', action: 'change' })
    );

    allCreatedWatchers[2].simulate('unlink', '/path/heartbeats/h.json');
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-file-event', action: 'unlink' })
    );
  });
});

// ═════════════════════════════════════════════════════════════════════
// KanvasHeartbeatWriter
// ═════════════════════════════════════════════════════════════════════

describe('KanvasHeartbeatWriter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start and report isActive', () => {
    const writer = new KanvasHeartbeatWriter();
    writer.start('/tmp/heartbeats', '1.2.0');
    expect(writer.isActive).toBe(true);
  });

  it('should stop and report inactive', () => {
    const writer = new KanvasHeartbeatWriter();
    writer.start('/tmp/heartbeats', '1.2.0');
    writer.stop();
    expect(writer.isActive).toBe(false);
  });

  it('should write heartbeat file immediately on start', async () => {
    const writer = new KanvasHeartbeatWriter();
    writer.start('/tmp/heartbeats', '1.2.0');

    // Let the immediate write resolve
    await jest.advanceTimersByTimeAsync(0);

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/heartbeats', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/heartbeats/kanvas.json',
      expect.stringContaining('"process": "kanvas"')
    );
  });

  it('should write heartbeat periodically (every 30s)', async () => {
    const writer = new KanvasHeartbeatWriter();
    writer.start('/tmp/heartbeats', '1.2.0');

    await jest.advanceTimersByTimeAsync(0); // initial write
    const initialCalls = mockWriteFile.mock.calls.length;

    await jest.advanceTimersByTimeAsync(30_000); // 30 second interval
    expect(mockWriteFile.mock.calls.length).toBeGreaterThan(initialCalls);

    writer.stop();
  });

  it('should include version in heartbeat data', async () => {
    const writer = new KanvasHeartbeatWriter();
    writer.start('/tmp/heartbeats', '2.0.0');

    await jest.advanceTimersByTimeAsync(0);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"version": "2.0.0"')
    );
  });

  it('should handle write errors gracefully', async () => {
    mockMkdir.mockRejectedValueOnce(new Error('Permission denied') as never);

    const writer = new KanvasHeartbeatWriter();
    // Should not throw
    expect(() => writer.start('/tmp/heartbeats', '1.2.0')).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// RebaseMonitor
// ═════════════════════════════════════════════════════════════════════

/** A checkout the fake git knows about, keyed by the cwd git is run in. */
interface FakeCheckout {
  /** What `git rev-parse --git-common-dir` prints ('.git' or an absolute path). */
  commonDir?: string;
  commonDirError?: Error;
  fetchError?: Error;
  /** `git rev-list --left-right --count` output: "ahead\tbehind". */
  aheadBehind?: string;
  revListError?: Error;
  branch?: string;
}

/**
 * Answer git by command rather than by call order: polls from several
 * sessions interleave, so positional mocks would test the scheduling, not
 * the behaviour.
 */
function fakeGit(checkouts: Record<string, FakeCheckout>): void {
  mockExecFileAsync.mockImplementation((async (_bin: string, args: string[], opts: { cwd: string }) => {
    const c = checkouts[opts.cwd];
    if (!c) throw new Error(`fatal: not a git repository: ${opts.cwd}`);
    const out = (stdout: string) => ({ stdout, stderr: '' });
    if (args.includes('fetch')) {
      if (c.fetchError) throw c.fetchError;
      return out('');
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      if (c.commonDirError) throw c.commonDirError;
      return out(`${c.commonDir ?? '.git'}\n`);
    }
    if (args[0] === 'rev-list') {
      if (c.revListError) throw c.revListError;
      return out(c.aheadBehind ?? '0\t0\n');
    }
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return out(`${c.branch ?? 'main'}\n`);
    throw new Error(`unexpected git ${args.join(' ')}`);
  }) as never);
}

describe('RebaseMonitor', () => {
  let emitFn: jest.Mock;

  /** Let every pending poll run to completion (each poll awaits several git calls). */
  const settle = async () => {
    for (let i = 0; i < 25; i++) await jest.advanceTimersByTimeAsync(0);
  };
  const fetchCalls = () =>
    mockExecFileAsync.mock.calls.filter((call) => (call[1] as string[]).includes('fetch'));
  const statusesFor = (sessionId: string) =>
    emitFn.mock.calls
      .map((call) => call[0] as WorkerEvent & { sessionId?: string })
      .filter((e) => e.type === 'rebase-remote-status' && e.sessionId === sessionId);
  const errorsFor = (sessionId: string) =>
    emitFn.mock.calls
      .map((call) => call[0] as WorkerEvent & { message?: string })
      .filter((e) => e.type === 'error' && (e.message ?? '').includes(sessionId));

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecFileAsync.mockReset();
    mockRealpath.mockReset();
    mockRealpath.mockImplementation((async (p: string) => p) as never);
    jest.useFakeTimers();
    emitFn = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start polling and track the session', () => {
    fakeGit({ '/repo': {} });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
    expect(monitor.activeCount).toBe(1);
  });

  it('should stop polling', () => {
    fakeGit({ '/repo': {} });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
    monitor.stop('sess-1');
    expect(monitor.activeCount).toBe(0);
  });

  it('should emit rebase-remote-status after successful poll', async () => {
    fakeGit({ '/repo': { aheadBehind: '2\t5\n', branch: 'feature-branch' } });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
    await settle();

    expect(emitFn).toHaveBeenCalledWith({
      type: 'rebase-remote-status',
      sessionId: 'sess-1',
      behind: 5,
      ahead: 2,
      remoteBranch: 'origin/main',
      localBranch: 'feature-branch',
    });
  });

  it('should emit error on git fetch failure', async () => {
    fakeGit({ '/repo': { fetchError: new Error('Network error') } });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
    await settle();

    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', source: 'RebaseMonitor' })
    );
    expect(statusesFor('sess-1')).toHaveLength(0);
  });

  it('should stopAll monitors', () => {
    fakeGit({ '/repo1': {}, '/repo2': {} });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo1', 'main', 'origin', 60000);
    monitor.start('sess-2', '/repo2', 'main', 'origin', 60000);

    monitor.stopAll();
    expect(monitor.activeCount).toBe(0);
  });

  it('should stop previous monitor on re-start for same session', () => {
    fakeGit({ '/repo1': {}, '/repo2': {} });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo1', 'main', 'origin', 60000);
    monitor.start('sess-1', '/repo2', 'develop', 'origin', 30000);

    expect(monitor.activeCount).toBe(1);
  });

  it('should handle graceful rev-list failure', async () => {
    fakeGit({ '/repo': { revListError: new Error('no upstream') } });

    const monitor = new RebaseMonitor(emitFn as EmitFn);
    monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
    await settle();

    // Should still emit with behind=0, ahead=0
    expect(emitFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'rebase-remote-status',
        behind: 0,
        ahead: 0,
      })
    );
  });

  describe('one fetch per repository', () => {
    // Three worktrees of one repository: each reports the shared common dir.
    const oneRepoThreeWorktrees: Record<string, FakeCheckout> = {
      '/repo': { commonDir: '.git', aheadBehind: '0\t3\n', branch: 'main' },
      '/wt/a': { commonDir: '/repo/.git', aheadBehind: '1\t3\n', branch: 'feature-a' },
      '/wt/b': { commonDir: '/repo/.git', aheadBehind: '2\t3\n', branch: 'feature-b' },
    };

    it('fetches once for several worktrees of one repository', async () => {
      fakeGit(oneRepoThreeWorktrees);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-main', '/repo', 'main', 'origin', 60000);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(1);
      // Each session still measures ahead/behind in its own checkout.
      expect(statusesFor('sess-main')).toEqual([expect.objectContaining({ ahead: 0, behind: 3, localBranch: 'main' })]);
      expect(statusesFor('sess-a')).toEqual([expect.objectContaining({ ahead: 1, behind: 3, localBranch: 'feature-a' })]);
      expect(statusesFor('sess-b')).toEqual([expect.objectContaining({ ahead: 2, behind: 3, localBranch: 'feature-b' })]);
    });

    it('fetches once per poll cycle, not once per session', async () => {
      fakeGit(oneRepoThreeWorktrees);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();
      expect(fetchCalls()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(60000);
      await settle();
      expect(fetchCalls()).toHaveLength(2);
      expect(statusesFor('sess-a')).toHaveLength(2);
      expect(statusesFor('sess-b')).toHaveLength(2);
    });

    it('reuses a fetch that finished within the poll interval', async () => {
      fakeGit(oneRepoThreeWorktrees);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      await settle();

      await jest.advanceTimersByTimeAsync(30000);
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(1);
      expect(statusesFor('sess-b')).toHaveLength(1);
    });

    it('fetches separately for different repositories', async () => {
      fakeGit({
        '/repo1': { commonDir: '.git' },
        '/repo2': { commonDir: '.git' },
      });

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-1', '/repo1', 'main', 'origin', 60000);
      monitor.start('sess-2', '/repo2', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls().map((call) => (call[2] as { cwd: string }).cwd).sort()).toEqual(['/repo1', '/repo2']);
    });

    it('fetches separately for different remotes of one repository', async () => {
      fakeGit(oneRepoThreeWorktrees);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      monitor.start('sess-b', '/wt/b', 'main', 'upstream', 60000);
      await settle();

      expect(fetchCalls().map((call) => (call[1] as string[])[3]).sort()).toEqual(['origin', 'upstream']);
    });

    it('treats a repository reached through a symlink as the same repository', async () => {
      fakeGit({
        '/real/repo': { commonDir: '.git' },
        '/link/repo': { commonDir: '.git' },
      });
      mockRealpath.mockImplementation((async (p: string) => p.replace(/^\/link\//, '/real/')) as never);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-1', '/real/repo', 'main', 'origin', 60000);
      monitor.start('sess-2', '/link/repo', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(1);
      expect(statusesFor('sess-1')).toHaveLength(1);
      expect(statusesFor('sess-2')).toHaveLength(1);
    });

    it('reports a failed shared fetch to every session on the repository', async () => {
      fakeGit({
        '/wt/a': { commonDir: '/repo/.git', fetchError: new Error('Could not resolve host') },
        '/wt/b': { commonDir: '/repo/.git', fetchError: new Error('Could not resolve host') },
      });

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(1);
      expect(errorsFor('sess-a')).toHaveLength(1);
      expect(errorsFor('sess-b')).toHaveLength(1);
      expect(statusesFor('sess-a')).toHaveLength(0);
      expect(statusesFor('sess-b')).toHaveLength(0);
    });

    it('fetches without triggering git auto-maintenance', async () => {
      fakeGit({ '/repo': {} });

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-1', '/repo', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(1);
      expect(fetchCalls()[0][1]).toEqual(['-c', 'maintenance.auto=false', 'fetch', 'origin', '--no-tags', '--quiet']);
    });

    it('fetches per checkout when the repository cannot be identified', async () => {
      const unreadable = new Error('fatal: not a git repository');
      fakeGit({
        '/wt/a': { commonDirError: unreadable },
        '/wt/b': { commonDirError: unreadable },
      });

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(2);
    });

    it('forgets a repository once its last session stops', async () => {
      fakeGit(oneRepoThreeWorktrees);

      const monitor = new RebaseMonitor(emitFn as EmitFn);
      monitor.start('sess-a', '/wt/a', 'main', 'origin', 60000);
      await settle();
      monitor.stop('sess-a');

      // A new session right away gets a fresh fetch, not the stopped group's result.
      monitor.start('sess-b', '/wt/b', 'main', 'origin', 60000);
      await settle();

      expect(fetchCalls()).toHaveLength(2);
    });
  });
});
