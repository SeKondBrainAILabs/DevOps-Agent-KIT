/**
 * SettingsModal Code Organization tests (KC-S1.2.2.2)
 * Tests the new Code Organization section in SettingsModal
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { useAgentStore } from '../../../renderer/store/agentStore';
import type { SessionReport } from '../../../renderer/shared/agent-protocol';

// Helper to seed the agent store with a session that has a repoPath
function seedReportedSession(repoPath: string, sessionId: string = 'test-session-1') {
  const session: SessionReport = {
    sessionId,
    repoPath,
    task: 'Test task',
    branchName: 'test-branch',
    agentType: 'claude',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  useAgentStore.getState().addReportedSession(session);
  useAgentStore.setState({ selectedSessionId: sessionId });
}

// Install mock API for organization config and fix config.getAll
function installOrganizationConfigApi(initialStructure: 'feature-folders' | 'flat' = 'feature-folders') {
  let currentStructure = initialStructure;
  const getOrganizationConfig = jest.fn(async (path: string) => {
    return { success: true, data: { enabled: true, structure: currentStructure } };
  });
  const setOrganizationConfig = jest.fn(async (path: string, config: { structure: string }) => {
    currentStructure = config.structure;
    return { success: true, data: { enabled: true, structure: config.structure } };
  });
  const api = { getOrganizationConfig, setOrganizationConfig };
  
  // Mock config.getAll for SettingsModal
  const configGetAll = jest.fn(async () => {
    return { success: true, data: {} };
  });
  
  // Mock credential.has for SettingsModal
  const credentialHas = jest.fn(async () => {
    return { success: true, data: false };
  });
  
  // Mock version.getRepoVersion for SettingsModal
  const versionGetRepoVersion = jest.fn(async () => {
    return { success: true, data: null };
  });
  
  // Mock version.getSettings for SettingsModal
  const versionGetSettings = jest.fn(async () => {
    return { success: true, data: null };
  });
  
  // Mock update.getStatus for SettingsModal
  const updateGetStatus = jest.fn(async () => {
    return { success: true, data: null };
  });
  
  (window as any).api = {
    ...(window as any).api,
    contractRegistry: api,
    config: {
      ...(window as any).api?.config,
      getAll: configGetAll,
    },
    credential: {
      ...(window as any).api?.credential,
      has: credentialHas,
    },
    version: {
      ...(window as any).api?.version,
      getRepoVersion: versionGetRepoVersion,
      getSettings: versionGetSettings,
    },
    update: {
      ...(window as any).api?.update,
      getStatus: updateGetStatus,
    },
  };
  return api;
}

describe('SettingsModal Code Organization section (AC1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });
  });

  it('section', async () => {
    const repoPath = '/test/repo';
    seedReportedSession(repoPath);
    installOrganizationConfigApi('feature-folders');

    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);

    // Open the 'code' tab
    const codeTabButton = screen.getByRole('button', { name: /code/i });
    await userEvent.click(codeTabButton);

    // Wait for Code Organization section to appear
    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Check that current preference is shown
    expect(screen.getByText('Feature-based')).toBeInTheDocument();

    // Check that there's a control to change it (dropdown)
    const dropdown = screen.getByRole('combobox');
    expect(dropdown).toBeInTheDocument();
  });
});

describe('SettingsModal Code Organization current preference (AC2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });
  });

  it('current preference', async () => {
    const repoPath = '/test/repo';
    seedReportedSession(repoPath);
    installOrganizationConfigApi('feature-folders');

    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);

    // Open the 'code' tab
    const codeTabButton = screen.getByRole('button', { name: /code/i });
    await userEvent.click(codeTabButton);

    // Wait for the section to load and show Feature-based
    await waitFor(() => {
      expect(screen.getByText('Feature-based')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Verify the dropdown shows feature-folders as selected
    const dropdown = screen.getByRole('combobox');
    expect(dropdown).toHaveValue('feature-folders');
  });
});

describe('SettingsModal Code Organization saves (AC3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });
  });

  it('saves', async () => {
    const repoPath = '/test/repo';
    seedReportedSession(repoPath);
    const api = installOrganizationConfigApi('feature-folders');

    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);

    // Open the 'code' tab
    const codeTabButton = screen.getByRole('button', { name: /code/i });
    await userEvent.click(codeTabButton);

    // Wait for section to load
    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Change dropdown from feature-folders to flat
    const dropdown = screen.getByRole('combobox');
    await userEvent.selectOptions(dropdown, 'flat');

    // Click save button
    const saveButton = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveButton);

    // Verify setOrganizationConfig was called with the new structure
    await waitFor(() => {
      expect(api.setOrganizationConfig).toHaveBeenCalledWith(repoPath, { structure: 'flat' });
    }, { timeout: 5000 });
  });
});

describe('SettingsModal Code Organization warns (AC4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });
    // Mock window.confirm
    (window.confirm as jest.Mock<any, any>) = jest.fn();
  });

  it('warns', async () => {
    const repoPath = '/test/repo';
    seedReportedSession(repoPath);
    const api = installOrganizationConfigApi('feature-folders');

    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);

    // Open the 'code' tab
    const codeTabButton = screen.getByRole('button', { name: /code/i });
    await userEvent.click(codeTabButton);

    // Wait for section to load
    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Change dropdown from feature-folders to flat
    const dropdown = screen.getByRole('combobox');
    await userEvent.selectOptions(dropdown, 'flat');

    // Click save button - this should trigger confirmation
    const saveButton = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveButton);

    // Verify window.confirm was called with the warning message
    expect(window.confirm).toHaveBeenCalledWith(
      'Change Code Organization: Switching to flat organization may affect existing project layouts. Continue?'
    );

    // Verify setOrganizationConfig was NOT called yet (waiting for confirmation)
    expect(api.setOrganizationConfig).not.toHaveBeenCalled();
  });

  it('declines the warning and asserts nothing was saved, value stays feature-based', async () => {
    const repoPath = '/test/repo';
    seedReportedSession(repoPath);
    const api = installOrganizationConfigApi('feature-folders');

    // Mock confirm to return false (user declines/cancels)
    (window.confirm as jest.Mock<any, any>).mockReturnValueOnce(false);

    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);

    // Open the 'code' tab
    const codeTabButton = screen.getByRole('button', { name: /code/i });
    await userEvent.click(codeTabButton);

    // Wait for section to load
    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    }, { timeout: 5000 });

    // Store reference to the current preference display element
    const currentPreferenceText = screen.getByText('Feature-based');

    // Change dropdown from feature-folders to flat
    const dropdown = screen.getByRole('combobox');
    await userEvent.selectOptions(dropdown, 'flat');

    // Click save button - user declines the warning
    const saveButton = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveButton);

    // Assert that setOrganizationConfig was NOT called (nothing saved)
    expect(api.setOrganizationConfig).not.toHaveBeenCalled();

    // Assert the dropdown's value reverts to feature-folders
    expect(dropdown).toHaveValue('feature-folders');

    // Assert the displayed current value still reads 'Feature-based'
    expect(currentPreferenceText).toHaveTextContent('Feature-based');
  });
});
