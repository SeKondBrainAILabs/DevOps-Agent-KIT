/**
 * ReviewTab CI badge - component behavior tests
 *
 * AC3: Checks are fetched once when the review tab mounts and once per Refresh
 * click; ten minutes of fake timers trigger no further call.
 *
 * AC4: The review card shows the CI state.
 *
 * These tests verify the CI badge behavior in the ReviewTab component.
 * The ReviewTab only mounts once the Review tab is selected, so every test
 * below switches to that tab before asserting on the CI controls.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor, screen, fireEvent, act } from '@testing-library/react';

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

  const openReviewTab = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
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
    openReviewTab();

    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalledTimes(1);
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
    openReviewTab();

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
    openReviewTab();

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
    openReviewTab();

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
    openReviewTab();

    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalled();
    });
    expect(screen.queryByText(/CI passing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/CI failing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/CI pending/i)).not.toBeInTheDocument();
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
    openReviewTab();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh ci/i })).toBeInTheDocument();
    });
  });

  it('fetches checks again on each Refresh click', async () => {
    window.api.pr.checks.mockResolvedValue({
      success: true,
      data: {
        state: 'passing' as const,
        counts: { passing: 3, failing: 0, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);
    openReviewTab();

    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh ci/i }));
    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh ci/i }));
    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalledTimes(3);
    });
  });

  it('does not re-fetch checks on a timer over ten minutes', async () => {
    jest.useFakeTimers();
    try {
      window.api.pr.checks.mockResolvedValue({
        success: true,
        data: {
          state: 'passing' as const,
          counts: { passing: 3, failing: 0, pending: 0, total: 3 },
        },
      });

      render(<SessionDetailView session={mockSession as any} />);
      openReviewTab();

      // Let the mount-time fetch settle before advancing timers.
      await act(async () => {
        await Promise.resolve();
      });
      const checksMock = window.api.pr.checks as unknown as {
        mock: { calls: unknown[][] };
      };
      const afterMount = checksMock.mock.calls.length;
      expect(afterMount).toBe(1);

      // Ten minutes of wall-clock time must not trigger a single extra call.
      await act(async () => {
        jest.advanceTimersByTime(10 * 60 * 1000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(checksMock.mock.calls.length).toBe(afterMount);
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders the passing badge in green', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'passing' as const,
        counts: { passing: 3, failing: 0, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);
    openReviewTab();

    const badge = await screen.findByText(/CI passing/i);
    expect(badge.className).toMatch(/bg-green-100/);
    expect(badge.className).toMatch(/text-green-800/);
  });

  it('renders the failing badge in red', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'failing' as const,
        counts: { passing: 2, failing: 1, pending: 0, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);
    openReviewTab();

    const badge = await screen.findByText(/CI failing/i);
    expect(badge.className).toMatch(/bg-red-100/);
    expect(badge.className).toMatch(/text-red-800/);
  });

  it('renders the pending badge in amber', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'pending' as const,
        counts: { passing: 1, failing: 0, pending: 2, total: 3 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);
    openReviewTab();

    const badge = await screen.findByText(/CI pending/i);
    expect(badge.className).toMatch(/bg-amber-100/);
    expect(badge.className).toMatch(/text-amber-800/);
  });

  it('omits the coloured CI badge entirely when state is none', async () => {
    window.api.pr.checks.mockResolvedValueOnce({
      success: true,
      data: {
        state: 'none' as const,
        counts: { passing: 0, failing: 0, pending: 0, total: 0 },
      },
    });

    render(<SessionDetailView session={mockSession as any} />);
    openReviewTab();

    await waitFor(() => {
      expect(window.api.pr.checks).toHaveBeenCalled();
    });

    // No badge element carrying any of the three state colours is rendered.
    const coloured = document.querySelector(
      '.bg-green-100, .bg-red-100, .bg-amber-100'
    );
    expect(coloured).toBeNull();
  });
});
