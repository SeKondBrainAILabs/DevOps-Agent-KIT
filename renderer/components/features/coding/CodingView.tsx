/**
 * CodingView (KC-S2.1.1): the Coding tab, Kanvas's front door to KIT Harness.
 * Lanes header, then the board of runs and stories, or one story's run view.
 */

import React, { useState } from 'react';
import { useUIStore } from '../../../store/uiStore';
import { useClusterStatus, useHarnessRuns } from '../../../hooks/useHarness';
import { CodingBoard } from './CodingBoard';
import { LanesHeader } from './LanesHeader';
import { HarnessOffline } from './HarnessOffline';
import { RunProposal } from './Gates';
import { StoryRunView } from './StoryRunView';

export function CodingView(): React.ReactElement {
  const runs = useHarnessRuns();
  const cluster = useClusterStatus();
  const setShowSettingsModal = useUIStore((s) => s.setShowSettingsModal);
  const focusRunId = useUIStore((s) => s.codingFocusRunId);
  const setFocusRunId = useUIStore((s) => s.setCodingFocusRunId);
  const [selected, setSelected] = useState<{ runId: string; storyId: string } | null>(null);
  const [busyRun, setBusyRun] = useState<string | null>(null);

  const proposals = runs.runs.filter((r) => r.status === 'awaiting_approval');
  const decideRun = async (runId: string, approved: boolean) => {
    setBusyRun(runId);
    await window.api.harness.approve(runId, null, approved);
    setBusyRun(null);
    await runs.refresh();
  };

  const haveData = runs.runs.length > 0;
  let body: React.ReactNode;
  if (runs.status === 'loading' && !haveData) {
    body = <p className="p-6 text-sm text-text-secondary">Connecting to KIT Harness…</p>;
  } else if (runs.status !== 'ready' && runs.status !== 'loading' && !haveData) {
    body = (
      <HarnessOffline
        state={runs.status}
        error={runs.error}
        onOpenSettings={() => setShowSettingsModal(true)}
        onRetry={() => void runs.refresh()}
      />
    );
  } else if (selected) {
    body = <StoryRunView runId={selected.runId} storyId={selected.storyId} onBack={() => setSelected(null)} />;
  } else {
    body = (
      <>
        {runs.status !== 'ready' && runs.status !== 'loading' && (
          <HarnessOffline compact state={runs.status} error={runs.error} onOpenSettings={() => setShowSettingsModal(true)} onRetry={() => void runs.refresh()} />
        )}
        {proposals.length > 0 && (
          <div className="px-4 pt-3 space-y-2">
            {proposals.map((r) => (
              <RunProposal
                key={r.run_id}
                runId={r.run_id}
                epic={r.epic}
                storyCount={r.stories.length}
                questions={r.questions}
                busy={busyRun === r.run_id}
                onDecision={(approved) => void decideRun(r.run_id, approved)}
              />
            ))}
          </div>
        )}
        {!haveData && (
          <p className="px-5 pt-4 text-sm text-text-secondary">
            No runs yet. Submit stories or an epic to KIT Harness from any MCP client (harness_submit_stories, harness_submit_epic).
          </p>
        )}
        <CodingBoard runs={runs.runs} onOpenStory={(runId, storyId) => setSelected({ runId, storyId })} />
      </>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="coding-view">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <p className="kb-eyebrow">KIT Harness</p>
          <h1 className="text-xl font-semibold">Coding</h1>
        </div>
        <LanesHeader status={cluster.data} />
      </header>
      {focusRunId && (
        <FocusedRun
          runId={focusRunId}
          status={runs.runs.find((r) => r.run_id === focusRunId)?.status ?? null}
          onDismiss={() => setFocusRunId(null)}
        />
      )}
      <div className="flex-1 min-h-0 overflow-auto">{body}</div>
    </div>
  );
}

/** The run a devops-agent:// link opened (Kanvas "Build in KIT IDE", KC-S2.3.1). */
function FocusedRun({
  runId,
  status,
  onDismiss,
}: {
  runId: string;
  status: string | null;
  onDismiss: () => void;
}): React.ReactElement {
  const note =
    status === null
      ? 'KIT Harness has not reported this run yet.'
      : status === 'awaiting_approval'
        ? 'Its proposed stories are waiting for your approval below.'
        : `Status: ${status.replace(/_/g, ' ')}.`;
  return (
    <div
      role="status"
      data-testid="coding-focused-run"
      className="flex items-center justify-between gap-3 border-b border-border bg-surface-subtle px-5 py-2 text-sm"
    >
      <span>
        Opened from Kanvas: run <code className="text-xs">{runId}</code>. {note}
      </span>
      <button type="button" className="text-xs text-text-secondary hover:underline" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
