/**
 * The watcher makes no commit of its own in an adopted session unless
 * auto-commit was asked for (kit_adopt_session auto_commit: true).
 *
 * Two watcher paths commit without a kit_* call: the commit-message file
 * (.claude-commit-msg / .devops-commit-*.msg) and the idle-end auto-checkpoint.
 * Both read the session's live config, so kit_update_session takes effect at
 * once. Sessions that are not adopted keep their old behaviour.
 *
 * The watcher key need not be the live session id: the app-launch restart
 * leaves the old-id watcher running after restartInstance replaced the
 * instance, so the gate resolves restart predecessors. While the key resolves
 * to nothing (mid-restart) the settings captured at watcher start decide.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined as never),
    })),
  },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => true),
    promises: {
      readFile: jest.fn().mockResolvedValue('feat: a message' as never),
      writeFile: jest.fn().mockResolvedValue(undefined as never),
    },
  };
});

jest.mock('../../../electron/services/DatabaseService', () => ({
  databaseService: {
    getSetting: jest.fn(() => []),
    setSetting: jest.fn(),
    recordCommit: jest.fn(),
    recordSessionEvent: jest.fn(),
  },
}));

import { promises as fsp } from 'fs';
import { WatcherService } from '../../../electron/services/WatcherService';

const SESSION = 'sess_adopt1';
const WORKTREE = '/repos/KIT-DevOps-app/kit-pr-branch';
const REPO = '/repos/app';

function watcherInstance(over: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    worktreePath: WORKTREE,
    repoPath: REPO,
    agentType: 'claude' as const,
    branchName: 'kit/pr-branch',
    watcher: null,
    commitMsgFile: `${WORKTREE}/.devops-commit-adopt1.msg`,
    claudeCommitMsgFile: `${WORKTREE}/.claude-commit-msg`,
    ...over,
  };
}

function build(config: Record<string, unknown>, instances?: any[]) {
  const gitService: any = {
    registerWorktree: jest.fn(),
    commit: jest.fn().mockResolvedValue({ success: true, data: { hash: 'abc123def', shortHash: 'abc123' } } as never),
    getStatus: jest.fn().mockResolvedValue({ success: true, data: { changes: [] } } as never),
    push: jest.fn().mockResolvedValue({ success: true } as never),
  };
  const activityService: any = { log: jest.fn(), logFileActivity: jest.fn(), linkToCommit: jest.fn(() => 0) };
  const service = new WatcherService(gitService, activityService);
  (service as any).emitToRenderer = jest.fn();
  // Like the real one: getInstance matches the instance id or live session id
  // only — never a restart predecessor.
  const live = instances ?? [{ id: 'inst_1', sessionId: SESSION, config }];
  service.setAgentInstanceService({
    getInstance: (id: string) => ({
      success: true,
      data: live.find((i) => i.id === id || i.sessionId === id) ?? null,
    }),
    listInstances: () => ({ success: true, data: live }),
    updateLastProcessedCommit: jest.fn(),
  } as any);
  return { service, gitService, activityService };
}

describe('WatcherService in an adopted session', () => {
  let service: WatcherService | undefined;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await service?.dispose();
    service = undefined;
  });

  async function fireCommitMsgFile(config: Record<string, unknown>, instances?: any[], over: Record<string, unknown> = {}) {
    jest.useFakeTimers();
    const h = build(config, instances);
    service = h.service;
    const inst = watcherInstance(over);
    await (h.service as any).triggerCommit(inst, inst.claudeCommitMsgFile);
    await jest.advanceTimersByTimeAsync(1500);
    return h;
  }

  it('ignores the commit-message file when auto-commit is off', async () => {
    const h = await fireCommitMsgFile({ createdBy: 'adopted', autoCommit: false });
    expect(h.gitService.commit).not.toHaveBeenCalled();
    expect(h.activityService.log).toHaveBeenCalledWith(
      SESSION,
      'info',
      expect.stringMatching(/auto-commit is off/)
    );
  });

  it('clears the ignored commit-message file, so it is never committed later', async () => {
    (fsp.writeFile as jest.Mock).mockClear();
    const h = await fireCommitMsgFile({ createdBy: 'adopted', autoCommit: false });
    expect(h.gitService.commit).not.toHaveBeenCalled();
    expect(fsp.writeFile).toHaveBeenCalledWith(`${WORKTREE}/.claude-commit-msg`, '');
  });

  it('does nothing, and logs nothing, for an empty commit-message file', async () => {
    (fsp.readFile as jest.Mock).mockResolvedValueOnce('' as never);
    (fsp.writeFile as jest.Mock).mockClear();
    const h = await fireCommitMsgFile({ createdBy: 'adopted', autoCommit: false });
    expect(h.gitService.commit).not.toHaveBeenCalled();
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(h.activityService.log).not.toHaveBeenCalled();
  });

  it('resolves a watcher keyed by a restart-predecessor id to the live instance', async () => {
    // The app-launch restart starts a watcher under the OLD id, then
    // restartInstance replaces the instance. getInstance(old id) finds nothing.
    const replaced = [
      { id: 'inst_2', sessionId: 'sess_new', predecessorSessionIds: [SESSION], config: { createdBy: 'adopted', autoCommit: false } },
    ];
    const h = await fireCommitMsgFile({}, replaced);
    expect(h.gitService.commit).not.toHaveBeenCalled();
    const r = await (h.service as any).tryIdleEndAutoCommit(watcherInstance(), SESSION, 5, Date.now());
    expect(r).toEqual({ committed: false, skipReason: 'auto-commit is off for this adopted session' });
  });

  it('still commits through a predecessor-keyed watcher of a session that is not adopted', async () => {
    const replaced = [
      { id: 'inst_2', sessionId: 'sess_new', predecessorSessionIds: [SESSION], config: { createdBy: 'mcp', autoCommit: true } },
    ];
    const h = await fireCommitMsgFile({}, replaced);
    expect(h.gitService.commit).toHaveBeenCalled();
  });

  it('uses the settings captured at watcher start while the session resolves to nothing (mid-restart)', async () => {
    const adopted = { startAutoCommit: { createdBy: 'adopted', autoCommit: false } };
    const h = await fireCommitMsgFile({}, [], adopted);
    expect(h.gitService.commit).not.toHaveBeenCalled();
    const r = await (h.service as any).tryIdleEndAutoCommit(watcherInstance(adopted), SESSION, 5, Date.now());
    expect(r).toEqual({ committed: false, skipReason: 'auto-commit is off for this adopted session' });
  });

  it('keeps the old behaviour for an unresolved watcher with no captured settings', async () => {
    const h = await fireCommitMsgFile({}, []);
    expect(h.gitService.commit).toHaveBeenCalled();
  });

  it('captures the adopted settings when the watcher starts', async () => {
    const h = build({ createdBy: 'adopted', autoCommit: false });
    service = h.service;
    const started = await h.service.startWithPath(SESSION, WORKTREE);
    expect(started).toEqual({ success: true });
    expect((h.service as any).watchers.get(SESSION).startAutoCommit).toEqual({ createdBy: 'adopted', autoCommit: false });
  });

  it('resolves a multi-repo id:repo watcher key to its session', async () => {
    const h = build({ createdBy: 'adopted', autoCommit: false });
    service = h.service;
    const r = await (h.service as any).tryIdleEndAutoCommit(watcherInstance(), `${SESSION}:app`, 5, Date.now());
    expect(r).toEqual({ committed: false, skipReason: 'auto-commit is off for this adopted session' });
  });

  it('commits from the commit-message file when auto-commit was asked for', async () => {
    const h = await fireCommitMsgFile({ createdBy: 'adopted', autoCommit: true });
    expect(h.gitService.commit).toHaveBeenCalledWith(SESSION, 'feat: a message', undefined);
  });

  it('still commits from the commit-message file for a session that is not adopted', async () => {
    const h = await fireCommitMsgFile({ createdBy: 'mcp', autoCommit: false });
    expect(h.gitService.commit).toHaveBeenCalled();
  });

  it('skips the idle-end auto-checkpoint when auto-commit is off', async () => {
    const h = build({ createdBy: 'adopted', autoCommit: false });
    service = h.service;
    const r = await (h.service as any).tryIdleEndAutoCommit(watcherInstance(), SESSION, 5, Date.now());
    expect(r).toEqual({ committed: false, skipReason: 'auto-commit is off for this adopted session' });
    expect(h.gitService.commit).not.toHaveBeenCalled();
  });
});
