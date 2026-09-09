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

// Mock the DeleteSessionDialog — delete is now a dialog-driven flow (not inline two-click).
// The dialog exposes its sessionId and an onDeleted trigger so we can assert SessionRow's
// responsibility: opening the dialog with the right session and wiring up onDeleted.
jest.mock('../../../renderer/components/features/DeleteSessionDialog', () => ({
  DeleteSessionDialog: ({ sessionId, onDeleted, onClose }: { sessionId: string; onDeleted: () => void; onClose: () => void }) => (
    <div data-testid="delete-dialog" data-session-id={sessionId}>
      <button onClick={onDeleted}>Confirm delete</button>
      <button onClick={onClose}>Cancel</button>
    </div>
  ),
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

  it('should open DeleteSessionDialog on delete click', () => {
    renderWithSession(createSession());

    // Dialog not shown initially
    expect(screen.queryByTestId('delete-dialog')).toBeNull();

    fireEvent.click(screen.getByTitle('Delete session'));

    // Clicking delete opens the confirmation dialog with the correct session
    const dialog = screen.getByTestId('delete-dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('data-session-id')).toBe('sess-test-1');
    // Should NOT have removed the session yet — deletion is confirmed inside the dialog
    expect(mockRemoveReportedSession).not.toHaveBeenCalled();
  });

  it('should remove session from store when dialog confirms deletion', () => {
    renderWithSession(createSession());

    fireEvent.click(screen.getByTitle('Delete session'));
    // The dialog owns the actual deletion; on success it calls onDeleted
    fireEvent.click(screen.getByText('Confirm delete'));

    expect(mockRemoveReportedSession).toHaveBeenCalledWith('sess-test-1');
  });

  it('should default baseBranch to main when not set', () => {
    renderWithSession(createSession({ baseBranch: undefined }));
    expect(screen.getByTitle('Merge to main')).toBeDefined();
  });

  it('should close the dialog without deleting when cancelled', () => {
    renderWithSession(createSession({ repoPath: '', worktreePath: '/test/worktree' }));

    fireEvent.click(screen.getByTitle('Delete session'));
    expect(screen.getByTestId('delete-dialog')).toBeDefined();

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByTestId('delete-dialog')).toBeNull();
    expect(mockRemoveReportedSession).not.toHaveBeenCalled();
  });
});
