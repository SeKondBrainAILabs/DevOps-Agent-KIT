/**
 * Unit Tests for G1 — Disk usage breakdown reducer
 */

import { describe, it, expect } from '@jest/globals';
import {
  RECLAIMABLE_CATEGORIES,
  categorizePath,
  formatBytes,
  reduceDiskBreakdown,
} from '../../../shared/disk-usage';

describe('categorizePath (G1)', () => {
  it('detects .git, node_modules, .venv/venv, dist/build, .worktrees', () => {
    expect(categorizePath('.git/objects')).toBe('.git');
    expect(categorizePath('node_modules/foo')).toBe('node_modules');
    expect(categorizePath('.venv/lib')).toBe('.venv');
    expect(categorizePath('venv/lib')).toBe('.venv');
    expect(categorizePath('dist/index.js')).toBe('dist-or-build');
    expect(categorizePath('build/output')).toBe('dist-or-build');
    expect(categorizePath('.worktrees/feat-x')).toBe('.worktrees');
  });

  it('falls back to "source" for everything else', () => {
    expect(categorizePath('src/auth.ts')).toBe('source');
    expect(categorizePath('docs/readme.md')).toBe('source');
  });

  it('strips leading slashes before classifying', () => {
    expect(categorizePath('/node_modules/foo')).toBe('node_modules');
  });
});

describe('reduceDiskBreakdown (G1)', () => {
  it('sums per-category bytes and total', () => {
    const out = reduceDiskBreakdown([
      { relPath: '.git', bytes: 100 },
      { relPath: 'node_modules', bytes: 5000 },
      { relPath: 'src', bytes: 200 },
      { relPath: 'dist', bytes: 800 },
      { relPath: 'build', bytes: 200 },
    ]);
    expect(out.totalBytes).toBe(6300);
    expect(out.byCategory['.git']).toBe(100);
    expect(out.byCategory['node_modules']).toBe(5000);
    expect(out.byCategory['source']).toBe(200);
    expect(out.byCategory['dist-or-build']).toBe(1000);
  });

  it('reclaimableBytes sums the reclaimable categories only', () => {
    const out = reduceDiskBreakdown([
      { relPath: '.git', bytes: 100 },
      { relPath: 'node_modules', bytes: 5000 },
      { relPath: '.venv', bytes: 2000 },
      { relPath: 'dist', bytes: 800 },
      { relPath: 'src', bytes: 200 },
      { relPath: '.worktrees/feat-x', bytes: 999 }, // not reclaimable here
    ]);
    expect(out.reclaimableBytes).toBe(5000 + 2000 + 800);
    expect(out.reclaimableFraction).toBeCloseTo(7800 / (100 + 5000 + 2000 + 800 + 200 + 999));
  });

  it('reclaimableFraction is 0 when total is 0', () => {
    const out = reduceDiskBreakdown([]);
    expect(out.reclaimableFraction).toBe(0);
    expect(out.totalBytes).toBe(0);
  });

  it('skips negative or non-finite byte values', () => {
    const out = reduceDiskBreakdown([
      { relPath: 'src', bytes: 100 },
      { relPath: 'src', bytes: -50 },
      { relPath: 'src', bytes: NaN },
      { relPath: 'src', bytes: Infinity },
    ]);
    expect(out.totalBytes).toBe(100);
  });

  it('ensures every category is present (zeroed) even if no entries hit it', () => {
    const out = reduceDiskBreakdown([{ relPath: 'src', bytes: 1 }]);
    for (const cat of RECLAIMABLE_CATEGORIES) {
      expect(out.byCategory[cat]).toBe(0);
    }
  });
});

describe('formatBytes (G1)', () => {
  it('returns B / KB / MB / GB at the right thresholds', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 ** 2)).toBe('2.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
  it('safe on negative / non-finite', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});
