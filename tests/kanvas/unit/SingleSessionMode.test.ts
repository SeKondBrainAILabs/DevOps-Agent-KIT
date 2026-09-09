/**
 * Unit Tests for C5 Single-Session Mode
 *
 * Two layers:
 *  (1) Pure-function guard: `evaluateSingleSessionGuard(mode, activeCount)` —
 *      this is what AgentInstanceService.createInstance() consults before
 *      allowing a new session.
 *  (2) IPC contract: `window.api.repoWorkspace.{getWorktreeMode,
 *      setWorktreeMode, getActiveSessionCount}` exposed for the renderer
 *      to disable the "New session" CTA in single-session mode.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  evaluateSingleSessionGuard,
  SINGLE_SESSION_MODE_ERROR_CODE,
} from '../../../shared/single-session-guard';
import { mockApi } from '../setup';

// ─── Pure guard logic ────────────────────────────────────────────────────────
describe('evaluateSingleSessionGuard (C5)', () => {
  it('does NOT block when mode is "worktree" regardless of active count', () => {
    expect(evaluateSingleSessionGuard('worktree', 0).blocked).toBe(false);
    expect(evaluateSingleSessionGuard('worktree', 5).blocked).toBe(false);
  });

  it('does NOT block when mode is "in-place" but no active sessions exist', () => {
    expect(evaluateSingleSessionGuard('in-place', 0).blocked).toBe(false);
  });

  it('BLOCKS with SINGLE_SESSION_MODE_ACTIVE when mode is "in-place" and >=1 active session', () => {
    const result = evaluateSingleSessionGuard('in-place', 1);
    expect(result.blocked).toBe(true);
    expect(result.error?.code).toBe(SINGLE_SESSION_MODE_ERROR_CODE);
    expect(result.error?.message).toMatch(/Single-Session Mode/);
  });

  it('BLOCKS regardless of how many sessions are active when mode is "in-place"', () => {
    expect(evaluateSingleSessionGuard('in-place', 1).blocked).toBe(true);
    expect(evaluateSingleSessionGuard('in-place', 17).blocked).toBe(true);
  });

  it('error message instructs the user how to unblock', () => {
    const result = evaluateSingleSessionGuard('in-place', 1);
    expect(result.error?.message).toMatch(/close the current session/i);
    expect(result.error?.message).toMatch(/enable worktrees/i);
  });
});

// ─── IPC contract (window.api.repoWorkspace.*) ───────────────────────────────
describe('window.api.repoWorkspace — IPC contract (C5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes getWorktreeMode, setWorktreeMode, getActiveSessionCount', () => {
    expect(window.api.repoWorkspace).toBeDefined();
    expect(typeof window.api.repoWorkspace.getWorktreeMode).toBe('function');
    expect(typeof window.api.repoWorkspace.setWorktreeMode).toBe('function');
    expect(typeof window.api.repoWorkspace.getActiveSessionCount).toBe('function');
  });

  it('getWorktreeMode returns the current mode for a repo', async () => {
    (mockApi.repoWorkspace.getWorktreeMode as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 'in-place',
    } as never);

    const result = await window.api.repoWorkspace.getWorktreeMode('/repos/foo');
    expect(result).toEqual({ success: true, data: 'in-place' });
    expect(mockApi.repoWorkspace.getWorktreeMode).toHaveBeenCalledWith('/repos/foo');
  });

  it('setWorktreeMode persists the mode for a repo', async () => {
    const result = await window.api.repoWorkspace.setWorktreeMode('/repos/foo', 'in-place');
    expect(result.success).toBe(true);
    expect(mockApi.repoWorkspace.setWorktreeMode).toHaveBeenCalledWith('/repos/foo', 'in-place');
  });

  it('getActiveSessionCount returns the number of active sessions for a repo', async () => {
    (mockApi.repoWorkspace.getActiveSessionCount as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 2,
    } as never);

    const result = await window.api.repoWorkspace.getActiveSessionCount('/repos/foo');
    expect(result).toEqual({ success: true, data: 2 });
  });

  it('UI guard composition: disable CTA when mode=in-place AND activeCount>=1', async () => {
    // Simulate what the renderer does before showing the "New Session" CTA.
    (mockApi.repoWorkspace.getWorktreeMode as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 'in-place',
    } as never);
    (mockApi.repoWorkspace.getActiveSessionCount as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 1,
    } as never);

    const [modeRes, countRes] = await Promise.all([
      window.api.repoWorkspace.getWorktreeMode('/repos/foo'),
      window.api.repoWorkspace.getActiveSessionCount('/repos/foo'),
    ]);

    const guard = evaluateSingleSessionGuard(
      (modeRes.data ?? 'worktree') as 'in-place' | 'worktree',
      countRes.data ?? 0
    );

    expect(guard.blocked).toBe(true);
    expect(guard.error?.code).toBe(SINGLE_SESSION_MODE_ERROR_CODE);
  });

  it('UI guard composition: enable CTA when mode=in-place AND activeCount=0', async () => {
    (mockApi.repoWorkspace.getWorktreeMode as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 'in-place',
    } as never);
    (mockApi.repoWorkspace.getActiveSessionCount as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: 0,
    } as never);

    const [modeRes, countRes] = await Promise.all([
      window.api.repoWorkspace.getWorktreeMode('/repos/foo'),
      window.api.repoWorkspace.getActiveSessionCount('/repos/foo'),
    ]);

    const guard = evaluateSingleSessionGuard(
      (modeRes.data ?? 'worktree') as 'in-place' | 'worktree',
      countRes.data ?? 0
    );

    expect(guard.blocked).toBe(false);
  });
});
