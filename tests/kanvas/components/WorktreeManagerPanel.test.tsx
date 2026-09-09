/**
 * Component Tests for WorktreeManagerPanel (Day 2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { WorktreeManagerPanel } from '../../../renderer/components/features/WorktreeManagerPanel';
import { mockApi } from '../setup';

describe('WorktreeManagerPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockApi.git.listWorktrees as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { path: '/repo', branch: 'main', head: 'abc', bare: false },
        { path: '/repo/local_deploy/feat-x', branch: 'feat/x', head: 'def', bare: false },
      ],
    } as never);
  });

  it('renders one row per worktree', async () => {
    render(<WorktreeManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-table')).toBeInTheDocument();
    });
    expect(screen.getByTestId('worktree-row-/repo')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-row-/repo/local_deploy/feat-x')).toBeInTheDocument();
  });

  it('marks the primary worktree (whose path === repoPath)', async () => {
    render(<WorktreeManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('worktree-table'));
    expect(screen.getByTestId('worktree-row-/repo').textContent).toContain('primary');
    expect(screen.getByTestId('worktree-row-/repo/local_deploy/feat-x').textContent).not.toContain(
      'primary'
    );
  });

  it('renders "(detached)" for worktrees without a branch', async () => {
    (mockApi.git.listWorktrees as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{ path: '/repo', branch: '', head: 'abc', bare: false }],
    } as never);
    render(<WorktreeManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('worktree-table'));
    expect(screen.getByTestId('worktree-row-/repo').textContent).toContain('(detached)');
  });

  it('shows the empty state when no worktrees', async () => {
    (mockApi.git.listWorktrees as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [],
    } as never);
    render(<WorktreeManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-empty')).toBeInTheDocument();
    });
  });

  it('surfaces backend errors', async () => {
    (mockApi.git.listWorktrees as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'GIT_FAIL', message: 'boom' },
    } as never);
    render(<WorktreeManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-error')).toHaveTextContent('boom');
    });
  });
});
