/**
 * Unit Tests for shared/branch-naming.ts (story KIT-MCP-M1)
 *
 * Extracted from CreateAgentWizard so the MCP session tools name branches the
 * same way the wizard does. The drift this prevents is quiet: a session branch
 * that stops matching `isSessionOrRemoteBranch` starts being offered in the
 * base-branch picker as something you can cut new work from.
 */

import { describe, it, expect } from '@jest/globals';
import {
  generateSessionBranchName,
  isSessionOrRemoteBranch,
  pickDefaultBaseBranch,
  SESSION_BRANCH_AGENTS,
} from '../../../shared/branch-naming';

describe('generateSessionBranchName', () => {
  const at = new Date('2026-08-29T12:34:56.000Z');

  it('produces <agent>-session-<YYYYMMDD>-<rand4>', () => {
    expect(generateSessionBranchName('claude', at, 'a1b2')).toBe(
      'claude-session-20260829-a1b2'
    );
  });

  it('has no task slug — the wizard never produced one', () => {
    // An earlier draft of the spec claimed the shape included a slug. It does
    // not, and inventing one would put MCP branches in a different namespace
    // from wizard branches.
    const name = generateSessionBranchName('claude', at, 'a1b2');
    expect(name.split('-')).toHaveLength(4);
  });

  it('matches the shape for every supported agent', () => {
    for (const agent of SESSION_BRANCH_AGENTS) {
      const name = generateSessionBranchName(agent, at, 'zzzz');
      expect(name).toBe(`${agent}-session-20260829-zzzz`);
      // The round trip that matters: anything we generate must be recognised.
      expect(isSessionOrRemoteBranch(name)).toBe(true);
    }
  });

  it('generates distinct names without an explicit suffix', () => {
    const names = new Set(
      Array.from({ length: 200 }, () => generateSessionBranchName('claude', at))
    );
    expect(names.size).toBeGreaterThan(150);
  });
});

describe('isSessionOrRemoteBranch', () => {
  it('recognises claude session branches — the gap this epic closes', () => {
    // claude was missing from the wizard's list, so Claude session branches
    // (by far the most common kind) were offered as valid base branches.
    expect(isSessionOrRemoteBranch('claude-session-20260829-a1b2')).toBe(true);
  });

  it('recognises every other agent prefix that was already listed', () => {
    for (const agent of ['codex', 'cursor', 'copilot', 'aider', 'warp', 'cline']) {
      expect(isSessionOrRemoteBranch(`${agent}-session-20260829-a1b2`)).toBe(true);
    }
  });

  it('rejects remotes', () => {
    expect(isSessionOrRemoteBranch('origin/main')).toBe(true);
    expect(isSessionOrRemoteBranch('remotes/origin/main')).toBe(true);
  });

  it('rejects detached-HEAD sentinels', () => {
    expect(isSessionOrRemoteBranch('HEAD')).toBe(true);
    expect(isSessionOrRemoteBranch('(HEAD detached at v1.2.3)')).toBe(true);
    expect(isSessionOrRemoteBranch('some HEAD detached thing')).toBe(true);
  });

  it('accepts ordinary branches', () => {
    for (const b of ['main', 'development', 'feat/auth', 'release-2.7']) {
      expect(isSessionOrRemoteBranch(b)).toBe(false);
    }
  });

  it('does not match a branch that merely mentions an agent name', () => {
    expect(isSessionOrRemoteBranch('feat/claude-integration')).toBe(false);
    expect(isSessionOrRemoteBranch('claude-notes')).toBe(false);
  });

  it('handles the empty string', () => {
    expect(isSessionOrRemoteBranch('')).toBe(false);
  });
});

describe('pickDefaultBaseBranch', () => {
  it('prefers the current branch when it is a real one', () => {
    expect(
      pickDefaultBaseBranch({ currentBranch: 'development', branches: ['main', 'development'] })
    ).toBe('development');
  });

  it('does NOT return a session branch as the base', () => {
    // The realistic case: KIT is itself running on a session branch when an
    // agent asks for a new session. Cutting from it would nest sessions.
    expect(
      pickDefaultBaseBranch({
        currentBranch: 'claude-session-20260829-a1b2',
        branches: ['main', 'claude-session-20260829-a1b2'],
      })
    ).toBe('main');
  });

  it('does not return a detached HEAD', () => {
    expect(
      pickDefaultBaseBranch({ currentBranch: 'HEAD', branches: ['development'] })
    ).toBe('development');
  });

  it('falls back through the primary branches in order', () => {
    expect(pickDefaultBaseBranch({ branches: ['develop', 'master'] })).toBe('master');
    expect(pickDefaultBaseBranch({ branches: ['develop'] })).toBe('develop');
  });

  it('falls back to any real branch before defaulting to main', () => {
    expect(
      pickDefaultBaseBranch({ branches: ['origin/x', 'feat/only-branch'] })
    ).toBe('feat/only-branch');
  });

  it('defaults to main when there is nothing usable', () => {
    // This is the case the MCP path would otherwise hit blindly. The wizard
    // shows the user its choice; an agent just gets it, so a hard 'main'
    // default would cut sessions off the wrong base in every repo on
    // 'development'.
    expect(pickDefaultBaseBranch({})).toBe('main');
    expect(pickDefaultBaseBranch({ branches: [] })).toBe('main');
    expect(pickDefaultBaseBranch({ branches: ['origin/main', 'HEAD'] })).toBe('main');
  });
});
