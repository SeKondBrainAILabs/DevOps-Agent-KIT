/**
 * FileMonitor
 * Runs chokidar file watchers in the utility process.
 * Detects file changes and commit message files, emitting events to main process.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import type { WorkerEvent } from '../worker-protocol';

interface FileMonitorSession {
  sessionId: string;
  worktreePath: string;
  commitMsgFile: string;
  claudeCommitMsgFile: string;
  watcher: FSWatcher;
}

export class FileMonitor {
  private sessions: Map<string, FileMonitorSession> = new Map();

  constructor(private emit: (event: WorkerEvent) => void) {}

  start(
    sessionId: string,
    worktreePath: string,
    commitMsgFile: string,
    claudeCommitMsgFile: string
  ): void {
    // Stop existing watcher for this session
    this.stop(sessionId);

    const watcher = chokidar.watch(worktreePath, {
      ignored: (filePath: string) => {
        const basename = path.basename(filePath);
        // Allow commit message files
        if (
          basename === '.claude-commit-msg' ||
          basename.startsWith('.devops-commit-') ||
          basename.startsWith('.claude-session-')
        ) {
          return false;
        }
        // Ignore other dotfiles and common directories
        if (basename.startsWith('.')) return true;
        // Nested worktree containers (`local_deploy`, `.worktrees`): a worktree
        // checkout can hold its own local_deploy with OTHER sessions' worktrees,
        // and via symlinks/submodules this nests arbitrarily deep — recursing in
        // produces thousands of phantom add events → main-process memory runaway.
        // Check segments RELATIVE to the watched root (a substring check would
        // self-ignore the root, whose own path contains '/local_deploy/').
        const rel = path.relative(worktreePath, filePath);
        if (rel) {
          const segs = rel.split(path.sep);
          if (segs.includes('local_deploy') || segs.includes('.worktrees')) return true;
        }
        if (filePath.includes('node_modules')) return true;
        if (filePath.includes('.git')) return true;
        if (filePath.includes('/dist/')) return true;
        if (filePath.includes('/build/')) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      // Do NOT follow symlinks — repos link to sibling repos (e.g. lib/*-link),
      // and following them recurses into other repos' worktree trees (unbounded).
      followSymlinks: false,
      awaitWriteFinish: {
        // 30s stability window — see WatcherService.ts for rationale. Worker
        // watcher needs the same value so both code paths agree.
        stabilityThreshold: 30_000,
        pollInterval: 2_000,
      },
    });

    const handleChange = (filePath: string, changeType: 'add' | 'change' | 'unlink') => {
      // Check if this is a commit message file
      if (filePath === commitMsgFile || filePath === claudeCommitMsgFile) {
        if (changeType !== 'unlink') {
          this.emit({
            type: 'commit-msg-detected',
            sessionId,
            commitMsgFilePath: filePath,
          });
        }
        return;
      }

      this.emit({
        type: 'file-changed',
        sessionId,
        filePath,
        changeType,
      });
    };

    watcher.on('add', (fp) => handleChange(fp, 'add'));
    watcher.on('change', (fp) => handleChange(fp, 'change'));
    watcher.on('unlink', (fp) => handleChange(fp, 'unlink'));

    watcher.on('error', (error) => {
      this.emit({
        type: 'error',
        source: 'FileMonitor',
        message: `Watcher error for ${sessionId}: ${error.message}`,
      });
    });

    this.sessions.set(sessionId, {
      sessionId,
      worktreePath,
      commitMsgFile,
      claudeCommitMsgFile,
      watcher,
    });

    this.emit({ type: 'log', level: 'info', source: 'FileMonitor', message: `Started watching ${worktreePath} for session ${sessionId}` });
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.watcher.close().catch((err) => {
        this.emit({ type: 'log', level: 'error', source: 'FileMonitor', message: `Error closing watcher for ${sessionId}: ${err}` });
      });
      this.sessions.delete(sessionId);
      this.emit({ type: 'log', level: 'info', source: 'FileMonitor', message: `Stopped watching session ${sessionId}` });
    }
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stop(sessionId);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}
