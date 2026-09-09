/**
 * Unit Tests for the auto-commit safety guard.
 *
 * Fix for the incident where `git rebase origin/main` picked a stale WIP
 * commit while the KIT auto-saver + Kanvas auto-commit were running,
 * silently orphaning ~15 real commits.
 */

import { describe, it, expect } from '@jest/globals';
import {
  evaluateAutoCommitGuard,
  type AutoCommitGuardInputs,
} from '../../../shared/git-rewrite-guard';

const clear: AutoCommitGuardInputs = {
  midRebase: false,
  midMerge: false,
  midCherryPick: false,
  midBisect: false,
  detachedHead: false,
  historyRewriteLocked: false,
};

describe('evaluateAutoCommitGuard', () => {
  it('allows when nothing dangerous is happening', () => {
    const r = evaluateAutoCommitGuard(clear);
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('allowed');
  });

  it('blocks during a rebase — this is the incident case', () => {
    const r = evaluateAutoCommitGuard({ ...clear, midRebase: true });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('blocked-mid-rebase');
    expect(r.message).toMatch(/rebase/);
    expect(r.message).toMatch(/silently reset/);
  });

  it('blocks during a merge', () => {
    const r = evaluateAutoCommitGuard({ ...clear, midMerge: true });
    expect(r.kind).toBe('blocked-mid-merge');
  });

  it('blocks during a cherry-pick', () => {
    const r = evaluateAutoCommitGuard({ ...clear, midCherryPick: true });
    expect(r.kind).toBe('blocked-mid-cherry-pick');
  });

  it('blocks during a bisect', () => {
    const r = evaluateAutoCommitGuard({ ...clear, midBisect: true });
    expect(r.kind).toBe('blocked-mid-bisect');
  });

  it('blocks on detached HEAD (commits would be dangling)', () => {
    const r = evaluateAutoCommitGuard({ ...clear, detachedHead: true });
    expect(r.kind).toBe('blocked-detached-head');
    expect(r.message).toMatch(/detached/);
  });

  it('blocks when the history-rewrite lockfile is held', () => {
    const r = evaluateAutoCommitGuard({
      ...clear,
      historyRewriteLocked: true,
      lockReason: 'rebase feat/x onto origin/main',
    });
    expect(r.kind).toBe('blocked-history-rewrite-lock');
    expect(r.message).toMatch(/rebase feat\/x onto origin\/main/);
  });

  it('precedence: mid-rebase wins over other blockers', () => {
    const r = evaluateAutoCommitGuard({
      ...clear,
      midRebase: true,
      midMerge: true,
      detachedHead: true,
      historyRewriteLocked: true,
    });
    expect(r.kind).toBe('blocked-mid-rebase');
  });

  it('precedence: mid-merge wins over cherry-pick / bisect / detached / lock', () => {
    const r = evaluateAutoCommitGuard({
      ...clear,
      midMerge: true,
      midCherryPick: true,
      midBisect: true,
      detachedHead: true,
      historyRewriteLocked: true,
    });
    expect(r.kind).toBe('blocked-mid-merge');
  });

  it('precedence: detached-head wins over lock alone', () => {
    const r = evaluateAutoCommitGuard({
      ...clear,
      detachedHead: true,
      historyRewriteLocked: true,
    });
    expect(r.kind).toBe('blocked-detached-head');
  });
});
