/**
 * KC-S1.2.2.2: the Code Organization section in Settings.
 *
 * The repository's code-organization preference (chosen in the Create Agent
 * wizard) can be read and changed later from the General tab of SettingsModal,
 * scoped to the repo already selected in the Repo Version block.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { useAgentStore } from '../../../renderer/store/agentStore';

const REPO = '/repos/example-repo';

type OrgStructure = 'feature-folders' | 'flat' | 'custom';

interface OrgConfig {
  enabled: boolean;
  structure: OrgStructure;
  setupCompleted: boolean;
  setupCompletedAt?: string;
}

/**
 * Install the full window.api surface SettingsModal touches, and return the
 * contractRegistry mock so a test can assert on setOrganizationConfig.
 */
function installApi(initial: OrgConfig) {
  let stored: OrgConfig = initial;
  const contractRegistry = {
    getOrganizationConfig: jest.fn(async (_repoPath: string) => ({ success: true, data: stored })),
    setOrganizationConfig: jest.fn(async (_repoPath: string, config: OrgConfig) => {
      stored = config;
      return { success: true };
    }),
  };

  (window as any).api = {
    ...(window as any).api,
    config: {
      getAll: jest.fn(async () => ({
        success: true,
        data: {
          theme: 'dark',
          defaultAgentType: 'claude',
          recentProjects: [],
          autoWatch: true,
          autoPush: true,
          onboardingCompleted: true,
          telemetryOptIn: false,
          defaultLandingView: 'last-visited',
        },
      })),
      set: jest.fn(async () => ({ success: true })),
    },
    credential: {
      has: jest.fn(async () => ({ success: true, data: false })),
    },
    app: {
      getVersion: jest.fn(async () => '1.0.0'),
    },
    update: {
      getStatus: jest.fn(async () => ({ success: true, data: {} })),
    },
    version: {
      getRepoVersion: jest.fn(async () => ({ success: true, data: { version: '1.0.0', major: 1, minor: 0, patch: 0 } })),
      getSettings: jest.fn(async () => ({ success: true, data: { autoVersionBump: true } })),
    },
    contractRegistry,
  };

  return contractRegistry;
}

function seedRepo() {
  useAgentStore.setState({
    reportedSessions: new Map([
      ['sess-1', { sessionId: 'sess-1', repoPath: REPO } as any],
    ]),
    selectedSessionId: 'sess-1',
  });
}

describe('SettingsModal Code Organization (KC-S1.2.2.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedRepo();
  });

  it('renders the Code Organization section in the General tab with heading, current preference, and control', async () => {
    installApi({ enabled: true, structure: 'feature-folders', setupCompleted: true });
    render(<SettingsModal onClose={() => {}} />);

    // The section heading is present in the General tab.
    expect(await screen.findByText('Code Organization')).toBeInTheDocument();
    // The current preference is shown as its label.
    expect(screen.getByTestId('current-org-preference')).toHaveTextContent('Feature-based');
    // A control to change it is present.
    expect(screen.getByTestId('code-organization-select')).toBeInTheDocument();
  });

  it('shows the current preference for {enabled: true, structure: feature-folders}', async () => {
    installApi({ enabled: true, structure: 'feature-folders', setupCompleted: true });
    render(<SettingsModal onClose={() => {}} />);

    expect(await screen.findByTestId('current-org-preference')).toHaveTextContent('Feature-based');
  });

  it('saves the new structure via setOrganizationConfig with the wizard shape', async () => {
    const api = installApi({ enabled: false, structure: 'flat', setupCompleted: true });
    render(<SettingsModal onClose={() => {}} />);

    const select = await screen.findByTestId('code-organization-select');
    await userEvent.selectOptions(select, 'custom');

    await waitFor(() => expect(api.setOrganizationConfig).toHaveBeenCalledTimes(1));
    expect(api.setOrganizationConfig).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({
        enabled: false,
        structure: 'custom',
        setupCompleted: true,
        setupCompletedAt: expect.any(String),
      })
    );
  });

  it('warns before switching from feature-based to flat and writes nothing until confirmed', async () => {
    const api = installApi({ enabled: true, structure: 'feature-folders', setupCompleted: true });
    render(<SettingsModal onClose={() => {}} />);

    const select = await screen.findByTestId('code-organization-select');
    await userEvent.selectOptions(select, 'flat');

    // A warning/confirmation is shown inside the section, and nothing is written yet.
    expect(await screen.findByTestId('code-organization-confirm')).toBeInTheDocument();
    expect(api.setOrganizationConfig).not.toHaveBeenCalled();

    // Only after the user confirms is the write made.
    await userEvent.click(screen.getByTestId('code-organization-confirm'));
    await waitFor(() => expect(api.setOrganizationConfig).toHaveBeenCalledTimes(1));
    expect(api.setOrganizationConfig).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ structure: 'flat' })
    );
  });
});
