/**
 * KanvasHeartbeatWriter
 * Writes a heartbeat file so external agents can detect when Kanvas is alive.
 * Runs in the utility process, writes every 30 seconds.
 */

import { promises as fs } from 'fs';
import path from 'path';

const WRITE_INTERVAL_MS = 30 * 1000; // 30 seconds
const startTime = Date.now();

export class KanvasHeartbeatWriter {
  private interval: NodeJS.Timeout | null = null;
  private heartbeatDir: string | null = null;
  private appVersion: string = 'unknown';

  start(heartbeatDir: string, appVersion: string): void {
    this.stop();
    this.heartbeatDir = heartbeatDir;
    this.appVersion = appVersion;

    // Write immediately, then on interval
    this.writeHeartbeat().catch(() => {});
    this.interval = setInterval(() => {
      this.writeHeartbeat().catch(() => {});
    }, WRITE_INTERVAL_MS);

    console.log(`[KanvasHeartbeatWriter] Started writing heartbeats to ${heartbeatDir}`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.heartbeatDir = null;
    console.log('[KanvasHeartbeatWriter] Stopped');
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.heartbeatDir) return;

    const heartbeatFile = path.join(this.heartbeatDir, 'kanvas.json');
    const data = {
      process: 'kanvas',
      pid: process.pid,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
      version: this.appVersion,
    };

    try {
      await fs.mkdir(this.heartbeatDir, { recursive: true });
      await fs.writeFile(heartbeatFile, JSON.stringify(data, null, 2));
    } catch {
      // Directory might not be writable; silently ignore
    }
  }

  get isActive(): boolean {
    return this.interval !== null;
  }
}
