/**
 * Unit Tests for F5 — Cross-repo PR linking by ticket
 */

import { describe, it, expect } from '@jest/globals';
import {
  groupPrsByTicket,
  ticketForPr,
  type PrSummary,
} from '../../../shared/cross-repo-pr-link';

const pr = (id: string, repoName: string, title: string, branchName: string): PrSummary => ({
  id,
  repoName,
  title,
  branchName,
});

describe('ticketForPr (F5)', () => {
  it('prefers title over branch when title has a ticket', () => {
    expect(ticketForPr(pr('1', 'r', '[PROJ-9] foo', 'feat/x'))).toBe('PROJ-9');
  });

  it('falls back to branch when title has no ticket', () => {
    expect(ticketForPr(pr('1', 'r', 'foo', 'feat/PROJ-7-x'))).toBe('PROJ-7');
  });

  it('returns null when neither has one', () => {
    expect(ticketForPr(pr('1', 'r', 'foo', 'feat/x'))).toBeNull();
  });
});

describe('groupPrsByTicket (F5)', () => {
  it('groups PRs that share a ticket across repos', () => {
    const out = groupPrsByTicket([
      pr('1', 'kora', '[PROJ-9] auth', 'feat/auth'),
      pr('2', 'backend', 'feat: PROJ-9 server', 'feat/PROJ-9-server'),
      pr('3', 'kanvas', '[OTHER-1] unrelated', 'main'),
    ]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].ticketId).toBe('PROJ-9');
    expect(out.groups[0].prs.map((p) => p.repoName).sort()).toEqual(['backend', 'kora']);
    expect(out.singletons.map((p) => p.id)).toEqual(['3']);
    expect(out.ungrouped).toEqual([]);
  });

  it('moves single-ticket PRs into singletons', () => {
    const out = groupPrsByTicket([pr('1', 'r', '[PROJ-1] solo', 'feat/x')]);
    expect(out.groups).toEqual([]);
    expect(out.singletons).toHaveLength(1);
  });

  it('puts no-ticket PRs in ungrouped', () => {
    const out = groupPrsByTicket([pr('1', 'r', 'random', 'main')]);
    expect(out.ungrouped).toHaveLength(1);
    expect(out.groups).toEqual([]);
    expect(out.singletons).toEqual([]);
  });

  it('groups are sorted by ticketId', () => {
    const out = groupPrsByTicket([
      pr('1', 'a', '[ZED-9] x', 'feat/x'),
      pr('2', 'b', '[ZED-9] y', 'feat/y'),
      pr('3', 'a', '[ALPHA-1] x', 'feat/x'),
      pr('4', 'b', '[ALPHA-1] y', 'feat/y'),
    ]);
    expect(out.groups.map((g) => g.ticketId)).toEqual(['ALPHA-1', 'ZED-9']);
  });

  it('within a group, PRs are sorted by repoName then id', () => {
    const out = groupPrsByTicket([
      pr('z', 'beta', '[PROJ-1] x', 'feat/x'),
      pr('a', 'alpha', '[PROJ-1] x', 'feat/x'),
      pr('m', 'alpha', '[PROJ-1] x', 'feat/x'),
    ]);
    const ids = out.groups[0].prs.map((p) => p.id);
    expect(ids).toEqual(['a', 'm', 'z']);
  });
});
