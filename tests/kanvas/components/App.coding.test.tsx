/**
 * KC-S2.1.1 AC2: App renders the Coding view for mainView === 'coding', which is
 * where the app opens. The rest of the shell (layout, other views, modals and
 * the agent subscriptions) is stubbed: only App's view selection is under test.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react';

function mockStub(name: string) {
  return () => ({ [name]: () => null });
}
jest.mock('../../../renderer/components/layouts/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
jest.mock('../../../renderer/components/layouts/Sidebar', mockStub('Sidebar'));
jest.mock('../../../renderer/components/layouts/StatusBar', mockStub('StatusBar'));
jest.mock('../../../renderer/components/features/DashboardCanvas', () => ({ DashboardCanvas: () => <div data-testid="dashboard" /> }));
jest.mock('../../../renderer/components/features/SessionDetailView', mockStub('SessionDetailView'));
jest.mock('../../../renderer/components/features/UniversalCommitsView', () => ({ UniversalCommitsView: () => <div data-testid="commits-view" /> }));
jest.mock('../../../renderer/components/features/WorkspaceBrowserView', mockStub('WorkspaceBrowserView'));
jest.mock('../../../renderer/components/ui/HomeArtefactLeft', mockStub('HomeArtefactLeft'));
jest.mock('../../../renderer/components/features/NewSessionWizard', mockStub('NewSessionWizard'));
jest.mock('../../../renderer/components/features/CloseSessionDialog', mockStub('CloseSessionDialog'));
jest.mock('../../../renderer/components/features/SettingsModal', mockStub('SettingsModal'));
jest.mock('../../../renderer/components/features/CreateAgentWizard', mockStub('CreateAgentWizard'));
jest.mock('../../../renderer/components/features/RepoDetailModal', mockStub('RepoDetailModal'));
jest.mock('../../../renderer/components/features/RebaseMergeErrorDialog', mockStub('RebaseMergeErrorDialog'));
jest.mock('../../../renderer/components/features/OnboardingModal', mockStub('OnboardingModal'));
jest.mock('../../../renderer/components/features/StaleSessionsDialog', mockStub('StaleSessionsDialog'));
jest.mock('../../../renderer/components/features/AgentSessionsExpiredDialog', mockStub('AgentSessionsExpiredDialog'));
jest.mock('../../../renderer/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }));
jest.mock('../../../renderer/hooks/useAgentSubscription', () => ({ useAgentSubscription: () => undefined }));
jest.mock('../../../renderer/hooks/useContractGenerationSubscription', () => ({ useContractGenerationSubscription: () => undefined }));

import App from '../../../renderer/App';
import { useUIStore } from '../../../renderer/store/uiStore';
import { installHarnessApi } from '../fixtures/harness/mockHarness';

describe('App (KC-S2.1.1 AC2)', () => {
  it('opens on the Coding view and switches views from the store', async () => {
    installHarnessApi();
    const api = (window as any).api;
    api.config = { ...api.config, get: jest.fn(async () => ({ success: true, data: true })) };
    useUIStore.setState({ mainView: useUIStore.getInitialState().mainView });
    render(<App />);
    expect(screen.getByTestId('coding-view')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('coding-board')).toBeInTheDocument());

    act(() => useUIStore.getState().setMainView('commits'));
    expect(screen.queryByTestId('coding-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('commits-view')).toBeInTheDocument();

    act(() => useUIStore.getState().setMainView('coding'));
    expect(screen.getByTestId('coding-view')).toBeInTheDocument();
  });
});
