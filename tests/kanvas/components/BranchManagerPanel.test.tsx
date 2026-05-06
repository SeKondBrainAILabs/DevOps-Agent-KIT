/**
 * Component Tests for BranchManagerPanel (Day 2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchManagerPanel } from '../../../renderer/components/features/BranchManagerPanel';
import { mockApi } from '../setup';
import type { RepoBranchRow } from '../../../shared/types';

const NOW = Date.now();
const day = (n: number) => NOW - n * 24 * 60 * 60 * 1000;

const rows: RepoBranchRow[] = [
  { name: 'main', isCurrent: false, lastCommitMs: day(1), mergedIntoDefault: true, deletedOnRemote: false, hasWorktree: true },
  { name: 'feat/active', isCurrent: true, lastCommitMs: day(0), mergedIntoDefault: false, deletedOnRemote: false, hasWorktree: false },
  { name: 'feat/stale', isCurrent: false, lastCommitMs: day(60), mergedIntoDefault: false, deletedOnRemote: false, hasWorktree: false },
  { name: 'feat/merged', isCurrent: false, lastCommitMs: day(2), mergedIntoDefault: true, deletedOnRemote: false, hasWorktree: false },
  { name: 'feat/gone', isCurrent: false, lastCommitMs: day(5), mergedIntoDefault: false, deletedOnRemote: true, hasWorktree: false },
];

describe('BranchManagerPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockApi.git.listBranchesForRepo as jest.Mock).mockResolvedValue({
      success: true,
      data: rows,
    } as never);
  });

  it('renders a row for every branch returned by the API', async () => {
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('branch-table')).toBeInTheDocument();
    });
    for (const r of rows) {
      expect(screen.getByTestId(`branch-row-${r.name}`)).toBeInTheDocument();
    }
  });

  it('marks the current branch with a leading dot', async () => {
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    expect(screen.getByTestId('branch-row-feat/active').textContent).toContain('●');
    expect(screen.getByTestId('branch-row-main').textContent).not.toContain('●');
  });

  it('"Merged" filter shows only merged branches', async () => {
    const user = userEvent.setup();
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    await user.click(screen.getByTestId('chip-merged'));
    expect(screen.queryByTestId('branch-row-feat/active')).toBeNull();
    expect(screen.getByTestId('branch-row-main')).toBeInTheDocument();
    expect(screen.getByTestId('branch-row-feat/merged')).toBeInTheDocument();
  });

  it('"Stale" filter shows only stale branches (>30d)', async () => {
    const user = userEvent.setup();
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    await user.click(screen.getByTestId('chip-stale'));
    expect(screen.getByTestId('branch-row-feat/stale')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-feat/active')).toBeNull();
  });

  it('"Deleted on remote" filter shows only that group', async () => {
    const user = userEvent.setup();
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    await user.click(screen.getByTestId('chip-deleted-on-remote'));
    expect(screen.getByTestId('branch-row-feat/gone')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-main')).toBeNull();
  });

  it('"Has worktree" filter shows only worktree-bearing branches', async () => {
    const user = userEvent.setup();
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    await user.click(screen.getByTestId('chip-has-worktree'));
    expect(screen.getByTestId('branch-row-main')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-feat/stale')).toBeNull();
  });

  it('shows "safe to delete" tag and total count', async () => {
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => screen.getByTestId('branch-table'));
    // feat/merged is merged + no worktree + not current → safe
    expect(screen.getByTestId('safe-tag-feat/merged')).toBeInTheDocument();
    // main is merged but has worktree → NOT safe
    expect(screen.queryByTestId('safe-tag-main')).toBeNull();
    expect(screen.getByTestId('safe-to-delete-count')).toHaveTextContent('1 safe to delete');
  });

  it('surfaces backend errors', async () => {
    (mockApi.git.listBranchesForRepo as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'GIT_FAIL', message: 'something went wrong' },
    } as never);
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('branch-error')).toHaveTextContent('something went wrong');
    });
  });

  it('shows the empty filter message when no branches match', async () => {
    (mockApi.git.listBranchesForRepo as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [],
    } as never);
    render(<BranchManagerPanel repoPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('branch-empty')).toBeInTheDocument();
    });
  });
});
