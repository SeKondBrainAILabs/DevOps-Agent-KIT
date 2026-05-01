/**
 * Unit Tests for P1 — Github Actions scaffold generator
 */

import { describe, it, expect } from '@jest/globals';
import {
  ALL_CI_STEPS,
  generateCiWorkflow,
} from '../../../shared/github-actions-scaffold';

describe('generateCiWorkflow — common (P1)', () => {
  it('writes to .github/workflows/ci.yml', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install', 'test'],
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('.github/workflows/ci.yml');
  });

  it('starts with `name: CI` and includes push + PR triggers', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install', 'test'],
    });
    const yaml = out.files[0].contents;
    expect(yaml.startsWith('name: CI')).toBe(true);
    expect(yaml).toMatch(/on:\s*\n\s+push:/);
    expect(yaml).toMatch(/pull_request:/);
  });

  it('respects custom branches + prTargets', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install'],
      branches: ['main', 'develop'],
      prTargets: ['develop'],
    });
    const yaml = out.files[0].contents;
    expect(yaml).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+- develop/);
    expect(yaml).toMatch(/pull_request:\s*\n\s+branches:\s*\n\s+- develop/);
  });

  it('exposes ALL_CI_STEPS', () => {
    expect(ALL_CI_STEPS).toEqual(['install', 'lint', 'typecheck', 'test', 'coverage']);
  });
});

describe('generateCiWorkflow — TS / Node (P1)', () => {
  it('includes setup-node@v4 with the requested version', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install'],
      nodeVersion: '22',
    });
    const yaml = out.files[0].contents;
    expect(yaml).toMatch(/uses: actions\/setup-node@v4/);
    expect(yaml).toMatch(/node-version: '22'/);
  });

  it('includes lint / typecheck / test / coverage steps when requested', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install', 'lint', 'typecheck', 'test', 'coverage'],
    });
    const yaml = out.files[0].contents;
    expect(yaml).toMatch(/npm ci/);
    expect(yaml).toMatch(/npm run lint/);
    expect(yaml).toMatch(/tsc --noEmit/);
    expect(yaml).toMatch(/npm test/);
    expect(yaml).toMatch(/npm run coverage/);
    expect(yaml).toMatch(/upload-artifact@v4/);
  });

  it('omits steps not requested', () => {
    const out = generateCiWorkflow({
      projectType: 'ts-node',
      steps: ['install', 'test'],
    });
    const yaml = out.files[0].contents;
    expect(yaml).not.toMatch(/npm run lint/);
    expect(yaml).not.toMatch(/tsc --noEmit/);
    expect(yaml).not.toMatch(/coverage/);
  });
});

describe('generateCiWorkflow — Python (P1)', () => {
  it('includes setup-python@v5 + ruff/mypy/pytest as requested', () => {
    const out = generateCiWorkflow({
      projectType: 'python',
      steps: ['install', 'lint', 'typecheck', 'test', 'coverage'],
      pythonVersion: '3.13',
    });
    const yaml = out.files[0].contents;
    expect(yaml).toMatch(/uses: actions\/setup-python@v5/);
    expect(yaml).toMatch(/python-version: '3.13'/);
    expect(yaml).toMatch(/pip install -e \.\[dev\]/);
    expect(yaml).toMatch(/ruff check \./);
    expect(yaml).toMatch(/mypy \./);
    expect(yaml).toMatch(/pytest/);
    expect(yaml).toMatch(/pytest --cov/);
  });
});

describe('generateCiWorkflow — Go (P1)', () => {
  it('includes setup-go@v5 + lint + go test', () => {
    const out = generateCiWorkflow({
      projectType: 'go',
      steps: ['install', 'lint', 'test', 'coverage'],
      goVersion: '1.23',
    });
    const yaml = out.files[0].contents;
    expect(yaml).toMatch(/uses: actions\/setup-go@v5/);
    expect(yaml).toMatch(/go-version: '1.23'/);
    expect(yaml).toMatch(/go mod download/);
    expect(yaml).toMatch(/golangci-lint-action@v6/);
    expect(yaml).toMatch(/go test \.\/\.\.\./);
    expect(yaml).toMatch(/coverprofile=coverage.out/);
  });
});
