/**
 * KC-S1.2.2.2: Code Organization settings in SettingsModal
 * Tests for the Code Organization tab that allows users to change repository
 * code-organization preferences via Settings.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { useAgentStore } from '../../../renderer/store/agentStore';

// Helper to mock the organization config API
function installOrganizationApi(
  initialConfig: { enabled: boolean; structure: 'feature-folders' | 'flat' | 'custom'; setupCompleted: boolean } = {
    enabled: true,
    structure: 'feature-folders',
    setupCompleted: true,
  }
) {
  let storedConfig = initialConfig;
  const contractRegistry = {
    getOrganizationConfig: jest.fn(async (_repoPath: string) => ({ success: true, data: storedConfig })),
    setOrganizationConfig: jest.fn(async (_repoPath: string, config: typeof storedConfig) => {
      storedConfig = config;
      return { success: true };
    }),
  };
  // Extend existing api mock with contractRegistry
  (window as any).api.contractRegistry = contractRegistry;
  return contractRegistry;
}

// The Code Organization section only loads once a repository is selected.
// SettingsModal derives that repo from the agent store's reported sessions,
// so seed one session pointing at /test/repo before rendering.
function seedSelectedRepo(repoPath = '/test/repo') {
  useAgentStore.setState({
    reportedSessions: new Map([
      [
        'test-session',
        {
          sessionId: 'test-session',
          agentId: 'agent-1',
          agentType: 'claude',
          task: 'test task',
          branchName: 'test-branch',
          baseBranch: 'main',
          repoPath,
          status: 'active',
        } as any,
      ],
    ]),
    selectedSessionId: 'test-session',
  });
}

// The structure label appears both as the current-preference display and as an
// <option> in the change control, so match the display element (a div) rather
// than the option.
function currentPreferenceText(pattern: RegExp): HTMLElement {
  const matches = screen
    .getAllByText(pattern)
    .filter((el) => el.tagName.toLowerCase() !== 'option');
  if (matches.length === 0) {
    throw new Error(`No current-preference element matched ${pattern}`);
  }
  return matches[0];
}

describe('SettingsModal Code Organization tab (KC-S1.2.2.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the agent store so each test starts with no reported sessions.
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });
  });

  // AC1: Settings shows a Code Organization section with the repository's current preference and a control to change it
  describe('AC1 - section', () => {
    it('shows a Code tab in the Settings modal navigation', async () => {
      installOrganizationApi();
      seedSelectedRepo();
      
      // Configure mocks for config, instance list, and app version
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      // Look for the Code tab button
      const codeTab = screen.getByRole('button', { name: /code/i });
      expect(codeTab).toBeInTheDocument();
    });

    it('shows the Code Organization section with current preference and control when code tab is active', async () => {
      const api = installOrganizationApi({
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      // Click on the Code tab
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      // Wait for the organization config to load
      await waitFor(() => {
        expect(api.getOrganizationConfig).toHaveBeenCalledWith('/test/repo');
      });
      
      // Check for Code Organization heading
      expect(screen.getByText(/code organization/i)).toBeInTheDocument();
      
      // Check for current preference display
      expect(currentPreferenceText(/feature-based/i)).toBeInTheDocument();
      
      // Check for a control to change it (dropdown/select)
      const structureSelect = screen.getByRole('combobox');
      expect(structureSelect).toBeInTheDocument();
    });
  });

  // AC2: With getOrganizationConfig returning {enabled: true, structure: 'feature-folders'} the section shows "Feature-based"
  describe('AC2 - current preference', () => {
    it('displays "Feature-based" when structure is feature-folders', async () => {
      installOrganizationApi({
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      await waitFor(() => {
        expect(currentPreferenceText(/feature-based/i)).toBeInTheDocument();
      });
    });

    it('displays "Flat" when structure is flat', async () => {
      installOrganizationApi({
        enabled: true,
        structure: 'flat',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      await waitFor(() => {
        expect(currentPreferenceText(/flat/i)).toBeInTheDocument();
      });
    });
  });

  // AC3: Changing the preference and saving calls setOrganizationConfig with the new structure
  describe('AC3 - saves', () => {
    it('calls setOrganizationConfig with the new structure when saving', async () => {
      const api = installOrganizationApi({
        enabled: true,
        structure: 'flat',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      await waitFor(() => {
        expect(currentPreferenceText(/flat/i)).toBeInTheDocument();
      });
      
      // Change to feature-folders - this is the save action; the preference is
      // persisted when the new structure is chosen. This transition does not
      // trigger the flat-warning, so the save goes straight through.
      const structureSelect = screen.getByRole('combobox');
      await userEvent.selectOptions(structureSelect, 'feature-folders');
      
      // Verify setOrganizationConfig was called with the new structure
      await waitFor(() => {
        expect(api.setOrganizationConfig).toHaveBeenCalledWith('/test/repo', expect.objectContaining({
          structure: 'feature-folders',
        }));
      });
    });
  });

  // AC4: Switching from feature-based to flat shows a warning before anything is saved
  describe('AC4 - warns', () => {
    it('shows a warning dialog when switching from feature-folders to flat', async () => {
      // Mock window.confirm to return false (user cancels)
      const originalConfirm = window.confirm;
      window.confirm = jest.fn().mockReturnValue(false);
      
      const api = installOrganizationApi({
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      await waitFor(() => {
        expect(currentPreferenceText(/feature-based/i)).toBeInTheDocument();
      });
      
      // Change to flat structure - should trigger warning dialog
      const structureSelect = screen.getByRole('combobox');
      await userEvent.selectOptions(structureSelect, 'flat');
      
      // Verify confirm was called (warning shown)
      expect(window.confirm).toHaveBeenCalled();
      
      // Verify setOrganizationConfig was NOT called since user cancelled
      expect(api.setOrganizationConfig).not.toHaveBeenCalled();
      
      // Restore original confirm
      window.confirm = originalConfirm;
    });

    it('proceeds with save when user confirms the warning', async () => {
      // Mock window.confirm to return true (user confirms)
      const originalConfirm = window.confirm;
      window.confirm = jest.fn().mockReturnValue(true);
      
      const api = installOrganizationApi({
        enabled: true,
        structure: 'feature-folders',
        setupCompleted: true,
      });
      seedSelectedRepo();
      
      (window as any).api.config.getAll.mockResolvedValue({
        success: true,
        data: { theme: 'dark', defaultAgentType: 'claude', autoWatch: false, autoPush: false },
      });
      (window as any).api.instance.list.mockResolvedValue({
        success: true,
        data: [{ id: 'test-session', repoPath: '/test/repo', status: 'running' }],
      });
      (window as any).api.app.getVersion.mockResolvedValue('1.0.0');

      render(<SettingsModal onClose={jest.fn()} />);
      
      const codeTab = screen.getByRole('button', { name: /code/i });
      await userEvent.click(codeTab);
      
      await waitFor(() => {
        expect(currentPreferenceText(/feature-based/i)).toBeInTheDocument();
      });
      
      // Change to flat structure - this is the save action; confirming the
      // warning persists the new structure.
      const structureSelect = screen.getByRole('combobox');
      await userEvent.selectOptions(structureSelect, 'flat');
      
      // Verify warning was shown
      expect(window.confirm).toHaveBeenCalled();
      
      // Verify setOrganizationConfig was called
      await waitFor(() => {
        expect(api.setOrganizationConfig).toHaveBeenCalledWith('/test/repo', expect.objectContaining({
          structure: 'flat',
        }));
      });
      
      // Restore original confirm
      window.confirm = originalConfirm;
    });
  });
});
