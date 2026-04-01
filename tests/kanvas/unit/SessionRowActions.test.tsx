/**
 * Unit Tests for SessionRow — Merge & Delete buttons
 * Tests that merge/delete icon buttons appear and function correctly.
 */

import React from 'react';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock the MergeWorkflowModal
jest.mock('../../../renderer/components/features/MergeWorkflowModal', () => ({
  MergeWorkflowModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <div data-testid="merge-modal"><button onClick={onClose}>Close</button></div> : null,
}));

// Mock agentStore
const mockRemoveReportedSession = jest.fn();
const mockViewedCommitCounts = new Map<string, number>();
let mockSessions = new Map<string, any>();

jest.mock('../../../renderer/store/agentStore', () => ({
  useAgentStore: (selector: (state: any) => any) => {
    const state = {
      isInitialized: true,
      reportedSessions: mockSessions,
      selectedSessionId: null,
      setSelectedSession: jest.fn(),
      removeReportedSession: mockRemoveReportedSession,
      viewedCommitCounts: mockViewedCommitCounts,
      lastRebaseTimes: new Map(),
    };
    return selector(state);
  },
}));

// Import after mocks
import { AgentList } from '../../../renderer/components/features/AgentList';

function createSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sess-test-1',
    agentType: 'claude',
    status: 'active',
    branchName: 'feature-abc123',
    baseBranch: 'main',
    repoPath: '/test/repo',
    worktreePath: '/test/worktree',
    commitCount: 5,
    task: 'Test task',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    ...overrides,
  };
}

function renderWithSession(session: Record<string, any>) {
  mockSessions = new Map([[session.sessionId, session]]);
  return render(<AgentList />);
}

describe('SessionRow — Merge & Delete buttons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockViewedCommitCounts.clear();
    (window as any).api = {
      instance: {
        deleteSession: jest.fn().mockResolvedValue({ success: true } as never),
      },
    };
  });

  it('should render merge button with correct title', () => {
    renderWithSession(createSession({ baseBranch: 'development' }));
    const mergeBtn = screen.getByTitle('Merge to development');
    expect(mergeBtn).toBeDefined();
  });

  it('should render delete button', () => {
    renderWithSession(createSession());
    const deleteBtn = screen.getByTitle('Delete session');
    expect(deleteBtn).toBeDefined();
  });

  it('should open MergeWorkflowModal when merge button clicked', () => {
    renderWithSession(createSession());
    expect(screen.queryByTestId('merge-modal')).toBeNull();

    fireEvent.click(screen.getByTitle('Merge to main'));
    expect(screen.getByTestId('merge-modal')).toBeDefined();
  });

  it('should show confirm state on first delete click', () => {
    renderWithSession(createSession());

    fireEvent.click(screen.getByTitle('Delete session'));

    // Should show confirm state
    expect(screen.getByTitle('Click again to confirm')).toBeDefined();
    expect(screen.getByText('Del?')).toBeDefined();
    // Should NOT have deleted yet
    expect((window as any).api.instance.deleteSession).not.toHaveBeenCalled();
    expect(mockRemoveReportedSession).not.toHaveBeenCalled();
  });

  it('should delete session on second click (confirm)', () => {
    renderWithSession(createSession());

    // First click — enter confirm
    fireEvent.click(screen.getByTitle('Delete session'));
    // Second click — confirm
    fireEvent.click(screen.getByTitle('Click again to confirm'));

    expect((window as any).api.instance.deleteSession).toHaveBeenCalledWith('sess-test-1', '/test/repo');
    expect(mockRemoveReportedSession).toHaveBeenCalledWith('sess-test-1');
  });

  it('should default baseBranch to main when not set', () => {
    renderWithSession(createSession({ baseBranch: undefined }));
    expect(screen.getByTitle('Merge to main')).toBeDefined();
  });

  it('should use worktreePath when repoPath is empty', () => {
    renderWithSession(createSession({ repoPath: '', worktreePath: '/test/worktree' }));

    fireEvent.click(screen.getByTitle('Delete session'));
    fireEvent.click(screen.getByTitle('Click again to confirm'));

    expect((window as any).api.instance.deleteSession).toHaveBeenCalledWith('sess-test-1', '/test/worktree');
  });
});
