/**
 * Files KIT (or the agent it launched) writes into every worktree on its own.
 *
 * A change to one of these is not work anybody did, so it must not make a
 * session look dirty. Before this, nearly every session showed "uncommitted
 * changes" in the delete dialog because KIT rewrites `.claude/settings.json`
 * when it registers the MCP server — which trained people to click
 * "Delete Anyway" past the warning, including when it was real.
 *
 * Pure, so the path matching can be tested without git.
 */

/** Exact paths, relative to the worktree root. */
const GENERATED_PATHS = new Set<string>([
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.vscode/settings.json',
  '.mcp.json',
  '.agent-config',
]);

/** Path prefixes and patterns for per-session files. */
const GENERATED_PATTERNS: RegExp[] = [
  /^\.S9N_KIT_DevOpsAgent\//,
  /^\.devops-commit-[^/]*\.msg$/,
  /^\.(claude|codex)-session-[^/]*\.md$/,
];

export function isKitGeneratedPath(path: string): boolean {
  const p = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return GENERATED_PATHS.has(p) || GENERATED_PATTERNS.some((re) => re.test(p));
}

/**
 * The path a `git status --porcelain` (v1) line refers to.
 *
 * Tolerates a line whose leading space was trimmed away — callers often
 * `.trim()` the whole stdout, which eats the first line's blank X column.
 * A rename reports its destination; quoted paths are unquoted.
 */
export function porcelainPath(line: string): string {
  let rest = line.replace(/^\s*[MADRCUT?! ]{1,2}\s+/, '');
  const arrow = rest.indexOf(' -> ');
  if (arrow >= 0) rest = rest.slice(arrow + 4);
  rest = rest.trim();
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest;
}

/** The porcelain lines that represent real, human- or agent-made changes. */
export function meaningfulStatusLines(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isKitGeneratedPath(porcelainPath(line)));
}
