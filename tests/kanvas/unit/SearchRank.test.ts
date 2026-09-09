/**
 * Unit Tests for L1 — Search ranker
 */

import { describe, it, expect } from '@jest/globals';
import {
  rankSearch,
  scoreItem,
  tokenize,
  type SearchableItem,
} from '../../../shared/search-rank';

const item = (id: string, kind: SearchableItem['kind'], label: string): SearchableItem => ({
  id,
  kind,
  label,
});

describe('tokenize (L1)', () => {
  it('splits on - / _ . whitespace', () => {
    expect(tokenize('feat/PROJ-123-add_login.test')).toEqual([
      'feat',
      'proj',
      '123',
      'add',
      'login',
      'test',
    ]);
  });
  it('lowercases everything', () => {
    expect(tokenize('Core_Kanvas')).toEqual(['core', 'kanvas']);
  });
  it('returns [] for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('scoreItem — match tiers (L1)', () => {
  it('exact match scores higher than prefix', () => {
    const exact = scoreItem(item('1', 'repo', 'core_kanvas'), 'core_kanvas');
    const prefix = scoreItem(item('2', 'repo', 'core_kanvas_lite'), 'core_kanvas');
    expect(exact).toBeGreaterThan(prefix);
  });

  it('prefix scores higher than word-boundary substring', () => {
    const prefix = scoreItem(item('1', 'repo', 'kanvas-app'), 'kanv');
    const wordBoundary = scoreItem(item('2', 'repo', 'core-kanvas'), 'kanv');
    expect(prefix).toBeGreaterThan(wordBoundary);
  });

  it('any-substring still scores positive', () => {
    const sub = scoreItem(item('1', 'repo', 'mykanvas'), 'kanv');
    expect(sub).toBeGreaterThan(0);
  });

  it('zero score on empty query', () => {
    expect(scoreItem(item('1', 'repo', 'kanvas'), '')).toBe(0);
  });

  it('zero score on no match', () => {
    expect(scoreItem(item('1', 'repo', 'kanvas'), 'foobar')).toBe(0);
  });
});

describe('scoreItem — token coverage bonus (L1)', () => {
  it('multi-token queries get partial-credit', () => {
    const partial = scoreItem(item('1', 'branch', 'feat/login-page'), 'add login');
    const full = scoreItem(item('2', 'branch', 'feat/add-login'), 'add login');
    expect(full).toBeGreaterThan(partial);
  });
});

describe('rankSearch (L1)', () => {
  const items: SearchableItem[] = [
    item('a', 'repo', 'kanvas'),
    item('b', 'repo', 'kanvas-app'),
    item('c', 'branch', 'feat/kanvas-overhaul'),
    item('d', 'repo', 'kora-stack'),
    item('e', 'pr', 'Refactor kanvas worktree handling'),
    item('f', 'file', 'src/kanvas/index.ts'),
  ];

  it('returns hits sorted by score', () => {
    const out = rankSearch(items, 'kanvas');
    expect(out.length).toBeGreaterThan(0);
    // Exact match must be first
    expect(out[0].item.label).toBe('kanvas');
  });

  it('filters out non-matches', () => {
    const out = rankSearch(items, 'kanvas');
    expect(out.every((h) => h.item.label.toLowerCase().includes('kanvas'))).toBe(true);
    expect(out.find((h) => h.item.id === 'd')).toBeUndefined();
  });

  it('honors a kinds filter', () => {
    const out = rankSearch(items, 'kanvas', { kinds: ['branch'] });
    expect(out.every((h) => h.item.kind === 'branch')).toBe(true);
  });

  it('honors limit', () => {
    const out = rankSearch(items, 'kanvas', { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('clamps negative limit to []', () => {
    const out = rankSearch(items, 'kanvas', { limit: -1 });
    expect(out).toEqual([]);
  });

  it('determinstic tie-breaker: label asc, then id asc', () => {
    const tied = [
      item('z', 'repo', 'core-stack'),
      item('a', 'repo', 'core-stack'),
    ];
    const out = rankSearch(tied, 'core-stack');
    expect(out.map((h) => h.item.id)).toEqual(['a', 'z']);
  });
});
