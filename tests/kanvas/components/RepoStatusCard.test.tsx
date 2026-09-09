/**
 * Component Tests for RepoStatusCard (Epic B / story B1 — MVP slice)
 *
 * Renders the atomic card unit and exercises:
 *  - basic info (name, path, last-touched)
 *  - status block: branch chip, ahead/behind, uncommitted, stash, worktree, active sessions
 *  - C5 single-session badge
 *  - action buttons (open IDE, open terminal, new session) — including stopPropagation
 *  - keyboard activation (Enter / Space) on the card body
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepoStatusCard, type RepoStatusBlock } from '../../../renderer/components/features/RepoStatusCard';
import type { DiscoveredRepo } from '../../../shared/types';

const baseRepo: DiscoveredRepo = {
  workspaceId: 'ws_1',
  path: '/Users/me/work/kanvas',
  name: 'kanvas',
  depth: 1,
  discoveredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
};

describe('RepoStatusCard — basics', () => {
  it('renders repo name and path', () => {
    render(<RepoStatusCard repo={baseRepo} />);
    expect(screen.getByText('kanvas')).toBeInTheDocument();
    expect(screen.getByTestId('repo-path')).toHaveTextContent('/Users/me/work/kanvas');
  });

  it('renders the first letter of the repo name as the avatar', () => {
    render(<RepoStatusCard repo={baseRepo} />);
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('shows a relative "discovered" timestamp', () => {
    render(<RepoStatusCard repo={baseRepo} />);
    const lastTouched = screen.getByTestId('last-touched');
    expect(lastTouched.textContent).toMatch(/^(Discovered .+ ago|Discovered just now)$/);
  });

  it('omits last-touched when discoveredAt is empty', () => {
    render(<RepoStatusCard repo={{ ...baseRepo, discoveredAt: '' }} />);
    expect(screen.queryByTestId('last-touched')).toBeNull();
  });
});

describe('RepoStatusCard — status block', () => {
  it('does not render branch chip when status is null', () => {
    render(<RepoStatusCard repo={baseRepo} status={null} />);
    expect(screen.queryByTestId('branch-chip')).toBeNull();
  });

  it('renders branch chip when currentBranch is provided', () => {
    const status: RepoStatusBlock = { currentBranch: 'feat/login' };
    render(<RepoStatusCard repo={baseRepo} status={status} />);
    expect(screen.getByTestId('branch-chip')).toHaveTextContent('feat/login');
  });

  it('renders ahead/behind counts only when > 0', () => {
    const { rerender } = render(
      <RepoStatusCard repo={baseRepo} status={{ ahead: 0, behind: 0 }} />
    );
    expect(screen.queryByText(/↑/)).toBeNull();
    expect(screen.queryByText(/↓/)).toBeNull();

    rerender(<RepoStatusCard repo={baseRepo} status={{ ahead: 3, behind: 1 }} />);
    expect(screen.getByText('↑ 3')).toBeInTheDocument();
    expect(screen.getByText('↓ 1')).toBeInTheDocument();
  });

  it('sums modified + staged + untracked into a single uncommitted count', () => {
    const status: RepoStatusBlock = {
      modifiedCount: 2,
      stagedCount: 1,
      untrackedCount: 4,
    };
    render(<RepoStatusCard repo={baseRepo} status={status} />);
    expect(screen.getByTestId('uncommitted-count')).toHaveTextContent('✎ 7');
  });

  it('hides uncommitted count when total is 0', () => {
    const status: RepoStatusBlock = {
      modifiedCount: 0,
      stagedCount: 0,
      untrackedCount: 0,
    };
    render(<RepoStatusCard repo={baseRepo} status={status} />);
    expect(screen.queryByTestId('uncommitted-count')).toBeNull();
  });

  it('renders active session count badge when > 0', () => {
    render(<RepoStatusCard repo={baseRepo} status={{ activeSessionCount: 2 }} />);
    expect(screen.getByTestId('active-session-count')).toHaveTextContent('◉ 2 active');
  });

  it('omits active session count when 0', () => {
    render(<RepoStatusCard repo={baseRepo} status={{ activeSessionCount: 0 }} />);
    expect(screen.queryByTestId('active-session-count')).toBeNull();
  });
});

describe('RepoStatusCard — Single-Session badge (C5)', () => {
  it('shows the badge when worktreeMode is in-place', () => {
    render(<RepoStatusCard repo={baseRepo} status={{ worktreeMode: 'in-place' }} />);
    expect(screen.getByTestId('single-session-badge')).toHaveTextContent('Single-session');
  });

  it('hides the badge when worktreeMode is worktree', () => {
    render(<RepoStatusCard repo={baseRepo} status={{ worktreeMode: 'worktree' }} />);
    expect(screen.queryByTestId('single-session-badge')).toBeNull();
  });

  it('hides the badge when status is null', () => {
    render(<RepoStatusCard repo={baseRepo} status={null} />);
    expect(screen.queryByTestId('single-session-badge')).toBeNull();
  });

  it('badge has explanatory tooltip', () => {
    render(<RepoStatusCard repo={baseRepo} status={{ worktreeMode: 'in-place' }} />);
    expect(screen.getByTestId('single-session-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('Worktrees disabled')
    );
  });
});

describe('RepoStatusCard — interactions', () => {
  it('calls onSelect when the card body is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<RepoStatusCard repo={baseRepo} onSelect={onSelect} />);
    await user.click(screen.getByTestId('repo-status-card'));
    expect(onSelect).toHaveBeenCalledWith(baseRepo);
  });

  it('action buttons stopPropagation — clicking IDE/Terminal/New session does NOT also fire onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    const onOpenIde = jest.fn();
    const onOpenTerminal = jest.fn();
    const onNewSession = jest.fn();
    render(
      <RepoStatusCard
        repo={baseRepo}
        onSelect={onSelect}
        onOpenIde={onOpenIde}
        onOpenTerminal={onOpenTerminal}
        onNewSession={onNewSession}
      />
    );
    await user.click(screen.getByTestId('open-ide'));
    await user.click(screen.getByTestId('open-terminal'));
    await user.click(screen.getByTestId('new-session'));
    expect(onOpenIde).toHaveBeenCalledWith(baseRepo);
    expect(onOpenTerminal).toHaveBeenCalledWith(baseRepo);
    expect(onNewSession).toHaveBeenCalledWith(baseRepo);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('responds to Enter / Space when card is focused', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<RepoStatusCard repo={baseRepo} onSelect={onSelect} />);
    const card = screen.getByTestId('repo-status-card');
    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('is keyboard-accessible via tabIndex', () => {
    render(<RepoStatusCard repo={baseRepo} />);
    expect(screen.getByTestId('repo-status-card')).toHaveAttribute('tabIndex', '0');
  });

  it('does not crash when no callbacks are provided', async () => {
    const user = userEvent.setup();
    render(<RepoStatusCard repo={baseRepo} />);
    await user.click(screen.getByTestId('open-ide'));
    await user.click(screen.getByTestId('new-session'));
    // No assertion needed — just must not throw.
  });
});
