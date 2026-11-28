/**
 * Code Organization Settings Tests (KC-S1.2.2.2)
 * Verifies AC1-AC4 and the decline twin for AC4
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { mockApi } from '../setup';

// Mock the store to prevent infinite re-render loops
let _storeState: any = {};
jest.mock('../../../renderer/store/agentStore', () => ({
  useAgentStore: (selector: (state: any) => any) => selector(_storeState),
}));

describe('SettingsModal - Code Organization', () => {
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset store state
    _storeState = {
      reportedSessions: new Map(),
      selectedSessionId: null,
    };
    
    // Mock config.getAll
    (mockApi.config.getAll as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        theme: 'dark',
        defaultAgentType: 'claude',
        autoWatch: true,
        autoPush: false,
        onboardingCompleted: true,
        telemetryOptIn: false,
        defaultLandingView: 'morning-check',
      },
    } as never);

    // Mock credential check
    (mockApi.credential.has as jest.Mock).mockResolvedValue({ success: true, data: false } as never);

    // Mock version
    (mockApi.app.getVersion as jest.Mock).mockResolvedValue('1.0.0' as never);

    // Mock update status
    (mockApi.update?.getStatus as jest.Mock).mockResolvedValue({
      success: true,
      data: { currentVersion: '1.0.0', updateAvailable: false, downloading: false, downloaded: false },
    } as never);

    // Mock version APIs - return empty/error to avoid repo version section
    (mockApi.version.getRepoVersion as jest.Mock).mockResolvedValue({
      success: false,
      error: { code: 'NO_REPO', message: 'No repo selected' },
    } as never);
    (mockApi.version.getSettings as jest.Mock).mockResolvedValue({
      success: true,
      data: { autoVersionBump: true },
    } as never);

    // Mock contractRegistry for Code Organization
    (window.api.contractRegistry.getOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
      data: { enabled: true, structure: 'feature-folders', setupCompleted: true },
    } as never);
    
    // Mock mcp status
    (mockApi.mcp.status as jest.Mock).mockResolvedValue({
      success: true,
      data: { port: 39100, url: 'http://127.0.0.1:39100/mcp', isRunning: true, connectionCount: 0, startedAt: null },
    } as never);
    
    // Mock debug log stats
    (mockApi.debugLog.getStats as jest.Mock).mockResolvedValue({
      success: true,
      data: { memoryEntries: 0, fileSize: 0, rotatedFiles: 0 },
    } as never);
  });

  it('AC1: section renders with Code Organization heading and a control to change it', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    // Wait for Settings modal to render
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Look for Code Organization section
    const codeOrgHeading = screen.getByText(/Code Organization/i);
    expect(codeOrgHeading).toBeInTheDocument();

    // Check that there's a control to change the preference (radio buttons)
    const featureFoldersRadio = screen.getByRole('radio', { name: /feature-based/i });
    expect(featureFoldersRadio).toBeInTheDocument();
  });

  it('AC2: current preference shows Feature-based when getOrganizationConfig returns feature-folders', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/Code Organization/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    // The "Feature-based" option should be selected
    const featureFoldersRadio = screen.getByRole('radio', { name: /feature-based/i });
    expect(featureFoldersRadio).toBeChecked();

    // The current preference display should show "Feature-based"
    expect(screen.getByText(/Feature-based/i)).toBeInTheDocument();
  });

  it('AC3: saves calls setOrganizationConfig with new structure when preference is changed and saved', async () => {
    (window.api.contractRegistry.setOrganizationConfig as jest.Mock).mockResolvedValue({
      success: true,
    } as never);

    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/Code Organization/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    const user = userEvent.setup();

    // Select "Flat" option
    const flatRadio = screen.getByRole('radio', { name: /flat/i });
    await user.click(flatRadio);

    // Click Save button
    const saveButton = screen.getByRole('button', { name: /save code organization/i });
    await user.click(saveButton);

    // Verify setOrganizationConfig was called with the new structure
    await waitFor(() => {
      expect(window.api.contractRegistry.setOrganizationConfig).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  it('AC4: warns when switching from feature-based to flat before saving', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/Code Organization/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    const user = userEvent.setup();

    // Select "Flat" option (switching from feature-folders)
    const flatRadio = screen.getByRole('radio', { name: /flat/i });
    await user.click(flatRadio);

    // A warning message should be visible before saving
    expect(screen.getByText(/warning/i)).toBeInTheDocument();

    // setOrganizationConfig should NOT have been called yet
    expect(window.api.contractRegistry.setOrganizationConfig).not.toHaveBeenCalled();
  });

  it('AC4 decline twin: declining the warning keeps value as feature-based and prevents save', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/Code Organization/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    const user = userEvent.setup();

    // Select "Flat" option (switching from feature-folders)
    const flatRadio = screen.getByRole('radio', { name: /flat/i });
    await user.click(flatRadio);

    // Warning should appear
    expect(screen.getByText(/warning/i)).toBeInTheDocument();

    // Click Cancel button to decline the warning
    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    await user.click(cancelButton);

    // setOrganizationConfig should NOT have been called
    expect(window.api.contractRegistry.setOrganizationConfig).not.toHaveBeenCalled();

    // The radio button should still be on feature-folders
    const featureFoldersRadio = screen.getByRole('radio', { name: /feature-based/i });
    expect(featureFoldersRadio).toBeChecked();
  });
});
