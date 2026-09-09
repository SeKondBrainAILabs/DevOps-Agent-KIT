/**
 * Component Tests for WorkspaceBrowserView (Epic A / story A5 — MVP)
 *
 * Exercises the top-level page that ties workspace CRUD, scan, watcher,
 * filter, sort, and per-repo status lookups together.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceBrowserView } from '../../../renderer/components/features/WorkspaceBrowserView';
import { mockApi } from '../setup';
import type { DiscoveredRepo, Workspace } from '../../../shared/types';

const mkWorkspace = (id: string, name: string): Workspace => ({
  id,
  name,
  path: `/Users/me/${name}`,
  scanDepth: 2,
  ignoreGlobs: [],
  createdAt: new Date().toISOString(),
});

const mkRepo = (name: string, depth = 1, ago = 0): DiscoveredRepo => ({
  workspaceId: 'ws_1',
  path: `/Users/me/work/${name}`,
  name,
  depth,
  discoveredAt: new Date(Date.now() - ago * 60_000).toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  // Default: one workspace, two repos
  (mockApi.workspace.list as jest.Mock).mockResolvedValue({
    success: true,
    data: [mkWorkspace('ws_1', 'work')],
  } as never);
  (mockApi.workspace.getActive as jest.Mock).mockResolvedValue({
    success: true,
    data: mkWorkspace('ws_1', 'work'),
  } as never);
  (mockApi.workspace.scan as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      workspaceId: 'ws_1',
      scannedAt: new Date().toISOString(),
      durationMs: 12,
      repoCount: 2,
      repos: [mkRepo('zed', 1, 60), mkRepo('alpha', 1, 5)],
    },
  } as never);
  (mockApi.workspace.startWatching as jest.Mock).mockResolvedValue({ success: true } as never);
  (mockApi.workspace.setActive as jest.Mock).mockResolvedValue({ success: true } as never);
  (mockApi.repoWorkspace.getWorktreeMode as jest.Mock).mockResolvedValue({
    success: true,
    data: 'worktree',
  } as never);
  (mockApi.repoWorkspace.getActiveSessionCount as jest.Mock).mockResolvedValue({
    success: true,
    data: 0,
  } as never);
  (mockApi.cleanup.getStorageMetrics as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      fetchedAt: new Date().toISOString(),
      docker: {
        available: true,
        images: { sizeBytes: 19.88 * 1024 ** 3, reclaimableBytes: 10.74 * 1024 ** 3, reclaimablePercent: 54 },
        localVolumes: { sizeBytes: 26.38 * 1024 ** 3, reclaimableBytes: 26.38 * 1024 ** 3, reclaimablePercent: 100 },
        buildCache: { sizeBytes: 21.73 * 1024 ** 3, reclaimableBytes: 0, reclaimablePercent: 0 },
      },
      local: {
        scannedRepoCount: 2,
        nodeModulesTotalBytes: 4 * 1024 ** 3,
        pythonEnvsTotalBytes: 2 * 1024 ** 3,
        nodeModulesByRepo: [{ repoPath: '/Users/me/work/alpha', bytes: 4 * 1024 ** 3, paths: ['/Users/me/work/alpha/node_modules'] }],
        pythonEnvsByRepo: [{ repoPath: '/Users/me/work/zed', bytes: 2 * 1024 ** 3, paths: ['/Users/me/work/zed/.venv'] }],
        abandonedWorktrees: [
          {
            repoPath: '/Users/me/work/alpha',
            worktreePath: '/Users/me/worktrees/alpha-missing-cleanup',
            branch: 'feature/missing-cleanup',
            bytes: 0,
            exists: false,
            lastTouchedAt: null,
            daysSinceLastTouched: null,
            reason: 'missing-path',
          },
          {
            repoPath: '/Users/me/work/zed',
            worktreePath: '/Users/me/worktrees/zed-feature-cleanup',
            branch: 'feature/cleanup',
            bytes: 3 * 1024 ** 3,
            exists: true,
            lastTouchedAt: '2026-05-01T00:00:00.000Z',
            daysSinceLastTouched: 20,
            reason: 'stale-no-session',
          },
        ],
        reclaimableByRepo: [
          {
            repoPath: '/Users/me/work/zed',
            totalReclaimableBytes: 5 * 1024 ** 3,
            nodeModulesBytes: 0,
            pythonEnvsBytes: 2 * 1024 ** 3,
            abandonedWorktreeBytes: 3 * 1024 ** 3,
            abandonedWorktreeCount: 1,
          },
          {
            repoPath: '/Users/me/work/alpha',
            totalReclaimableBytes: 4 * 1024 ** 3,
            nodeModulesBytes: 4 * 1024 ** 3,
            pythonEnvsBytes: 0,
            abandonedWorktreeBytes: 0,
            abandonedWorktreeCount: 0,
          },
        ],
      },
    },
  } as never);
});

describe('WorkspaceBrowserView — empty state', () => {
  it('shows the no-workspaces empty state when none configured', async () => {
    (mockApi.workspace.list as jest.Mock).mockResolvedValue({ success: true, data: [] } as never);
    (mockApi.workspace.getActive as jest.Mock).mockResolvedValue({ success: true, data: null } as never);
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-no-workspace')).toBeInTheDocument();
    });
    expect(screen.getByText(/Add your first workspace/i)).toBeInTheDocument();
  });

  it('shows no-repos message when scan returns empty', async () => {
    (mockApi.workspace.scan as jest.Mock).mockResolvedValue({
      success: true,
      data: { workspaceId: 'ws_1', scannedAt: '', durationMs: 0, repoCount: 0, repos: [] },
    } as never);
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-no-repos')).toHaveTextContent(/No git repositories/);
    });
  });
});

describe('WorkspaceBrowserView — happy path', () => {
  it('lists workspaces in the switcher', async () => {
    (mockApi.workspace.list as jest.Mock).mockResolvedValue({
      success: true,
      data: [mkWorkspace('ws_1', 'work'), mkWorkspace('ws_2', 'personal')],
    } as never);
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      const switcher = screen.getByTestId('workspace-switcher');
      const options = within(switcher).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['work', 'personal']);
      expect(screen.getByTestId('workspace-manager-panel')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-manager-collapsed-summary')).toBeInTheDocument();
      expect(screen.queryByTestId('workspace-manager-list')).toBeNull();
    });
    await user.click(screen.getByTestId('workspace-manager-toggle'));
    await waitFor(() => {
      expect(screen.getAllByTestId('workspace-manager-row')).toHaveLength(2);
    });
  });

  it('renders a dense row for every discovered repo', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      const list = screen.getByTestId('repo-list');
      expect(within(list).getAllByTestId('repo-list-row')).toHaveLength(2);
      expect(screen.getAllByTestId('repo-row-priority')).toHaveLength(2);
      expect(screen.getAllByTestId('repo-row-health')).toHaveLength(2);
      expect(screen.getAllByTestId('repo-row-health-score')).toHaveLength(2);
    });
  });

  it('renders read-only Docker and local storage metrics panel', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);

    // Workflow queue lives under the Workflow tab
    await user.click(await screen.findByTestId('workspace-tab-workflow'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-queue-panel')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-queue-item-0')).toHaveTextContent(/Prune missing worktree refs/i);
    });

    // Storage metrics + cleanup actions live under the Storage tab
    await user.click(screen.getByTestId('workspace-tab-storage'));
    await waitFor(() => {
      expect(screen.getByTestId('storage-metrics-panel')).toBeInTheDocument();
      expect(screen.getByTestId('docker-images-metric')).toHaveTextContent(/images/i);
      expect(screen.getByTestId('docker-volumes-metric')).toHaveTextContent(/local volumes/i);
      expect(screen.getByTestId('docker-build-cache-metric')).toHaveTextContent(/build cache/i);
      expect(screen.getByTestId('local-node-modules-metric')).toHaveTextContent(/node_modules/i);
      expect(screen.getByTestId('local-python-metric')).toHaveTextContent(/python envs/i);
      expect(screen.getByTestId('top-priority-actions-section')).toBeInTheDocument();
      expect(screen.getByTestId('top-priority-action-row-0')).toHaveTextContent(/zed/i);
      expect(screen.getByTestId('top-priority-action-copy-0')).toBeInTheDocument();
      expect(screen.getByTestId('top-priority-action-terminal-0')).toBeInTheDocument();
      expect(screen.getByTestId('reclaimable-ranking-section')).toBeInTheDocument();
      expect(screen.getByTestId('reclaimable-ranking-row-0')).toHaveTextContent(/zed/i);
      expect(screen.getByTestId('abandoned-worktrees-section')).toBeInTheDocument();
      expect(screen.getByTestId('abandoned-worktree-row-1')).toHaveTextContent(/feature\/cleanup/i);
      expect(screen.getByTestId('abandoned-worktree-clean-0')).toBeInTheDocument();
      expect(screen.getByTestId('abandoned-worktree-copy-0')).toBeInTheDocument();
    });
    expect(mockApi.cleanup.getStorageMetrics).toHaveBeenCalledWith(
      expect.arrayContaining(['/Users/me/work/zed', '/Users/me/work/alpha'])
    );
  });

  it('starts the filesystem watcher for the active workspace', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(mockApi.workspace.startWatching).toHaveBeenCalledWith('ws_1');
    });
  });

  it('Rescan button re-invokes workspace.scan', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    (mockApi.workspace.scan as jest.Mock).mockClear();
    await user.click(screen.getByTestId('rescan-button'));
    await waitFor(() => {
      expect(mockApi.workspace.scan).toHaveBeenCalledWith('ws_1');
    });
  });

  it('top-priority action buttons copy cleanup command and open terminal', async () => {
    const user = userEvent.setup();
    const clipboardSpy = jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined as never);
    render(<WorkspaceBrowserView />);
    await user.click(await screen.findByTestId('workspace-tab-storage'));
    await waitFor(() => {
      expect(screen.getByTestId('top-priority-action-copy-0')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('top-priority-action-copy-0'));
    expect(clipboardSpy).toHaveBeenCalledWith(
      expect.stringContaining("rm -rf")
    );
    expect(clipboardSpy).toHaveBeenCalledWith(
      expect.stringContaining("/Users/me/work/zed/.venv")
    );
    expect(clipboardSpy).toHaveBeenCalledWith(
      expect.stringContaining("/Users/me/worktrees/zed-feature-cleanup")
    );

    await user.click(screen.getByTestId('top-priority-action-terminal-0'));
    expect(mockApi.shell.openTerminal).toHaveBeenCalledWith('/Users/me/work/zed');
    clipboardSpy.mockRestore();
  });

  it('abandoned-worktree action buttons copy commands and trigger cleanup APIs', async () => {
    const user = userEvent.setup();
    const clipboardSpy = jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined as never);
    render(<WorkspaceBrowserView />);
    await user.click(await screen.findByTestId('workspace-tab-storage'));
    await waitFor(() => {
      expect(screen.getByTestId('abandoned-worktree-clean-0')).toBeInTheDocument();
      expect(screen.getByTestId('abandoned-worktree-clean-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('abandoned-worktree-copy-0'));
    expect(clipboardSpy).toHaveBeenCalledWith(
      "git -C '/Users/me/work/alpha' worktree prune"
    );

    await user.click(screen.getByTestId('abandoned-worktree-copy-1'));
    expect(clipboardSpy).toHaveBeenCalledWith(
      "git -C '/Users/me/work/zed' worktree remove --force '/Users/me/worktrees/zed-feature-cleanup' && git -C '/Users/me/work/zed' worktree prune"
    );

    await user.click(screen.getByTestId('abandoned-worktree-clean-0'));
    expect(mockApi.cleanup.execute).toHaveBeenNthCalledWith(1,
      {
        repoPath: '/Users/me/work/alpha',
        worktreesToRemove: [
          { path: '/Users/me/worktrees/alpha-missing-cleanup', branch: 'feature/missing-cleanup' },
        ],
        branchesToDelete: [],
        branchesToMerge: [],
      },
      {
        removeWorktrees: true,
        deleteMergedBranches: false,
        mergeCompletedBranches: false,
        deleteRemoteBranches: false,
      }
    );

    await user.click(screen.getByTestId('abandoned-worktree-clean-1'));
    expect(mockApi.cleanup.execute).toHaveBeenNthCalledWith(2,
      {
        repoPath: '/Users/me/work/zed',
        worktreesToRemove: [
          { path: '/Users/me/worktrees/zed-feature-cleanup', branch: 'feature/cleanup' },
        ],
        branchesToDelete: [],
        branchesToMerge: [],
      },
      {
        removeWorktrees: true,
        deleteMergedBranches: false,
        mergeCompletedBranches: false,
        deleteRemoteBranches: false,
      }
    );
    clipboardSpy.mockRestore();
  });

  it('workflow queue primary cleanup action runs and hides item after success', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await user.click(await screen.findByTestId('workspace-tab-workflow'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-queue-primary-0')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-queue-item-0')).toHaveTextContent(/Prune missing worktree refs/i);
    });

    await user.click(screen.getByTestId('workflow-queue-primary-0'));
    await waitFor(() => {
      expect(mockApi.cleanup.execute).toHaveBeenCalledWith(
        {
          repoPath: '/Users/me/work/alpha',
          worktreesToRemove: [
            { path: '/Users/me/worktrees/alpha-missing-cleanup', branch: 'feature/missing-cleanup' },
          ],
          branchesToDelete: [],
          branchesToMerge: [],
        },
        {
          removeWorktrees: true,
          deleteMergedBranches: false,
          mergeCompletedBranches: false,
          deleteRemoteBranches: false,
        }
      );
      expect(screen.queryByText(/Prune missing worktree refs/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('workflow-queue-reset')).toHaveTextContent(/Show hidden \(1\)/i);
    });
  });

  it('workflow queue stores snooze state and reset restores hidden items', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await user.click(await screen.findByTestId('workspace-tab-workflow'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-queue-snooze-0')).toBeInTheDocument();
      expect(screen.getByText(/Prune missing worktree refs/i)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('workflow-queue-snooze-0'));
    await waitFor(() => {
      expect(screen.queryByText(/Prune missing worktree refs/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('workflow-queue-reset')).toHaveTextContent(/Show hidden \(1\)/i);
    });

    const persistedSnooze = JSON.parse(window.localStorage.getItem('kanvas.workspace.workflow-dashboard.v1') ?? '{}');
    expect(persistedSnooze.snoozedUntilByItemId?.['cleanup:missing-path-refs']).toBeTruthy();

    await user.click(screen.getByTestId('workflow-queue-reset'));
    await waitFor(() => {
      expect(screen.getByText(/Prune missing worktree refs/i)).toBeInTheDocument();
    });

    const persistedAfterReset = JSON.parse(window.localStorage.getItem('kanvas.workspace.workflow-dashboard.v1') ?? '{}');
    expect(persistedAfterReset.dismissedItemIds).toEqual([]);
    expect(persistedAfterReset.snoozedUntilByItemId).toEqual({});
  });

  it('workflow queue displays action-level error when cleanup fails', async () => {
    const user = userEvent.setup();
    (mockApi.cleanup.execute as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { message: 'cleanup failed' },
    } as never);
    render(<WorkspaceBrowserView />);
    await user.click(await screen.findByTestId('workspace-tab-workflow'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-queue-primary-0')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('workflow-queue-primary-0'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-queue-error-0')).toHaveTextContent(/cleanup failed/i);
    });
  });
});

describe('WorkspaceBrowserView — sort + filter', () => {
  it('sorts repos last-touched first by default', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    // alpha was discovered 5 min ago, zed 60 min ago → alpha is newer
    const rows = screen.getAllByTestId('repo-list-row');
    expect(within(rows[0]).getByText('alpha')).toBeInTheDocument();
    expect(within(rows[1]).getByText('zed')).toBeInTheDocument();
  });

  it('switching sort to priority places highest risk repo first', async () => {
    (mockApi.git.getRepoStatus as jest.Mock).mockImplementation(async (repoPath: string) => {
      if (repoPath.endsWith('/zed')) {
        return {
          success: true,
          data: {
            repoPath,
            currentBranch: 'main',
            ahead: 0,
            behind: 3,
            modifiedCount: 4,
            stagedCount: 1,
            untrackedCount: 2,
            unmergedCount: 1,
            stashCount: 0,
            worktreeCount: 1,
            fetchedAt: '2026-05-04T00:00:00.000Z',
          },
        };
      }
      return {
        success: true,
        data: {
          repoPath,
          currentBranch: 'main',
          ahead: 0,
          behind: 0,
          modifiedCount: 0,
          stagedCount: 0,
          untrackedCount: 0,
          unmergedCount: 0,
          stashCount: 0,
          worktreeCount: 1,
          fetchedAt: '2026-05-04T00:00:00.000Z',
        },
      };
    });

    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    await user.selectOptions(screen.getByTestId('sort-select'), 'priority');
    await waitFor(() => {
      const rows = screen.getAllByTestId('repo-list-row');
      expect(within(rows[0]).getByText('zed')).toBeInTheDocument();
      expect(within(rows[0]).getByTestId('repo-row-priority-badge')).toHaveTextContent(/Critical/i);
      expect(within(rows[0]).getByTestId('repo-row-risk')).toHaveTextContent(/Risk 20/i);
    });
  });

  it('switching sort to alphabetical reorders A→Z', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    await user.selectOptions(screen.getByTestId('sort-select'), 'alphabetical');
    const rows = screen.getAllByTestId('repo-list-row');
    expect(within(rows[0]).getByText('alpha')).toBeInTheDocument();
    expect(within(rows[1]).getByText('zed')).toBeInTheDocument();
  });

  it('filters by name substring', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    await user.type(screen.getByTestId('repo-filter'), 'alp');
    await waitFor(() => {
      expect(screen.getAllByTestId('repo-list-row')).toHaveLength(1);
    });
  });

  it('shows a "no matches" message when filter excludes everything', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    await user.type(screen.getByTestId('repo-filter'), 'no-such-repo');
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-no-repos')).toHaveTextContent(/match your filter/);
    });
  });
});

describe('WorkspaceBrowserView — per-repo status fetch', () => {
  it('shows worktree mode and active session count in list rows', async () => {
    (mockApi.repoWorkspace.getWorktreeMode as jest.Mock).mockResolvedValue({
      success: true,
      data: 'in-place',
    } as never);
    (mockApi.repoWorkspace.getActiveSessionCount as jest.Mock).mockResolvedValue({
      success: true,
      data: 1,
    } as never);
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getAllByTestId('repo-row-sessions')).toHaveLength(2);
      expect(screen.getAllByText(/In-place mode/i)).toHaveLength(2);
    });
  });
});

describe('WorkspaceBrowserView — recent-repos fallback (Day 1.5 polish)', () => {
  beforeEach(() => {
    // Override default: no workspaces, but recent repos exist
    (mockApi.workspace.list as jest.Mock).mockResolvedValue({ success: true, data: [] } as never);
    (mockApi.workspace.getActive as jest.Mock).mockResolvedValue({ success: true, data: null } as never);
    (mockApi.instance.getRecentRepos as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { path: '/Users/me/work/kora', name: 'kora', lastUsed: new Date(Date.now() - 60_000).toISOString() },
        { path: '/Users/me/work/kanvas', name: 'kanvas', lastUsed: new Date().toISOString() },
      ],
    } as never);
  });

  it('renders repo rows from recentRepos when no workspace is configured', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      const list = screen.getByTestId('repo-list');
      expect(within(list).getAllByTestId('repo-list-row')).toHaveLength(2);
    });
    // The dedicated empty state is suppressed in favor of the fallback banner
    expect(screen.queryByTestId('empty-state-no-workspace')).toBeNull();
    expect(screen.getByTestId('recent-repos-banner')).toBeInTheDocument();
  });

  it('shows a pin-parent CTA targeting the common parent path', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('recent-repos-banner'));
    const pin = screen.getByTestId('pin-parent-button');
    expect(pin).toHaveTextContent('Pin /Users/me/work as workspace');
  });

  it('clicking pin-parent calls workspace.add with the common parent', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('pin-parent-button'));
    await user.click(screen.getByTestId('pin-parent-button'));
    await waitFor(() => {
      expect(mockApi.workspace.add).toHaveBeenCalledWith({ path: '/Users/me/work' });
    });
  });

  it('falls through to no-workspaces empty state when there are also no recent repos', async () => {
    (mockApi.instance.getRecentRepos as jest.Mock).mockResolvedValue({
      success: true,
      data: [],
    } as never);
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-no-workspace')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recent-repos-banner')).toBeNull();
  });
});

describe('WorkspaceBrowserView — switching workspaces', () => {
  it('changing the active workspace persists via setActive and re-scans', async () => {
    (mockApi.workspace.list as jest.Mock).mockResolvedValue({
      success: true,
      data: [mkWorkspace('ws_1', 'work'), mkWorkspace('ws_2', 'personal')],
    } as never);
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-list'));
    (mockApi.workspace.scan as jest.Mock).mockClear();
    (mockApi.workspace.setActive as jest.Mock).mockClear();

    await user.selectOptions(screen.getByTestId('workspace-switcher'), 'ws_2');
    await waitFor(() => {
      expect(mockApi.workspace.setActive).toHaveBeenCalledWith('ws_2');
      expect(mockApi.workspace.scan).toHaveBeenCalledWith('ws_2');
    });
  });
});

describe('WorkspaceBrowserView — workspace management controls', () => {
  it('stays compact by default and expands controls when requested', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-manager-panel')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-manager-collapsed-summary')).toBeInTheDocument();
      expect(screen.queryByTestId('workspace-manager-list')).toBeNull();
      expect(screen.getByTestId('workspace-manager-toggle')).toHaveTextContent(/Manage/i);
      expect(screen.getByTestId('add-workspace-button')).toHaveTextContent(/\+ Add local folder/i);
    });
    await user.click(screen.getByTestId('workspace-manager-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-manager-list')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-manager-toggle')).toHaveTextContent(/Done/i);
      expect(screen.getByText(/Add any local folder \(repo root or parent folder\)/i)).toBeInTheDocument();
    });
  });

  it('switch button in workspace manager updates active workspace and re-scans', async () => {
    (mockApi.workspace.list as jest.Mock).mockResolvedValue({
      success: true,
      data: [mkWorkspace('ws_1', 'work'), mkWorkspace('ws_2', 'personal')],
    } as never);
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-manager-toggle')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('workspace-manager-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-manager-switch-ws_2')).toBeInTheDocument();
    });
    (mockApi.workspace.scan as jest.Mock).mockClear();
    (mockApi.workspace.setActive as jest.Mock).mockClear();

    await user.click(screen.getByTestId('workspace-manager-switch-ws_2'));
    await waitFor(() => {
      expect(mockApi.workspace.setActive).toHaveBeenCalledWith('ws_2');
      expect(mockApi.workspace.scan).toHaveBeenCalledWith('ws_2');
    });
  });

  it('delete button removes workspace and refreshes workspace list', async () => {
    (mockApi.workspace.list as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [mkWorkspace('ws_1', 'work'), mkWorkspace('ws_2', 'personal')],
      } as never)
      .mockResolvedValueOnce({
        success: true,
        data: [mkWorkspace('ws_1', 'work')],
      } as never);
    (mockApi.workspace.getActive as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: mkWorkspace('ws_1', 'work'),
      } as never)
      .mockResolvedValueOnce({
        success: true,
        data: mkWorkspace('ws_1', 'work'),
      } as never);

    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-manager-toggle')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('workspace-manager-toggle'));
    await waitFor(() => {
      expect(screen.getAllByTestId('workspace-manager-row')).toHaveLength(2);
    });

    await user.click(screen.getByTestId('workspace-manager-remove-ws_2'));
    await waitFor(() => {
      expect(mockApi.workspace.remove).toHaveBeenCalledWith('ws_2');
      expect(screen.getAllByTestId('workspace-manager-row')).toHaveLength(1);
      expect(screen.queryByTestId('workspace-manager-remove-ws_2')).not.toBeInTheDocument();
    });
  });
});
