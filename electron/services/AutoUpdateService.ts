/**
 * AutoUpdateService
 * Handles app auto-updates via electron-updater with GitHub Releases
 */

import { BrowserWindow, app } from 'electron';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { IPC } from '../../shared/ipc-channels';
import type { AppUpdateInfo } from '../../shared/types';

export class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null;
  private status: AppUpdateInfo;

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

  /**
   * Initialize the auto-updater with event listeners.
   * Should be called once after the main window is ready.
   */
  initialize(): void {
    // Don't run auto-updater in development
    if (!app.isPackaged) {
      console.log('[AutoUpdate] Skipping auto-updater setup in development mode');
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdate] Checking for updates...');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AutoUpdate] Update available:', info.version);
      this.status.updateAvailable = true;
      this.status.latestVersion = info.version;
      this.status.releaseNotes = typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined;
      this.status.releaseDate = info.releaseDate;
      this.status.error = undefined;
      this.sendToRenderer(IPC.UPDATE_AVAILABLE, this.status);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log('[AutoUpdate] No update available. Current:', info.version);
      this.status.updateAvailable = false;
      this.status.latestVersion = info.version;
      this.status.error = undefined;
      this.sendToRenderer(IPC.UPDATE_NOT_AVAILABLE, this.status);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.status.downloading = true;
      this.status.progress = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      };
      this.sendToRenderer(IPC.UPDATE_PROGRESS, this.status);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AutoUpdate] Update downloaded:', info.version);
      this.status.downloading = false;
      this.status.downloaded = true;
      this.status.progress = undefined;
      this.sendToRenderer(IPC.UPDATE_DOWNLOADED, this.status);
    });

    autoUpdater.on('error', (err: Error) => {
      console.error('[AutoUpdate] Error:', err.message);
      this.status.downloading = false;
      this.status.error = err.message;
      this.sendToRenderer(IPC.UPDATE_ERROR, this.status);
    });
  }

  /**
   * Check for available updates.
   * In dev mode, returns a "not available" status without hitting the network.
   */
  async checkForUpdates(): Promise<AppUpdateInfo> {
    if (!app.isPackaged) {
      this.status.error = undefined;
      this.status.updateAvailable = false;
      return { ...this.status };
    }

    try {
      this.status.error = undefined;
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : 'Check failed';
    }
    return { ...this.status };
  }

  /**
   * Start downloading the available update.
   */
  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return;

    this.status.downloading = true;
    this.status.error = undefined;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.status.downloading = false;
      this.status.error = err instanceof Error ? err.message : 'Download failed';
      throw err;
    }
  }

  /**
   * Quit the app and install the downloaded update.
   */
  installUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * Return the current update status snapshot.
   */
  getStatus(): AppUpdateInfo {
    return { ...this.status };
  }

  private sendToRenderer(channel: string, data: AppUpdateInfo): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}
