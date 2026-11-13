/**
 * Runs first in the main process (imported before anything else in index.ts),
 * so every child process — git, its hooks, the worker, agents — inherits a
 * PATH with the user's tools on it. See shared/login-path.ts for why.
 *
 * The login shell is asked only when PATH looks like launchd's bare default,
 * so a KIT started from a terminal pays nothing. It is bounded by a timeout
 * and never blocks startup on failure: the fallback directories still apply.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import {
  PRINT_PATH_COMMAND,
  fallbackToolDirs,
  looksLikeLaunchdPath,
  mergePath,
  parseShellPath,
} from '../shared/login-path';

function loginShellPath(): string | null {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  try {
    // -i -l: read the same startup files a new terminal tab does (Homebrew's
    // shellenv usually lives in .zprofile, nvm in .zshrc).
    const r = spawnSync(shell, ['-ilc', PRINT_PATH_COMMAND], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TERM: 'dumb' },
    });
    return parseShellPath(r.stdout ?? '');
  } catch {
    return null;
  }
}

export function applyLoginPath(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const before = process.env.PATH;
  const loginShell = looksLikeLaunchdPath(before, existsSync) ? loginShellPath() : null;
  process.env.PATH = mergePath({
    current: before,
    loginShell,
    fallbacks: fallbackToolDirs(homedir()),
    exists: existsSync,
  });
  if (process.env.PATH !== before) {
    console.log(
      `[Startup] PATH extended${loginShell ? ' from the login shell' : ''}: ${process.env.PATH}`
    );
  }
}

applyLoginPath();
