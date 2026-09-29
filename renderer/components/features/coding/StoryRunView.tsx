/**
 * StoryRunView (KC-S2.1.4-7): one story of a KIT Harness run: gates first when
 * it is waiting on a person, then roles, live events, evidence, tokens and diff.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { HarnessRun, HarnessStory } from '../../../../shared/harness-types';
import { useHarnessRunEvents } from '../../../hooks/useHarness';
import { PlanApproval, QuestionCard } from './Gates';
import { RoleTimeline, LiveStream } from './RunStream';
import { EvidencePanel } from './EvidencePanel';
import { TokenMeter } from './TokenMeter';
import { DiffPanel } from './DiffPanel';

export function StoryRunView({
  runId,
  storyId,
  onBack,
}: {
  runId: string;
  storyId: string;
  onBack: () => void;
}): React.ReactElement {
  const api = window.api.harness;
  const [story, setStory] = useState<HarnessStory | null>(null);
  const [run, setRun] = useState<HarnessRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const stream = useHarnessRunEvents(runId);

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([api.getStory(runId, storyId), api.getRun(runId)]);
    if (s.success && s.data) setStory(s.data);
    if (r.success && r.data) setRun(r.data);
  }, [api, runId, storyId]);

  // Re-read the story whenever the stream moves on, and at least every 5s.
  useEffect(() => { void refresh(); }, [refresh, stream.frames.length]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (label: string, call: () => Promise<{ success: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setNotice(null);
    const res = await call();
    setBusy(false);
    setNotice(res.success ? { type: 'success', text: label } : { type: 'error', text: res.error?.message ?? 'Failed' });
    await refresh();
  };

  const loadScreenshot = useCallback(async (path: string) => {
    const res = await api.screenshot(runId, storyId, path);
    return res.success ? res.data ?? null : null;
  }, [api, runId, storyId]);

  const loadDiff = useCallback(async () => {
    const res = await api.storyDiff(runId, storyId);
    return res.success ? { diff: res.data ?? null } : { diff: null, error: res.error?.message };
  }, [api, runId, storyId]);

  const state = story?.state ?? 'queued';
  return (
    <div className="p-5 space-y-4" data-testid="story-run-view">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button type="button" className="text-xs text-text-secondary hover:text-black" onClick={onBack}>
            ← Board
          </button>
          <p className="mt-1 font-mono text-xs text-text-secondary">{storyId} · run {runId}</p>
          <h2 className="text-lg font-semibold">{story?.title ?? storyId}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge badge-info" data-testid="story-state">{state.replace(/_/g, ' ')}</span>
          {run?.status === 'paused' ? (
            <button type="button" className="kb-btn-sm" disabled={busy} onClick={() => act('Run resumed', () => api.resume(runId))}>Resume run</button>
          ) : (
            <button type="button" className="kb-btn-sm" disabled={busy || run?.status === 'done'} onClick={() => act('Run pauses at its next step', () => api.pause(runId))}>Pause run</button>
          )}
          <button type="button" className="kb-btn-sm" disabled={busy || run?.status === 'done'} onClick={() => act('Run cancelled', () => api.cancel(runId))}>Cancel run</button>
        </div>
      </div>

      {notice && (
        <p role="status" className={`text-sm ${notice.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{notice.text}</p>
      )}
      {story?.reason && state === 'failed' && <p className="text-sm text-status-error">{story.reason}</p>}

      {state === 'awaiting_plan_approval' && (
        <PlanApproval
          plan={story?.plan ?? null}
          busy={busy}
          onDecision={(approved, comment) =>
            act(approved ? 'Plan approved' : 'Plan sent back to the Planner', () => api.approve(runId, storyId, approved, comment))
          }
        />
      )}
      {state === 'blocked' && (story?.questions?.length ?? 0) > 0 && (
        <QuestionCard
          questions={story!.questions!}
          busy={busy}
          onAnswer={(text) => act('Answers sent; the story is re-queued', () => api.answer(runId, storyId, text))}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <RoleTimeline frames={stream.frames} storyId={storyId} />
          <LiveStream frames={stream.frames} storyId={storyId} connected={stream.connected} error={stream.error} />
        </div>
        <div className="space-y-4">
          <TokenMeter roleTotals={run?.role_totals} totals={run?.totals} />
          <EvidencePanel evidence={story?.evidence ?? null} prUrl={story?.pr_url} loadScreenshot={loadScreenshot} />
        </div>
      </div>
      <DiffPanel loadDiff={loadDiff} evidence={story?.evidence ?? null} />
    </div>
  );
}
