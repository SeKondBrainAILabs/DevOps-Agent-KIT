/**
 * Component Tests for AddWorkspaceDialog (Epic A / story A4–A5 — MVP)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddWorkspaceDialog } from '../../../renderer/components/features/AddWorkspaceDialog';
import { mockApi } from '../setup';

describe('AddWorkspaceDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockApi.workspace.add as jest.Mock).mockResolvedValue({
      success: true,
      data: { id: 'ws_1', name: 'work', path: '/Users/me/work', scanDepth: 2, ignoreGlobs: [], createdAt: '' },
    } as never);
    (mockApi.dialog.openDirectory as jest.Mock).mockResolvedValue({
      success: true,
      data: '/Users/me/work',
    } as never);
  });

  it('returns null when not open', () => {
    const { container } = render(
      <AddWorkspaceDialog open={false} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders form fields with defaults when open', () => {
    render(<AddWorkspaceDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId('add-workspace-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-path-input')).toHaveValue('');
    expect(screen.getByTestId('scan-depth-input')).toHaveValue(2);
    expect(screen.getByTestId('ignore-globs-input')).toHaveValue(
      'node_modules, .git, .worktrees, dist, build'
    );
  });

  it('Browse button calls dialog.openDirectory and fills the path field', async () => {
    const user = userEvent.setup();
    render(<AddWorkspaceDialog open={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('browse-button'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-path-input')).toHaveValue('/Users/me/work');
    });
    expect(mockApi.dialog.openDirectory).toHaveBeenCalled();
  });

  it('blocks submit when path is empty', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<AddWorkspaceDialog open={true} onClose={onClose} />);
    await user.click(screen.getByTestId('submit-button'));
    expect(screen.getByTestId('add-workspace-error')).toHaveTextContent(/pick a folder/i);
    expect(mockApi.workspace.add).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits with the trimmed path + name + parsed ignore globs', async () => {
    const user = userEvent.setup();
    const onAdded = jest.fn();
    const onClose = jest.fn();
    render(
      <AddWorkspaceDialog open={true} onClose={onClose} onAdded={onAdded} />
    );
    await user.type(screen.getByTestId('workspace-path-input'), '   /Users/me/work   ');
    await user.type(screen.getByTestId('workspace-name-input'), 'My Work');
    await user.clear(screen.getByTestId('ignore-globs-input'));
    await user.type(screen.getByTestId('ignore-globs-input'), 'node_modules, dist');
    await user.click(screen.getByTestId('submit-button'));
    await waitFor(() => {
      expect(mockApi.workspace.add).toHaveBeenCalledWith({
        path: '/Users/me/work',
        name: 'My Work',
        scanDepth: 2,
        ignoreGlobs: ['node_modules', 'dist'],
      });
    });
    expect(onAdded).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('omits name when blank (so the service uses basename default)', async () => {
    const user = userEvent.setup();
    render(<AddWorkspaceDialog open={true} onClose={() => {}} />);
    await user.type(screen.getByTestId('workspace-path-input'), '/Users/me/work');
    await user.click(screen.getByTestId('submit-button'));
    await waitFor(() => {
      expect(mockApi.workspace.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: undefined })
      );
    });
  });

  it('surfaces backend errors instead of closing the dialog', async () => {
    (mockApi.workspace.add as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: { code: 'WORKSPACE_DUPLICATE_PATH', message: 'A workspace already exists for "/Users/me/work".' },
    } as never);
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<AddWorkspaceDialog open={true} onClose={onClose} />);
    await user.type(screen.getByTestId('workspace-path-input'), '/Users/me/work');
    await user.click(screen.getByTestId('submit-button'));
    await waitFor(() => {
      expect(screen.getByTestId('add-workspace-error')).toHaveTextContent(
        /already exists/
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<AddWorkspaceDialog open={true} onClose={onClose} />);
    await user.click(screen.getByTestId('cancel-button'));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables submit + cancel while a request is in flight, re-enables after', async () => {
    let resolveAdd: (v: unknown) => void = () => {};
    (mockApi.workspace.add as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { resolveAdd = resolve; })
    );
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<AddWorkspaceDialog open={true} onClose={onClose} />);
    await user.type(screen.getByTestId('workspace-path-input'), '/x');
    await user.click(screen.getByTestId('submit-button'));

    // While in-flight, both buttons disabled and label shows "Adding…"
    expect(screen.getByTestId('submit-button')).toBeDisabled();
    expect(screen.getByTestId('cancel-button')).toBeDisabled();
    expect(screen.getByTestId('submit-button')).toHaveTextContent(/Adding/);

    // Resolve the in-flight promise
    resolveAdd({ success: true, data: { id: 'ws_x' } });

    // After success, onClose is called (parent would unmount the dialog)
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
