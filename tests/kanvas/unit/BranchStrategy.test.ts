/**
 * Unit Tests for P3 — Branch-strategy templates
 */

import { describe, it, expect } from '@jest/globals';
import {
  BRANCH_STRATEGIES,
  getBranchStrategy,
  isValidBranchName,
} from '../../../shared/branch-strategy-templates';

describe('BRANCH_STRATEGIES (P3)', () => {
  it('exposes 3 strategies', () => {
    expect(BRANCH_STRATEGIES).toHaveLength(3);
    expect(BRANCH_STRATEGIES.map((s) => s.id)).toEqual([
      'single-trunk',
      'feature-branch',
      'git-flow',
    ]);
  });
});

describe('getBranchStrategy (P3)', () => {
  it('returns the matching template', () => {
    expect(getBranchStrategy('single-trunk').defaultBranch).toBe('main');
    expect(getBranchStrategy('git-flow').defaultBranch).toBe('develop');
  });
  it('throws on unknown id', () => {
    expect(() => getBranchStrategy('bogus' as 'single-trunk')).toThrow();
  });
});

describe('single-trunk strategy (P3)', () => {
  const strategy = getBranchStrategy('single-trunk');

  it('accepts main and hotfix/<slug>', () => {
    expect(isValidBranchName('main', strategy)).toBe(true);
    expect(isValidBranchName('hotfix/auth-bug', strategy)).toBe(true);
  });
  it('rejects feature branches', () => {
    expect(isValidBranchName('feat/login', strategy)).toBe(false);
    expect(isValidBranchName('develop', strategy)).toBe(false);
  });
  it('main protection rule requires linear history', () => {
    const rule = strategy.protectionRules.find((r) => r.branchPattern === 'main');
    expect(rule?.requireLinearHistory).toBe(true);
  });
});

describe('feature-branch strategy (P3)', () => {
  const strategy = getBranchStrategy('feature-branch');

  it('accepts conventional prefixes', () => {
    for (const name of [
      'main',
      'feat/login',
      'fix/null-deref',
      'chore/update-deps',
      'docs/readme',
      'refactor/auth',
      'test/coverage',
    ]) {
      expect(isValidBranchName(name, strategy)).toBe(true);
    }
  });

  it('rejects non-conventional names', () => {
    expect(isValidBranchName('my-branch', strategy)).toBe(false);
    expect(isValidBranchName('Feature/login', strategy)).toBe(false); // case-sensitive
    expect(isValidBranchName('release/1.0', strategy)).toBe(false);
  });
});

describe('git-flow strategy (P3)', () => {
  const strategy = getBranchStrategy('git-flow');

  it('accepts feature, hotfix, release, bugfix + main + develop', () => {
    for (const name of [
      'main',
      'develop',
      'feature/login',
      'hotfix/regress',
      'release/1.2.0',
      'bugfix/null-deref',
    ]) {
      expect(isValidBranchName(name, strategy)).toBe(true);
    }
  });

  it('rejects unknown prefixes', () => {
    expect(isValidBranchName('feat/login', strategy)).toBe(false); // 'feat' not allowed in git-flow
  });

  it('release/* protection requires 2 approvals', () => {
    const rule = strategy.protectionRules.find((r) => r.branchPattern === 'release/*');
    expect(rule?.requiredApprovingReviewCount).toBe(2);
  });
});

describe('all strategies (P3)', () => {
  it('every strategy ships docs + CODEOWNERS template', () => {
    for (const s of BRANCH_STRATEGIES) {
      expect(s.docMarkdown.length).toBeGreaterThan(0);
      expect(s.codeownersTemplate.length).toBeGreaterThan(0);
      expect(s.protectionRules.length).toBeGreaterThan(0);
    }
  });
});
