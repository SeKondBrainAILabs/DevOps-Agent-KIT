/**
 * Settings Code Organization Settings Tests
 * Tests for the Code Organization settings section in SettingsModal
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockApi } from '../setup';

// Import the actual component under test
import { CodeOrganizationSettings } from '../../../renderer/components/features/coding/CodeOrganizationSettings';

describe('Settings Code Organization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('section', async () => {
    // AC1: Settings shows a Code Organization section with the repository's
    // current preference and a control to change it
    // Mock API to return a valid config
    (mockApi.contractRegistry?.getOrganizationConfig as jest.Mock)
      .mockResolvedValue({
        success: true,
        data: { enabled: true, structure: 'feature-folders', setupCompleted: true },
      });

    render(<CodeOrganizationSettings repoPath="/test/repo" />);

    // Verify the heading is present
    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });
    // Verify the current preference is shown
    expect(screen.getByTestId('current-preference')).toBeInTheDocument();
    // Verify there is a control to change it
    expect(screen.getByTestId('org-structure-select')).toBeInTheDocument();
  });

  it('current preference', async () => {
    // AC2: With getOrganizationConfig returning {enabled: true, structure: 'feature-folders'}
    // the section shows "Feature-based"
    (mockApi.contractRegistry?.getOrganizationConfig as jest.Mock)
      .mockResolvedValue({
        success: true,
        data: { enabled: true, structure: 'feature-folders', setupCompleted: true },
      });

    render(<CodeOrganizationSettings repoPath="/test/repo" />);

    // Wait for the component to load the config
    await waitFor(() => {
      expect(screen.getByTestId('current-preference')).toBeInTheDocument();
    });

    // When structure is 'feature-folders', display should show "Feature-based"
    expect(screen.getByTestId('current-preference')).toHaveTextContent('Feature-based');
  });

  it('saves', async () => {
    // AC3: Changing the preference and saving calls setOrganizationConfig with the new structure
    (mockApi.contractRegistry?.getOrganizationConfig as jest.Mock)
      .mockResolvedValue({
        success: true,
        data: {
          enabled: true,
          structure: 'feature-folders',
          setupCompleted: true,
          setupCompletedAt: '2024-01-01T00:00:00.000Z',
        },
      });
    const mockSetOrgConfig = jest.fn().mockResolvedValue({ success: true });
    (mockApi.contractRegistry?.setOrganizationConfig as jest.Mock)
      .mockImplementation(mockSetOrgConfig);

    render(<CodeOrganizationSettings repoPath="/test/repo" />);

    // Wait for the component to load
    await waitFor(() => {
      expect(screen.getByTestId('org-structure-select')).toBeInTheDocument();
    });

    // Change the preference to flat - this triggers the warning dialog
    const select = screen.getByTestId('org-structure-select');
    fireEvent.change(select, { target: { value: 'flat' } });

    // Wait for warning dialog to appear
    await waitFor(() => {
      expect(screen.getByTestId('warning-dialog')).toBeInTheDocument();
    });

    // Click "Confirm Change" to proceed with the change
    const confirmButton = screen.getByTestId('confirm-change');
    fireEvent.click(confirmButton);

    // Wait for the select value to update
    await waitFor(() => {
      expect(select).toHaveValue('flat');
    });

    // Wait for the save button to be enabled
    const saveButton = await screen.findByTestId('save-button');
    expect(saveButton).not.toBeDisabled();

    // Click save button
    fireEvent.click(saveButton);

    // Wait for the API call to be made
    await waitFor(() => {
      expect(mockSetOrgConfig).toHaveBeenCalled();
    });

    // Verify setOrganizationConfig was called with the exact payload:
    // structure 'flat', enabled false, setupCompleted true, and setupCompletedAt preserved
    expect(mockSetOrgConfig).toHaveBeenCalledWith(
      '/test/repo',
      expect.objectContaining({
        structure: 'flat',
        enabled: false,
        setupCompleted: true,
        setupCompletedAt: '2024-01-01T00:00:00.000Z',
      })
    );
  });

  it('warns', async () => {
    // AC4: Switching from feature-based to flat shows a warning before anything is saved
    (mockApi.contractRegistry?.getOrganizationConfig as jest.Mock)
      .mockResolvedValue({
        success: true,
        data: { enabled: true, structure: 'feature-folders', setupCompleted: true },
      });
    const mockSetOrgConfig = jest.fn().mockResolvedValue({ success: true });
    (mockApi.contractRegistry?.setOrganizationConfig as jest.Mock)
      .mockImplementation(mockSetOrgConfig);

    render(<CodeOrganizationSettings repoPath="/test/repo" />);

    // Wait for the component to load
    await waitFor(() => {
      expect(screen.getByTestId('org-structure-select')).toBeInTheDocument();
    });

    // Change to flat - this should trigger the warning modal
    const select = screen.getByTestId('org-structure-select');
    fireEvent.change(select, { target: { value: 'flat' } });

    // Verify warning dialog is shown before saving
    await waitFor(() => {
      expect(screen.getByTestId('warning-dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    // Confirm and cancel buttons should be present
    expect(screen.getByTestId('confirm-change')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-change')).toBeInTheDocument();

    // Assert that setOrganizationConfig was NOT called when the dialog appears
    expect(mockSetOrgConfig).not.toHaveBeenCalled();

    // Click Cancel to dismiss the dialog
    const cancelButton = screen.getByTestId('cancel-change');
    fireEvent.click(cancelButton);

    // Wait for dialog to be dismissed
    await waitFor(() => {
      expect(screen.queryByTestId('warning-dialog')).not.toBeInTheDocument();
    });

    // After Cancel, assert the select shows 'feature-folders' again
    expect(select).toHaveValue('feature-folders');

    // Still no save after canceling
    expect(mockSetOrgConfig).not.toHaveBeenCalled();
  });
});
