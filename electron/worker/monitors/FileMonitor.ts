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
        if (filePath.includes('node_modules')) return true;
        if (filePath.includes('.git')) return true;
        if (filePath.includes('.worktrees')) return true;
        if (filePath.includes('/dist/')) return true;
        if (filePath.includes('/build/')) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 500,
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

    console.log(`[FileMonitor] Started watching ${worktreePath} for session ${sessionId}`);
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.watcher.close().catch((err) => {
        console.error(`[FileMonitor] Error closing watcher for ${sessionId}:`, err);
      });
      this.sessions.delete(sessionId);
      console.log(`[FileMonitor] Stopped watching session ${sessionId}`);
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
