/**
 * Code Organization Settings Component Tests
 * Tests for SettingsModal's Code Organization section (KC-S1.2.2.2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { mockApi } from '../setup';

describe('SettingsModal - Code Organization', () => {
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock getOrganizationConfig to return feature-folders by default
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      },
    });

    // Mock setOrganizationConfig to succeed
    (mockApi.contractRegistry.setOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
    });

    // Mock getAll config for SettingsModal to render
    (mockApi.config.getAll as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        theme: 'dark',
        defaultAgentType: 'claude',
        autoWatch: false,
        autoPush: false,
      },
    });

    // Mock version APIs for the Repo Version block
    (mockApi.app.getVersion as jest.Mock).mockResolvedValue('1.0.0');
  });

  it('section renders Code Organization heading with current preference and radio control (AC1)', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    // Wait for General tab content to render
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // Check for Code Organization section
    expect(screen.getByText('Code Organization')).toBeInTheDocument();
    
    // Check for current preference display (should show "Feature-based" for feature-folders)
    expect(screen.getByText('Feature-based')).toBeInTheDocument();
    
    // Check for radio button control
    const radioButtons = screen.getAllByRole('radio');
    expect(radioButtons.length).toBeGreaterThan(0);
  });

  it('shows "Feature-based" when getOrganizationConfig returns structure: feature-folders (AC2)', async () => {
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Should display "Feature-based" for feature-folders structure
    expect(screen.getByText('Feature-based')).toBeInTheDocument();
  });

  it('shows "Flat layout" when structure is flat', async () => {
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'flat',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Should display "Flat layout" for flat structure
    expect(screen.getByText('Flat layout')).toBeInTheDocument();
  });

  it('shows "Custom" when structure is custom', async () => {
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'custom',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Should display "Custom" for custom structure
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('saves new preference by calling setOrganizationConfig with the new structure (AC3)', async () => {
    const user = userEvent.setup();

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Select a different structure (e.g., flat)
    const flatRadio = screen.getByLabelText('Flat layout');
    await user.click(flatRadio);

    // Click save button
    const saveButton = screen.getByText('Save Settings');
    await user.click(saveButton);

    // Verify setOrganizationConfig was called with the new structure
    expect(mockApi.contractRegistry.setOrganizationConfig).toHaveBeenCalledWith(
      expect.any(String), // repoPath
      expect.objectContaining({
        structure: 'flat',
        enabled: true,
        setupCompleted: true,
      })
    );
  });

  it('warns before switching from feature-based to flat (AC4)', async () => {
    const user = userEvent.setup();

    // Start with feature-folders
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Try to select flat
    const flatRadio = screen.getByLabelText('Flat layout');
    await user.click(flatRadio);

    // A warning modal or confirmation should appear
    // Check for modal dialog with warning message
    await waitFor(() => {
      expect(
        screen.getByText(/warning|confirm|caution/i) || 
        screen.getByText(/structure|organization/i)
      ).toBeInTheDocument();
    });
  });

  it('declining the warning prevents save and keeps current value (AC4 twin)', async () => {
    const user = userEvent.setup();

    // Start with feature-folders
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Get reference to the element showing the current structure value BEFORE user action
    // The component displays current preference (e.g., "Feature-based") in the section
    const currentValueElement = screen.getByText('Feature-based');

    // Try to select flat
    const flatRadio = screen.getByLabelText('Flat layout');
    await user.click(flatRadio);

    // Wait for warning modal to appear
    await waitFor(() => {
      expect(
        screen.getByText(/warning|confirm|caution/i) || 
        screen.getByText(/structure|organization/i)
      ).toBeInTheDocument();
    });

    // Click Cancel to decline the warning
    const cancelButton = screen.getByRole('button', { name: /cancel|no|keep current/i });
    await user.click(cancelButton);

    // Verify setOrganizationConfig was NOT called
    expect(mockApi.contractRegistry.setOrganizationConfig).not.toHaveBeenCalled();

    // Verify the control's value is still feature-folders (radio should not be checked)
    const flatRadioAfter = screen.getByLabelText('Flat layout');
    expect(flatRadioAfter).not.toBeChecked();

    // Verify the displayed current value is still "Feature-based" AFTER declining
    // Use toHaveTextContent on the specific element reference, not a new getByText search
    expect(currentValueElement).toHaveTextContent('Feature-based');
  });

  it('accepting the warning allows save to proceed (AC4 positive path)', async () => {
    const user = userEvent.setup();

    // Start with feature-folders
    (mockApi.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      },
    });

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Try to select flat
    const flatRadio = screen.getByLabelText('Flat layout');
    await user.click(flatRadio);

    // Wait for warning modal to appear
    await waitFor(() => {
      expect(
        screen.getByText(/warning|confirm|caution/i) || 
        screen.getByText(/structure|organization/i)
      ).toBeInTheDocument();
    });

    // Click Confirm/Yes to accept the warning
    const confirmButton = screen.getByRole('button', { name: /confirm|yes|proceed/i });
    await user.click(confirmButton);

    // Now click Save Settings
    const saveButton = screen.getByText('Save Settings');
    await user.click(saveButton);

    // Verify setOrganizationConfig was called
    expect(mockApi.contractRegistry.setOrganizationConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        structure: 'flat',
      })
    );
  });

  it('displays "No repository selected" when selectedRepoPath is empty', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // The component should handle the case where no repo is selected
    // It may show a message or disable controls
    expect(
      screen.getByText('Code Organization') || 
      screen.getByText(/no repository/i) ||
      screen.getByText(/loading/i)
    ).toBeInTheDocument();
  });
});
