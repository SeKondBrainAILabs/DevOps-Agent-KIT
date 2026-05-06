/**
 * Github Actions scaffold generator (Epic P / story P1).
 *
 * Pure template generator: pick a project type + which steps to include,
 * get back the workflow YAML and any companion files. The Electron service
 * writes them to `.github/workflows/ci.yml`.
 */

export type CiProjectType = 'ts-node' | 'python' | 'go';
export type CiStep = 'install' | 'lint' | 'typecheck' | 'test' | 'coverage';

export const ALL_CI_STEPS: ReadonlyArray<CiStep> = [
  'install',
  'lint',
  'typecheck',
  'test',
  'coverage',
];

export interface CiScaffoldInputs {
  projectType: CiProjectType;
  steps: ReadonlyArray<CiStep>;
  /** Branches CI should run on (push). Default ['main']. */
  branches?: ReadonlyArray<string>;
  /** Run on pull-requests targeting these branches. Default ['main']. */
  prTargets?: ReadonlyArray<string>;
  /** Node version for ts-node project. Default '20'. */
  nodeVersion?: string;
  /** Python version for python project. Default '3.12'. */
  pythonVersion?: string;
  /** Go version for go project. Default '1.22'. */
  goVersion?: string;
}

export interface CiScaffoldFile {
  path: string;
  contents: string;
}

export interface CiScaffoldResult {
  files: CiScaffoldFile[];
}

export function generateCiWorkflow(input: CiScaffoldInputs): CiScaffoldResult {
  const branches = input.branches ?? ['main'];
  const prTargets = input.prTargets ?? ['main'];
  const lines: string[] = [];

  lines.push('name: CI');
  lines.push('on:');
  lines.push('  push:');
  lines.push('    branches:');
  for (const b of branches) lines.push(`      - ${b}`);
  lines.push('  pull_request:');
  lines.push('    branches:');
  for (const b of prTargets) lines.push(`      - ${b}`);
  lines.push('');
  lines.push('jobs:');
  lines.push('  ci:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');

  switch (input.projectType) {
    case 'ts-node':
      lines.push(...renderTsSteps(input));
      break;
    case 'python':
      lines.push(...renderPythonSteps(input));
      break;
    case 'go':
      lines.push(...renderGoSteps(input));
      break;
  }

  return {
    files: [{ path: '.github/workflows/ci.yml', contents: lines.join('\n') + '\n' }],
  };
}

function renderTsSteps(input: CiScaffoldInputs): string[] {
  const lines: string[] = [];
  const node = input.nodeVersion ?? '20';
  lines.push('      - uses: actions/setup-node@v4');
  lines.push('        with:');
  lines.push(`          node-version: '${node}'`);
  lines.push("          cache: 'npm'");
  if (input.steps.includes('install')) {
    lines.push('      - run: npm ci');
  }
  if (input.steps.includes('lint')) {
    lines.push('      - run: npm run lint');
  }
  if (input.steps.includes('typecheck')) {
    lines.push('      - run: npx tsc --noEmit');
  }
  if (input.steps.includes('test')) {
    lines.push('      - run: npm test');
  }
  if (input.steps.includes('coverage')) {
    lines.push('      - run: npm run coverage');
    lines.push('      - uses: actions/upload-artifact@v4');
    lines.push('        with:');
    lines.push('          name: coverage-report');
    lines.push('          path: coverage/');
  }
  return lines;
}

function renderPythonSteps(input: CiScaffoldInputs): string[] {
  const lines: string[] = [];
  const py = input.pythonVersion ?? '3.12';
  lines.push('      - uses: actions/setup-python@v5');
  lines.push('        with:');
  lines.push(`          python-version: '${py}'`);
  if (input.steps.includes('install')) {
    lines.push('      - run: pip install -e .[dev]');
  }
  if (input.steps.includes('lint')) {
    lines.push('      - run: ruff check .');
  }
  if (input.steps.includes('typecheck')) {
    lines.push('      - run: mypy .');
  }
  if (input.steps.includes('test')) {
    lines.push('      - run: pytest');
  }
  if (input.steps.includes('coverage')) {
    lines.push('      - run: pytest --cov=. --cov-report=xml');
    lines.push('      - uses: actions/upload-artifact@v4');
    lines.push('        with:');
    lines.push('          name: coverage-report');
    lines.push('          path: coverage.xml');
  }
  return lines;
}

function renderGoSteps(input: CiScaffoldInputs): string[] {
  const lines: string[] = [];
  const go = input.goVersion ?? '1.22';
  lines.push('      - uses: actions/setup-go@v5');
  lines.push('        with:');
  lines.push(`          go-version: '${go}'`);
  if (input.steps.includes('install')) {
    lines.push('      - run: go mod download');
  }
  if (input.steps.includes('lint')) {
    lines.push('      - uses: golangci/golangci-lint-action@v6');
  }
  // typecheck is implicit in `go build`/`go test`
  if (input.steps.includes('test')) {
    lines.push('      - run: go test ./...');
  }
  if (input.steps.includes('coverage')) {
    lines.push('      - run: go test -coverprofile=coverage.out ./...');
    lines.push('      - uses: actions/upload-artifact@v4');
    lines.push('        with:');
    lines.push('          name: coverage-report');
    lines.push('          path: coverage.out');
  }
  return lines;
}
