/**
 * Unit Tests for I3 — SQL read-only guard
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateSqlGuard, normalizeSql } from '../../../shared/sql-readonly-guard';

describe('normalizeSql (I3)', () => {
  it('strips block comments', () => {
    expect(normalizeSql('SELECT 1 /* delete from x */')).toBe('select 1');
  });
  it('strips -- line comments', () => {
    expect(normalizeSql('SELECT 1 -- delete from x')).toBe('select 1');
  });
  it('strips # comments', () => {
    expect(normalizeSql('SELECT 1\n# delete from x')).toBe('select 1');
  });
  it('collapses whitespace', () => {
    expect(normalizeSql('SELECT    1\n\nFROM   t')).toBe('select 1 from t');
  });
});

describe('evaluateSqlGuard — allowed (I3)', () => {
  it('allows a plain SELECT', () => {
    const r = evaluateSqlGuard('SELECT id FROM users WHERE id = 1');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('allowed');
  });

  it('allows trailing semicolon (single statement)', () => {
    const r = evaluateSqlGuard('SELECT 1;');
    expect(r.ok).toBe(true);
  });

  it('allows queries with a column literally named "delete" via quoting', () => {
    // Note: word-boundary match — keywords must appear as whole words.
    // "deleted_at" should not trip.
    const r = evaluateSqlGuard('SELECT id, deleted_at FROM users');
    expect(r.ok).toBe(true);
  });
});

describe('evaluateSqlGuard — blocked-keyword (I3)', () => {
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXEC']) {
    it(`blocks ${kw}`, () => {
      const r = evaluateSqlGuard(`${kw} INTO users VALUES (1)`);
      expect(r.ok).toBe(false);
      expect(r.kind).toBe('blocked-keyword');
      expect(r.keyword).toBe(kw);
    });
  }

  it('blocks even when keyword is hidden in a comment-stripped section', () => {
    const r = evaluateSqlGuard('-- harmless\nDELETE FROM users');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('blocked-keyword');
    expect(r.keyword).toBe('DELETE');
  });

  it('case-insensitive', () => {
    expect(evaluateSqlGuard('drop table users').ok).toBe(false);
    expect(evaluateSqlGuard('DrOp TaBlE users').ok).toBe(false);
  });
});

describe('evaluateSqlGuard — multi-statement (I3)', () => {
  it('blocks two statements separated by semicolon', () => {
    const r = evaluateSqlGuard('SELECT 1; SELECT 2');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('blocked-multi-statement');
  });

  it('allows single statement with trailing semicolon', () => {
    expect(evaluateSqlGuard('SELECT 1 ;').ok).toBe(true);
  });

  it('honors allowMultiStatement override', () => {
    const r = evaluateSqlGuard('SELECT 1; SELECT 2', { allowMultiStatement: true });
    expect(r.ok).toBe(true);
  });
});

describe('evaluateSqlGuard — empty (I3)', () => {
  it('blocks empty / whitespace input', () => {
    expect(evaluateSqlGuard('').kind).toBe('blocked-empty');
    expect(evaluateSqlGuard('   \n  ').kind).toBe('blocked-empty');
    expect(evaluateSqlGuard('-- only a comment').kind).toBe('blocked-empty');
  });
});
