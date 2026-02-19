/**
 * AgentMonitor
 * Watches .S9N_KIT_DevOpsAgent directories for agent registrations,
 * session reports, heartbeats, and activity logs in the utility process.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import type { WorkerEvent } from '../worker-protocol';

const WATCHED_SUBDIRS = ['agents', 'sessions', 'heartbeats', 'activity'] as const;

type WatchedSubdir = typeof WATCHED_SUBDIRS[number];

// Map subdirectory names to event subtypes
const SUBDIR_TO_SUBTYPE: Record<WatchedSubdir, 'agent' | 'session' | 'heartbeat' | 'activity'> = {
  agents: 'agent',
  sessions: 'session',
  heartbeats: 'heartbeat',
  activity: 'activity',
};

export class AgentMonitor {
  private watchers: Map<string, FSWatcher> = new Map();
  private baseDir: string | null = null;

  constructor(private emit: (event: WorkerEvent) => void) {}

  start(baseDir: string): void {
    this.stop();
    this.baseDir = baseDir;

    for (const subdir of WATCHED_SUBDIRS) {
      const dirPath = path.join(baseDir, '.S9N_KIT_DevOpsAgent', subdir);
      const subtype = SUBDIR_TO_SUBTYPE[subdir];

      const watcher = chokidar.watch(dirPath, {
        persistent: true,
        ignoreInitial: false,
        depth: 0,
      });

      const handleEvent = (action: 'add' | 'change' | 'unlink') => (filePath: string) => {
        // Only process JSON files
        if (!filePath.endsWith('.json')) return;
        this.emit({
          type: 'agent-file-event',
          subtype,
          action,
          filePath,
        });
      };

      watcher.on('add', handleEvent('add'));
      watcher.on('change', handleEvent('change'));
      watcher.on('unlink', handleEvent('unlink'));

      watcher.on('error', (error) => {
        // Directory may not exist yet; that's OK
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.emit({
            type: 'error',
            source: 'AgentMonitor',
            message: `Watcher error for ${subdir}: ${error.message}`,
          });
        }
      });

      this.watchers.set(subdir, watcher);
    }

    console.log(`[AgentMonitor] Started watching ${baseDir}`);
  }

  stop(): void {
    for (const [name, watcher] of this.watchers) {
      watcher.close().catch((err) => {
        console.error(`[AgentMonitor] Error closing ${name} watcher:`, err);
      });
    }
    this.watchers.clear();
    this.baseDir = null;
    console.log('[AgentMonitor] Stopped all watchers');
  }

  get activeCount(): number {
    return this.watchers.size > 0 ? 1 : 0;
  }
}
