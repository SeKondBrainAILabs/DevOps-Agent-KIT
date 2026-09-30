/**
 * Guard for the git commands the AI "Resolve" panel offers to run.
 *
 * Root incident: on a repo that was only behind its remote, the model
 * suggested `git add .` (which would have committed a `.env.bak` to main),
 * an unnecessary `pull --rebase`, and `git stash pop` of a stash taken on a
 * different branch. The prompt now steers away from those, but a prompt is a
 * request, not a guarantee — this predicate is the enforcement. The main
 * process refuses anything it rejects, and the renderer uses the same verdict
 * to show the command as blocked instead of runnable.
 *
 * The rule of thumb: allow what is reversible and scoped (fetch, fast-forward
 * pull, push, staging named paths, stashing), refuse what discards work or
 * sweeps up files nobody looked at.
 */

export type ResolveCommandCheck =
  | { allowed: true; argv: string[] }
  | { allowed: false; reason: string };

/**
 * Split a command line into argv, honouring single and double quotes so that
 * `git commit -m "Add docs"` keeps its message as one argument. Returns null
 * for anything that would need a shell: chaining, pipes, redirects,
 * substitution, or an unterminated quote.
 */
export function tokenizeCommand(command: string): string[] | null {
  const argv: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/[;&|<>`$\\]/.test(ch)) return null;
    if (/\s/.test(ch)) {
      if (inToken) argv.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) argv.push(current);
  return argv;
}

/** Pathspecs that mean "everything" rather than a file someone named. */
function isSweepingPathspec(arg: string): boolean {
  return arg === '.' || arg === '*' || arg === ':/' || arg === ':' || arg.startsWith(':/') || arg === './';
}

export function checkResolveCommand(command: string): ResolveCommandCheck {
  const argv = tokenizeCommand(command);
  if (!argv) return { allowed: false, reason: 'Shell operators, substitution and unbalanced quotes are not allowed' };
  if (argv[0] !== 'git' || argv.length < 2) return { allowed: false, reason: 'Only git commands can be run here' };

  const sub = argv[1];
  const args = argv.slice(2);
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));

  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'fetch':
      return { allowed: true, argv };

    case 'branch':
    case 'remote':
      // Listing only — creating, renaming and deleting are out of scope.
      if (args.every((a) => a.startsWith('-') && !['-d', '-D', '-m', '-M', '--delete', '--move'].includes(a))) {
        return { allowed: true, argv };
      }
      return { allowed: false, reason: `git ${sub} can only list here` };

    case 'pull':
      return { allowed: true, argv };

    case 'push':
      if (has('--force', '-f', '--mirror', '--delete', '-d', '--prune') || args.some((a) => a.startsWith('+') || a.startsWith(':'))) {
        return { allowed: false, reason: 'Force, mirror and deleting pushes are not allowed' };
      }
      return { allowed: true, argv };

    case 'add': {
      if (has('-A', '--all', '-u', '--update', '--no-ignore-removal', '-f', '--force')) {
        return { allowed: false, reason: 'Stage files by name — `git add -A/-u/-f` sweeps up files nobody reviewed' };
      }
      const paths = args.filter((a) => !a.startsWith('-'));
      if (paths.length === 0 || paths.some(isSweepingPathspec)) {
        return { allowed: false, reason: 'Stage files by name — `git add .` sweeps up files nobody reviewed' };
      }
      return { allowed: true, argv };
    }

    case 'commit':
      if (has('-a', '--all', '--amend') || args.some((a) => /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith('--'))) {
        return { allowed: false, reason: '`commit -a` and `--amend` are not allowed — stage named files, then commit' };
      }
      return { allowed: true, argv };

    case 'stash': {
      const action = args.find((a) => !a.startsWith('-')) ?? 'push';
      if (['push', 'save', 'list', 'show'].includes(action)) {
        if (has('-a', '--all')) return { allowed: false, reason: '`stash --all` also stashes ignored files' };
        return { allowed: true, argv };
      }
      return { allowed: false, reason: `\`git stash ${action}\` is not allowed — stashes can come from other branches; apply or drop them yourself` };
    }

    case 'switch':
      if (has('--discard-changes', '-f', '--force', '-C', '--force-create')) {
        return { allowed: false, reason: 'Switching must not discard local changes' };
      }
      return { allowed: true, argv };

    case 'checkout':
      // Branch switching only. `checkout -- <path>` and `checkout .` discard edits.
      if (has('--', '-f', '--force', '-B', '.', '-p', '--patch') || args.some(isSweepingPathspec)) {
        return { allowed: false, reason: '`git checkout` may only switch branches here' };
      }
      return { allowed: true, argv };

    case 'restore':
      // Unstaging is safe; restoring the working tree throws edits away.
      if (has('--staged', '-S') && !has('--worktree', '-W')) return { allowed: true, argv };
      return { allowed: false, reason: '`git restore` of the working tree discards edits — only `--staged` is allowed' };

    case 'rebase':
    case 'merge':
    case 'cherry-pick':
      if (args.length === 1 && args[0] === '--abort') return { allowed: true, argv };
      return { allowed: false, reason: `Only \`git ${sub} --abort\` is allowed here` };

    case 'clean':
      return { allowed: false, reason: '`git clean` permanently deletes untracked files' };

    case 'reset':
      return { allowed: false, reason: '`git reset` can discard commits or edits' };

    default:
      return { allowed: false, reason: `\`git ${sub}\` is not in the Resolve allowlist` };
  }
}

export interface ResolveCommand {
  label: string;
  cmd: string;
  /** Set when checkResolveCommand refuses it; the main process would refuse it too. */
  blockedReason?: string;
}

// Models indent these under numbered steps, so allow leading whitespace.
const COMMAND_LINE = /^\s*COMMAND:\s*(.+?)\s*$/;

/** Pull the `COMMAND:` lines out of a Resolve answer, each labelled by the step text above it. */
export function parseResolveCommands(text: string): ResolveCommand[] {
  const results: ResolveCommand[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(COMMAND_LINE);
    if (!match) continue;
    // Use the preceding non-empty line as a label, stripping markdown
    let label = '';
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim().replace(/^#+\s*/, '').replace(/^\d+\.\s*/, '').replace(/\*\*/g, '');
      if (prev) { label = prev; break; }
    }
    const cmd = match[1].replace(/^`(.*)`$/, '$1');
    const check = checkResolveCommand(cmd);
    results.push({ label: label || cmd, cmd, blockedReason: check.allowed ? undefined : check.reason });
  }
  return results;
}

/** The Resolve answer with its `COMMAND:` lines removed, for the explanation block. */
export function stripResolveCommands(text: string): string {
  return text.split('\n').filter((l) => !COMMAND_LINE.test(l)).join('\n').trim();
}
