/**
 * Unit Tests for shared/kit-generated-files.ts
 *
 * KIT rewrites a handful of files in every worktree. Counting them as
 * uncommitted work made nearly every session's delete dialog warn, which
 * taught people to click past the warning when it was real.
 */

import { describe, it, expect } from '@jest/globals';
import {
  isKitGeneratedPath,
  meaningfulStatusLines,
  porcelainPath,
} from '../../../shared/kit-generated-files';

describe('isKitGeneratedPath', () => {
  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.vscode/settings.json',
    '.mcp.json',
    '.agent-config',
    '.S9N_KIT_DevOpsAgent/config.json',
    '.S9N_KIT_DevOpsAgent/sessions/sess_1.json',
    '.devops-commit-abc123.msg',
    '.claude-session-abc.md',
    '.codex-session-abc.md',
    './.claude/settings.json',
  ])('treats %s as generated', (p) => {
    expect(isKitGeneratedPath(p)).toBe(true);
  });

  it.each([
    'settings.json',
    'src/.claude/settings.json',
    'dashboard/.vscode/settings.json',
    '.claude/commands/review.md',
    '.env',
    'backend/core/auth.py',
    'docs/.mcp.json.example',
  ])('treats %s as real work', (p) => {
    expect(isKitGeneratedPath(p)).toBe(false);
  });
});

describe('porcelainPath', () => {
  it('reads the path from each status shape', () => {
    expect(porcelainPath(' M .claude/settings.json')).toBe('.claude/settings.json');
    expect(porcelainPath('M  src/a.ts')).toBe('src/a.ts');
    expect(porcelainPath('?? notes.md')).toBe('notes.md');
    expect(porcelainPath(' D gone.ts')).toBe('gone.ts');
  });

  it('survives a first line whose leading space was trimmed', () => {
    // `stdout.trim()` eats the blank X column of the first line.
    expect(porcelainPath('M .claude/settings.json')).toBe('.claude/settings.json');
  });

  it('reports a rename by its destination, and unquotes', () => {
    expect(porcelainPath('R  old.ts -> new.ts')).toBe('new.ts');
    expect(porcelainPath('?? "with space.md"')).toBe('with space.md');
  });
});

describe('meaningfulStatusLines', () => {
  it('drops only the generated files', () => {
    const out = [
      ' M .claude/settings.json',
      ' M .vscode/settings.json',
      '?? .S9N_KIT_DevOpsAgent/sessions/sess_1.json',
      ' M backend/core/auth.py',
      '?? notes.md',
      '',
    ].join('\n');
    expect(meaningfulStatusLines(out)).toEqual([' M backend/core/auth.py', '?? notes.md']);
  });

  it('is empty when the only change is a settings file', () => {
    expect(meaningfulStatusLines(' M .claude/settings.json\n')).toEqual([]);
    expect(meaningfulStatusLines('M .claude/settings.json')).toEqual([]);
  });

  it('is empty for a clean tree', () => {
    expect(meaningfulStatusLines('')).toEqual([]);
  });
});

describe('untracked directories', () => {
  it('does NOT swallow a collapsed untracked directory — callers must pass -uall', () => {
    // `git status --porcelain` reports a new .claude/ as one line, `?? .claude/`,
    // which might hold real files. Only per-file output can be filtered safely.
    expect(meaningfulStatusLines('?? .claude/\n')).toEqual(['?? .claude/']);
  });
});
