/**
 * The CI badge on a session's Review tab.
 *
 * The Review tab is where a person decides whether work is safe to merge, and
 * "is CI green" is the first thing they look for. It has to be fetched when the
 * tab opens and on an explicit Refresh — and NEVER on a timer: at agent
 * fan-out, twenty sessions each polling `gh` is a rate-limit incident. This
 * suite pins both halves of that: the badge reflects what `pr.checks` returns,
 * and checks is called on mount and on Refresh but not by any polling loop.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// SessionDetailView imports ESM-only deps (react-markdown, remark-gfm) that the
// kanvas jest config does not transform. Stub them so the module under test
// loads; none of them are involved in the Review tab's CI badge.
jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children) }));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => {} }));
jest.mock('react-window', () => ({
  __esModule: true,
  FixedSizeList: ({ children, itemCount }: { children: (p: { index: number; style: React.CSSProperties }) => React.ReactNode; itemCount: number }) =>
    React.createElement('div', null, Array.from({ length: itemCount }, (_, i) => children({ index: i, style: {} }))),
}));

import { SessionDetailView } from '../../../renderer/components/features/SessionDetailView';
import type { SessionReport } from '../../../shared/agent-protocol';

type CheckRow = { name: string; state: string; bucket?: string };

const WORKTREE = '/test/worktree';

function makeSession(overrides: Partial<SessionReport> = {}): SessionReport {
  return {
    sessionId: 'sess-ci',
    repoPath: '/test/repo',
    worktreePath: WORKTREE,
    branchName: 'feat/ci-badge',
    baseBranch: 'main',
    task: 'Add a CI badge to the review card',
    status: 'running',
    reviewRequest: {
      summary: 'Added the CI badge to the Review tab.',
      requestedAt: new Date().toISOString(),
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      prStatus: 'open',
    },
    ...overrides,
  } as SessionReport;
}

/**
 * Install a `pr` mock on window.api. `checks` is the new call this story adds;
 * `list`/`canApprove` are the ones the tab already makes so the rest of the tab
 * renders normally. Returns the mock so a test can assert call counts.
 */
function installPrApi(checks: Array<CheckRow> = []) {
  const pr = {
    list: jest.fn(async () => ({
      success: true,
      data: [
        {
          number: 42,
          url: 'https://github.com/o/r/pull/42',
          state: 'OPEN',
          title: 'Add a CI badge',
          createdAt: new Date().toISOString(),
          isDraft: false,
        },
      ],
    })),
    canApprove: jest.fn(async () => ({ success: true, data: { allowed: true } })),
    review: jest.fn(async () => ({ success: true, data: undefined })),
    checks: jest.fn(async () => ({ success: true, data: checks })),
  };
  (window as any).api = { ...(window as any).api, pr };
  return pr;
}

async function openReviewTab() {
  render(<SessionDetailView session={makeSession()} onBack={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: /^Review/ }));
}

describe('ReviewTab CI status', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches CI checks when the Review tab opens', async () => {
    const pr = installPrApi([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }]);
    await openReviewTab();

    await waitFor(() => expect(pr.checks).toHaveBeenCalled());
    expect(pr.checks).toHaveBeenCalledWith(WORKTREE, 42);
  });

  it('shows a passing badge when every check passed', async () => {
    installPrApi([
      { name: 'build', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: 'SUCCESS', bucket: 'pass' },
    ]);
    await openReviewTab();

    expect(await screen.findByText(/CI passing/i)).toBeInTheDocument();
  });

  it('shows a failing badge when a check failed', async () => {
    installPrApi([
      { name: 'build', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: 'FAILURE', bucket: 'fail' },
    ]);
    await openReviewTab();

    expect(await screen.findByText(/CI failing/i)).toBeInTheDocument();
  });

  it('shows a pending badge while a check is still running', async () => {
    installPrApi([
      { name: 'build', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: 'IN_PROGRESS', bucket: 'pending' },
    ]);
    await openReviewTab();

    expect(await screen.findByText(/CI pending/i)).toBeInTheDocument();
  });

  it('re-fetches when Refresh is clicked', async () => {
    const pr = installPrApi([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }]);
    await openReviewTab();
    await waitFor(() => expect(pr.checks).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));

    await waitFor(() => expect(pr.checks).toHaveBeenCalledTimes(2));
  });

  it('does not poll: no further checks call without an explicit refresh', async () => {
    jest.useFakeTimers();
    const pr = installPrApi([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }]);

    render(<SessionDetailView session={makeSession()} onBack={() => {}} />);
    await userEvent.setup({ advanceTimers: jest.advanceTimersByTime }).click(
      screen.getByRole('button', { name: /^Review/ })
    );
    await waitFor(() => expect(pr.checks).toHaveBeenCalledTimes(1));

    // Ten minutes of wall-clock time pass with the tab open.
    jest.advanceTimersByTime(10 * 60 * 1000);

    expect(pr.checks).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
