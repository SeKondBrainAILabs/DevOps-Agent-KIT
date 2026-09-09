/**
 * Unit Tests for M3 — Ticket-required commit policy
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateTicketPolicy } from '../../../shared/ticket-policy';

const enabled = { enabled: true };

describe('evaluateTicketPolicy — disabled (M3)', () => {
  it('always allows when policy is disabled', () => {
    const r = evaluateTicketPolicy({
      message: 'no ticket here',
      branchName: 'feat/random',
      policy: { enabled: false },
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-policy-disabled');
  });
});

describe('evaluateTicketPolicy — ticket in message (M3)', () => {
  it('allows when commit message has a [TICKET-123] prefix', () => {
    const r = evaluateTicketPolicy({
      message: '[PROJ-9] add login',
      branchName: 'feat/random',
      policy: enabled,
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-ticket-in-message');
    expect(r.ticketId).toBe('PROJ-9');
  });

  it('allows when message contains a bare ticket id elsewhere', () => {
    const r = evaluateTicketPolicy({
      message: 'fix: handle PROJ-42 retries',
      branchName: 'feat/random',
      policy: enabled,
    });
    expect(r.allowed).toBe(true);
    expect(r.ticketId).toBe('PROJ-42');
  });
});

describe('evaluateTicketPolicy — ticket in branch (M3)', () => {
  it('allows when ticket is in branch name (no override needed)', () => {
    const r = evaluateTicketPolicy({
      message: 'add login',
      branchName: 'feat/PROJ-7-login',
      policy: enabled,
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-ticket-in-branch');
    expect(r.ticketId).toBe('PROJ-7');
  });
});

describe('evaluateTicketPolicy — override (M3)', () => {
  it('allows when override=true with a non-empty reason', () => {
    const r = evaluateTicketPolicy({
      message: 'tweak readme',
      branchName: 'main',
      policy: enabled,
      override: true,
      overrideReason: 'doc-only change, no ticket needed',
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed-override');
    expect(r.overrideMetadata?.reason).toBe('doc-only change, no ticket needed');
  });

  it('blocks when override=true but reason is empty / whitespace', () => {
    const r = evaluateTicketPolicy({
      message: 'tweak readme',
      branchName: 'main',
      policy: enabled,
      override: true,
      overrideReason: '   ',
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-override-without-reason');
  });

  it('blocks when override=true but reason is undefined', () => {
    const r = evaluateTicketPolicy({
      message: 'tweak readme',
      branchName: 'main',
      policy: enabled,
      override: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-override-without-reason');
  });
});

describe('evaluateTicketPolicy — block (M3)', () => {
  it('blocks when neither message nor branch has a ticket and no override', () => {
    const r = evaluateTicketPolicy({
      message: 'random commit',
      branchName: 'main',
      policy: enabled,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-no-ticket');
    expect(r.message).toMatch(/PROJ-123/i); // example in error message
  });
});

describe('evaluateTicketPolicy — custom regex (M3)', () => {
  it('honors a caller-supplied regex source (Linear-style)', () => {
    const r = evaluateTicketPolicy({
      message: 'tweak',
      branchName: 'feat/ENG-5-foo',
      policy: { enabled: true, regexSource: '(?:^|[^A-Za-z0-9])(ENG-\\d+)' },
    });
    expect(r.allowed).toBe(true);
    expect(r.ticketId).toBe('ENG-5');
  });

  it('rejects when custom regex does not match', () => {
    const r = evaluateTicketPolicy({
      message: 'tweak',
      branchName: 'feat/PROJ-5-foo', // PROJ-5, not ENG-N
      policy: { enabled: true, regexSource: '(?:^|[^A-Za-z0-9])(ENG-\\d+)' },
    });
    expect(r.allowed).toBe(false);
  });
});
