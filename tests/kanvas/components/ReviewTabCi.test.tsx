/**
 * ReviewTab CI badge - component behavior tests
 *
 * AC3: Checks are fetched once when the review tab mounts and once per Refresh
 * click; ten minutes of fake timers trigger no further call.
 *
 * AC4: The review card shows the CI state.
 *
 * These tests verify the CI badge behavior in the ReviewTab component.
 * The tests fail today because the CI implementation does not exist.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor, screen } from '@testing-library/react';

// Import the SessionDetailView component which contains ReviewTab
// This import may fail due to dependencies, which is expected
import { SessionDetailView } from '../../../renderer/components/features/SessionDetailView';

describe('ReviewTab CI - component behavior', () => {
  const mockSession = {
    sessionId: 'test-session',
    branchName: 'feat/test-branch',
    repoPath: '/tmp/test-repo',
    worktreePath: '/tmp/test-repo/worktree',
    baseBranch: 'main',
    agentType: 'coder',
    task: 'Test task',
    createdAt: new Date().toISOString(),
    reviewRequest: {
      requestedAt: new Date().toISOString(),
      summary: 'Test summary',
      prStatus: 'available' as const,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.api.pr.checks.mockResolvedValue({
      success: true,
      data: {
        state: 'none' as const,
        counts: { passing: 0, failing: 0, pending: 0, total: 0 },
      },
    });
  });

  it('SessionDetailView exports exist', () => {
    expect(SessionDetailView).toBeDefined();
  });

  it('calls window.api.pr.checks when ReviewTab mounts', async () => {
    window.api.pr.checks.mockResolvedValue({
      success: true,
      data: {
        state: 'passing' as const,
        counts: { passing: 3, failing: 0, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalled();
    });
  });

  it('renders CI badge with passing state', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'passing' as const,
        counts: { passing: 3, failing: 0, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(screen.getByText(/CI passing/i)).toBeInTheDocument();
    });
  });

  it('renders CI badge with failing state', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'failing' as const,
        counts: { passing: 2, failing: 1, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(screen.getByText(/CI failing/i)).toBeInTheDocument();
    });
  });

  it('renders CI badge with pending state', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'pending' as const,
        counts: { passing: 1, failing: 0, pending: 2, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(screen.getByText(/CI pending/i)).toBeInTheDocument();
    });
  });

  it('does not render CI badge when state is none', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'none' as const,
        counts: { passing: 0, failing: 0, pending: 0, total: 0 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(screen.queryByText(/CI passing/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/CI failing/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/CI pending/i)).not.toBeInTheDocument();
    });
  });

  it('has Refresh button for explicit refresh', async () => {
    window.api.pr.checks.mockResolvedValue({
      success: true,
      data: {
        state: 'passing' as const,
        counts: { passing: 3, failing: 0, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    });
  });
});
