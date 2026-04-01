/**
 * CommitsTab Component Tests
 * Tests for the session-level commit history tab
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CommitsTab } from '../../../renderer/components/features/CommitsTab';
import { mockApi } from '../setup';
import type { SessionReport } from '../../../shared/agent-protocol';

describe('CommitsTab', () => {
  const mockSession: SessionReport = {
    sessionId: 'session-123',
    agentId: 'agent-456',
    agentType: 'claude',
    task: 'Test Task',
    branchName: 'feature-branch',
    baseBranch: 'main',
    worktreePath: '/test/worktree',
    repoPath: '/test/repo',
    status: 'active',
    created: '2026-01-21T10:00:00Z',
    updated: '2026-01-21T11:00:00Z',
    commitCount: 5,
  };

  const mockCommits = [
    {
      hash: 'abc123def456',
      shortHash: 'abc123d',
      message: 'feat: add new feature',
      author: 'John Doe',
      date: '2026-01-21T11:00:00Z',
      filesChanged: 3,
      additions: 100,
      deletions: 20,
    },
    {
      hash: 'def456ghi789',
      shortHash: 'def456g',
      message: 'fix: resolve bug in component',
      author: 'Jane Smith',
      date: '2026-01-21T10:00:00Z',
      filesChanged: 1,
      additions: 10,
      deletions: 5,
    },
  ];

  const mockDiffDetail = {
    commit: mockCommits[0],
    files: [
      {
        path: 'src/Component.tsx',
        status: 'modified',
        additions: 50,
        deletions: 10,
        diff: '@@ -1,5 +1,55 @@\n+import React from "react";\n+export function Component() {}',
        language: 'typescript',
      },
      {
        path: 'src/utils.ts',
        status: 'added',
        additions: 50,
        deletions: 10,
        diff: '@@ -0,0 +1,50 @@\n+export function helper() {}',
        language: 'typescript',
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.git.getCommitHistory.mockResolvedValue({
      success: true,
      data: mockCommits,
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

      render(<CommitsTab session={mockSession} />);

      // Should show animated pulse elements
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  describe('Commit List', () => {
    it('should render commits after loading', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
        expect(screen.getByText('fix: resolve bug in component')).toBeInTheDocument();
      });
    });

    it('should display commit count in header', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument(); // Count badge
        expect(screen.getByText('Commits')).toBeInTheDocument();
      });
    });

    it('should display short hash for each commit', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('abc123d')).toBeInTheDocument();
        expect(screen.getByText('def456g')).toBeInTheDocument();
      });
    });

    it('should display author name', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('John Doe')).toBeInTheDocument();
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      });
    });

    it('should display file change stats', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        // First commit: 3 files, +100/-20
        expect(screen.getByText('3 files')).toBeInTheDocument();
        expect(screen.getByText('+100')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no commits', async () => {
      mockApi.git.getCommitHistory.mockResolvedValue({
        success: true,
        data: [],
      });

      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('No commits yet in this session')).toBeInTheDocument();
      });
    });
  });

  describe('Error State', () => {
    it('should show error message when API fails', async () => {
      mockApi.git.getCommitHistory.mockResolvedValue({
        success: false,
        error: { message: 'Failed to load commits' },
      });

      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load commits')).toBeInTheDocument();
      });
    });

    it('should show retry button on error', async () => {
      mockApi.git.getCommitHistory.mockResolvedValue({
        success: false,
        error: { message: 'Failed' },
      });

      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });
  });

  describe('Commit Expansion', () => {
    it('should expand commit when clicked', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
      });

      // Click on the first commit
      const commitCard = screen.getByText('feat: add new feature').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitCard!);

      // Should show loading indicator or diff content
      await waitFor(() => {
        // Either loading or diff content should be visible
        const hasDiffContent = screen.queryByText(/src\/Component\.tsx/);
        const hasLoading = screen.queryByText(/Loading diff/);
        expect(hasDiffContent || hasLoading).toBeTruthy();
      });
    });

    it('should load diff detail when expanding', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
      });

      // Click to expand
      const commitCard = screen.getByText('feat: add new feature').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitCard!);

      await waitFor(() => {
        expect(mockApi.git.getCommitDiff).toHaveBeenCalledWith(
          mockSession.worktreePath,
          'abc123def456'
        );
      });
    });

    it('should display diff viewer when expanded', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
      });

      // Click to expand
      const commitCard = screen.getByText('feat: add new feature').closest('div[class*="cursor-pointer"]');
      fireEvent.click(commitCard!);

      await waitFor(() => {
        // File paths from diff should be visible
        expect(screen.getByText('src/Component.tsx')).toBeInTheDocument();
      });
    });

    it('should collapse commit when clicked again', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
      });

      const commitCard = screen.getByText('feat: add new feature').closest('div[class*="cursor-pointer"]');

      // Click to expand
      fireEvent.click(commitCard!);

      await waitFor(() => {
        expect(screen.getByText('src/Component.tsx')).toBeInTheDocument();
      });

      // Click to collapse
      fireEvent.click(commitCard!);

      await waitFor(() => {
        // Diff content should no longer be in the border section
        const borderSection = document.querySelector('.border-t.border-border.bg-surface-secondary');
        expect(borderSection).toBeNull();
      });
    });
  });

  describe('Refresh', () => {
    it('should have refresh button', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });
    });

    it('should reload commits when refresh is clicked', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });

      // Clear call count
      mockApi.git.getCommitHistory.mockClear();

      // Click refresh
      fireEvent.click(screen.getByText('Refresh'));

      await waitFor(() => {
        expect(mockApi.git.getCommitHistory).toHaveBeenCalled();
      });
    });
  });

  describe('Session Context', () => {
    it('should use worktreePath when available', async () => {
      render(<CommitsTab session={mockSession} />);

      await waitFor(() => {
        expect(mockApi.git.getCommitHistory).toHaveBeenCalledWith(
          '/test/worktree',
          'main',
          100,
          'feature-branch'
        );
      });
    });

    it('should fall back to repoPath when worktreePath is not available', async () => {
      const sessionWithoutWorktree = {
        ...mockSession,
        worktreePath: undefined,
      };

      render(<CommitsTab session={sessionWithoutWorktree} />);

      await waitFor(() => {
        expect(mockApi.git.getCommitHistory).toHaveBeenCalledWith(
          '/test/repo',
          'main',
          100,
          'feature-branch'
        );
      });
    });

    it('should use session baseBranch for comparison', async () => {
      const sessionWithDifferentBase = {
        ...mockSession,
        baseBranch: 'develop',
      };

      render(<CommitsTab session={sessionWithDifferentBase} />);

      await waitFor(() => {
        expect(mockApi.git.getCommitHistory).toHaveBeenCalledWith(
          expect.any(String),
          'develop',
          100,
          'feature-branch'
        );
      });
    });
  });
});
