/**
 * Unit Tests for shared/resolve-facts.ts and the repo_resolve / session_task_refiner
 * mode prompts.
 *
 * The Resolve prompt used to get counts only, so the model could not tell a
 * `.env` backup from source code or this branch's stash from another agent's.
 * These tests pin the facts it now gets, and check that every placeholder in
 * the mode prompts is actually supplied.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import {
  collectResolveFacts,
  formatResolveVariables,
  looksSensitive,
  parsePorcelain,
  parseStashList,
  type GitRunner,
} from '../../../shared/resolve-facts';

// The agent_memory_vault state that produced the bad advice.
const INCIDENT_STATUS = [
  '?? .env.bak',
  '?? kemory-open-backlog-prioritized.csv',
  '?? tag-prune-rollback-20260829-0054.sql',
  '?? tag-prune-rollback-exact-0126.tsv',
  '',
].join('\n');

const INCIDENT_STASHES = [
  'stash@{0}: WIP on claude-session-20260916-mcpclaude: 87a71b5 docs(support): re-bank gate-ask',
  'stash@{1}: autostash',
  'stash@{2}: On main: Auto-stash before AI rebase onto main',
  'stash@{3}: On (no branch): Auto-stash before AI rebase onto main',
].join('\n');

function fakeGit(responses: Record<string, string>): GitRunner {
  return async (args) => {
    const key = args.join(' ');
    for (const [prefix, out] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return out;
    }
    throw new Error(`unexpected git ${key}`);
  };
}

describe('parsePorcelain', () => {
  it('keeps the leading space of an unstaged modification', () => {
    expect(parsePorcelain(' M src/a.ts\nM  src/b.ts\nMM src/c.ts\n?? new.txt\nR  old.ts -> renamed.ts\n')).toEqual({
      staged: ['src/b.ts', 'src/c.ts', 'renamed.ts'],
      modified: ['src/a.ts', 'src/c.ts'],
      untracked: ['new.txt'],
    });
  });
});

describe('parseStashList', () => {
  it('records the branch each stash was taken on', () => {
    expect(parseStashList(INCIDENT_STASHES)).toEqual([
      { ref: 'stash@{0}', sourceBranch: 'claude-session-20260916-mcpclaude', message: '87a71b5 docs(support): re-bank gate-ask' },
      { ref: 'stash@{1}', sourceBranch: null, message: 'autostash' },
      { ref: 'stash@{2}', sourceBranch: 'main', message: 'Auto-stash before AI rebase onto main' },
      { ref: 'stash@{3}', sourceBranch: null, message: 'Auto-stash before AI rebase onto main' },
    ]);
  });
});

describe('looksSensitive', () => {
  it.each(['.env', '.env.bak', 'config/.env.local', 'server.pem', 'id_rsa', 'aws-credentials.json', 'dump.sql', 'db.bak'])(
    'flags %s', (p) => expect(looksSensitive(p)).toBe(true));
  it.each(['src/env.ts', 'README.md', 'package.json', 'backlog.csv'])(
    'does not flag %s', (p) => expect(looksSensitive(p)).toBe(false));
});

describe('collectResolveFacts + formatResolveVariables — the incident', () => {
  const git = fakeGit({
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': 'origin/main\n',
    'status --porcelain=v1': INCIDENT_STATUS,
    'stash list': INCIDENT_STASHES,
    'rev-list --left-right --count origin/main...HEAD': '274\t0\n',
    'ls-tree -r --name-only origin/main': '',
  });

  it('reports a clean fast-forward', async () => {
    const facts = await collectResolveFacts('agent_memory_vault', git);
    expect(facts).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 274, untrackedCollidingWithUpstream: [] });
    expect(formatResolveVariables(facts).fast_forward_possible).toBe('yes');
  });

  it('marks the .env backup and the stash from another branch', async () => {
    const vars = formatResolveVariables(await collectResolveFacts('agent_memory_vault', git));
    expect(vars.untracked_files).toContain('- .env.bak  [LOOKS SENSITIVE — never commit]');
    expect(vars.untracked_files).toContain('- kemory-open-backlog-prioritized.csv\n');
    expect(vars.stashes).toContain('stash@{0}: taken on claude-session-20260916-mcpclaude (a different branch)');
    expect(vars.stashes).toContain('stash@{2}: taken on main (this branch)');
  });

  it('says a pull is blocked when an untracked file is also on the upstream', async () => {
    const colliding = fakeGit({
      'rev-parse --abbrev-ref HEAD': 'main',
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': 'origin/main',
      'status --porcelain=v1': '?? docs/new.md\n?? scratch.txt\n',
      'stash list': '',
      'rev-list --left-right --count origin/main...HEAD': '3\t0',
      'ls-tree -r --name-only origin/main': 'docs/new.md\n',
    });
    const vars = formatResolveVariables(await collectResolveFacts('r', colliding));
    expect(vars.fast_forward_possible).toBe('no');
    expect(vars.untracked_files).toContain('- docs/new.md  [ALSO ON UPSTREAM — blocks pull]');
  });

  it('handles a branch with no upstream', async () => {
    const noUpstream = fakeGit({
      'rev-parse --abbrev-ref HEAD': 'feature',
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': '',
      'status --porcelain=v1': '',
      'stash list': '',
    });
    const vars = formatResolveVariables(await collectResolveFacts('r', noUpstream));
    expect(vars).toMatchObject({ upstream: '(no upstream configured)', ahead: '0', behind: '0', fast_forward_possible: 'no', stashes: '(none)' });
  });
});

describe('mode prompts', () => {
  const modesDir = join(__dirname, '../../../electron/config/modes');
  const load = (id: string) => yaml.load(readFileSync(join(modesDir, `${id}.yaml`), 'utf-8')) as {
    mode: { id: string };
    settings: Record<string, unknown>;
    prompts: Record<string, { system: string; user_template: string }>;
  };
  const placeholders = (text: string) => new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));

  it('repo_resolve gets every placeholder it uses', async () => {
    const mode = load('repo_resolve');
    expect(mode.mode.id).toBe('repo_resolve');
    const vars = formatResolveVariables({
      repoName: 'r', branch: 'main', upstream: null, ahead: 0, behind: 0,
      staged: [], modified: [], untracked: [], untrackedCollidingWithUpstream: [], stashes: [],
    });
    const supplied = new Set([...Object.keys(vars), 'user_message']);
    const used = placeholders(mode.prompts.resolve.system + mode.prompts.resolve.user_template);
    expect([...used].filter((v) => !supplied.has(v))).toEqual([]);
  });

  it('repo_resolve forbids the incident commands', () => {
    const system = load('repo_resolve').prompts.resolve.system;
    expect(system).toContain('git pull --ff-only');
    expect(system).toMatch(/Never use `git add \.`/);
    expect(system).toMatch(/never pop, apply, drop or clear/);
  });

  it('session_task_refiner asks for JSON and gets every placeholder', () => {
    const mode = load('session_task_refiner');
    expect(mode.settings.response_format).toBe('json_object');
    const used = placeholders(mode.prompts.refine.system + mode.prompts.refine.user_template);
    expect([...used].sort()).toEqual(['agent_type', 'repo_line', 'user_message']);
  });
});
