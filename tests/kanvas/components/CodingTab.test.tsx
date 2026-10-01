/**
 * KC-S2.1.1: Coding is the first main view on the rail; the app opens on sessions.
 * KC-S2.1.2 AC1: Settings holds the KIT Harness URL and token.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// KITMark loads its image with import.meta.url, which Jest cannot parse.
jest.mock('../../../renderer/components/ui/KITMark', () => ({ KITMarkContainer: () => null }));

import { useUIStore, DEFAULT_MAIN_VIEW } from '../../../renderer/store/uiStore';
import { Sidebar } from '../../../renderer/components/layouts/Sidebar';
import { HarnessSettings } from '../../../renderer/components/features/coding/HarnessSettings';
import { installHarnessApi } from '../fixtures/harness/mockHarness';

describe('Coding main view (KC-S2.1.1)', () => {
  it('is no longer the view the app opens on: sessions are, each with its own Code tab (uiStore)', () => {
    expect(DEFAULT_MAIN_VIEW).toBe('dashboard');
    expect(useUIStore.getInitialState().mainView).toBe('dashboard');
  });

  it('is the first entry in the view switcher and selects the Coding view', async () => {
    useUIStore.setState({ mainView: 'dashboard' });
    render(<Sidebar />);
    const nav = screen.getByTestId('nav-coding');
    const railButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('title') && !b.hasAttribute('disabled'));
    const firstView = railButtons.find((b) => ['Coding', 'Sessions & Agents', 'Workspaces'].includes(b.getAttribute('title')!));
    expect(firstView).toBe(nav);
    await userEvent.click(nav);
    expect(useUIStore.getState().mainView).toBe('coding');
    expect(nav).toHaveAttribute('aria-current', 'page');
  });
});

describe('HarnessSettings (KC-S2.1.2 AC1)', () => {
  it('loads, saves and tests the harness URL and token', async () => {
    const api = installHarnessApi({
      connection: jest.fn(async () => ({ success: true, data: { url: 'http://old:39200/mcp', hasToken: false } })) as any,
      setConnection: jest.fn(async (url: string) => ({ success: true, data: { url, hasToken: true } })) as any,
    });
    render(<HarnessSettings />);
    const url = await screen.findByLabelText('KIT Harness URL');
    await waitFor(() => expect(url).toHaveValue('http://old:39200/mcp'));
    await userEvent.clear(url);
    await userEvent.type(url, 'http://mac-mini:39200/mcp');
    await userEvent.type(screen.getByLabelText('KIT Harness token'), 's3cret');
    await userEvent.click(screen.getByText('Save harness connection'));
    expect(api.setConnection).toHaveBeenCalledWith('http://mac-mini:39200/mcp', 's3cret');
    expect(await screen.findByText('KIT Harness connection saved')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByLabelText('KIT Harness token')).toHaveValue(''); // never shown again

    await userEvent.click(screen.getByText('Test'));
    expect(await screen.findByText('Connected to KIT Harness (LiteLLM up, DevOps Agent up)')).toBeInTheDocument();
  });

  it('keeps the saved token when only the URL changes', async () => {
    const api = installHarnessApi();
    render(<HarnessSettings />);
    const url = await screen.findByLabelText('KIT Harness URL');
    await waitFor(() => expect(url).toHaveValue('http://mini:39200/mcp'));
    await userEvent.click(screen.getByText('Save harness connection'));
    expect(api.setConnection).toHaveBeenCalledWith('http://mini:39200/mcp', undefined);
  });

  it('says so when the harness cannot be reached', async () => {
    installHarnessApi({
      clusterStatus: jest.fn(async () => ({ success: false, error: { code: 'HARNESS_OFFLINE', message: 'KIT Harness unreachable at http://mini:39200/mcp' } })) as any,
    });
    render(<HarnessSettings />);
    await waitFor(() => expect(screen.getByLabelText('KIT Harness URL')).toHaveValue('http://mini:39200/mcp'));
    await userEvent.click(screen.getByText('Test'));
    expect(await screen.findByText('KIT Harness unreachable at http://mini:39200/mcp')).toBeInTheDocument();
  });
});
