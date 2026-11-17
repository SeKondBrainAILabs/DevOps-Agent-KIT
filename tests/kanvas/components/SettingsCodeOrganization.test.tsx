/**
 * Code Organization section in SettingsModal (KC-S1.2.2.2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';

// Helper to install contractRegistry API stub
function installContractRegistryApi(
  initialConfig: {
    enabled: boolean;
    structure: 'feature-folders' | 'flat' | 'custom';
    setupCompleted: boolean;
    setupCompletedAt?: string;
  } | null = null
) {
  let stored = initialConfig;
  const api = {
    getOrganizationConfig: jest.fn(async (repoPath: string) => {
      if (stored === null) {
        return { success: false, error: { code: 'CONFIG_NOT_FOUND', message: 'Not configured' } };
      }
      return { success: true, data: stored };
    }),
    setOrganizationConfig: jest.fn(async (repoPath: string, config: any) => {
      stored = config;
      return { success: true, data: undefined };
    }),
  };
  (window as any).api = {
    ...(window as any).api,
    contractRegistry: api,
  };
  return api;
}

// Helper to seed agent store with reported sessions
function seedAgentStore(reportedSessions: Array<{ sessionId: string; repoPath: string; agentId?: string }>) {
  const { useAgentStore } = require('../../../renderer/store/agentStore');
  const store = useAgentStore.getState();
  
  // Clear existing sessions by removing them one by one
  Array.from(store.reportedSessions.keys()).forEach((key) => {
    store.removeReportedSession(key);
  });
  
  // Add test sessions
  reportedSessions.forEach((session, idx) => {
    store.addReportedSession({
      sessionId: session.sessionId,
      agentId: session.agentId || `agent-${idx}`,
      agentType: 'claude',
      task: 'Test task',
      branchName: 'test-branch',
      baseBranch: 'main',
      repoPath: session.repoPath,
      status: 'idle',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      commitCount: 0,
    });
  });
  
  // Set selected session if provided
  if (reportedSessions.length > 0) {
    store.setSelectedSession(reportedSessions[0].sessionId);
  }
}

describe('SettingsModal Code Organization section (KC-S1.2.2.2)', () => {
  let mockApi: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset agent store
    const { useAgentStore } = require('../../../renderer/store/agentStore');
    // Clear existing sessions by removing them one by one
    Array.from(useAgentStore.getState().reportedSessions.keys()).forEach((key) => {
      useAgentStore.getState().removeReportedSession(key);
    });
    useAgentStore.getState().setSelectedSession(null);

    // Install stubs for required APIs
    mockApi = {
      config: {
        getAll: jest.fn(async () => ({
          success: true,
          data: {
            theme: 'dark' as const,
            defaultAgentType: 'claude' as const,
            autoWatch: false,
            autoPush: false,
            onboardingCompleted: true,
            telemetryOptIn: true,
            defaultLandingView: 'coding' as const,
          },
        })),
        set: jest.fn(async () => ({ success: true })),
      },
      version: {
        getRepoVersion: jest.fn(async () => ({
          success: true,
          data: { version: '1.0.0', major: 1, minor: 0, patch: 0 },
        })),
        getSettings: jest.fn(async () => ({ success: true, data: { autoVersionBump: true } })),
        bump: jest.fn(async () => ({ success: true, data: { version: '1.0.1', major: 1, minor: 0, patch: 1 } })),
        setSettings: jest.fn(async () => ({ success: true })),
      },
      credential: {
        has: jest.fn(async () => ({ success: true, data: false })),
        set: jest.fn(async () => ({ success: true })),
      },
      app: {
        getVersion: jest.fn(async () => '1.0.0'),
      },
      update: {
        getStatus: jest.fn(async () => ({ success: true, data: null })),
        onAvailable: jest.fn(() => () => {}),
        onNotAvailable: jest.fn(() => () => {}),
        onProgress: jest.fn(() => () => {}),
        onDownloaded: jest.fn(() => () => {}),
        onError: jest.fn(() => () => {}),
        check: jest.fn(async () => ({ success: true, data: { updateAvailable: false } })),
      },
      mcp: {
        getAgentSessionCount: jest.fn(async () => ({ success: true, data: { limits: { enabled: true, maxConcurrentGlobal: 8, maxConcurrentPerRepo: 4, agentsMayCloseUiSessions: false } } })),
        status: jest.fn(async () => ({ success: true, data: { port: 39100, url: 'http://127.0.0.1:39100/mcp', isRunning: true, connectionCount: 0, startedAt: new Date().toISOString() } })),
        checkClaudeCodeConfig: jest.fn(async () => ({ success: true, data: { installed: false, path: '', currentUrl: null, portMismatch: false } })),
        checkClaudeDesktopConfig: jest.fn(async () => ({ success: true, data: { installed: false, path: '', currentUrl: null, portMismatch: false } })),
      },
      debugLog: {
        getStats: jest.fn(async () => ({ success: true, data: { memoryEntries: 0, fileSize: 0, rotatedFiles: 0 } })),
      },
    };
    
    (window as any).api = { ...(window as any).api, ...mockApi };
  });

  it('section: renders Code Organization section in General tab with heading, current preference, and control', async () => {
    // Seed agent store with a reported session
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    // Install contractRegistry API with initial config
    const registryApi = installContractRegistryApi({
      enabled: true,
      structure: 'feature-folders',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    // Render SettingsModal
    const { getByText, getByTestId } = render(<SettingsModal onClose={() => {}} />);

    // Ensure General tab is active and config is loaded
    await waitFor(() => {
      expect(getByText('Settings')).toBeInTheDocument();
    });

    // Wait for Code Organization section to appear
    await waitFor(() => {
      expect(getByText('Code Organization')).toBeInTheDocument();
    });

    // Verify heading
    expect(getByText('Code Organization')).toBeInTheDocument();

    // Verify current preference label
    expect(getByText('Feature-based')).toBeInTheDocument();

    // Verify control to change preference
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe('feature-folders');
  });

  it('current preference: shows "Feature-based" when getOrganizationConfig returns { enabled: true, structure: "feature-folders" }', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    installContractRegistryApi({
      enabled: true,
      structure: 'feature-folders',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Verify label mapping
    expect(screen.getByText('Feature-based')).toBeInTheDocument();
  });

  it('current preference: shows "Flat" when structure is "flat"', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    installContractRegistryApi({
      enabled: false,
      structure: 'flat',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    expect(screen.getByText('Flat')).toBeInTheDocument();
  });

  it('current preference: shows "Custom" when structure is "custom"', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    installContractRegistryApi({
      enabled: false,
      structure: 'custom',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('saves: calls setOrganizationConfig with the new structure when changing and saving', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    const registryApi = installContractRegistryApi({
      enabled: true,
      structure: 'feature-folders',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Change preference to flat
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'flat');

    // Click save button
    const saveButton = screen.getByRole('button', { name: /save settings/i });
    await userEvent.click(saveButton);

    // Wait for setOrganizationConfig to be called
    await waitFor(() => {
      expect(registryApi.setOrganizationConfig).toHaveBeenCalled();
    });

    // Verify the call shape matches what CreateAgentWizard writes
    expect(registryApi.setOrganizationConfig).toHaveBeenCalledWith(
      '/test/repo',
      expect.objectContaining({
        enabled: false, // false because structure !== 'feature-folders'
        structure: 'flat',
        setupCompleted: true,
        setupCompletedAt: expect.any(String),
      })
    );
  });

  it('warns: shows inline confirmation when switching from feature-based to flat, and does not call setOrganizationConfig until confirmed', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    const registryApi = installContractRegistryApi({
      enabled: true,
      structure: 'feature-folders',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    // Change preference from feature-folders to flat
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'flat');

    // Verify warning/confirmation is shown
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    expect(screen.getByText(/confirm/i)).toBeInTheDocument();

    // Verify setOrganizationConfig was NOT called yet
    expect(registryApi.setOrganizationConfig).not.toHaveBeenCalled();

    // Click confirm button
    const confirmButton = screen.getByRole('button', { name: /confirm/i });
    await userEvent.click(confirmButton);

    // Wait for setOrganizationConfig to be called after confirmation
    await waitFor(() => {
      expect(registryApi.setOrganizationConfig).toHaveBeenCalled();
    });
  });

  it('warns: does not show warning when switching from flat to feature-folders', async () => {
    seedAgentStore([{ sessionId: 'session-1', repoPath: '/test/repo' }]);
    
    installContractRegistryApi({
      enabled: false,
      structure: 'flat',
      setupCompleted: true,
      setupCompletedAt: new Date().toISOString(),
    });

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Code Organization')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'feature-folders');

    // No warning should be shown
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
  });

  it('shows "No repos connected" when uniqueRepos is empty', async () => {
    // Don't seed any sessions - ensure store is empty
    const { useAgentStore } = require('../../../renderer/store/agentStore');
    Array.from(useAgentStore.getState().reportedSessions.keys()).forEach((key) => {
      useAgentStore.getState().removeReportedSession(key);
    });
    useAgentStore.getState().setSelectedSession(null);

    render(<SettingsModal onClose={() => {}} />);

    // Wait for Settings and config to load
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // Wait for the config to be loaded and "No repos connected" to appear
    await waitFor(() => {
      expect(screen.getByText('No repos connected')).toBeInTheDocument();
    });
    
    // Code Organization section should not be visible when no repos connected
    expect(screen.queryByText('Code Organization')).not.toBeInTheDocument();
  });
});
