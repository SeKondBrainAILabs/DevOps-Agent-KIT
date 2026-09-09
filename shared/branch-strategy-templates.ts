/**
 * Branch-strategy template generator (Epic P / story P3).
 *
 * Pure templates for three strategies: single-trunk, feature-branch, git-flow.
 * Each strategy emits:
 *   - A branch-naming regex (string form) the policy can enforce.
 *   - A CODEOWNERS template stub.
 *   - A BRANCHING.md doc summarizing the rules.
 *   - A list of branch-protection rules to apply via the GitHub API.
 *
 * Service layer applies the artifacts; this module owns the policy.
 */

export type BranchStrategyId = 'single-trunk' | 'feature-branch' | 'git-flow';

export interface BranchProtectionRule {
  branchPattern: string;
  requirePullRequestReviews: boolean;
  requiredApprovingReviewCount: number;
  requireStatusChecks: boolean;
  requiredStatusChecks: string[];
  requireLinearHistory: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

export interface BranchStrategyTemplate {
  id: BranchStrategyId;
  label: string;
  /** Default branch name. */
  defaultBranch: string;
  /** Regex source the renderer can compile to validate new branch names. */
  branchNameRegexSource: string;
  /** Human-readable rule summary for tooltip / settings UI. */
  branchNameRule: string;
  /** Markdown body for `BRANCHING.md`. */
  docMarkdown: string;
  /** CODEOWNERS file template (always-merging from /). */
  codeownersTemplate: string;
  /** Protection rules to push to GitHub. */
  protectionRules: BranchProtectionRule[];
}

const COMMON_REVIEW_RULE = (branch: string): BranchProtectionRule => ({
  branchPattern: branch,
  requirePullRequestReviews: true,
  requiredApprovingReviewCount: 1,
  requireStatusChecks: true,
  requiredStatusChecks: ['ci/lint', 'ci/test'],
  requireLinearHistory: false,
  allowForcePushes: false,
  allowDeletions: false,
});

const SINGLE_TRUNK: BranchStrategyTemplate = {
  id: 'single-trunk',
  label: 'Single-trunk (everyone commits to main)',
  defaultBranch: 'main',
  branchNameRegexSource: '^(main|hotfix/[a-z0-9-]+)$',
  branchNameRule: 'Only `main` and `hotfix/<slug>` branches allowed.',
  docMarkdown:
    '# Branching: Single-trunk\n\n' +
    '- All work lands on `main` via short-lived PRs (≤24h).\n' +
    '- `hotfix/<slug>` branches are allowed for emergency fixes.\n' +
    '- No long-lived feature branches.\n' +
    '- CI must pass on every PR.\n',
  codeownersTemplate: '# CODEOWNERS — single-trunk\n* @team-leads\n',
  protectionRules: [
    {
      ...COMMON_REVIEW_RULE('main'),
      requireLinearHistory: true,
    },
  ],
};

const FEATURE_BRANCH: BranchStrategyTemplate = {
  id: 'feature-branch',
  label: 'Feature-branch (feat/* → main)',
  defaultBranch: 'main',
  branchNameRegexSource: '^(main|(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)/[a-z0-9][a-z0-9-]*)$',
  branchNameRule:
    'Branch names: `<conventional-prefix>/<slug>` ' +
    '(prefixes: feat, fix, chore, docs, refactor, test, perf, build, ci, revert).',
  docMarkdown:
    '# Branching: Feature-branch\n\n' +
    '- Default branch: `main`.\n' +
    '- New work goes on `<prefix>/<slug>` per conventional commits.\n' +
    '- Branches merge to `main` via PR with at least 1 approval.\n' +
    '- Stale branches (>30d, no commits) flagged for cleanup.\n',
  codeownersTemplate: '# CODEOWNERS — feature-branch\n* @team-leads\n',
  protectionRules: [COMMON_REVIEW_RULE('main')],
};

const GIT_FLOW: BranchStrategyTemplate = {
  id: 'git-flow',
  label: 'git-flow (develop + main + release/*)',
  defaultBranch: 'develop',
  branchNameRegexSource:
    '^(main|develop|(feature|hotfix|release|bugfix)/[a-z0-9][a-z0-9.-]*)$',
  branchNameRule:
    'Branch names: `feature/<slug>`, `hotfix/<slug>`, `release/<x.y.z>`, `bugfix/<slug>`. ' +
    'Permanent: `main`, `develop`.',
  docMarkdown:
    '# Branching: git-flow\n\n' +
    '- `develop` is the integration branch; `main` always reflects production.\n' +
    '- `feature/<slug>` branches off `develop`, merges back via PR.\n' +
    '- `release/<x.y.z>` cuts from `develop`, merges to both `main` and `develop`.\n' +
    '- `hotfix/<slug>` cuts from `main`, merges back to both.\n',
  codeownersTemplate: '# CODEOWNERS — git-flow\n* @team-leads\n',
  protectionRules: [
    COMMON_REVIEW_RULE('main'),
    COMMON_REVIEW_RULE('develop'),
    {
      ...COMMON_REVIEW_RULE('release/*'),
      requiredApprovingReviewCount: 2,
    },
  ],
};

export const BRANCH_STRATEGIES: ReadonlyArray<BranchStrategyTemplate> = [
  SINGLE_TRUNK,
  FEATURE_BRANCH,
  GIT_FLOW,
];

export function getBranchStrategy(id: BranchStrategyId): BranchStrategyTemplate {
  const t = BRANCH_STRATEGIES.find((x) => x.id === id);
  if (!t) {
    throw new Error(`Unknown branch strategy id: ${id}`);
  }
  return t;
}

export function isValidBranchName(name: string, strategy: BranchStrategyTemplate): boolean {
  return new RegExp(strategy.branchNameRegexSource).test(name);
}
