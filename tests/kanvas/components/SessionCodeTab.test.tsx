/**
 * A session's Code tab: KIT Harness runs for that session's repo, work submitted
 * against its checkout, and the sessions the harness spawned, one per story.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionCodeTab } from '../../../renderer/components/features/coding/SessionCodeTab';
import { useAgentStore } from '../../../renderer/store/agentStore';
import { installHarnessApi, RUNS } from '../fixtures/harness/mockHarness';

const REPO = '/Volumes/Repos/sekond/agent_memory_vault';
// The first fixture run targets this session's checkout; the second targets another repo.
const MINE = { ...RUNS[0], repos: [REPO], stories: RUNS[0].stories.map((s) => ({ ...s, repo: REPO })) };
const OTHER = { ...RUNS[1], repos: ['o/other'], stories: RUNS[1].stories.map((s) => ({ ...s, repo: 'o/other' })) };

const session = { sessionId: 'sess-parent', repoPath: REPO, branchName: 'feat/x', baseBranch: 'main' } as any;

function installRuns() {
  return installHarnessApi({
    listRuns: async () => ({ success: true, data: [MINE, OTHER].map((r) => ({ run_id: r.run_id, status: r.status, created_at: r.created_at, stories: {}, repos: r.repos })) }),
    getRun: async (runId: string) => ({ success: true, data: [MINE, OTHER].find((r) => r.run_id === runId) }),
  });
}

describe('SessionCodeTab', () => {
  beforeEach(() => {
    useAgentStore.setState({ reportedSessions: new Map([['sess-2', { sessionId: 'sess-2' } as any]]), selectedSessionId: 'sess-parent' });
  });

  it("shows only this repo's runs and the sessions the harness spawned for them", async () => {
    installRuns();
    render(<SessionCodeTab session={session} />);
    const spawned = await screen.findByTestId('spawned-sessions');
    expect(within(spawned).getByText('KC-S9.9.1')).toBeInTheDocument();
    expect(within(spawned).getByText('KC-S9.9.2')).toBeInTheDocument();
    expect(within(spawned).queryByText('KC-S9.9.3')).not.toBeInTheDocument();
  });

  it('opens a spawned session the DevOps Agent knows, and disables one it has not reported', async () => {
    installRuns();
    render(<SessionCodeTab session={session} />);
    const spawned = await screen.findByTestId('spawned-sessions');
    const buttons = within(spawned).getAllByRole('button', { name: 'Open session' });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    await userEvent.click(buttons[0]);
    expect(useAgentStore.getState().selectedSessionId).toBe('sess-2');
  });

  it("submits work against this session's checkout", async () => {
    const api = installRuns();
    render(<SessionCodeTab session={session} />);
    await screen.findByTestId('spawned-sessions');
    await userEvent.type(screen.getByLabelText('Build in this repo'), 'kit://prod-1');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Send to KIT Harness' }));
    await waitFor(() => expect(api.submitEpic).toHaveBeenCalledWith('kit://prod-1', REPO, { auto_approve: true }));
    expect(await screen.findByText('Submitted as run r-epic.')).toBeInTheDocument();
  });
});
