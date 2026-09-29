/**
 * KC-S1.11.6: the cloud-escalation switch in Settings, and the escalation
 * marker on the Coding tab's role timeline.
 */

import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudEscalationSettings } from '../../../renderer/components/features/coding/HarnessSettings';
import { RoleTimeline } from '../../../renderer/components/features/coding/RunStream';
import {
  DEFAULT_CLOUD_ESCALATION,
  normalizeCloudEscalation,
  type CloudEscalationPolicy,
  type HarnessFrame,
} from '../../../shared/harness-types';

function installEscalationApi(initial: CloudEscalationPolicy = DEFAULT_CLOUD_ESCALATION) {
  let stored = initial;
  const api = {
    escalation: jest.fn(async () => ({ success: true, data: stored })),
    setEscalation: jest.fn(async (policy: CloudEscalationPolicy) => {
      stored = normalizeCloudEscalation(policy);
      return { success: true, data: stored };
    }),
  };
  (window as any).api = { ...(window as any).api, harness: api };
  return api;
}

describe('CloudEscalationSettings (KC-S1.11.6 AC1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is off by default, with both triggers listed but disabled', async () => {
    installEscalationApi();
    render(<CloudEscalationSettings />);
    expect(screen.getByText('Escalate hard stories to cloud (DAMA → Vercel)')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-escalation-enabled')).not.toBeChecked();
    expect(screen.getByTestId('cloud-escalation-stuck_ladder')).toBeDisabled();
    expect(screen.getByTestId('cloud-escalation-size_l_xl')).toBeDisabled();
  });

  it('turning it on saves the policy to the app config', async () => {
    const api = installEscalationApi();
    render(<CloudEscalationSettings />);
    await userEvent.click(screen.getByTestId('cloud-escalation-enabled'));
    await waitFor(() =>
      expect(api.setEscalation).toHaveBeenCalledWith({ enabled: true, triggers: ['stuck_ladder', 'size_l_xl'] })
    );
    expect(screen.getByTestId('cloud-escalation-enabled')).toBeChecked();
    expect(screen.getByTestId('cloud-escalation-size_l_xl')).toBeEnabled();
  });

  it('a trigger can be turned off on its own', async () => {
    const api = installEscalationApi({ enabled: true, triggers: ['stuck_ladder', 'size_l_xl'] });
    render(<CloudEscalationSettings />);
    await waitFor(() => expect(screen.getByTestId('cloud-escalation-enabled')).toBeChecked());
    await userEvent.click(screen.getByTestId('cloud-escalation-size_l_xl'));
    await waitFor(() =>
      expect(api.setEscalation).toHaveBeenLastCalledWith({ enabled: true, triggers: ['stuck_ladder'] })
    );
    expect(screen.getByTestId('cloud-escalation-size_l_xl')).not.toBeChecked();
  });

  it('a failed save puts the switch back and says why', async () => {
    const api = installEscalationApi();
    api.setEscalation.mockResolvedValueOnce({ success: false, error: { message: 'Failed to set config' } } as any);
    render(<CloudEscalationSettings />);
    await userEvent.click(screen.getByTestId('cloud-escalation-enabled'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to set config'));
    expect(screen.getByTestId('cloud-escalation-enabled')).not.toBeChecked();
  });
});

function bus(eventId: string, eventType: string, payload: Record<string, unknown>): HarnessFrame {
  return {
    event: 'feature_bus',
    id: eventId,
    data: {
      event_id: eventId,
      event_type: eventType,
      timestamp: '2026-09-29T12:00:00Z',
      correlation_id: 'KC-S9.9.9',
      payload: { story_id: 'KC-S9.9.9', ...payload },
    },
  } as unknown as HarnessFrame;
}

describe('RoleTimeline escalation marker (KC-S1.11.6 AC4)', () => {
  it('marks the steps that ran on the escalation route, with the model that served them', () => {
    const frames = [
      bus('1', 'kit.phase.start', { phase: 'CODE' }),
      bus('2', 'kit.story.session', { role: 'coder', model: 'kit-builder', served_model: 'qwen3-coder-30B' }),
      bus('3', 'kit.phase.end', { phase: 'CODE' }),
      bus('4', 'kit.story.escalated', { trigger: 'stuck_ladder', alias: 'kit-builder@escalate' }),
      bus('5', 'kit.phase.start', { phase: 'CODE' }),
      bus('6', 'kit.story.session', { role: 'coder', model: 'kit-builder@escalate', served_model: 'moonshotai/kimi-k3' }),
    ];
    render(<RoleTimeline frames={frames} storyId="KC-S9.9.9" />);

    expect(screen.queryByTestId('timeline-escalated-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('timeline-escalated-1')).toHaveTextContent('cloud · stuck ladder');
    expect(screen.getByTestId('timeline-step-1')).toHaveTextContent('kit-builder@escalate → moonshotai/kimi-k3');
  });
});
