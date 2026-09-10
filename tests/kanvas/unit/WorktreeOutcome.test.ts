/**
 * Unit Tests for shared/worktree-outcome.ts (story KIT-MCP-A1)
 *
 * `createWorktreeIfNeeded` silently returned the SOURCE REPO path on any
 * failure. A human notices that; an orchestrator does not, and twenty agents
 * landing in one checkout overwrite each other's work.
 */

import { describe, it, expect } from '@jest/globals';
import {
  evaluateWorktreeOutcome,
  WORKTREE_CREATE_FAILED_CODE,
  type WorktreeStatus,
} from '../../../shared/worktree-outcome';

const SUCCESSES: WorktreeStatus[] = ['created', 'reused', 'legacy', 'observer'];

describe('evaluateWorktreeOutcome — successful outcomes', () => {
  it.each(SUCCESSES)('%s is never fatal, whoever asked', (status) => {
    for (const origin of ['ui', 'mcp', 'adopted', undefined] as const) {
      expect(evaluateWorktreeOutcome(status, origin).fatal).toBe(false);
    }
  });
});

describe('evaluateWorktreeOutcome — failure', () => {
  it('is FATAL for an agent-created session', () => {
    const verdict = evaluateWorktreeOutcome('failed', 'mcp');
    expect(verdict.fatal).toBe(true);
    expect(verdict.error?.code).toBe(WORKTREE_CREATE_FAILED_CODE);
  });

  it('explains why refusing beats falling back', () => {
    // The agent has to be able to report something actionable.
    const verdict = evaluateWorktreeOutcome('failed', 'mcp');
    expect(verdict.error?.message).toMatch(/source repositor/i);
    expect(verdict.error?.message).toMatch(/overwrite/i);
  });

  it('includes the underlying git error when one is available', () => {
    const verdict = evaluateWorktreeOutcome(
      'failed',
      'mcp',
      "fatal: '../wt' already exists"
    );
    expect(verdict.error?.message).toContain("fatal: '../wt' already exists");
  });

  it('is NOT fatal for a UI-created session — the human path is unchanged', () => {
    // Degrade-and-continue is preserved deliberately; this story must not
    // change behaviour for the person sitting in front of the app. The
    // instance still records worktreeStatus:'failed' so the UI can show it,
    // which it previously could not.
    expect(evaluateWorktreeOutcome('failed', 'ui').fatal).toBe(false);
  });

  it('is NOT fatal for an adopted session', () => {
    expect(evaluateWorktreeOutcome('failed', 'adopted').fatal).toBe(false);
  });

  it('treats an absent origin as ui — legacy records must not start failing', () => {
    // Records written before createdBy existed are humans' sessions. Making
    // them suddenly fatal would break existing installs on upgrade.
    expect(evaluateWorktreeOutcome('failed', undefined).fatal).toBe(false);
  });
});
