/**
 * AgentSessionsExpiredDialog
 *
 * Shown when the agent-session reaper (R1) has acted on one or more sessions an
 * AI created. It is a report of what ALREADY happened, not a prompt — the
 * reaper runs unattended, so by the time this appears the decisions are made.
 *
 * Why the distinction matters for the copy: `StaleSessionsDialog` asks the user
 * to choose what to delete. This one tells them what was done and offers the
 * two follow-ups that are still available — pin a session so it is never reaped
 * again, or clean up one the reaper deliberately kept.
 *
 * The reaper's default is conservative: anything with uncommitted or unmerged
 * work is snapshotted and closed with the worktree KEPT. So most rows here are
 * "kept" rows, and the destructive ones are the exception.
 */

import React, { useMemo, useState } from 'react';
import type { ExpiredAgentSessionInfo } from '../../../shared/types';

interface AgentSessionsExpiredDialogProps {
  sessions: ExpiredAgentSessionInfo[];
  onClose: () => void;
  /** Called after sessions are removed so the parent can refresh its list. */
  onRemoved?: (removedSessionIds: string[]) => void;
}

const REASON_LABEL: Record<string, string> = {
  IDLE_TTL_EXCEEDED: 'idle too long',
  HARD_CEILING_EXCEEDED: 'hit the 24h ceiling',
  TTL_EXPIRED: 'TTL expired',
};

function describeAction(s: ExpiredAgentSessionInfo): {
  label: string;
  tone: 'kept' | 'removed';
  detail: string;
} {
  switch (s.action) {
    case 'delete-clean':
      return {
        label: 'Removed',
        tone: 'removed',
        detail: 'Worktree and local branch deleted — everything was committed and merged.',
      };
    case 'delete-observer':
      return {
        label: 'Removed',
        tone: 'removed',
        detail: 'Observer session — it owned no worktree or branch.',
      };
    case 'snapshot-and-close':
      return {
        label: 'Kept',
        tone: 'kept',
        detail: s.snapshotRef
          ? `Work preserved. Closed, worktree kept, and a snapshot pinned to ${s.snapshotRef}.`
          : 'Work preserved. Closed with the worktree and branch left in place.',
      };
    case 'teardown-only':
    default:
      return {
        label: 'Kept',
        tone: 'kept',
        detail: 'Session stopped. Nothing on disk was touched.',
      };
  }
}

const formatIdle = (minutes: number): string => {
  if (minutes < 90) return `${Math.round(minutes)}m idle`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h idle`;
  return `${(hours / 24).toFixed(1)}d idle`;
};

export function AgentSessionsExpiredDialog({
  sessions,
  onClose,
  onRemoved,
}: AgentSessionsExpiredDialogProps): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { kept, gone } = useMemo(() => {
    const k: ExpiredAgentSessionInfo[] = [];
    const g: ExpiredAgentSessionInfo[] = [];
    for (const s of sessions) (describeAction(s).tone === 'kept' ? k : g).push(s);
    return { kept: k, gone: g };
  }, [sessions]);

  const handlePin = async (s: ExpiredAgentSessionInfo): Promise<void> => {
    setBusy(s.sessionId);
    setError(null);
    try {
      const result = await window.api?.instance?.setPinned?.(s.sessionId, true);
      if (result?.success) setPinned((prev) => new Set(prev).add(s.sessionId));
      else setError(result?.error?.message ?? 'Could not pin that session.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pin that session.');
    } finally {
      setBusy(null);
    }
  };

  const handleCleanUp = async (s: ExpiredAgentSessionInfo): Promise<void> => {
    setBusy(s.sessionId);
    setError(null);
    try {
      const result = await window.api?.instance?.deleteWithCleanup?.(
        s.sessionId,
        {
          deleteWorktree: true,
          // Never the branch: these rows are the ones the reaper KEPT, which
          // means it found uncommitted or unmerged work, or could not verify.
          // Deleting the branch here would throw away the commits the reaper
          // deliberately preserved.
          deleteLocalBranch: false,
          deleteRemoteBranch: false,
        },
        {
          repoPath: s.repoPath,
          branchName: s.branchName,
          worktreePath: s.worktreePath,
        }
      );
      if (result?.success) {
        setRemoved((prev) => new Set(prev).add(s.sessionId));
        onRemoved?.([s.sessionId]);
      } else {
        setError(result?.error?.message ?? 'Could not clean that session up.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clean that session up.');
    } finally {
      setBusy(null);
    }
  };

  const renderRow = (s: ExpiredAgentSessionInfo): React.ReactElement => {
    const action = describeAction(s);
    const isPinned = pinned.has(s.sessionId);
    const isRemoved = removed.has(s.sessionId);
    return (
      <div
        key={s.sessionId}
        className="p-2.5 rounded-[10px] border border-[rgba(0,0,0,0.10)] bg-white"
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm text-text-primary truncate">
                {s.branchName ?? s.sessionId}
              </code>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1 ${
                  action.tone === 'kept'
                    ? 'bg-emerald-500/15 text-emerald-700'
                    : 'bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.55)]'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    action.tone === 'kept' ? 'bg-emerald-500' : 'bg-[rgba(0,0,0,0.35)]'
                  }`}
                />
                {action.label}
              </span>
              <span className="text-[10px] font-mono text-[rgba(0,0,0,0.45)]">
                {REASON_LABEL[s.reasonCode] ?? s.reasonCode.toLowerCase()} ·{' '}
                {formatIdle(s.idleMinutes)}
              </span>
            </div>
            {s.taskDescription ? (
              <p className="text-xs text-text-secondary mt-1 truncate">{s.taskDescription}</p>
            ) : null}
            <p className="text-xs text-text-secondary mt-1">{action.detail}</p>
          </div>

          {action.tone === 'kept' && !isRemoved ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => void handlePin(s)}
                disabled={busy !== null || isPinned}
                className="btn-secondary text-xs px-2 py-1"
                title="Never reap this session"
              >
                {isPinned ? 'Pinned' : 'Keep'}
              </button>
              <button
                onClick={() => void handleCleanUp(s)}
                disabled={busy !== null}
                className="btn-secondary text-xs px-2 py-1"
                title="Delete the worktree (the branch and its commits are kept)"
              >
                {busy === s.sessionId ? '…' : 'Clean up'}
              </button>
            </div>
          ) : null}
          {isRemoved ? (
            <span className="text-[10px] font-mono text-[rgba(0,0,0,0.45)] shrink-0">
              cleaned up
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/15 backdrop-blur-[2px] flex items-center justify-center z-50">
      <div className="bg-white border border-[rgba(0,0,0,0.10)] rounded-[22px] shadow-[0_4px_6px_rgba(0,0,0,0.08)] w-full max-w-2xl max-h-[85vh] flex flex-col animate-slide-up">
        <div className="p-4 border-b border-[rgba(0,0,0,0.10)] flex items-start justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-[rgba(0,0,0,0.45)]">
              Agent sessions
            </p>
            <h2 className="text-lg font-semibold text-text-primary mt-0.5">
              {sessions.length} agent session{sessions.length === 1 ? '' : 's'} expired
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              These were created by an AI and went quiet. Anything with unfinished work was
              closed but left on disk — only fully committed and merged sessions were removed.
            </p>
          </div>
          <button onClick={onClose} className="btn-icon" title="Dismiss">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {kept.length > 0 ? (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-[rgba(0,0,0,0.45)] mb-2">
                Kept — work preserved
              </p>
              <div className="space-y-1">{kept.map(renderRow)}</div>
            </div>
          ) : null}

          {gone.length > 0 ? (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-[rgba(0,0,0,0.45)] mb-2">
                Removed — nothing was outstanding
              </p>
              <div className="space-y-1">{gone.map(renderRow)}</div>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-red-600 whitespace-pre-wrap">{error}</p>
          ) : null}
        </div>

        <div className="p-4 border-t border-[rgba(0,0,0,0.10)] flex items-center justify-between">
          <p className="text-xs text-text-secondary">
            Pin a session from its row menu at any time to keep it out of the reaper.
          </p>
          <button onClick={onClose} className="btn-primary text-sm px-3 py-1.5">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
