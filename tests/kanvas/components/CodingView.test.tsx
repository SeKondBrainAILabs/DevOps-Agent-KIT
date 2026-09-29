/**
 * KC-S2.1.2 AC3, KC-S2.1.3 AC2, KC-S2.1.5, KC-S2.1.6 AC2, KC-S2.1.7 AC2: the Coding tab
 * against window.api.harness serving fixtures captured from a real harness run.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodingView } from '../../../renderer/components/features/coding/CodingView';
import { CodingBoard } from '../../../renderer/components/features/coding/CodingBoard';
import { QuestionCard, MAX_QUESTIONS } from '../../../renderer/components/features/coding/Gates';
import { EvidencePanel } from '../../../renderer/components/features/coding/EvidencePanel';
import { TokenMeter } from '../../../renderer/components/features/coding/TokenMeter';
import { useUIStore } from '../../../renderer/store/uiStore';
import { DONE_RUN, GATED_RUN, RUNS, STORY_DONE, STORY_GATED, installHarnessApi } from '../fixtures/harness/mockHarness';

describe('CodingBoard (KC-S2.1.3)', () => {
  it('clicking a story opens its run view', async () => {
    const onOpen = jest.fn();
    render(<CodingBoard runs={RUNS} onOpenStory={onOpen} />);
    const pr = screen.getByTestId('column-pr');
    expect(within(pr).getByText('PR open')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-approval')).getByTestId('story-card-KC-S9.9.3')).toBeInTheDocument();
    await userEvent.click(within(pr).getByTestId('story-card-KC-S9.9.1'));
    expect(onOpen).toHaveBeenCalledWith(DONE_RUN.run_id, 'KC-S9.9.1');
  });
});

describe('CodingView', () => {
  it('shows the board, then the run view of the story clicked', async () => {
    const api = installHarnessApi();
    render(<CodingView />);
    await waitFor(() => expect(screen.getByTestId('coding-board')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^story-card-/)).toHaveLength(3);
    await userEvent.click(screen.getByTestId('story-card-KC-S9.9.1'));
    await waitFor(() => expect(screen.getByTestId('story-run-view')).toBeInTheDocument());
    expect(api.getStory).toHaveBeenCalledWith(DONE_RUN.run_id, 'KC-S9.9.1');
    await waitFor(() => expect(screen.getByTestId('evidence-pr-link')).toHaveAttribute('href', STORY_DONE.pr_url!));
    await waitFor(() => expect(screen.getByTestId('timeline-step-0')).toHaveTextContent('refiner'));
    await userEvent.click(screen.getByText('← Board'));
    expect(screen.getByTestId('coding-board')).toBeInTheDocument();
  });

  it('approves or sends back a plan waiting at the plan gate (KC-S2.1.5 AC1)', async () => {
    const api = installHarnessApi();
    render(<CodingView />);
    await userEvent.click(await screen.findByTestId('story-card-KC-S9.9.3'));
    const gate = await screen.findByTestId('plan-approval');
    expect(within(gate).getByText('hello.txt')).toBeInTheDocument();
    await userEvent.click(within(gate).getByText('Request changes'));
    await userEvent.type(within(gate).getByLabelText('Requested changes'), 'Split the greeting into two files');
    await userEvent.click(within(gate).getByText('Send back to Planner'));
    expect(api.approve).toHaveBeenCalledWith(GATED_RUN.run_id, STORY_GATED.story_id, false, 'Split the greeting into two files');
    await userEvent.click(within(gate).getByText('Approve'));
    expect(api.approve).toHaveBeenLastCalledWith(GATED_RUN.run_id, STORY_GATED.story_id, true, '');
  });

  it('answers a blocked story through harness_answer (KC-S2.1.5 AC2)', async () => {
    const blocked = { ...STORY_DONE, state: 'blocked', questions: ['Which greeting language?'], pr_url: null };
    const api = installHarnessApi({ getStory: jest.fn(async () => ({ success: true, data: blocked })) as any });
    render(<CodingView />);
    await userEvent.click(await screen.findByTestId('story-card-KC-S9.9.1'));
    const card = await screen.findByTestId('question-card');
    await userEvent.type(within(card).getByLabelText(/Which greeting language/), 'English');
    await userEvent.click(within(card).getByText('Send answers and re-queue'));
    expect(api.answer).toHaveBeenCalledWith(DONE_RUN.run_id, 'KC-S9.9.1', 'English');
  });

  it('shows a clear offline state, not a crash, when the harness is unreachable (KC-S2.1.2 AC3)', async () => {
    installHarnessApi({
      listRuns: jest.fn(async () => ({ success: false, error: { code: 'HARNESS_OFFLINE', message: 'KIT Harness unreachable at http://bad:1/mcp: ECONNREFUSED' } })) as any,
    });
    render(<CodingView />);
    const offline = await screen.findByTestId('harness-offline');
    expect(offline).toHaveAttribute('data-state', 'offline');
    expect(offline).toHaveTextContent('KIT Harness is offline');
    expect(offline).toHaveTextContent('ECONNREFUSED');
  });

  it('asks for the connection in Settings when nothing is configured', async () => {
    installHarnessApi({
      listRuns: jest.fn(async () => ({ success: false, error: { code: 'HARNESS_NOT_CONFIGURED', message: 'Set the KIT Harness URL and token in Settings' } })) as any,
    });
    useUIStore.setState({ showSettingsModal: false });
    render(<CodingView />);
    const offline = await screen.findByTestId('harness-offline');
    expect(offline).toHaveAttribute('data-state', 'unconfigured');
    await userEvent.click(within(offline).getByText('Open Settings'));
    expect(useUIStore.getState().showSettingsModal).toBe(true);
  });

  it('approves a proposed run from an epic', async () => {
    const proposed = { ...GATED_RUN, run_id: 'r-epic', status: 'awaiting_approval', epic: 'Greeting epic', stories: [] };
    const api = installHarnessApi({
      listRuns: jest.fn(async () => ({ success: true, data: [{ run_id: 'r-epic', status: 'awaiting_approval', created_at: '', stories: {} }] })) as any,
      getRun: jest.fn(async () => ({ success: true, data: proposed })) as any,
    });
    render(<CodingView />);
    const banner = await screen.findByTestId('run-proposal-r-epic');
    await userEvent.click(within(banner).getByText('Approve run'));
    expect(api.approve).toHaveBeenCalledWith('r-epic', null, true);
  });
});

describe('QuestionCard (KC-S2.1.5 AC2)', () => {
  it('shows up to three questions and sends every answer in one harness_answer', async () => {
    const onAnswer = jest.fn();
    render(<QuestionCard questions={['Q one?', 'Q two?', 'Q three?', 'Q four?']} onAnswer={onAnswer} />);
    const boxes = screen.getAllByRole('textbox');
    expect(boxes).toHaveLength(MAX_QUESTIONS);
    expect(screen.queryByText(/Q four/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 more question will follow/)).toBeInTheDocument();
    const send = screen.getByText('Send answers and re-queue');
    expect(send).toBeDisabled();
    for (const [i, box] of boxes.entries()) await userEvent.type(box, `answer ${i + 1}`);
    await userEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith(
      'Q1: Q one?\nA: answer 1\n\nQ2: Q two?\nA: answer 2\n\nQ3: Q three?\nA: answer 3'
    );
  });
});

describe('EvidencePanel (KC-S2.1.6)', () => {
  it('links the pull request and shows each criterion with its commands', () => {
    render(<EvidencePanel evidence={STORY_DONE.evidence} prUrl={STORY_DONE.pr_url} loadScreenshot={async () => null} />);
    const link = screen.getByTestId('evidence-pr-link');
    expect(link).toHaveAttribute('href', STORY_DONE.pr_url!);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('criterion-AC1-result')).toHaveTextContent('pass');
    expect(screen.getByText("grep -q 'hello world' hello.txt", { selector: 'span' })).toBeInTheDocument();
  });

  it('loads screenshots for visual criteria', async () => {
    const evidence = {
      ...STORY_DONE.evidence!,
      acceptance_criteria: [{
        id: 'AC2', text: 'The badge reads CI passing', passed: false,
        visual: { pass: false, confidence: 0.82, screenshot: '/srv/kit/.kit/runs/r/KC/screenshots/ac2.png', finding: 'badge missing', advisory: true },
      }],
    };
    const load = jest.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
    render(<EvidencePanel evidence={evidence} prUrl={null} loadScreenshot={load} />);
    expect(await screen.findByAltText('Screenshot for AC2')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(load).toHaveBeenCalledWith('/srv/kit/.kit/runs/r/KC/screenshots/ac2.png');
    expect(screen.getByTestId('criterion-AC2-result')).toHaveTextContent('fail');
    expect(screen.getByText(/badge missing/)).toBeInTheDocument();
    expect(screen.getByText('No pull request yet')).toBeInTheDocument();
  });
});

describe('TokenMeter (KC-S2.1.7 AC2)', () => {
  it('shows tokens per role for the run, largest first', () => {
    render(
      <TokenMeter
        roleTotals={{
          coder: { sessions: 3, tokens_in: 42000, tokens_out: 8000, cost: 0 },
          refiner: { sessions: 1, tokens_in: 3000, tokens_out: 500, cost: 0 },
        }}
        totals={{ sessions: 4, tokens_in: 45000, tokens_out: 8500, cost: 0.42 }}
      />
    );
    const rows = screen.getAllByTestId(/^tokens-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['tokens-coder', 'tokens-refiner']);
    expect(rows[0]).toHaveTextContent('50.0k (42.0k in / 8.0k out) · 3 sessions');
    expect(screen.getByTestId('token-meter')).toHaveTextContent('53.5k total · $0.42');
  });
});
