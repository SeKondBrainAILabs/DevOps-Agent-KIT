/**
 * Pre-commit hook installer templates (Epic P / story P2).
 *
 * Pure template generation — given a project type + selected checks, return
 * the file contents the installer should write. The Electron service writes
 * those files; this module owns the policy.
 *
 * Supported project types:
 *  - 'ts-node'  → husky + lint-staged
 *  - 'python'   → pre-commit framework (.pre-commit-config.yaml)
 *  - 'shell'    → raw .git/hooks/pre-commit script
 *
 * Supported checks:
 *  - 'lint'      → ESLint / ruff / shellcheck
 *  - 'format'    → Prettier / black / shfmt
 *  - 'typecheck' → tsc --noEmit / mypy / (shell: skipped)
 *  - 'secrets'   → gitleaks (project-agnostic)
 */

export type ProjectType = 'ts-node' | 'python' | 'shell';
export type HookCheck = 'lint' | 'format' | 'typecheck' | 'secrets';

export const ALL_CHECKS: ReadonlyArray<HookCheck> = [
  'lint',
  'format',
  'typecheck',
  'secrets',
];

export interface PrecommitGenInputs {
  projectType: ProjectType;
  checks: ReadonlyArray<HookCheck>;
}

export interface PrecommitFile {
  /** Repo-relative path. */
  path: string;
  contents: string;
  executable?: boolean;
}

export interface PrecommitGenResult {
  files: PrecommitFile[];
  /** package.json devDependencies to ensure (TS) — empty for python/shell. */
  npmDevDeps: string[];
  /** Notes the installer should surface to the user. */
  notes: string[];
}

export function dedupeChecks(checks: ReadonlyArray<HookCheck>): HookCheck[] {
  return Array.from(new Set(checks));
}

export function generatePrecommitTemplate(input: PrecommitGenInputs): PrecommitGenResult {
  const checks = dedupeChecks(input.checks);
  switch (input.projectType) {
    case 'ts-node':
      return generateTsNode(checks);
    case 'python':
      return generatePython(checks);
    case 'shell':
      return generateShell(checks);
  }
}

// ─── TS / Node — husky + lint-staged ─────────────────────────────────────────
function generateTsNode(checks: ReadonlyArray<HookCheck>): PrecommitGenResult {
  const lintStagedRules: Record<string, string[]> = {};
  const npmDevDeps = ['husky', 'lint-staged'];
  const notes: string[] = [
    'Run `npx husky install` after commit to register hooks.',
    'Run `npm install` to pull in the new devDependencies.',
  ];

  if (checks.includes('format')) {
    lintStagedRules['*.{ts,tsx,js,jsx,json,md,css,scss,html,yaml,yml}'] = ['prettier --write'];
    npmDevDeps.push('prettier');
  }
  if (checks.includes('lint')) {
    const rules = lintStagedRules['*.{ts,tsx,js,jsx}'] ?? [];
    rules.push('eslint --fix');
    lintStagedRules['*.{ts,tsx,js,jsx}'] = rules;
    npmDevDeps.push('eslint');
  }
  if (checks.includes('secrets')) {
    notes.push('gitleaks must be installed separately (brew install gitleaks).');
  }

  const huskyHookLines: string[] = [
    '#!/usr/bin/env sh',
    '. "$(dirname -- "$0")/_/husky.sh"',
    '',
    'npx lint-staged',
  ];
  if (checks.includes('typecheck')) {
    huskyHookLines.push('npx tsc --noEmit');
  }
  if (checks.includes('secrets')) {
    huskyHookLines.push('command -v gitleaks >/dev/null 2>&1 && gitleaks protect --staged --redact || true');
  }

  return {
    files: [
      { path: '.husky/pre-commit', contents: huskyHookLines.join('\n') + '\n', executable: true },
      {
        path: 'lint-staged.config.js',
        contents:
          'module.exports = ' + JSON.stringify(lintStagedRules, null, 2) + ';\n',
      },
    ],
    npmDevDeps: Array.from(new Set(npmDevDeps)),
    notes,
  };
}

// ─── Python — pre-commit framework ───────────────────────────────────────────
function generatePython(checks: ReadonlyArray<HookCheck>): PrecommitGenResult {
  const repos: Array<{ repo: string; rev: string; hooks: Array<{ id: string }> }> = [];
  if (checks.includes('format')) {
    repos.push({
      repo: 'https://github.com/psf/black',
      rev: '24.10.0',
      hooks: [{ id: 'black' }],
    });
  }
  if (checks.includes('lint')) {
    repos.push({
      repo: 'https://github.com/astral-sh/ruff-pre-commit',
      rev: 'v0.7.0',
      hooks: [{ id: 'ruff' }],
    });
  }
  if (checks.includes('typecheck')) {
    repos.push({
      repo: 'https://github.com/pre-commit/mirrors-mypy',
      rev: 'v1.13.0',
      hooks: [{ id: 'mypy' }],
    });
  }
  if (checks.includes('secrets')) {
    repos.push({
      repo: 'https://github.com/gitleaks/gitleaks',
      rev: 'v8.21.2',
      hooks: [{ id: 'gitleaks' }],
    });
  }

  const yaml = renderPreCommitYaml(repos);
  return {
    files: [{ path: '.pre-commit-config.yaml', contents: yaml }],
    npmDevDeps: [],
    notes: [
      'Run `pip install pre-commit && pre-commit install` to register hooks.',
      'First commit will be slow while hook environments build.',
    ],
  };
}

function renderPreCommitYaml(
  repos: Array<{ repo: string; rev: string; hooks: Array<{ id: string }> }>
): string {
  if (repos.length === 0) return 'repos: []\n';
  const lines: string[] = ['repos:'];
  for (const r of repos) {
    lines.push(`  - repo: ${r.repo}`);
    lines.push(`    rev: ${r.rev}`);
    lines.push('    hooks:');
    for (const h of r.hooks) {
      lines.push(`      - id: ${h.id}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ─── Shell — raw git hook ────────────────────────────────────────────────────
function generateShell(checks: ReadonlyArray<HookCheck>): PrecommitGenResult {
  const lines: string[] = ['#!/usr/bin/env sh', 'set -e', ''];
  if (checks.includes('format')) {
    lines.push('command -v shfmt >/dev/null 2>&1 && shfmt -d . || true');
  }
  if (checks.includes('lint')) {
    lines.push('command -v shellcheck >/dev/null 2>&1 && find . -name "*.sh" -print0 | xargs -0 -r shellcheck || true');
  }
  if (checks.includes('secrets')) {
    lines.push('command -v gitleaks >/dev/null 2>&1 && gitleaks protect --staged --redact || true');
  }
  // typecheck has no shell equivalent — silently skipped.
  return {
    files: [{ path: '.git/hooks/pre-commit', contents: lines.join('\n') + '\n', executable: true }],
    npmDevDeps: [],
    notes: [
      'Tools (shfmt / shellcheck / gitleaks) must be installed separately.',
      'The hook fails-open: missing tools are skipped, not errored.',
    ],
  };
}
