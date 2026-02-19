/**
 * RebaseMonitor
 * Polls remote branches via git commands in the utility process.
 * Detects when remote base branch has new commits, emitting events to main process.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { WorkerEvent } from '../worker-protocol';

const execFileAsync = promisify(execFile);

interface RebaseMonitorSession {
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  remoteName: string;
  pollIntervalMs: number;
  intervalId: NodeJS.Timeout;
}

export class RebaseMonitor {
  private sessions: Map<string, RebaseMonitorSession> = new Map();

  constructor(private emit: (event: WorkerEvent) => void) {}

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

    console.log(`[RebaseMonitor] Started polling ${repoPath} for ${sessionId} every ${pollIntervalMs / 1000}s`);
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      clearInterval(session.intervalId);
      this.sessions.delete(sessionId);
      console.log(`[RebaseMonitor] Stopped polling ${sessionId}`);
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
      // Fetch latest from remote
      await execFileAsync('git', ['fetch', remoteName, '--no-tags', '--quiet'], {
        cwd: repoPath,
        timeout: 30000,
      });

      // Get behind/ahead counts
      const remoteBranch = `${remoteName}/${baseBranch}`;
      let behind = 0;
      let ahead = 0;

      try {
        const { stdout } = await execFileAsync(
          'git',
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
          'git',
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

  get activeCount(): number {
    return this.sessions.size;
  }
}
