/**
 * Unit Tests for shared/resolve-commands.ts
 *
 * The guard between the AI Resolve panel's suggestions and the shell. Root
 * incident: on a repo that was only behind its remote, the model proposed
 * `git add .` (committing a `.env.bak` to main) and `git stash pop` of a stash
 * from another branch. Those must be refused no matter what the model says.
 */

import { describe, it, expect } from '@jest/globals';
import { checkResolveCommand, parseResolveCommands, stripResolveCommands, tokenizeCommand } from '../../../shared/resolve-commands';

const allowed = (cmd: string) => checkResolveCommand(cmd).allowed;

describe('tokenizeCommand', () => {
  it('keeps a quoted commit message as one argument', () => {
    expect(tokenizeCommand('git commit -m "Add docs for resolve"')).toEqual(['git', 'commit', '-m', 'Add docs for resolve']);
    expect(tokenizeCommand("git commit -m 'it works'")).toEqual(['git', 'commit', '-m', 'it works']);
  });

  it('refuses anything that needs a shell', () => {
    for (const cmd of ['git status && rm -rf /', 'git log | head', 'git status; ls', 'git log > out', 'git show $(whoami)', 'git show `id`']) {
      expect(tokenizeCommand(cmd)).toBeNull();
    }
  });

  it('refuses an unterminated quote', () => {
    expect(tokenizeCommand('git commit -m "oops')).toBeNull();
  });
});

describe('checkResolveCommand — the incident', () => {
  it.each([
    'git add .',
    'git add -A',
    'git add --all',
    'git add -u',
    'git add :/',
    'git add',
    'git commit -a -m "x"',
    'git commit -am "x"',
    'git stash pop',
    'git stash apply stash@{0}',
    'git stash drop',
    'git stash clear',
  ])('blocks %s', (cmd) => {
    expect(allowed(cmd)).toBe(false);
  });

  it('still allows what the incident actually needed', () => {
    expect(allowed('git pull --ff-only')).toBe(true);
    expect(allowed('git pull --ff-only origin main')).toBe(true);
  });
});

describe('checkResolveCommand — destructive commands', () => {
  it.each([
    'git clean -fd',
    'git reset --hard origin/main',
    'git reset HEAD~1',
    'git push --force',
    'git push -f origin main',
    'git push origin +main',
    'git push origin :feature',
    'git push --delete origin feature',
    'git checkout -- src/app.ts',
    'git checkout .',
    'git checkout -f main',
    'git restore src/app.ts',
    'git restore --worktree --staged src/app.ts',
    'git switch --discard-changes main',
    'git branch -D feature',
    'git rebase origin/main',
    'git merge feature',
    'git stash --all',
    'rm -rf .git',
    'npm install',
  ])('blocks %s', (cmd) => {
    expect(allowed(cmd)).toBe(false);
  });
});

describe('checkResolveCommand — safe commands', () => {
  it.each([
    'git status',
    'git fetch origin',
    'git pull --rebase origin main',
    'git push origin main',
    'git push --force-with-lease origin feature',
    'git add src/app.ts docs/README.md',
    'git commit -m "fix(sync): pull latest main"',
    'git stash',
    'git stash push -m "before pull"',
    'git stash list',
    'git switch main',
    'git checkout main',
    'git restore --staged src/app.ts',
    'git rebase --abort',
    'git merge --abort',
    'git branch -vv',
  ])('allows %s', (cmd) => {
    expect(allowed(cmd)).toBe(true);
  });

  it('returns argv without shell quoting for execFile', () => {
    const check = checkResolveCommand('git commit -m "two words"');
    expect(check).toEqual({ allowed: true, argv: ['git', 'commit', '-m', 'two words'] });
  });

  it('explains why a command was blocked', () => {
    const check = checkResolveCommand('git add .');
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toMatch(/by name/);
  });
});

describe('parseResolveCommands', () => {
  // Verbatim shape of a gpt-oss-120b answer on the incident repo: the COMMAND
  // line is indented under its step, which the old column-0 parser missed.
  const answer = [
    "**What's happening:** Your local `main` branch is 274 commits behind `origin/main` and can be fast-forwarded.",
    '',
    '**Steps to resolve:**',
    '',
    '1. Fast-forward your branch to match the upstream.',
    '   COMMAND: git pull --ff-only',
    '',
    '**Leave alone:** Untracked files (including the sensitive ones) and existing stashes are left untouched.',
  ].join('\n');

  it('finds an indented COMMAND line and labels it with its step', () => {
    expect(parseResolveCommands(answer)).toEqual([
      { label: 'Fast-forward your branch to match the upstream.', cmd: 'git pull --ff-only', blockedReason: undefined },
    ]);
  });

  it('strips COMMAND lines from the explanation', () => {
    const explanation = stripResolveCommands(answer);
    expect(explanation).not.toContain('COMMAND:');
    expect(explanation).toContain('**Leave alone:**');
  });

  it('marks a blocked suggestion instead of dropping it', () => {
    const [add, pop] = parseResolveCommands('1. Stage everything\nCOMMAND: git add .\n2. Restore work\nCOMMAND: `git stash pop`');
    expect(add.cmd).toBe('git add .');
    expect(add.blockedReason).toMatch(/by name/);
    expect(pop.cmd).toBe('git stash pop');
    expect(pop.blockedReason).toMatch(/stash pop/);
  });
});
