/**
 * RebaseMonitor
 * Polls remote branches via git commands in the utility process.
 * Detects when remote base branch has new commits, emitting events to main process.
 *
 * One fetch per repository, not per session. Sessions are usually worktrees,
 * and every worktree of a repository shares one object store and one set of
 * remote-tracking refs, so a fetch in any of them updates all of them. Polling
 * each session's worktree on its own timer ran one `git fetch` per worktree
 * per cycle: with 20+ sessions on one repository that was 20+ concurrent
 * fetches into the same object store every minute. Sessions are therefore
 * grouped by their repository (the real path of the git common dir) and
 * remote; a fetch already running for the group is shared, and one that
 * finished within the poll interval is reused. Ahead/behind is still measured
 * in each session's own checkout, which is local and cheap.
 *
 * The fetch also opts out of git's auto-maintenance. Every fetch that receives
 * objects otherwise spawns a detached `git maintenance run --auto`; with git
 * 2.54 and no maintenance config that runs `git repack --geometric=2
 * --write-midx`. Many of those racing concurrent fetches in one shared object
 * store is the likely way a repository ended up with a multi-pack-index
 * pointing at a deleted pack. A background status poll should not be what
 * triggers repository maintenance.
 */

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import type { WorkerEvent } from '../worker-protocol';

const execFileAsync = promisify(execFile);

/**
 * A fetch for a repository is reused by any session that polls within this
 * fraction of its own poll interval after the fetch finished. Below 1 so a
 * session whose turn comes round a full interval later always fetches again.
 */
const FETCH_REUSE_FRACTION = 0.9;

interface RebaseMonitorSession {
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  remoteName: string;
  pollIntervalMs: number;
  intervalId: NodeJS.Timeout;
  /** Repository + remote this session fetches for; resolved on first poll. */
  fetchKey?: string;
}

/** Shared fetch state for every session on one repository and remote. */
interface RepoFetchState {
  inFlight: Promise<void> | null;
  /** Date.now() when the last fetch for this repository finished; 0 if never. */
  finishedAt: number;
  /** Outcome of that fetch, so a reused result reports the same failure. */
  error: Error | null;
}

export class RebaseMonitor {
  private sessions: Map<string, RebaseMonitorSession> = new Map();
  private repoFetches: Map<string, RepoFetchState> = new Map();
  private gitBinary = 'git'; // Default, overridden by configure

  constructor(private emit: (event: WorkerEvent) => void) {}

  /** Set the resolved git binary path (called once on worker startup) */
  setGitPath(gitPath: string): void {
    this.gitBinary = gitPath;
  }

  start(
    sessionId: string,
    repoPath: string,
    baseBranch: string,
    remoteName: string,
    pollIntervalMs: number
  ): void {
    // Stop existing monitor for this session
    this.stop(sessionId);

    // Start polling
    const intervalId = setInterval(() => {
      this.poll(sessionId).catch((err) => {
        this.emit({
          type: 'error',
          source: 'RebaseMonitor',
          message: `Poll error for ${sessionId}: ${err.message}`,
        });
      });
    }, pollIntervalMs);

    this.sessions.set(sessionId, {
      sessionId,
      repoPath,
      baseBranch,
      remoteName,
      pollIntervalMs,
      intervalId,
    });

    // Do an immediate first poll
    this.poll(sessionId).catch(() => {});

    this.emit({ type: 'log', level: 'info', source: 'RebaseMonitor', message: `Started polling ${repoPath} for ${sessionId} every ${pollIntervalMs / 1000}s` });
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      clearInterval(session.intervalId);
      this.sessions.delete(sessionId);
      this.forgetRepoIfUnused(session.fetchKey);
      this.emit({ type: 'log', level: 'info', source: 'RebaseMonitor', message: `Stopped polling ${sessionId}` });
    }
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stop(sessionId);
    }
  }

  private async poll(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { repoPath, baseBranch, remoteName } = session;

    try {
      // Fetch latest from remote, once for every session on this repository
      await this.fetchForRepo(session);

      // Get behind/ahead counts
      const remoteBranch = `${remoteName}/${baseBranch}`;
      let behind = 0;
      let ahead = 0;

      try {
        const { stdout } = await execFileAsync(
          this.gitBinary,
          ['rev-list', '--left-right', '--count', `HEAD...${remoteBranch}`],
          { cwd: repoPath, timeout: 10000 }
        );
        const parts = stdout.trim().split(/\s+/);
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      } catch {
        // Branch may not have upstream tracking
      }

      // Get current branch name
      let localBranch = 'HEAD';
      try {
        const { stdout } = await execFileAsync(
          this.gitBinary,
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: repoPath, timeout: 5000 }
        );
        localBranch = stdout.trim();
      } catch {
        // Ignore
      }

      this.emit({
        type: 'rebase-remote-status',
        sessionId,
        behind,
        ahead,
        remoteBranch,
        localBranch,
      });
    } catch (err) {
      this.emit({
        type: 'error',
        source: 'RebaseMonitor',
        message: `Git fetch failed for ${sessionId}: ${(err as Error).message}`,
      });
    }
  }

  /**
   * Fetch the session's remote, sharing the fetch with every other session on
   * the same repository: join one that is running, reuse one that finished
   * within this session's poll interval, otherwise start one.
   */
  private async fetchForRepo(session: RebaseMonitorSession): Promise<void> {
    const key = await this.resolveFetchKey(session);
    let state = this.repoFetches.get(key);
    if (!state) {
      state = { inFlight: null, finishedAt: 0, error: null };
      this.repoFetches.set(key, state);
    }

    if (state.inFlight) return state.inFlight;

    const reuseWindowMs = session.pollIntervalMs * FETCH_REUSE_FRACTION;
    if (state.finishedAt > 0 && Date.now() - state.finishedAt < reuseWindowMs) {
      if (state.error) throw state.error;
      return;
    }

    const shared = state;
    shared.inFlight = execFileAsync(
      this.gitBinary,
      ['-c', 'maintenance.auto=false', 'fetch', session.remoteName, '--no-tags', '--quiet'],
      { cwd: session.repoPath, timeout: 30000 }
    )
      .then(
        () => {
          shared.error = null;
        },
        (err: Error) => {
          shared.error = err;
          throw err;
        }
      )
      .finally(() => {
        shared.finishedAt = Date.now();
        shared.inFlight = null;
      });
    return shared.inFlight;
  }

  /**
   * The repository a session's checkout belongs to, as the real path of its
   * git common dir plus the remote. Every worktree of a repository resolves to
   * the same key, whatever path (or symlink) it was opened through. If the
   * common dir cannot be read, the session is keyed by its own path and
   * fetches on its own, as before.
   */
  private async resolveFetchKey(session: RebaseMonitorSession): Promise<string> {
    if (session.fetchKey) return session.fetchKey;

    let repoDir = resolve(session.repoPath);
    try {
      const { stdout } = await execFileAsync(
        this.gitBinary,
        ['rev-parse', '--git-common-dir'],
        { cwd: session.repoPath, timeout: 5000 }
      );
      const commonDir = stdout.trim();
      if (commonDir) repoDir = resolve(session.repoPath, commonDir);
    } catch {
      // Not readable (e.g. the worktree is gone): fetch for this checkout alone
    }
    try {
      repoDir = await fsp.realpath(repoDir);
    } catch {
      // Keep the unresolved path
    }

    session.fetchKey = `${repoDir}\u0000${session.remoteName}`;
    return session.fetchKey;
  }

  /** Drop a repository's fetch state once no session is polling it. */
  private forgetRepoIfUnused(fetchKey: string | undefined): void {
    if (!fetchKey) return;
    for (const other of this.sessions.values()) {
      if (other.fetchKey === fetchKey) return;
    }
    this.repoFetches.delete(fetchKey);
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}
