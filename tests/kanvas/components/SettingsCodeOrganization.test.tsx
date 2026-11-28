/**
 * Code Organization Settings Component Tests
 * Tests for SettingsModal's Code Organization section (KC-S1.2.2.2)
 */

import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../../../renderer/components/features/SettingsModal';
import { useAgentStore } from '../../../renderer/store/agentStore';
import { mockApi } from '../setup';

// A repo must be reported into the store so SettingsModal derives a
// selectedRepoPath and CodeOrganizationSettings actually fetches the config.
const TEST_REPO = '/test/repo';

function seedSelectedRepo(): void {
  useAgentStore.setState({
    reportedSessions: new Map([
      ['sess-1', { sessionId: 'sess-1', repoPath: TEST_REPO } as any],
    ]),
    selectedSessionId: 'sess-1',
  });
}

describe('SettingsModal - Code Organization', () => {
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    seedSelectedRepo();

    // SettingsModal reads the repo version once a repo is selected; without
    // this the version effect throws on an undefined window.api.version.
    (window.api as any).version = {
      getRepoVersion: jest.fn().mockResolvedValue({
        success: true,
        data: { version: '1.0.0', major: 1, minor: 0, patch: 0 },
      }),
      getSettings: jest.fn().mockResolvedValue({
        success: true,
        data: { autoVersionBump: true },
      }),
      bump: jest.fn(),
      setSettings: jest.fn(),
    };

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

  // The section shows the current preference in a dedicated element; scope
  // value assertions to it so the radio label of the same name does not
  // make getByText ambiguous. findByText waits for the async config load.
  function currentPreferenceElement(text: string): Promise<HTMLElement> {
    return screen.findByText(text, { selector: 'span.font-semibold' });
  }

  it('section renders Code Organization heading with current preference and radio control (AC1)', async () => {
    render(<SettingsModal onClose={mockOnClose} />);

    // Wait for the section to finish loading, not just the always-present header.
    const heading = await screen.findByText('Code Organization');
    expect(heading).toBeInTheDocument();

    // The current preference is shown ("Feature-based" for feature-folders).
    expect(await currentPreferenceElement('Feature-based')).toBeInTheDocument();

    // A radio control is present to change it.
    const radioButtons = screen.getAllByRole('radio');
    expect(radioButtons.length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Flat layout')).toBeInTheDocument();
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

    await screen.findByText('Code Organization');

    // Should display "Feature-based" for feature-folders structure
    expect(await currentPreferenceElement('Feature-based')).toBeInTheDocument();
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

    await screen.findByText('Code Organization');

    // Should display "Flat layout" for flat structure
    expect(await currentPreferenceElement('Flat layout')).toBeInTheDocument();
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

    await screen.findByText('Code Organization');

    // Should display "Custom" for custom structure
    expect(await currentPreferenceElement('Custom')).toBeInTheDocument();
  });

  it('saves new preference by calling setOrganizationConfig with the new structure (AC3)', async () => {
    const user = userEvent.setup();

    render(<SettingsModal onClose={mockOnClose} />);

    // Wait for the section to finish loading so the radio control exists.
    await currentPreferenceElement('Feature-based');

    // Select a different structure (e.g., flat). Switching from feature-folders
    // to flat raises the warning, so confirm it before saving.
    await user.click(screen.getByLabelText('Flat layout'));
    await user.click(await screen.findByRole('button', { name: /switch to flat/i }));

    // Save the change from the Code Organization section.
    await user.click(screen.getByText('Save Changes'));

    // Verify setOrganizationConfig was called with the new structure
    expect(mockApi.contractRegistry.setOrganizationConfig).toHaveBeenCalledWith(
      TEST_REPO, // repoPath
      expect.objectContaining({
        structure: 'flat',
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

    // Wait for the section to finish loading so the radio control exists.
    await currentPreferenceElement('Feature-based');

    // Try to select flat
    await user.click(screen.getByLabelText('Flat layout'));

    // A warning/confirmation must appear before anything is saved.
    const warning = await screen.findByRole('heading', { name: /switching to flat/i });
    expect(warning).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to flat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep current/i })).toBeInTheDocument();

    // Nothing was saved while the warning is showing.
    expect(mockApi.contractRegistry.setOrganizationConfig).not.toHaveBeenCalled();
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

    // Get reference to the element showing the current structure value BEFORE user action
    // The component displays current preference (e.g., "Feature-based") in the section
    const currentValueElement = await currentPreferenceElement('Feature-based');

    // Try to select flat
    await user.click(screen.getByLabelText('Flat layout'));

    // Wait for warning modal to appear
    await screen.findByRole('heading', { name: /switching to flat/i });

    // Click Keep Current to decline the warning
    await user.click(screen.getByRole('button', { name: /keep current/i }));

    // Verify setOrganizationConfig was NOT called
    expect(mockApi.contractRegistry.setOrganizationConfig).not.toHaveBeenCalled();

    // Verify the control's value is still feature-folders (radio should not be checked)
    expect(screen.getByLabelText('Flat layout')).not.toBeChecked();

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

    // Wait for the section to finish loading so the radio control exists.
    await currentPreferenceElement('Feature-based');

    // Try to select flat
    await user.click(screen.getByLabelText('Flat layout'));

    // Wait for warning modal to appear
    await screen.findByRole('heading', { name: /switching to flat/i });

    // Click Switch to Flat to accept the warning
    await user.click(screen.getByRole('button', { name: /switch to flat/i }));

    // Now save the change from the Code Organization section
    await user.click(screen.getByText('Save Changes'));

    // Verify setOrganizationConfig was called
    expect(mockApi.contractRegistry.setOrganizationConfig).toHaveBeenCalledWith(
      TEST_REPO,
      expect.objectContaining({
        structure: 'flat',
      })
    );
  });

  it('displays "No repository selected" when selectedRepoPath is empty', async () => {
    // Override the seeded repo: with no reported sessions there is no repo to
    // select, so the section must degrade gracefully.
    useAgentStore.setState({ reportedSessions: new Map(), selectedSessionId: null });

    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('Code Organization');

    // The component should handle the case where no repo is selected
    expect(screen.getByText(/no repository/i)).toBeInTheDocument();
    // And it must not attempt to load a config for a missing repo.
    expect(mockApi.contractRegistry.getOrganizationConfig).not.toHaveBeenCalled();
  });
});
