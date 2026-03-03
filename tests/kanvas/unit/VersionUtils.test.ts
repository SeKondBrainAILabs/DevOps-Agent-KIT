import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseVersion, bumpPackageVersion } from '../../../src/version-utils.js';

describe('parseVersion', () => {
  it('should parse a standard version string', () => {
    expect(parseVersion('1.1.1')).toEqual({ major: 1, minor: 1, patch: 1 });
  });

  it('should parse version with larger numbers', () => {
    expect(parseVersion('12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 });
  });

  it('should parse version with zeros', () => {
    expect(parseVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('should default to 0.0.0 for malformed version', () => {
    expect(parseVersion('abc')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion('1.2')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion('')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('should default to 0.0.0 for null/undefined input', () => {
    expect(parseVersion(null as any)).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion(undefined as any)).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('should handle whitespace around version', () => {
    expect(parseVersion('  1.2.3  ')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
});

describe('bumpPackageVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-utils-test-'));
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writePackageJson(version: string) {
    const pkg = { name: 'test-pkg', version };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }

  function readVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8'));
    return pkg.version;
  }

  it('should bump minor and reset patch', () => {
    writePackageJson('1.1.1');
    const result = bumpPackageVersion(tmpDir, 'minor');
    expect(result).toBe('1.2.0');
    expect(readVersion()).toBe('1.2.0');
  });

  it('should bump patch', () => {
    writePackageJson('1.2.0');
    const result = bumpPackageVersion(tmpDir, 'patch');
    expect(result).toBe('1.2.1');
    expect(readVersion()).toBe('1.2.1');
  });

  it('should bump major and reset minor and patch', () => {
    writePackageJson('1.2.1');
    const result = bumpPackageVersion(tmpDir, 'major');
    expect(result).toBe('2.0.0');
    expect(readVersion()).toBe('2.0.0');
  });

  it('should return null when package.json is missing', () => {
    const result = bumpPackageVersion(path.join(tmpDir, 'nonexistent'), 'patch');
    expect(result).toBeNull();
  });

  it('should handle malformed version by defaulting to 0.0.0 then bumping', () => {
    writePackageJson('invalid');
    const result = bumpPackageVersion(tmpDir, 'patch');
    expect(result).toBe('0.0.1');
    expect(readVersion()).toBe('0.0.1');
  });

  it('should preserve other package.json fields', () => {
    const pkg = { name: 'my-app', version: '1.0.0', description: 'test', scripts: { build: 'tsc' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

    bumpPackageVersion(tmpDir, 'minor');

    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8'));
    expect(updated.version).toBe('1.1.0');
    expect(updated.name).toBe('my-app');
    expect(updated.description).toBe('test');
    expect(updated.scripts.build).toBe('tsc');
  });
});
