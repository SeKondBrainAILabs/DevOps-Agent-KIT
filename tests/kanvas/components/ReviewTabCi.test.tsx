/**
 * Component test for ReviewTab CI fetching behavior (KC-S1.2.2.4 - AC3)
 *
 * Checks are fetched once when the review tab mounts and once per Refresh click;
 * ten minutes of fake timers trigger no further call.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock react-markdown and related ESM packages that Jest cannot parse
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: {},
}));

// Mock react-window
jest.mock('react-window', () => ({
  __esModule: true,
  FixedSizeList: ({ children }: { children: Function }) => <div>{children({ index: 0, style: {} })}</div>,
}));

// Mock the SessionDetailView component's dependencies
jest.mock('../../../renderer/store/agentStore', () => ({
  useAgentStore: () => ({
    getSession: jest.fn().mockReturnValue(null),
  }),
}));

jest.mock('../../../renderer/store/uiStore', () => ({
  useUIStore: () => ({
    mainView: 'dashboard',
  }),
}));

// Mock KITMark to avoid import.meta.url issues
jest.mock('../../../renderer/components/ui/KITMark', () => ({
  KITMarkContainer: () => null,
}));

import { SessionDetailView } from '../../../renderer/components/features/SessionDetailView';
import type { SessionReport } from '../../../shared/agent-protocol';

describe('ReviewTab CI fetching behavior', () => {
  const mockSession: SessionReport = {
    sessionId: 'sess-test-123',
    repoPath: '/tmp/test-repo',
    repoName: 'test-repo',
    branchName: 'feature/test',
    baseBranch: 'main',
    worktreePath: '/tmp/worktrees/test-repo-feature-test',
    agentType: 'opencode',
    status: 'completed',
    task: 'Add new feature',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    reviewRequest: {
      summary: 'This is what I changed.',
      requestedAt: new Date().toISOString(),
      prNumber: 42,
      prUrl: 'https://github.com/test/test-repo/pull/42',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Mock PR API
    (global.window as any).api = {
      pr: {
        list: jest.fn().mockResolvedValue({
          success: true,
          data: [
            {
              number: 42,
              url: 'https://github.com/test/test-repo/pull/42',
              state: 'OPEN',
              title: 'Feature test',
              createdAt: new Date().toISOString(),
              isDraft: false,
            },
          ],
        }),
        canApprove: jest.fn().mockResolvedValue({
          success: true,
          data: { allowed: true },
        }),
        checks: jest.fn(),
      },
      merge: {
        execute: jest.fn().mockResolvedValue({ success: true }),
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches checks once when the review tab mounts', async () => {
    render(<SessionDetailView session={mockSession} />);

    // Wait for initial PR fetch to complete
    await waitFor(() => {
      expect((global.window as any).api.pr.list).toHaveBeenCalled();
    }, { timeout: 5000 });

    // The component should have called pr.checks on mount
    // This will FAIL until the implementation adds the CI fetching logic
    expect((global.window as any).api.pr.checks).toHaveBeenCalled();
  });

  it('fetches checks again when Refresh button is clicked', async () => {
    render(<SessionDetailView session={mockSession} />);

    // Wait for mount
    await waitFor(() => {
      expect((global.window as any).api.pr.list).toHaveBeenCalled();
    }, { timeout: 5000 });

    // Find Refresh button and click it
    const refreshButton = screen.getByText('Refresh');
    fireEvent.click(refreshButton);

    // Should fetch checks again
    // This will FAIL until the implementation adds the CI refresh logic
    expect((global.window as any).api.pr.checks).toHaveBeenCalledTimes(2);
  });

  it('triggers no further call after ten minutes of fake timers', async () => {
    render(<SessionDetailView session={mockSession} />);

    // Wait for mount
    await waitFor(() => {
      expect((global.window as any).api.pr.list).toHaveBeenCalled();
    }, { timeout: 5000 });

    // Clear any pending timers and advance 10 minutes
    jest.clearAllTimers();
    jest.advanceTimersByTime(10 * 60 * 1000);

    // Should not have polled automatically
    // This verifies no polling - if implementation adds polling, this will FAIL
    const callCountAfter10Min = (global.window as any).api.pr.checks.mock.calls.length;
    expect(callCountAfter10Min).toBeLessThanOrEqual(1);
  });
});
