/**
 * HarnessSettings (KC-S2.1.2 AC1): the KIT Harness URL and bearer token, in
 * Settings → Credentials. The token is stored with the other Kanvas
 * credentials and never shown again once saved.
 *
 * Also the cloud-escalation switch (KC-S1.11.6 AC1), which the harness reads
 * over MCP with kit_get_harness_policy.
 */

import React, { useEffect, useState } from 'react';
import {
  DEFAULT_CLOUD_ESCALATION,
  type CloudEscalationPolicy,
  type EscalationTrigger,
} from '../../../../shared/harness-types';

const TRIGGER_LABELS: Record<EscalationTrigger, string> = {
  stuck_ladder: 'When local models get stuck (after the builder-large rung)',
  size_l_xl: 'For stories the Planner sizes L or XL',
};

/** "Escalate hard stories to cloud (DAMA → Vercel)": off by default, saved on change. */
export function CloudEscalationSettings(): React.ReactElement {
  const [policy, setPolicy] = useState<CloudEscalationPolicy>(DEFAULT_CLOUD_ESCALATION);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.harness?.escalation?.().then((res) => {
      if (res?.success && res.data) setPolicy(res.data);
    });
  }, []);

  const save = async (next: CloudEscalationPolicy) => {
    const previous = policy;
    setPolicy(next);
    setError(null);
    const res = await window.api.harness.setEscalation(next);
    if (res.success && res.data) {
      setPolicy(res.data);
    } else {
      setPolicy(previous);
      setError(res.error?.message ?? 'Could not save the escalation setting');
    }
  };

  const toggleTrigger = (trigger: EscalationTrigger, on: boolean) => {
    const triggers = on
      ? [...new Set([...policy.triggers, trigger])]
      : policy.triggers.filter((t) => t !== trigger);
    void save({ ...policy, triggers });
  };

  return (
    <div className="space-y-2" data-testid="cloud-escalation-settings">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          data-testid="cloud-escalation-enabled"
          checked={policy.enabled}
          onChange={(e) => void save({ ...policy, enabled: e.target.checked })}
        />
        Escalate hard stories to cloud (DAMA → Vercel)
      </label>
      <div className="pl-6 space-y-1">
        {(Object.keys(TRIGGER_LABELS) as EscalationTrigger[]).map((trigger) => (
          <label key={trigger} className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              data-testid={`cloud-escalation-${trigger}`}
              disabled={!policy.enabled}
              checked={policy.triggers.includes(trigger)}
              onChange={(e) => toggleTrigger(trigger, e.target.checked)}
            />
            {TRIGGER_LABELS[trigger]}
          </label>
        ))}
        <p className="text-xs text-gray-500">
          Escalated builder sessions run on an open-weight cloud model through Core AI Backend, billed to the KIT
          tenant. KIT Harness checks this before each story.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
    </div>
  );
}

export function HarnessSettings(): React.ReactElement {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void window.api.harness?.connection?.().then((res) => {
      if (res?.success && res.data) {
        setUrl(res.data.url ?? '');
        setHasToken(res.data.hasToken);
      }
    });
  }, []);

  const save = async () => {
    setBusy(true);
    setNote(null);
    const res = await window.api.harness.setConnection(url.trim(), token.trim() || undefined);
    setBusy(false);
    if (res.success && res.data) {
      setHasToken(res.data.hasToken);
      setToken('');
      setNote({ type: 'success', text: 'KIT Harness connection saved' });
    } else {
      setNote({ type: 'error', text: res.error?.message ?? 'Could not save the connection' });
    }
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    const res = await window.api.harness.clusterStatus();
    setBusy(false);
    if (res.success) {
      const models = res.data?.core
        ? res.data.core.ok ? 'Core AI Backend up' : 'Core AI Backend down'
        : res.data?.litellm?.ok ? 'LiteLLM up' : 'LiteLLM down';
      const devops = res.data?.devops_agent?.ok ? 'DevOps Agent up' : 'DevOps Agent down';
      setNote({ type: 'success', text: `Connected to KIT Harness (${models}, ${devops})` });
    } else {
      setNote({ type: 'error', text: res.error?.message ?? 'KIT Harness is unreachable' });
    }
  };

  return (
    <div className="space-y-3 pt-4 border-t border-border" data-testid="harness-settings">
      <div>
        <label className="label" htmlFor="harness-url">KIT Harness URL</label>
        <input
          id="harness-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://mac-mini:39200/mcp"
          className="input"
        />
      </div>
      <div>
        <label className="label" htmlFor="harness-token">KIT Harness token</label>
        <div className="flex items-center gap-2">
          <input
            id="harness-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? '•••••••••••• (saved; type to replace)' : 'KIT_HARNESS_TOKEN'}
            className="input flex-1"
          />
          {hasToken && <span className="badge badge-success">Configured</span>}
        </div>
        <p className="text-xs text-gray-500 mt-1">The Coding tab talks to the harness over MCP with this bearer token.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" disabled={busy || !url.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save harness connection'}
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !url.trim()} onClick={test}>
          Test
        </button>
      </div>
      {note && (
        <p role="status" className={`text-sm ${note.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{note.text}</p>
      )}
      <CloudEscalationSettings />
    </div>
  );
}
