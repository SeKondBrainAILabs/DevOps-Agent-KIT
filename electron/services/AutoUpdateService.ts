/**
 * AutoUpdateService
 * Handles app auto-updates via direct GitHub Releases API check.
 * Does NOT use electron's native autoUpdater (Squirrel.Mac) because that
 * requires a Developer ID code signature. Instead we fetch latest-mac.yml
 * directly.
 *
 * On macOS, when the install can replace itself, MacSelfUpdater downloads,
 * verifies, test-launches and installs the release (with rollback). Anywhere
 * else — other platforms, or an app folder this user cannot write — "install"
 * opens the release page as before.
 */

import { BrowserWindow, app, shell } from 'electron';
import { join } from 'path';
import { IPC } from '../../shared/ipc-channels';
import type { AppUpdateInfo } from '../../shared/types';
import https from 'https';
import type { DebugLogService } from './DebugLogService';
import { MacSelfUpdater, SMOKE_ENV } from './MacSelfUpdater';
import {
  appBundleFromExecPath,
  describeInstallResult,
  isNewerVersion,
} from '../../shared/mac-self-update';

const OWNER = 'SeKondBrainAILabs';
const REPO = 'DevOps-Agent-KIT';

export class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null;
  private status: AppUpdateInfo;
  private debugLog: DebugLogService | null = null;
  /** Set only when this install can replace itself (macOS, packaged, writable). */
  private macUpdater: MacSelfUpdater | null = null;
  private staged: { stagedAppPath: string; version: string } | null = null;
  private preparing: Promise<void> | null = null;
  /** Set once install has handed over to the swap script; further clicks are ignored. */
  private installing = false;
  /** What the last install did, if the user needs to know. Survives update checks. */
  private installNotice: string | undefined;
  private updatesDir: string | null = null;

  constructor() {
    this.status = {
      currentVersion: app.getVersion(),
      updateAvailable: false,
      downloading: false,
      downloaded: false,
    };
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setDebugLog(debugLog: DebugLogService): void {
    this.debugLog = debugLog;
  }

  /**
   * Set up the macOS self-updater when it can work here, report how the last
   * install went, and record that this version started (the swap script waits
   * for that marker before declaring an update good).
   */
  initialize(): void {
    if (!app.isPackaged) {
      console.log('[AutoUpdate] Skipping auto-updater setup in development mode');
      return;
    }
    if (process.platform !== 'darwin') return;

    const updatesDir = join(app.getPath('userData'), 'updates');
    this.updatesDir = updatesDir;
    const appPath = appBundleFromExecPath(process.execPath);
    if (process.env[SMOKE_ENV]) return; // the isolated test launch never updates anything

    if (appPath) {
      const updater = new MacSelfUpdater({
        updatesDir,
        appPath,
        currentVersion: app.getVersion(),
        arch: process.arch,
        userAgent: `KanvasForKit/${app.getVersion()}`,
        log: (message, details) => this.debugLog?.info('AutoUpdate', message, details),
      });
      const last = updater.takeInstallResult();
      if (last) {
        this.debugLog?.info('AutoUpdate', 'Last install', { ...last });
        if (last.outcome === 'rolled_back') updater.blockVersion(last.to);
        this.installNotice = describeInstallResult(last, app.getVersion()) ?? undefined;
        this.status.error = this.installNotice;
      }
      const ready = updater.readiness();
      if (ready.ok) {
        this.macUpdater = updater;
      } else {
        this.debugLog?.warn('AutoUpdate', 'Self-update unavailable; will open the release page', {
          reason: ready.reason,
        });
      }
    }
  }

  /**
   * The renderer calls this once it has mounted. Reaching here proves the
   * main process, its IPC handlers and the UI all came up, which is what the
   * swap script and the isolated test launch wait for. A failed page load
   * (the "failed to load" data: page) never makes this call.
   */
  markStarted(): void {
    if (!this.updatesDir || process.platform !== 'darwin' || !app.isPackaged) return;
    MacSelfUpdater.writeStartedMarker(this.updatesDir, app.getVersion());
    if (process.env[SMOKE_ENV]) setTimeout(() => app.quit(), 300);
  }

  /**
   * Check for available updates by fetching latest-mac.yml directly from GitHub.
   * Works without code signing, no Squirrel.Mac involved.
   */
  async checkForUpdates(): Promise<AppUpdateInfo> {
    if (!app.isPackaged) {
      return { ...this.status };
    }

    this.debugLog?.info('AutoUpdate', 'Checking for updates', { currentVersion: app.getVersion() });

    try {
      this.status.error = this.installNotice;
      const latestVersion = await this.fetchLatestVersion();
      if (!latestVersion) {
        return { ...this.status };
      }

      const current = app.getVersion();
      const blocked = this.macUpdater?.blockedVersion();
      if (blocked && blocked === latestVersion) {
        this.debugLog?.info('AutoUpdate', 'Skipping a version that failed to start here', { version: latestVersion });
      }
      if (isNewerVersion(latestVersion, current) && blocked !== latestVersion) {
        console.log(`[AutoUpdate] Update available: ${current} → ${latestVersion}`);
        this.status.updateAvailable = true;
        this.status.latestVersion = latestVersion;
        this.debugLog?.info('AutoUpdate', 'Update available', { current, latestVersion });
        this.sendToRenderer(IPC.UPDATE_AVAILABLE, this.status);
      } else {
        console.log(`[AutoUpdate] Up to date: ${current}`);
        this.status.updateAvailable = false;
        this.status.latestVersion = latestVersion;
        this.debugLog?.info('AutoUpdate', 'No update available', { current, latestVersion });
        this.sendToRenderer(IPC.UPDATE_NOT_AVAILABLE, this.status);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AutoUpdate] Check failed:', msg);
      this.status.error = msg;
      this.debugLog?.error('AutoUpdate', 'Update check failed', { error: msg });
      this.sendToRenderer(IPC.UPDATE_ERROR, this.status);
    }

    return { ...this.status };
  }

  /**
   * Download the update. On a self-updating Mac this really downloads,
   * verifies and test-launches it, reporting progress; elsewhere it marks the
   * update ready so "install" can open the release page.
   */
  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return;
    if (!this.macUpdater) {
      this.status.downloading = false;
      this.status.downloaded = true;
      this.debugLog?.info('AutoUpdate', 'Download complete — marked ready', { version: this.status.latestVersion });
      this.sendToRenderer(IPC.UPDATE_DOWNLOADED, this.status);
      return;
    }
    if (this.installing) return;
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareMacUpdate().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  private async prepareMacUpdate(): Promise<void> {
    const updater = this.macUpdater!;
    // Preparing deletes the staging folder, so the old staged bundle is gone.
    this.staged = null;
    this.status.error = undefined;
    this.status.downloading = true;
    this.status.downloaded = false;
    this.sendToRenderer(IPC.UPDATE_PROGRESS, this.status);
    try {
      // Re-read the feed so the checksum belongs to the version being installed.
      const feed = await updater.fetchFeed();
      if (!isNewerVersion(feed.version, app.getVersion())) {
        throw new Error(`v${feed.version} is not newer than v${app.getVersion()}`);
      }
      this.status.latestVersion = feed.version;
      this.staged = await updater.prepare(feed, (progress) => {
        this.status.progress = progress;
        this.sendToRenderer(IPC.UPDATE_PROGRESS, this.status);
      });
      this.status.downloading = false;
      this.status.downloaded = true;
      this.status.progress = undefined;
      this.sendToRenderer(IPC.UPDATE_DOWNLOADED, this.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.staged = null;
      this.status.downloading = false;
      this.status.downloaded = false;
      this.status.progress = undefined;
      this.status.error = `Update not installed: ${msg}`;
      this.debugLog?.error('AutoUpdate', 'Update preparation failed', { error: msg });
      this.sendToRenderer(IPC.UPDATE_ERROR, this.status);
      throw err;
    }
  }

  /**
   * Install. On a self-updating Mac with a verified, test-launched update this
   * hands over to the swap script and quits; otherwise it opens the release page.
   */
  installUpdate(): void {
    if (!app.isPackaged) return;
    if (this.macUpdater) {
      // One hand-over only, and never while a download is still preparing.
      if (this.installing || this.preparing) return;
      if (!this.staged) {
        this.status.error = 'The update is not downloaded yet.';
        this.sendToRenderer(IPC.UPDATE_ERROR, this.status);
        return;
      }
      this.installing = true;
      this.debugLog?.info('AutoUpdate', 'Installing update', { version: this.staged.version });
      this.macUpdater.launchSwap(this.staged.stagedAppPath, this.staged.version);
      app.quit();
      return;
    }
    const version = this.status.latestVersion;
    const releaseUrl = version
      ? `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`
      : `https://github.com/${OWNER}/${REPO}/releases/latest`;
    console.log('[AutoUpdate] Opening release page:', releaseUrl);
    this.debugLog?.info('AutoUpdate', 'Opening release page for install', { version: this.status.latestVersion });
    shell.openExternal(releaseUrl);
  }

  /**
   * Return the current update status snapshot.
   */
  getStatus(): AppUpdateInfo {
    return { ...this.status };
  }

  // ---------------------------------------------------------------------------

  private fetchLatestVersion(): Promise<string | null> {
    const base = process.env.KIT_UPDATE_FEED_BASE?.replace(/\/+$/, '');
    const startUrl = base
      ? `${base}/latest-mac.yml`
      : `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest-mac.yml`;
    return this.fetchFollowingRedirects(startUrl, 0);
  }

  /** Fetch a URL following up to maxRedirects 3xx hops (GitHub uses 2). */
  private fetchFollowingRedirects(url: string, depth: number): Promise<string | null> {
    if (depth > 5) return Promise.resolve(null); // safety cap
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https');
      const client = isHttps ? https : (require('http') as typeof import('http'));
      const req = client.get(url, {
        headers: { 'User-Agent': `KanvasForKit/${app.getVersion()}` },
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          res.resume(); // drain & discard redirect body
          if (!location) { resolve(null); return; }
          this.fetchFollowingRedirects(location, depth + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        this.readBody(res).then((body) => resolve(this.parseVersion(body))).catch(reject);
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Update check timed out')); });
    });
  }

  private readBody(res: import('http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  }

  private parseVersion(yml: string): string | null {
    const match = yml.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  private sendToRenderer(channel: string, data: AppUpdateInfo): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}
