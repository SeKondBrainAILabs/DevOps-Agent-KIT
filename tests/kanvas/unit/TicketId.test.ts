/**
 * Unit Tests for D3 — Ticket-ID extraction + auto-prepend
 */

import { describe, it, expect } from '@jest/globals';
import {
  extractTicketId,
  formatTicketPrefix,
  messageHasTicketPrefix,
  prependTicketPrefix,
} from '../../../shared/ticket-id';

describe('extractTicketId — default regex (D3)', () => {
  it('extracts from conventional branch names', () => {
    expect(extractTicketId('feat/PROJ-123-foo')).toBe('PROJ-123');
    expect(extractTicketId('bugfix/ABC-9999-thing')).toBe('ABC-9999');
    expect(extractTicketId('chore/X-1-x')).toBe('X-1');
  });

  it('extracts from a bare ticket id', () => {
    expect(extractTicketId('PROJ-123')).toBe('PROJ-123');
  });

  it('extracts when ticket appears mid-string after a separator', () => {
    expect(extractTicketId('hotfix-PROJ-42')).toBe('PROJ-42');
    expect(extractTicketId('something_PROJ-5_else')).toBe('PROJ-5');
  });

  it('returns null when nothing matches', () => {
    expect(extractTicketId('release-2025')).toBeNull();
    expect(extractTicketId('feature-branch-without-id')).toBeNull();
    expect(extractTicketId('proj-123')).toBeNull(); // lowercase project key — by design
  });

  it('returns null for null / undefined / empty', () => {
    expect(extractTicketId(null)).toBeNull();
    expect(extractTicketId(undefined)).toBeNull();
    expect(extractTicketId('')).toBeNull();
  });
});

describe('extractTicketId — custom regex (D3)', () => {
  it('honors a caller-supplied regex (Linear-style)', () => {
    const linear = /(?:^|[^A-Za-z0-9])(ENG-\d+)/;
    expect(extractTicketId('feat/eng-456', { regex: linear })).toBeNull();
    expect(extractTicketId('feat/ENG-456', { regex: linear })).toBe('ENG-456');
  });
});

describe('formatTicketPrefix (D3)', () => {
  it('wraps in square brackets', () => {
    expect(formatTicketPrefix('PROJ-123')).toBe('[PROJ-123]');
  });
});

describe('messageHasTicketPrefix (D3)', () => {
  it('true when message starts with [TICKET-123]', () => {
    expect(messageHasTicketPrefix('[PROJ-123] add login')).toBe(true);
    expect(messageHasTicketPrefix('[A-1]something')).toBe(true);
  });
  it('false when message has no prefix', () => {
    expect(messageHasTicketPrefix('add login')).toBe(false);
    expect(messageHasTicketPrefix('  [PROJ-123] late')).toBe(false);
  });
  it('safe on empty / null-ish input', () => {
    expect(messageHasTicketPrefix('')).toBe(false);
  });
});

describe('prependTicketPrefix (D3)', () => {
  it('prepends when no prefix exists', () => {
    expect(prependTicketPrefix('add login', 'PROJ-123')).toBe('[PROJ-123] add login');
  });

  it('leaves alone when message already starts with the same ticket', () => {
    expect(prependTicketPrefix('[PROJ-123] add login', 'PROJ-123')).toBe('[PROJ-123] add login');
  });

  it('leaves alone when message already has a different ticket prefix (default)', () => {
    expect(prependTicketPrefix('[OLD-9] add login', 'PROJ-123')).toBe('[OLD-9] add login');
  });

  it('replaces a different ticket prefix when replaceExistingPrefix=true', () => {
    expect(
      prependTicketPrefix('[OLD-9] add login', 'PROJ-123', { replaceExistingPrefix: true })
    ).toBe('[PROJ-123] add login');
  });

  it('prepends just the prefix on empty input', () => {
    expect(prependTicketPrefix('', 'PROJ-123')).toBe('[PROJ-123] ');
    expect(prependTicketPrefix('   ', 'PROJ-123')).toBe('[PROJ-123] ');
  });
});
