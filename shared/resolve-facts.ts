/**
 * Repository facts for the AI "Resolve" panel.
 *
 * The model used to get only counts ("4 untracked files, 15 stashes"), so it
 * could not tell that one untracked file was a `.env` backup or that a stash
 * came from another branch, and it filled the gap with `git add .` and
 * `git stash pop`. These are the specifics it needs to give advice that fits
 * this repo. Collection runs in the main process (see
 * collectResolveFacts); formatting is pure so it can be tested.
 */

export interface ResolveStash {
  ref: string;         // stash@{0}
  sourceBranch: string | null;  // branch the stash was taken on, when git recorded one
  message: string;
}

export interface ResolveFacts {
  repoName: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  /** Untracked paths that also exist on the upstream — they would block a pull. */
  untrackedCollidingWithUpstream: string[];
  stashes: ResolveStash[];
}

/** Paths that probably hold credentials or data dumps and must never be committed blindly. */
export function looksSensitive(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return (
    /^\.env(\..*)?$/i.test(name) ||
    /\.env\.(bak|backup|old|orig|save|local)$/i.test(name) ||
    /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(name) ||
    /(secret|credential|password|token)/i.test(name) ||
    /^id_(rsa|ed25519|ecdsa|dsa)$/.test(name) ||
    /\.(sql|dump|bak)$/i.test(name)
  );
}

/** `stash@{0}: WIP on main: 57ded16 msg` / `stash@{1}: On feat/x: msg` / `stash@{2}: autostash` */
export function parseStashList(output: string): ResolveStash[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
      if (!m) return { ref: line, sourceBranch: null, message: '' };
      const rest = m[2];
      const src = rest.match(/^(?:WIP on|On) ([^:]+):\s*(.*)$/);
      return src
        ? { ref: m[1], sourceBranch: src[1] === '(no branch)' ? null : src[1], message: src[2] }
        : { ref: m[1], sourceBranch: null, message: rest };
    });
}

const MAX_LISTED = 25;

function listPaths(paths: string[], mark: (p: string) => string = () => ''): string {
  if (paths.length === 0) return '(none)';
  const shown = paths.slice(0, MAX_LISTED).map((p) => `- ${p}${mark(p)}`);
  if (paths.length > MAX_LISTED) shown.push(`- … and ${paths.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/** Variables for the `repo_resolve` mode's `resolve` prompt. */
export function formatResolveVariables(f: ResolveFacts): Record<string, string> {
  const sensitive = (p: string) => (looksSensitive(p) ? '  [LOOKS SENSITIVE — never commit]' : '');
  const colliding = new Set(f.untrackedCollidingWithUpstream);
  const untrackedMark = (p: string) =>
    `${sensitive(p)}${colliding.has(p) ? '  [ALSO ON UPSTREAM — blocks pull]' : ''}`;

  const stashes = f.stashes.length === 0
    ? '(none)'
    : f.stashes.slice(0, MAX_LISTED).map((s) => {
        const origin = s.sourceBranch
          ? s.sourceBranch === f.branch ? `taken on ${s.sourceBranch} (this branch)` : `taken on ${s.sourceBranch} (a different branch)`
          : 'source branch unknown';
        return `- ${s.ref}: ${origin} — ${s.message || '(no message)'}`;
      }).join('\n') + (f.stashes.length > MAX_LISTED ? `\n- … and ${f.stashes.length - MAX_LISTED} more` : '');

  return {
    repo_name: f.repoName,
    branch: f.branch,
    upstream: f.upstream ?? '(no upstream configured)',
    ahead: String(f.ahead),
    behind: String(f.behind),
    fast_forward_possible: f.upstream && f.ahead === 0 && f.behind > 0 && f.untrackedCollidingWithUpstream.length === 0
      ? 'yes' : 'no',
    staged_files: listPaths(f.staged, sensitive),
    modified_files: listPaths(f.modified, sensitive),
    untracked_files: listPaths(f.untracked, untrackedMark),
    stashes,
  };
}

/** Parse `git status --porcelain=v1` output. Lines must be untrimmed: column 1 can be a space. */
export function parsePorcelain(output: string): { staged: string[]; modified: string[]; untracked: string[] } {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    if (path.includes(' -> ')) path = path.split(' -> ')[1];
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (x === '?' && y === '?') { untracked.push(path); continue; }
    if (x !== ' ' && x !== '!') staged.push(path);
    if (y !== ' ' && y !== '!') modified.push(path);
  }
  return { staged, modified, untracked };
}

export type GitRunner = (args: string[]) => Promise<string>;

/**
 * Gather the facts with read-only git calls. Uses the last fetched state of
 * the upstream (no network), same as the counts shown on the repo card.
 */
export async function collectResolveFacts(repoName: string, git: GitRunner): Promise<ResolveFacts> {
  const safe = (args: string[]) => git(args).catch(() => '');

  const [branchOut, upstreamOut, statusOut, stashOut] = await Promise.all([
    safe(['rev-parse', '--abbrev-ref', 'HEAD']),
    safe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    safe(['status', '--porcelain=v1', '--untracked-files=all']),
    safe(['stash', 'list']),
  ]);

  const upstream = upstreamOut.trim() || null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (await safe(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/);
    behind = Number(counts[0]) || 0;
    ahead = Number(counts[1]) || 0;
  }

  const { staged, modified, untracked } = parsePorcelain(statusOut);

  // Untracked paths the upstream also tracks would make `git pull` refuse.
  let untrackedCollidingWithUpstream: string[] = [];
  if (upstream && behind > 0 && untracked.length > 0) {
    const checked = untracked.slice(0, 200);
    const onUpstream = await safe(['ls-tree', '-r', '--name-only', upstream, '--', ...checked]);
    const present = new Set(onUpstream.split('\n').map((l) => l.trim()).filter(Boolean));
    untrackedCollidingWithUpstream = checked.filter((p) => present.has(p));
  }

  return {
    repoName,
    branch: branchOut.trim() || 'unknown',
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    untrackedCollidingWithUpstream,
    stashes: parseStashList(stashOut),
  };
}
