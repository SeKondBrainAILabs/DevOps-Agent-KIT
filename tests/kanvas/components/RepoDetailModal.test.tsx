/**
 * Component Tests for RepoDetailModal (Day 2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepoDetailModal } from '../../../renderer/components/features/RepoDetailModal';
import { mockApi } from '../setup';

describe('RepoDetailModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockApi.git.getRepoStatus as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        repoPath: '/Users/me/work/kanvas',
        currentBranch: 'feat/login',
        upstream: 'origin/feat/login',
        ahead: 2,
        behind: 1,
        modifiedCount: 3,
        stagedCount: 1,
        untrackedCount: 5,
        unmergedCount: 0,
        stashCount: 1,
        worktreeCount: 2,
        lastCommit: { sha: 'abc', shortSha: 'abc', subject: 'feat: add login', authoredAt: '' },
        fetchedAt: '',
      },
    } as never);
  });

  it('renders the repo basename + full path', async () => {
    render(<RepoDetailModal repoPath="/Users/me/work/kanvas" onClose={() => {}} />);
    expect(screen.getByTestId('repo-detail-name')).toHaveTextContent('kanvas');
    expect(screen.getByTestId('repo-detail-path')).toHaveTextContent('/Users/me/work/kanvas');
  });

  it('Overview tab shows status fields when API resolves', async () => {
    render(<RepoDetailModal repoPath="/repo" onClose={() => {}} />);
    await waitFor(() => {
      const overview = screen.getByTestId('repo-detail-overview');
      expect(within(overview).getByText('feat/login')).toBeInTheDocument();
      expect(within(overview).getByText('origin/feat/login')).toBeInTheDocument();
      expect(within(overview).getByText('↑ 2 · ↓ 1')).toBeInTheDocument();
      expect(within(overview).getByText('3 · 1 · 5')).toBeInTheDocument();
    });
  });

  it('renders three tabs and switching loads the corresponding panel', async () => {
    const user = userEvent.setup();
    render(<RepoDetailModal repoPath="/repo" onClose={() => {}} />);
    expect(screen.getByTestId('repo-detail-tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('repo-detail-tab-branches')).toBeInTheDocument();
    expect(screen.getByTestId('repo-detail-tab-worktrees')).toBeInTheDocument();
    await user.click(screen.getByTestId('repo-detail-tab-branches'));
    await waitFor(() => screen.getByTestId('branch-manager-panel'));
    await user.click(screen.getByTestId('repo-detail-tab-worktrees'));
    await waitFor(() => screen.getByTestId('worktree-manager-panel'));
    await user.click(screen.getByTestId('repo-detail-tab-overview'));
    expect(screen.getByTestId('repo-detail-overview')).toBeInTheDocument();
  });

  it('clicking the close button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<RepoDetailModal repoPath="/repo" onClose={onClose} />);
    await user.click(screen.getByTestId('repo-detail-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<RepoDetailModal repoPath="/repo" onClose={onClose} />);
    await user.click(screen.getByTestId('repo-detail-modal'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key closes the modal', async () => {
    const onClose = jest.fn();
    render(<RepoDetailModal repoPath="/repo" onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a status fetch error in the Overview tab', async () => {
    (mockApi.git.getRepoStatus as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'X', message: 'cannot read git' },
    } as never);
    render(<RepoDetailModal repoPath="/repo" onClose={() => {}} />);
    await waitFor(() => {
      const overview = screen.getByTestId('repo-detail-overview');
      expect(within(overview).getByText(/cannot read git/)).toBeInTheDocument();
    });
  });
});
