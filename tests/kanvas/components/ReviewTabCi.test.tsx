/**
 * ReviewTab CI checks badge (story KC-S1.2.2.4 AC3 and AC4)
 *
 * The review card fetches CI checks exactly once on mount and once per Refresh
 * click, never on a timer. It shows a CI badge by the Decision section —
 * 'CI passing' (green), 'CI failing' (red), or 'CI pending' (amber) — only
 * when an open PR exists.
 */

import '@testing-library/jest-dom';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock the KITMark component
jest.mock('../../../renderer/components/ui/KITMark', () => ({
  KITMarkContainer: () => null,
}));

// Mock react-markdown which SessionDetailView imports
jest.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('remark-gfm', () => ({}));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../setup';
import { SessionDetailView } from '../../../renderer/components/features/SessionDetailView';

// Helper to create a session with an open PR
function createSessionWithOpenPr(): any {
  return {
    sessionId: 'sess-test',
    repoPath: '/test/repo',
    worktreePath: '/test/worktree',
    branchName: 'feat/test',
    baseBranch: 'main',
    reviewRequest: {
      requestedAt: new Date().toISOString(),
      summary: 'Test summary',
      prStatus: null,
    },
  };
}

// Helper to create a session without an open PR
function createSessionWithoutOpenPr(): any {
  return {
    sessionId: 'sess-test',
    repoPath: '/test/repo',
    worktreePath: '/test/worktree',
    branchName: 'feat/test',
    baseBranch: 'main',
    reviewRequest: {
      requestedAt: new Date().toISOString(),
      summary: 'Test summary',
      prStatus: 'no_remote',
    },
  };
}

describe('ReviewTab CI badge - AC3 fetch timing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks for PR list and canApprove
    (mockApi.pr.list as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { number: 123, url: 'https://github.com/test/repo/pull/123', state: 'OPEN', title: 'Test', createdAt: '', isDraft: false },
      ],
    });
    (mockApi.pr.canApprove as jest.Mock).mockResolvedValue({ success: true, data: { allowed: true } });
    (mockApi.pr.checks as jest.Mock).mockResolvedValue({
      success: true,
      data: { overall: 'passing', counts: { passing: 2, pending: 0, failing: 0, total: 2 } },
    });
  });

  it('should call window.api.pr.checks exactly once on mount', async () => {
    const session = createSessionWithOpenPr();
    const checksSpy = jest.spyOn(mockApi.pr, 'checks');
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab to render ReviewTab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    // AC3: Should have called pr.checks exactly once on mount
    expect(checksSpy).toHaveBeenCalledTimes(1);
  });

  it('should NOT call window.api.pr.checks when advancing 10 minutes of fake timers', async () => {
    jest.useFakeTimers();
    
    const session = createSessionWithOpenPr();
    const checksSpy = jest.spyOn(mockApi.pr, 'checks');
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab to render ReviewTab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    const initialCallCount = checksSpy.mock.calls.length;
    
    // Advance 10 minutes - should NOT trigger additional calls
    jest.advanceTimersByTime(10 * 60 * 1000);
    
    // AC3: No polling - call count should be unchanged
    expect(checksSpy.mock.calls.length).toBe(initialCallCount);
    
    jest.useRealTimers();
  });

  it('should call window.api.pr.checks again when Refresh is clicked', async () => {
    const session = createSessionWithOpenPr();
    const checksSpy = jest.spyOn(mockApi.pr, 'checks');
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab to render ReviewTab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    // Initial call on mount
    expect(checksSpy).toHaveBeenCalledTimes(1);
    
    // Click Refresh button
    await userEvent.click(screen.getByText(/Refresh/i));
    
    // AC3: Should have called again
    expect(checksSpy).toHaveBeenCalledTimes(2);
  });
});

describe('ReviewTab CI badge - AC4 UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks for PR list and canApprove
    (mockApi.pr.list as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { number: 123, url: 'https://github.com/test/repo/pull/123', state: 'OPEN', title: 'Test', createdAt: '', isDraft: false },
      ],
    });
    (mockApi.pr.canApprove as jest.Mock).mockResolvedValue({ success: true, data: { allowed: true } });
  });

  it('should show "CI passing" badge when checks are passing', async () => {
    const session = createSessionWithOpenPr();
    (mockApi.pr.checks as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: { overall: 'passing', counts: { passing: 2, pending: 0, failing: 0, total: 2 } },
    });
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab to render ReviewTab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    // AC4: Badge should be visible
    const badge = await screen.findByText(/CI passing/i);
    expect(badge).toBeInTheDocument();
    // Should have green/emerald styling
    expect(badge).toHaveClass('text-emerald-700')
      .or.toHaveClass('bg-emerald-500')
      .or.toHaveClass('emerald')
      .or.toHaveClass('green');
  });

  it('should show "CI failing" badge in red when checks are failing', async () => {
    const session = createSessionWithOpenPr();
    (mockApi.pr.checks as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: { overall: 'failing', counts: { passing: 1, pending: 0, failing: 1, total: 2 } },
    });
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    const badge = await screen.findByText(/CI failing/i);
    expect(badge).toBeInTheDocument();
    // Should have red styling
    expect(badge).toHaveClass('text-red-600')
      .or.toHaveClass('bg-red-500')
      .or.toHaveClass('red');
  });

  it('should show "CI pending" badge in amber when checks are pending', async () => {
    const session = createSessionWithOpenPr();
    (mockApi.pr.checks as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: { overall: 'pending', counts: { passing: 0, pending: 2, failing: 0, total: 2 } },
    });
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    const badge = await screen.findByText(/CI pending/i);
    expect(badge).toBeInTheDocument();
    // Should have amber styling
    expect(badge).toHaveClass('text-amber-600')
      .or.toHaveClass('bg-amber-500')
      .or.toHaveClass('amber')
      .or.toHaveClass('yellow');
  });

  it('should NOT show CI badge when there is no open PR', async () => {
    const session = createSessionWithoutOpenPr();
    (mockApi.pr.list as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [], // No PRs
    });
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    // AC4: Badge should NOT be present when no open PR
    expect(screen.queryByText(/CI (passing|failing|pending)/i)).not.toBeInTheDocument();
  });

  it('should show the badge alongside the Refresh control in the Decision section', async () => {
    const session = createSessionWithOpenPr();
    (mockApi.pr.checks as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: { overall: 'passing', counts: { passing: 2, pending: 0, failing: 0, total: 2 } },
    });
    
    render(<SessionDetailView session={session} onClose={() => {}} />);
    
    // Click on the Review tab
    await userEvent.click(screen.getByText(/Review/i));
    
    await waitFor(() => {
      expect(screen.getByText(/Ready for review/i)).toBeInTheDocument();
    });
    
    // Decision section should exist
    expect(screen.getByText(/Decision/i)).toBeInTheDocument();
    
    // Both badge and Refresh should be visible
    await waitFor(() => {
      expect(screen.getByText(/CI passing/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Refresh/i)).toBeInTheDocument();
  });
});
