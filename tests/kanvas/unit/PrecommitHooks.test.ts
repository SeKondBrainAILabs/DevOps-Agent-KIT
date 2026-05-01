/**
 * Unit Tests for P2 — Pre-commit hook installer template generator
 */

import { describe, it, expect } from '@jest/globals';
import {
  ALL_CHECKS,
  dedupeChecks,
  generatePrecommitTemplate,
} from '../../../shared/precommit-hook-templates';

describe('dedupeChecks (P2)', () => {
  it('removes duplicates', () => {
    expect(dedupeChecks(['lint', 'lint', 'format'])).toEqual(['lint', 'format']);
  });
  it('preserves order', () => {
    expect(dedupeChecks(['secrets', 'lint', 'format', 'secrets'])).toEqual([
      'secrets',
      'lint',
      'format',
    ]);
  });
  it('exposes ALL_CHECKS', () => {
    expect(ALL_CHECKS).toEqual(['lint', 'format', 'typecheck', 'secrets']);
  });
});

describe('TS / Node template (P2)', () => {
  it('produces husky hook + lint-staged config', () => {
    const out = generatePrecommitTemplate({
      projectType: 'ts-node',
      checks: ['lint', 'format'],
    });
    const huskyFile = out.files.find((f) => f.path === '.husky/pre-commit');
    expect(huskyFile).toBeDefined();
    expect(huskyFile!.executable).toBe(true);
    expect(huskyFile!.contents).toMatch(/lint-staged/);

    const lsFile = out.files.find((f) => f.path === 'lint-staged.config.js');
    expect(lsFile).toBeDefined();
    expect(lsFile!.contents).toMatch(/eslint --fix/);
    expect(lsFile!.contents).toMatch(/prettier --write/);
  });

  it('includes typecheck step when requested', () => {
    const out = generatePrecommitTemplate({
      projectType: 'ts-node',
      checks: ['typecheck'],
    });
    expect(out.files[0].contents).toMatch(/tsc --noEmit/);
  });

  it('includes gitleaks line + note when secrets check is requested', () => {
    const out = generatePrecommitTemplate({
      projectType: 'ts-node',
      checks: ['secrets'],
    });
    expect(out.files[0].contents).toMatch(/gitleaks protect --staged/);
    expect(out.notes.some((n) => /gitleaks/i.test(n))).toBe(true);
  });

  it('lists devDependencies that match the chosen checks', () => {
    const out = generatePrecommitTemplate({
      projectType: 'ts-node',
      checks: ['lint', 'format'],
    });
    expect(out.npmDevDeps).toEqual(expect.arrayContaining(['husky', 'lint-staged', 'eslint', 'prettier']));
  });

  it('dedupes devDependencies', () => {
    const out = generatePrecommitTemplate({
      projectType: 'ts-node',
      checks: ['lint', 'format', 'lint'],
    });
    const counts = new Map<string, number>();
    for (const d of out.npmDevDeps) counts.set(d, (counts.get(d) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });
});

describe('Python template (P2)', () => {
  it('produces .pre-commit-config.yaml with the requested hooks', () => {
    const out = generatePrecommitTemplate({
      projectType: 'python',
      checks: ['lint', 'format', 'typecheck', 'secrets'],
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('.pre-commit-config.yaml');
    const y = out.files[0].contents;
    expect(y).toMatch(/black/);
    expect(y).toMatch(/ruff/);
    expect(y).toMatch(/mypy/);
    expect(y).toMatch(/gitleaks/);
  });

  it('emits "repos: []" when no checks selected', () => {
    const out = generatePrecommitTemplate({ projectType: 'python', checks: [] });
    expect(out.files[0].contents).toBe('repos: []\n');
  });

  it('does not require any npm devDependencies', () => {
    const out = generatePrecommitTemplate({ projectType: 'python', checks: ['lint'] });
    expect(out.npmDevDeps).toEqual([]);
  });
});

describe('Shell template (P2)', () => {
  it('writes a raw .git/hooks/pre-commit script', () => {
    const out = generatePrecommitTemplate({
      projectType: 'shell',
      checks: ['lint', 'format', 'secrets'],
    });
    expect(out.files[0].path).toBe('.git/hooks/pre-commit');
    expect(out.files[0].executable).toBe(true);
    expect(out.files[0].contents).toMatch(/shellcheck/);
    expect(out.files[0].contents).toMatch(/shfmt/);
    expect(out.files[0].contents).toMatch(/gitleaks/);
  });

  it('silently skips typecheck (no shell equivalent)', () => {
    const out = generatePrecommitTemplate({
      projectType: 'shell',
      checks: ['typecheck'],
    });
    // Should produce a valid file with no typecheck step (just shebang + set -e)
    expect(out.files[0].contents).not.toMatch(/typecheck/);
    expect(out.files[0].contents).not.toMatch(/mypy/);
    expect(out.files[0].contents).not.toMatch(/tsc/);
  });
});
