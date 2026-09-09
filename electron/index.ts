/**
 * Electron Main Process Entry Point
 * KIT for DevOps - Desktop DevOps Agent
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { registerIpcHandlers, removeIpcHandlers } from './ipc';
import { initializeServices, disposeServices, type Services } from './services';
import { startMemoryProbe } from './diagnostics/MemoryProbe';

import { IPC } from '../shared/ipc-channels';

// One-time data-dir migration from the legacy "sekondbrain-kanvas" userData
// directory to the current "kit-for-devops" one. Must run before any service
// touches userData, so we do it synchronously at module load.
//
// Why not just check "does the new dir exist?": Electron pre-creates the
// userData directory and writes Chromium files (Cookies, Preferences, …)
// before our module-level code runs. So the dir always exists by the time
// we get here — we need a marker tied to *our* data instead. The DB file is
// the right signal: present in legacy = real data; absent in current = nothing
// to lose. We move only our files (data/, logs/, *.json), leaving Chromium
// state alone in whichever dir it already lives.
(function migrateLegacyUserDataDir() {
  try {
    const appData = app.getPath('appData');
    const legacyDir = join(appData, 'sekondbrain-kanvas');
    const currentDir = join(appData, 'kit-for-devops');
    const legacyDb = join(legacyDir, 'data', 'kanvas.db');
    const currentDb = join(currentDir, 'data', 'kanvas.db');
    if (!existsSync(legacyDb) || existsSync(currentDb)) return;

    mkdirSync(currentDir, { recursive: true });
    // Move our data subdir (DB + WAL/SHM travel together)
    renameSync(join(legacyDir, 'data'), join(currentDir, 'data'));
    // Move our electron-store JSON files and logs subdir if present
    for (const item of [
      'kanvas-instances.json',
      'kanvas-project-groups.json',
      'kanvas-workspaces.json',
      'sekondbrain-kanvas.json',
      'logs',
    ]) {
      const src = join(legacyDir, item);
      const dst = join(currentDir, item);
      if (existsSync(src) && !existsSync(dst)) renameSync(src, dst);
    }
    // Best-effort cleanup of the now-empty (or Chromium-only) legacy dir.
    // We don't fail migration if this trips — the data is what mattered.
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch {
      // leave it; user can delete by hand
    }
    console.log(`[Migration] Moved userData files ${legacyDir} -> ${currentDir}`);
  } catch (err) {
    console.error('[Migration] Failed to migrate legacy userData dir:', err);
  }
})();

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
// Stored so it can be cleared on window close / recreate — prevents stacking intervals
let updateCheckInterval: NodeJS.Timeout | null = null;

/**
 * Check for orphaned sessions and notify the renderer
 */
async function checkForOrphanedSessions(svc: Services | null): Promise<void> {
  if (!svc || !mainWindow) return;

  try {
    const result = await svc.sessionRecovery.scanAllReposForSessions();
    if (result.success && result.data && result.data.length > 0) {
      console.log(`[Recovery] Found ${result.data.length} orphaned session(s)`);
      mainWindow.webContents.send(IPC.ORPHANED_SESSIONS_FOUND, result.data);

      // Also log to terminal
      svc.terminalLog.warn(
        `Found ${result.data.length} orphaned session(s) that may need recovery`,
        undefined,
        'Recovery'
      );
    }
  } catch (error) {
    console.error('[Recovery] Error scanning for orphaned sessions:', error);
  }
}

/**
 * Startup stale-session scan.
 *
 * A session is "stale" when its worktree has been idle >= STALE days and is
 * fully committed. Sessions with uncommitted/unstaged changes are intentionally
 * skipped — they stay visible in the workspace view rather than being touched.
 *
 * Behavior (per product decision):
 *   - safe   (no unmerged commits)  → auto-removed silently (worktree + local branch)
 *   - risky  (has unmerged commits) → surfaced to the renderer for confirmation
 */
const STALE_SESSION_DAYS = 14;

async function checkForStaleSessions(svc: Services | null): Promise<void> {
  if (!svc || !mainWindow) return;

  try {
    const { existsSync } = await import('fs');
    const { stat } = await import('fs/promises');

    const listed = svc.agentInstance.listInstances();
    if (!listed.success || !listed.data) return;

    const safe: import('../shared/types').StaleSessionInfo[] = [];
    const risky: import('../shared/types').StaleSessionInfo[] = [];

    for (const instance of listed.data) {
      // Never touch a session that's actively running or still spinning up.
      if (instance.status === 'active' || instance.status === 'initializing') continue;

      const worktreePath = instance.worktreePath;
      const repoPath = instance.config?.repoPath;
      // Only sessions with a real, separate worktree are candidates.
      if (!worktreePath || !repoPath || worktreePath === repoPath) continue;
      if (!existsSync(worktreePath)) continue; // missing worktrees handled by cleanup view

      // Idle days from the worktree directory mtime (same signal as the
      // abandoned-worktree classifier, keeps thresholds consistent).
      let daysIdle = 0;
      try {
        const stats = await stat(worktreePath);
        daysIdle = Math.floor((Date.now() - stats.mtime.getTime()) / (24 * 60 * 60 * 1000));
      } catch {
        continue;
      }
      if (daysIdle < STALE_SESSION_DAYS) continue;

      // Fully-committed check + merge status.
      const safetyResult = await svc.git.getWorktreeSafetyInfo(worktreePath);
      if (!safetyResult.success || !safetyResult.data) continue;
      const safety = safetyResult.data;

      // Uncommitted/unstaged work → NOT stale. Leave it for the workspace view.
      if (safety.hasUncommittedChanges) continue;

      const info: import('../shared/types').StaleSessionInfo = {
        sessionId: instance.sessionId || instance.id,
        repoPath,
        repoName: repoPath.split('/').filter(Boolean).pop() || repoPath,
        branchName: instance.config?.branchName || '(unknown)',
        worktreePath,
        daysIdle,
        unmergedCommitCount: safety.unmergedCommitCount,
        mergedIntoBranches: safety.mergedIntoBranches,
        safeToDelete: safety.unmergedCommitCount === 0,
      };

      if (info.safeToDelete) safe.push(info);
      else risky.push(info);
    }

    // Auto-remove the provably-safe stale sessions (worktree + local branch).
    const autoRemoved: import('../shared/types').StaleSessionInfo[] = [];
    for (const session of safe) {
      try {
        const result = await svc.agentInstance.deleteInstanceWithCleanup(session.sessionId, {
          deleteWorktree: true,
          deleteLocalBranch: true,   // safe: HEAD is already merged into main/development
          deleteRemoteBranch: false, // never touch the remote automatically
        });
        if (result.success) {
          autoRemoved.push(session);
          console.log(`[StaleScan] Auto-removed safe stale session ${session.sessionId} (${session.branchName}, idle ${session.daysIdle}d)`);
        }
      } catch (err) {
        console.warn(`[StaleScan] Failed to auto-remove ${session.sessionId}:`, err);
      }
    }

    if (autoRemoved.length > 0) {
      svc.terminalLog.logSystem(
        `[StaleScan] Auto-removed ${autoRemoved.length} stale session(s) with fully-merged work`
      );
      mainWindow.webContents.send(IPC.STALE_SESSIONS_AUTOREMOVED, autoRemoved);
    }

    if (risky.length > 0) {
      console.log(`[StaleScan] ${risky.length} stale session(s) have unmerged commits — prompting user`);
      svc.terminalLog.warn(
        `${risky.length} stale session(s) have unmerged commits and need review before removal`,
        undefined,
        'StaleScan'
      );
      mainWindow.webContents.send(IPC.STALE_SESSIONS_FOUND, risky);
    }
  } catch (error) {
    console.error('[StaleScan] Error scanning for stale sessions:', error);
  }
}

async function createWindow(): Promise<void> {
  // Icon path differs between dev and production
  // In production, macOS uses the bundled .icns automatically
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.icns')
    : join(__dirname, '../../resources/icon.png');

  console.log('Creating BrowserWindow...');
  console.log('app.isPackaged:', app.isPackaged);
  console.log('Icon path:', iconPath);

  // Build window options - only set icon in development
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      minimumFontSize: 0,  // Allow sub-12px fonts (KIT eyebrow at 11px)
    },
    backgroundColor: '#ffffff',
    show: true,
  };

  // Only set icon explicitly in development (production uses bundled .icns)
  if (!app.isPackaged) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  console.log('BrowserWindow created');

  // Set dock icon on macOS (only in dev, production uses bundled icon)
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }

  // Initialize services
  try {
    console.log('Initializing services...');
    services = await initializeServices(mainWindow);
    registerIpcHandlers(services, mainWindow);
    console.log('Services initialized');
  } catch (error) {
    console.error('Service init error:', error);
  }

  // Main-process memory/CPU watchdog. Always-on, cheap (one log line / 60s).
  // Surfaces rss/heap growth, V8 detached-context count, active libuv handle
  // tallies, and app gauges so a runaway is visible in logs; `kill -SIGUSR2 <pid>`
  // dumps a heap snapshot on demand. Counters read `services` lazily each tick.
  startMemoryProbe({
    vitalsMs: 60_000,
    counters: () => {
      const w = services?.watcher?.debugCounts();
      return {
        watchers: w?.watchers ?? 0,
        debounceTimers: w?.debounce ?? 0,
        periodicTimers: w?.periodic ?? 0,
        pendingEmits: services?.activity?.debugPendingEmits?.() ?? 0,
        mcpSessions: services?.mcpServer?.debugSessionCount?.() ?? 0,
        aiStreaming: services?.ai?.debugStreamActive?.() ? 1 : 0,
      };
    },
  });

  // Handle load failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Page load failed:', errorCode, errorDescription);
  });

  // Handle renderer process crash — auto-recover
  mainWindow.webContents.on('render-process-gone', async (_event, details) => {
    console.error('[Main] Renderer process gone:', details.reason, details.exitCode);
    services?.terminalLog?.logSystem(`Renderer crashed: ${details.reason}`);

    if (details.reason !== 'clean-exit') {
      setTimeout(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          await createWindow();
        } else {
          mainWindow.reload();
        }
      }, 1000);
    }
  });

  // Handle unresponsive renderer
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Main] Renderer unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[Main] Renderer responsive again');
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    console.log('Page loaded successfully');
    // Refresh prompts with latest templates, then emit stored sessions
    // Use services.agentInstance (not the singleton) — it has the MCP URL configured
    services?.agentInstance?.refreshStoredPrompts();
    setTimeout(() => {
      services?.agentInstance?.emitStoredSessions();
    }, 500);

    // Check for orphaned sessions after a longer delay
    setTimeout(async () => {
      await checkForOrphanedSessions(services);
    }, 1500);

    // Scan for stale sessions (idle 14+ days, fully committed): auto-remove the
    // safe ones, prompt for any with unmerged commits. Runs after the orphaned
    // scan so the two don't contend for git on the same repos.
    setTimeout(async () => {
      await checkForStaleSessions(services);
    }, 3000);

    // Check for app updates after startup (only runs in production)
    setTimeout(() => {
      if (services?.autoUpdate) {
        services.autoUpdate.checkForUpdates().catch((err) => {
          console.warn('[Main] Auto-update check failed:', err);
        });
      }
    }, 3000);

    // Periodic update check every 30 minutes — clear any existing interval first
    // to prevent stacking when the window reloads (macOS dock re-open, etc.)
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
    }
    updateCheckInterval = setInterval(() => {
      if (services?.autoUpdate) {
        services.autoUpdate.checkForUpdates().catch((err) => {
          console.warn('[Main] Periodic update check failed:', err);
        });
      }
    }, 30 * 60 * 1000);
  });

  // Load the app
  // In development, electron-vite sets ELECTRON_RENDERER_URL to the dev server URL
  // In production, we load the built index.html from disk
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;

  try {
    if (devServerUrl) {
      console.log('ELECTRON_RENDERER_URL:', devServerUrl);
      console.log('Loading dev URL:', devServerUrl);
      await mainWindow.loadURL(devServerUrl);
    } else {
      // Production: load from packaged files
      // __dirname in production is inside app.asar/dist/electron
      const indexHtmlPath = join(__dirname, '../renderer/index.html');
      console.log('Production mode - app.isPackaged:', app.isPackaged);
      console.log('__dirname:', __dirname);
      console.log('Loading file:', indexHtmlPath);

      // Verify the file exists (won't work in asar but helps debugging)
      const { existsSync } = await import('fs');
      console.log('File exists check:', existsSync(indexHtmlPath));

      await mainWindow.loadFile(indexHtmlPath);
    }
    console.log('Main window load completed');
  } catch (error) {
    console.error('Error loading main window:', error);
    // Show error in window for debugging
    mainWindow.webContents.loadURL(`data:text/html,<html><body style="background:#fff;color:#000;font-family:sans-serif;padding:40px;"><h1>Failed to load app</h1><pre>${error}</pre><p>__dirname: ${__dirname}</p></body></html>`);
  }

  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle window close — clear the periodic update interval so it doesn't
  // keep firing after the window is gone or stack up on recreate
  mainWindow.on('closed', () => {
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
    mainWindow = null;
  });
}

// App lifecycle events
app.whenReady().then(async () => {
  await createWindow();

  // macOS: recreate window when dock icon is clicked
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

// Handle second instance (focus existing window)
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Quit when all windows are closed (except macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('before-quit', async () => {
  removeIpcHandlers();
  await disposeServices();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
