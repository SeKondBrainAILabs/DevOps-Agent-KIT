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
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      const switcher = screen.getByTestId('workspace-switcher');
      const options = within(switcher).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['work', 'personal']);
    });
  });

  it('renders a card for every discovered repo', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => {
      const grid = screen.getByTestId('repo-grid');
      expect(within(grid).getAllByTestId('repo-status-card')).toHaveLength(2);
    });
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
    await waitFor(() => screen.getByTestId('repo-grid'));
    (mockApi.workspace.scan as jest.Mock).mockClear();
    await user.click(screen.getByTestId('rescan-button'));
    await waitFor(() => {
      expect(mockApi.workspace.scan).toHaveBeenCalledWith('ws_1');
    });
  });
});

describe('WorkspaceBrowserView — sort + filter', () => {
  it('sorts repos last-touched first by default', async () => {
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-grid'));
    // alpha was discovered 5 min ago, zed 60 min ago → alpha is newer
    const cards = screen.getAllByTestId('repo-status-card');
    expect(within(cards[0]).getByText('alpha')).toBeInTheDocument();
    expect(within(cards[1]).getByText('zed')).toBeInTheDocument();
  });

  it('switching sort to alphabetical reorders A→Z', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-grid'));
    await user.selectOptions(screen.getByTestId('sort-select'), 'alphabetical');
    const cards = screen.getAllByTestId('repo-status-card');
    expect(within(cards[0]).getByText('alpha')).toBeInTheDocument();
    expect(within(cards[1]).getByText('zed')).toBeInTheDocument();
  });

  it('filters by name substring', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-grid'));
    await user.type(screen.getByTestId('repo-filter'), 'alp');
    await waitFor(() => {
      expect(screen.getAllByTestId('repo-status-card')).toHaveLength(1);
    });
  });

  it('shows a "no matches" message when filter excludes everything', async () => {
    const user = userEvent.setup();
    render(<WorkspaceBrowserView />);
    await waitFor(() => screen.getByTestId('repo-grid'));
    await user.type(screen.getByTestId('repo-filter'), 'no-such-repo');
    await waitFor(() => {
      expect(screen.getByTestId('empty-state-no-repos')).toHaveTextContent(/match your filter/);
    });
  });
});

describe('WorkspaceBrowserView — per-repo status fetch', () => {
  it('passes worktreeMode + activeSessionCount through to each card', async () => {
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
      // Single-session badge only renders when worktreeMode === 'in-place'
      expect(screen.getAllByTestId('single-session-badge')).toHaveLength(2);
      expect(screen.getAllByTestId('active-session-count')).toHaveLength(2);
    });
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
    await waitFor(() => screen.getByTestId('repo-grid'));
    (mockApi.workspace.scan as jest.Mock).mockClear();
    (mockApi.workspace.setActive as jest.Mock).mockClear();

    await user.selectOptions(screen.getByTestId('workspace-switcher'), 'ws_2');
    await waitFor(() => {
      expect(mockApi.workspace.setActive).toHaveBeenCalledWith('ws_2');
      expect(mockApi.workspace.scan).toHaveBeenCalledWith('ws_2');
    });
  });
});
