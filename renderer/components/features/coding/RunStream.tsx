/**
 * RunStream (KC-S2.1.4): a story's per-role timeline, with the model that
 * served each step, and the run's live event stream.
 */

import React, { useEffect, useRef } from 'react';
import { describeFrame, storyTimeline, type HarnessFrame } from '../../../../shared/harness-types';
import { formatTokens } from './CodingBoard';

export function RoleTimeline({ frames, storyId }: { frames: HarnessFrame[]; storyId: string }): React.ReactElement {
  const steps = storyTimeline(frames, storyId);
  return (
    <section className="card p-4" data-testid="role-timeline" aria-label="Role timeline">
      <h3 className="kb-eyebrow">Roles</h3>
      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">No role has started yet.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-3 text-sm" data-testid={`timeline-step-${i}`}>
              <span
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${step.status === 'running' ? 'bg-status-working animate-pulse' : 'bg-status-success'}`}
                aria-label={step.status}
              />
              <span className="w-28 font-medium">{step.role}</span>
              <span className="flex-1 truncate font-mono text-xs text-text-secondary" title={step.model}>
                {step.served_model || step.model ? (
                  <>
                    {step.model}
                    {step.served_model && step.served_model !== step.model ? ` → ${step.served_model}` : ''}
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="text-xs text-text-secondary w-24 text-right">
                {step.tokens_in !== undefined ? `${formatTokens((step.tokens_in ?? 0) + (step.tokens_out ?? 0))} tok` : ''}
                {step.seconds ? ` · ${step.seconds.toFixed(1)}s` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function LiveStream({
  frames,
  storyId,
  connected,
  error,
}: {
  frames: HarnessFrame[];
  storyId: string;
  connected: boolean;
  error: string | null;
}): React.ReactElement {
  // The terminal frame already says the run finished; skip its kit.run.terminal twin.
  const mine = frames.filter((f) => {
    if (f.data.event_type === 'kit.run.terminal') return false;
    const sid = f.data.payload?.story_id ?? f.data.correlation_id;
    return f.event === 'terminal' || !sid || sid === storyId;
  });
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Follow the newest event, as a live log does.
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [mine.length]);
  return (
    <section className="card p-4" data-testid="live-stream" aria-label="Live events">
      <div className="flex items-center justify-between">
        <h3 className="kb-eyebrow">Live</h3>
        <span className={`badge ${connected ? 'badge-success' : 'badge-warning'}`} data-testid="stream-status">
          {connected ? 'connected' : 'reconnecting'}
        </span>
      </div>
      {!connected && error && <p className="mt-1 text-xs text-text-secondary">{error}</p>}
      <ol ref={list} className="mt-2 max-h-72 overflow-auto space-y-1 font-mono text-[11px]" data-testid="live-events">
        {mine.map((f) => (
          <li key={f.event_id} className="flex gap-2">
            <span className="text-text-secondary flex-shrink-0">{f.timestamp ? f.timestamp.slice(11, 19) : ''}</span>
            <span>{describeFrame(f)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
