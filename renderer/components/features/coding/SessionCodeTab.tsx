/**
 * SessionCodeTab: the Coding tab scoped to one session's repo, shown as the Code tab
 * in a session. Stories and epics submitted here run against this session's checkout,
 * and KIT Harness starts one DevOps session (worktree) per story; those spawned
 * sessions are listed here and open like any other session.
 */

import React, { useMemo, useState } from 'react';
import type { SessionReport } from '../../../../shared/agent-protocol';
import { runsForRepo, spawnedSessions } from '../../../../shared/harness-types';
import { useUIStore } from '../../../store/uiStore';
import { useAgentStore } from '../../../store/agentStore';
import { useClusterStatus, useHarnessRuns } from '../../../hooks/useHarness';
import { CodingBoard } from './CodingBoard';
import { LanesHeader } from './LanesHeader';
import { HarnessOffline } from './HarnessOffline';
import { RunProposal } from './Gates';
import { StoryRunView } from './StoryRunView';

export function SessionCodeTab({ session }: { session: SessionReport }): React.ReactElement {
  const runs = useHarnessRuns();
  const cluster = useClusterStatus();
  const setShowSettingsModal = useUIStore((s) => s.setShowSettingsModal);
  const reportedSessions = useAgentStore((s) => s.reportedSessions);
  const setSelectedSession = useAgentStore((s) => s.setSelectedSession);
  const [selected, setSelected] = useState<{ runId: string; storyId: string } | null>(null);
  const [busyRun, setBusyRun] = useState<string | null>(null);

  const repoPath = session.repoPath;
  const repoRuns = useMemo(() => runsForRepo(runs.runs, repoPath), [runs.runs, repoPath]);
  const spawned = useMemo(() => spawnedSessions(repoRuns), [repoRuns]);
  const proposals = repoRuns.filter((r) => r.status === 'awaiting_approval');
  const offline = runs.status !== 'ready' && runs.status !== 'loading';

  const decideRun = async (runId: string, approved: boolean) => {
    setBusyRun(runId);
    await window.api.harness.approve(runId, null, approved);
    setBusyRun(null);
    await runs.refresh();
  };

  if (selected) {
    return (
      <div className="h-full overflow-auto" data-testid="session-code-tab">
        <StoryRunView runId={selected.runId} storyId={selected.storyId} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="session-code-tab">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2">
        <p className="text-xs text-text-secondary">
          KIT Harness runs for <code>{repoPath}</code>
        </p>
        <LanesHeader status={cluster.data} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {offline && (
          <HarnessOffline
            compact={runs.runs.length > 0}
            state={runs.status}
            error={runs.error}
            onOpenSettings={() => setShowSettingsModal(true)}
            onRetry={() => void runs.refresh()}
          />
        )}
        <SubmitWork
          repoPath={repoPath}
          disabled={offline}
          onSubmitted={() => void runs.refresh()}
        />
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
        {spawned.length > 0 && (
          <section className="px-5 pt-4" data-testid="spawned-sessions">
            <h3 className="text-sm font-semibold mb-2">Sessions started by KIT Harness</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {spawned.map((s) => {
                const known = reportedSessions.has(s.session_id);
                return (
                  <li key={`${s.run_id}:${s.story_id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-xs text-text-secondary mr-2">{s.story_id}</span>
                      {s.title}
                      <span className="ml-2 text-xs text-text-secondary">{s.state.replace(/_/g, ' ')}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {s.pr_url && (
                        <a className="text-xs hover:underline" href={s.pr_url} target="_blank" rel="noreferrer">
                          PR
                        </a>
                      )}
                      <button
                        type="button"
                        className="text-xs font-medium hover:underline disabled:opacity-50 disabled:no-underline"
                        disabled={!known}
                        title={known ? 'Open this session' : 'The DevOps Agent has not reported this session yet'}
                        onClick={() => setSelectedSession(s.session_id)}
                      >
                        Open session
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {repoRuns.length === 0 && !offline && runs.status === 'ready' && (
          <p className="px-5 pt-4 text-sm text-text-secondary">
            No KIT Harness runs for this repo yet. Submit stories or an epic above; each story gets its own session.
          </p>
        )}
        <CodingBoard runs={repoRuns} onOpenStory={(runId, storyId) => setSelected({ runId, storyId })} />
      </div>
    </div>
  );
}

/** Hand stories, an epic, a PRD, a tracker epic URL or a kit:// reference to the harness for this repo. */
function SubmitWork({
  repoPath,
  disabled,
  onSubmitted,
}: {
  repoPath: string;
  disabled: boolean;
  onSubmitted: () => void;
}): React.ReactElement {
  const [source, setSource] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = source.trim();
    if (!text) return;
    setSending(true);
    setResult(null);
    const reply = await window.api.harness.submitEpic(text, repoPath, { auto_approve: autoApprove });
    setSending(false);
    if (reply.success) {
      const runId = String((reply.data as Record<string, unknown> | undefined)?.run_id ?? '');
      setResult({ ok: true, message: runId ? `Submitted as run ${runId}.` : 'Submitted.' });
      setSource('');
      onSubmitted();
    } else {
      setResult({ ok: false, message: reply.error?.message ?? 'KIT Harness did not accept it.' });
    }
  };

  return (
    <form className="px-5 pt-4 space-y-2" onSubmit={(e) => void submit(e)} data-testid="session-code-submit">
      <label className="label" htmlFor="session-code-source">
        Build in this repo
      </label>
      <textarea
        id="session-code-source"
        className="input w-full min-h-[96px] font-mono text-xs"
        placeholder="Stories or an epic in markdown, a PRD, an s9n tracker epic URL, or kit://<product>"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        disabled={disabled || sending}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Approve the proposed stories and plans automatically
        </label>
        <button
          type="submit"
          className="px-4 py-1.5 text-sm font-medium rounded-full bg-black text-white disabled:opacity-50"
          disabled={disabled || sending || !source.trim()}
        >
          {sending ? 'Sending…' : 'Send to KIT Harness'}
        </button>
      </div>
      {result && (
        <p role="status" className={`text-sm ${result.ok ? 'text-green-700' : 'text-red-600'}`}>
          {result.message}
        </p>
      )}
    </form>
  );
}
