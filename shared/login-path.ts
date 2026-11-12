/**
 * Give KIT the PATH a terminal would have.
 *
 * An app started from the Dock, Finder, a login item or a LaunchAgent gets
 * launchd's PATH — /usr/bin:/bin:/usr/sbin:/sbin — with no Homebrew. Every
 * child process inherits that: git, and through git every hook. So a push
 * whose pre-push hook runs `npm` failed with "npm: command not found" even
 * though npm was installed. (#41 fixed this for gh alone.)
 *
 * The fix merges, in order: the user's login-shell PATH (what their terminal
 * sees, nvm and all), then the PATH the app was given, then standard tool
 * directories that exist — so tools resolve even if the shell could not be
 * read. Pure, so the merge is testable.
 */

/** Tool directories worth adding when they exist (Apple Silicon and Intel Homebrew, user bins). */
export function fallbackToolDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.local/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/Library/pnpm`,
  ];
}

const START = '__KIT_PATH_START__';
const END = '__KIT_PATH_END__';

/** The shell command that prints PATH between markers, so shell banners cannot pollute it. */
export const PRINT_PATH_COMMAND = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;

/** Extract the PATH printed by PRINT_PATH_COMMAND from shell output, or null. */
export function parseShellPath(output: string): string | null {
  const i = output.lastIndexOf(START);
  const j = output.lastIndexOf(END);
  if (i < 0 || j <= i) return null;
  const path = output.slice(i + START.length, j).trim();
  return path && path.includes('/') ? path : null;
}

/**
 * Merge PATHs, keeping first occurrence order and dropping empties and
 * duplicates. Fallback directories are only added if `exists` says so.
 */
export function mergePath(input: {
  current: string | undefined;
  loginShell: string | null;
  fallbacks: string[];
  exists: (dir: string) => boolean;
}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (dir: string) => {
    const d = dir.trim().replace(/\/+$/, '') || dir.trim();
    if (!d || seen.has(d)) return;
    seen.add(d);
    out.push(d);
  };
  for (const d of (input.loginShell ?? '').split(':')) add(d);
  for (const d of (input.current ?? '').split(':')) add(d);
  for (const d of input.fallbacks) if (input.exists(d)) add(d);
  return out.join(':');
}

/** True when PATH already has a usable tool directory, so the login shell need not be asked. */
export function looksLikeLaunchdPath(path: string | undefined, exists: (dir: string) => boolean): boolean {
  const dirs = new Set((path ?? '').split(':'));
  return !['/opt/homebrew/bin', '/usr/local/bin'].some((d) => dirs.has(d) && exists(d));
}
