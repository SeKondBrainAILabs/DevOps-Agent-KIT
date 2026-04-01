/**
 * UniversalCommitsView Component Tests
 * Tests for the cross-session commit aggregation view
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { UniversalCommitsView } from '../../../renderer/components/features/UniversalCommitsView';
import { mockApi } from '../setup';
import type { SessionReport } from '../../../shared/agent-protocol';

// Mock the store — stable _storeState object prevents infinite re-render loops
let _storeState: any = {};
jest.mock('../../../renderer/store/agentStore', () => ({
  useAgentStore: (selector: (state: any) => any) => selector(_storeState),
}));

describe('UniversalCommitsView', () => {
  const mockSessions: SessionReport[] = [
    {
      sessionId: 'session-1',
      agentId: 'agent-1',
      agentType: 'claude',
      task: 'Add authentication',
      branchName: 'feature-auth',
      baseBranch: 'main',
      worktreePath: '/test/worktree-1',
      repoPath: '/test/repo-1',
      status: 'active',
      created: '2026-01-21T08:00:00Z',
      updated: '2026-01-21T10:00:00Z',
      commitCount: 3,
    },
    {
      sessionId: 'session-2',
      agentId: 'agent-2',
      agentType: 'cursor',
      task: 'Fix API bug',
      branchName: 'fix-api',
      baseBranch: 'main',
      worktreePath: '/test/worktree-2',
      repoPath: '/test/repo-2',
      status: 'active',
      created: '2026-01-21T09:00:00Z',
      updated: '2026-01-21T11:00:00Z',
      commitCount: 2,
    },
  ];

  const mockCommitsSession1 = [
    {
      hash: 'abc123def456',
      shortHash: 'abc123d',
      message: 'feat: add login form',
      author: 'John Doe',
      date: new Date().toISOString(), // Today
      filesChanged: 3,
      additions: 100,
      deletions: 10,
    },
  ];

  const mockCommitsSession2 = [
    {
      hash: 'def456ghi789',
      shortHash: 'def456g',
      message: 'fix: API validation error',
      author: 'Jane Smith',
      date: new Date().toISOString(), // Today
      filesChanged: 1,
      additions: 20,
      deletions: 5,
    },
  ];

  const mockDiffDetail = {
    commit: mockCommitsSession1[0],
    files: [
      {
        path: 'src/LoginForm.tsx',
        status: 'added',
        additions: 50,
        deletions: 0,
        diff: '@@ -0,0 +1,50 @@\n+import React from "react";\n+export function LoginForm() {}',
        language: 'typescript',
      },
    ],
  };

  // Stable references outside beforeEach to prevent infinite re-renders
  const stableSessionsMap = new Map(mockSessions.map(s => [s.sessionId, s]));

  beforeEach(() => {
    jest.clearAllMocks();

    // Set store state with stable Map reference
    _storeState = { reportedSessions: stableSessionsMap };

    // Setup API mocks — use mockResolvedValue to avoid re-creating promises
    mockApi.git.getCommitHistory
      .mockImplementation((repoPath: string) => {
        if (repoPath === '/test/worktree-1') {
          return Promise.resolve({ success: true, data: mockCommitsSession1 });
        }
        if (repoPath === '/test/worktree-2') {
          return Promise.resolve({ success: true, data: mockCommitsSession2 });
        }
        return Promise.resolve({ success: true, data: [] });
      });

    mockApi.git.getCommitDiff.mockResolvedValue({
      success: true,
      data: mockDiffDetail,
    });
  });

  describe('Loading State', () => {
    it('should show loading skeleton initially', () => {
      mockApi.git.getCommitHistory.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<UniversalCommitsView />);

      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  describe('Header', () => {
    it('should display "All Commits" title', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('All Commits')).toBeInTheDocument();
      });
    });

    it('should have refresh button', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });
    });

    it('should display commit and session counts', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('2 commits')).toBeInTheDocument();
        expect(screen.getByText('2 sessions')).toBeInTheDocument();
      });
    });
  });

  describe('Filters', () => {
    it('should render session filter dropdown', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('All Sessions')).toBeInTheDocument();
      });
    });

    it('should render repo filter dropdown', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('All Repos')).toBeInTheDocument();
      });
    });

    it('should render time filter dropdown', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('All Time')).toBeInTheDocument();
      });
    });

    it('should filter by session when selected', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
        expect(screen.getByText('fix: API validation error')).toBeInTheDocument();
      });

      // Change session filter
      const sessionSelect = screen.getByDisplayValue('All Sessions');
      fireEvent.change(sessionSelect, { target: { value: 'session-1' } });

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
        expect(screen.queryByText('fix: API validation error')).not.toBeInTheDocument();
      });
    });
  });

  describe('Commit List', () => {
    it('should render commits from all sessions', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
        expect(screen.getByText('fix: API validation error')).toBeInTheDocument();
      });
    });

    it('should display session name for each commit', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        // Session names appear in both filter dropdown and commit tags
        expect(screen.getAllByText('Add authentication').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Fix API bug').length).toBeGreaterThan(0);
      });
    });

    it('should display commit hashes', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('abc123d')).toBeInTheDocument();
        expect(screen.getByText('def456g')).toBeInTheDocument();
      });
    });

    it('should display author names', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('John Doe')).toBeInTheDocument();
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      });
    });

    it('should group commits by date', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no commits', async () => {
      mockApi.git.getCommitHistory.mockResolvedValue({
        success: true,
        data: [],
      });

      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });
    });

    it('should suggest adjusting filters when filtered and empty', async () => {
      mockApi.git.getCommitHistory.mockResolvedValue({
        success: true,
        data: [],
      });

      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });

      // Change a filter
      const timeSelect = screen.getByDisplayValue('All Time');
      fireEvent.change(timeSelect, { target: { value: '24h' } });

      await waitFor(() => {
        expect(screen.getByText('Try adjusting your filters')).toBeInTheDocument();
      });
    });
  });

  describe('Commit Expansion', () => {
    it('should expand commit when clicked', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
      });

      // Click on commit
      const commitRow = screen.getByText('feat: add login form').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitRow!);

      // Should show loading or diff content
      await waitFor(() => {
        const loadingOrDiff = screen.queryByText(/Loading diff/) || screen.queryByText(/LoginForm\.tsx/);
        expect(loadingOrDiff).toBeTruthy();
      });
    });

    it('should load diff detail when expanding', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
      });

      // Click to expand
      const commitRow = screen.getByText('feat: add login form').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitRow!);

      await waitFor(() => {
        expect(mockApi.git.getCommitDiff).toHaveBeenCalledWith(
          '/test/worktree-1',
          'abc123def456'
        );
      });
    });

    it('should display diff viewer when expanded', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('feat: add login form')).toBeInTheDocument();
      });

      // Click to expand
      const commitRow = screen.getByText('feat: add login form').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitRow!);

      await waitFor(() => {
        expect(screen.getByText('src/LoginForm.tsx')).toBeInTheDocument();
      });
    });
  });

  describe('Refresh', () => {
    it('should reload all commits when refresh is clicked', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });

      // Clear call count
      mockApi.git.getCommitHistory.mockClear();

      // Click refresh
      fireEvent.click(screen.getByText('Refresh'));

      await waitFor(() => {
        // Should have called getCommitHistory for each session
        expect(mockApi.git.getCommitHistory).toHaveBeenCalled();
      });
    });
  });

  describe('Agent Type Styling', () => {
    it('should apply different colors for different agent types', async () => {
      render(<UniversalCommitsView />);

      await waitFor(() => {
        // Find the styled tag spans (not the select options)
        const claudeTags = screen.getAllByText('Add authentication');
        const claudeTag = claudeTags.find(el => el.tagName === 'SPAN');
        expect(claudeTag?.className).toContain('orange');

        const cursorTags = screen.getAllByText('Fix API bug');
        const cursorTag = cursorTags.find(el => el.tagName === 'SPAN');
        expect(cursorTag?.className).toContain('purple');
      });
    });
  });

  describe('No Sessions', () => {
    it('should handle case when no sessions exist', async () => {
      _storeState = { reportedSessions: new Map() };

      render(<UniversalCommitsView />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
        expect(screen.getByText('0 commits')).toBeInTheDocument();
        expect(screen.getByText('0 sessions')).toBeInTheDocument();
      });
    });
  });
});
