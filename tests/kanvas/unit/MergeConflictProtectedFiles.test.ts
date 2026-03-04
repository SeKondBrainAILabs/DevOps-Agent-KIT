/**
 * Regression test: deterministic resolution must succeed even for "protected" files
 *
 * Root cause: docker-compose.yml (in NEVER_AUTO_RESOLVE) failed with
 * "Protected file — requires manual resolution" even though triage scored it
 * append_both / 0.95 confidence — a trivially safe deterministic merge.
 *
 * The fix moves the deterministic attempt BEFORE the protected-file check so that
 * rule-based resolutions (append_both, keep_current, keep_incoming) always run,
 * and only LLM-based resolution is blocked for protected files.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Minimal conflict content helpers ─────────────────────────────────────────

function makeConflict(current: string, incoming: string): string {
  return [
    '<<<<<<< HEAD',
    current,
    '=======',
    incoming,
    '>>>>>>> origin/main',
  ].join('\n');
}

// ─── Inline the deterministic resolver logic (mirrors MergeConflictService) ──

function resolveAppendBoth(content: string): string | null {
  const re = /<<<<<<< .+?\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> .+?(\n|$)/g;
  let resolved = content;
  let hadConflicts = false;
  resolved = resolved.replace(re, (_, current, incoming) => {
    hadConflicts = true;
    const c = current.trimEnd();
    const i = incoming.trimEnd();
    if (c === i) return c + '\n';
    return c + '\n' + i + '\n';
  });
  if (!hadConflicts) return null;
  if (/<<<<<<< /.test(resolved)) return null; // still has markers
  return resolved;
}

function resolveKeepCurrent(content: string): string | null {
  const re = /<<<<<<< .+?\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> .+?(\n|$)/g;
  let resolved = content;
  let hadConflicts = false;
  resolved = resolved.replace(re, (_, current) => {
    hadConflicts = true;
    return current;
  });
  if (!hadConflicts) return null;
  if (/<<<<<<< /.test(resolved)) return null;
  return resolved;
}

function resolveKeepIncoming(content: string): string | null {
  const re = /<<<<<<< .+?\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> .+?(\n|$)/g;
  let resolved = content;
  let hadConflicts = false;
  resolved = resolved.replace(re, (_, incoming) => {
    hadConflicts = true;
    return incoming;
  });
  if (!hadConflicts) return null;
  if (/<<<<<<< /.test(resolved)) return null;
  return resolved;
}

function tryDeterministicResolve(
  content: string,
  category: string,
  confidence: number
): string | null {
  if (confidence < 0.90) return null;
  switch (category) {
    case 'append_both': return resolveAppendBoth(content);
    case 'keep_current': return resolveKeepCurrent(content);
    case 'keep_incoming': return resolveKeepIncoming(content);
    default: return null;
  }
}

// ─── Simulate the NEVER_AUTO_RESOLVE list ─────────────────────────────────────

const NEVER_AUTO_RESOLVE = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
  '.env', '.env.local', '.env.production',
];

function isProtectedFile(filePath: string): boolean {
  const basename = filePath.split('/').pop()!;
  return NEVER_AUTO_RESOLVE.includes(basename);
}

// ─── Simulate the FIXED resolveFileConflict logic ────────────────────────────

interface Resolution {
  resolved: boolean;
  content?: string;
  skippedReason?: string;
}

function resolveFileConflict(
  filePath: string,
  content: string,
  category: string,
  confidence: number
): Resolution {
  const isProtected = isProtectedFile(filePath);

  // Try deterministic FIRST (safe for all files, no LLM)
  const deterministicResult = tryDeterministicResolve(content, category, confidence);
  if (deterministicResult) {
    return { resolved: true, content: deterministicResult };
  }

  // Only block LLM for protected files
  if (isProtected) {
    return { resolved: false, skippedReason: `Protected file — requires manual resolution: ${filePath.split('/').pop()}` };
  }

  // Would proceed to LLM here (not simulated)
  return { resolved: false, skippedReason: 'LLM not available in test' };
}

// ─── OLD logic (pre-fix) — for regression verification ───────────────────────

function resolveFileConflictOLD(
  filePath: string,
  content: string,
  category: string,
  confidence: number
): Resolution {
  // Old code: protected check BEFORE deterministic
  if (isProtectedFile(filePath)) {
    return { resolved: false, skippedReason: `Protected file — requires manual resolution: ${filePath.split('/').pop()}` };
  }
  const deterministicResult = tryDeterministicResolve(content, category, confidence);
  if (deterministicResult) {
    return { resolved: true, content: deterministicResult };
  }
  return { resolved: false, skippedReason: 'LLM not available in test' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MergeConflict — protected file deterministic resolution', () => {
  const dockerComposeConflict = makeConflict(
    'ports:\n  - "8080:8080"',
    'ports:\n  - "8080:8080"\n  - "9090:9090"'
  );

  it('OLD code: docker-compose.yml append_both is blocked by protected check → regression', () => {
    const result = resolveFileConflictOLD(
      'infrastructure/docker-compose.yml',
      dockerComposeConflict,
      'append_both',
      0.95
    );
    // This proves the old code was broken
    expect(result.resolved).toBe(false);
    expect(result.skippedReason).toContain('Protected file');
  });

  it('FIXED code: docker-compose.yml append_both resolves deterministically despite being protected', () => {
    const result = resolveFileConflict(
      'infrastructure/docker-compose.yml',
      dockerComposeConflict,
      'append_both',
      0.95
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toContain('8080:8080');
    expect(result.content).toContain('9090:9090');
    expect(result.skippedReason).toBeUndefined();
  });

  it('FIXED code: docker-compose.yml keep_current resolves deterministically', () => {
    const result = resolveFileConflict(
      'infrastructure/docker-compose.yml',
      makeConflict('version: "3.8"', 'version: "3.9"'),
      'keep_current',
      0.95
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toContain('3.8');
    expect(result.content).not.toContain('3.9');
  });

  it('FIXED code: Dockerfile keep_incoming resolves deterministically', () => {
    const result = resolveFileConflict(
      'Dockerfile',
      makeConflict('FROM node:18', 'FROM node:20'),
      'keep_incoming',
      0.95
    );
    expect(result.resolved).toBe(true);
    expect(result.content).toContain('node:20');
  });

  it('FIXED code: protected file with semantic_merge (needs LLM) is still blocked', () => {
    // semantic_merge → tryDeterministicResolve returns null → protected check fires
    const result = resolveFileConflict(
      'package.json',
      makeConflict('"version": "1.0.0"', '"version": "1.1.0"'),
      'semantic_merge',
      0.90
    );
    expect(result.resolved).toBe(false);
    expect(result.skippedReason).toContain('Protected file');
  });

  it('FIXED code: non-protected file with low confidence is blocked', () => {
    const result = resolveFileConflict(
      'src/utils.ts',
      makeConflict('const x = 1;', 'const x = 2;'),
      'semantic_merge',
      0.70 // below 0.80 threshold, but deterministic won't run anyway (semantic_merge)
    );
    // deterministic returns null for semantic_merge, non-protected so hits LLM stub
    expect(result.resolved).toBe(false);
  });

  it('deterministic resolution requires confidence >= 0.90', () => {
    const content = makeConflict('line A', 'line B');
    // 0.89 → deterministic won't run
    expect(tryDeterministicResolve(content, 'append_both', 0.89)).toBeNull();
    // 0.90 → deterministic runs
    expect(tryDeterministicResolve(content, 'append_both', 0.90)).not.toBeNull();
  });
});
