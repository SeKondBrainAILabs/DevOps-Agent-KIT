/**
 * StaleSessionsDialog
 *
 * Shown on startup when the stale-session scan finds sessions that are idle
 * (14+ days) and fully committed BUT still carry unmerged commits — so removing
 * them would orphan that work. Provably-safe stale sessions (already merged) are
 * auto-removed by the main process and never reach this dialog.
 *
 * Sessions are grouped by repo. Each row shows how many unmerged commits would
 * be lost and which primary branches (if any) already contain the work, so the
 * user can decide what is genuinely safe to remove.
 */

import React, { useMemo, useState } from 'react';
import type { StaleSessionInfo } from '../../../shared/types';

interface StaleSessionsDialogProps {
  sessions: StaleSessionInfo[];
  onClose: () => void;
  /** Called after sessions are removed so the parent can refresh its list. */
  onRemoved?: (removedSessionIds: string[]) => void;
}

export function StaleSessionsDialog({
  sessions,
  onClose,
  onRemoved,
}: StaleSessionsDialogProps): React.ReactElement {
  // Default selection: none — these all have unmerged work, so opt-in only.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Group sessions by repo for display.
  const byRepo = useMemo(() => {
    const map = new Map<string, StaleSessionInfo[]>();
    for (const s of sessions) {
      const list = map.get(s.repoName) ?? [];
      list.push(s);
      map.set(s.repoName, list);
    }
    return Array.from(map.entries());
  }, [sessions]);

  const toggle = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const handleRemove = async () => {
    setRunning(true);
    setError(null);
    const ids = Array.from(selected);
    const removed: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const sessionId = ids[i];
      const session = sessions.find((s) => s.sessionId === sessionId);
      setProgress(`Removing ${session?.branchName ?? sessionId} (${i + 1}/${ids.length})…`);
      try {
        const result = await window.api?.instance?.deleteWithCleanup?.(
          sessionId,
          {
            deleteWorktree: true,
            deleteLocalBranch: false, // unmerged work — keep the branch so commits survive
            deleteRemoteBranch: false,
          },
          session ? { repoPath: session.repoPath, branchName: session.branchName, worktreePath: session.worktreePath } : undefined
        );
        if (result?.success) removed.push(sessionId);
        else errors.push(`${session?.branchName ?? sessionId}: ${result?.error?.message ?? 'failed'}`);
      } catch (err) {
        errors.push(`${session?.branchName ?? sessionId}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }

    setProgress('');
    setRunning(false);
    if (errors.length > 0) setError(`Completed with errors:\n${errors.join('\n')}`);
    if (removed.length > 0) onRemoved?.(removed);
    // If everything selected was removed and nothing errored, close.
    if (errors.length === 0) onClose();
    else setSelected(new Set(Array.from(selected).filter((id) => !removed.includes(id))));
  };

  return (
    <div className="fixed inset-0 bg-black/15 backdrop-blur-[2px] flex items-center justify-center z-50">
      <div className="bg-white border border-[rgba(0,0,0,0.10)] rounded-[22px] shadow-[0_4px_6px_rgba(0,0,0,0.08)] w-full max-w-2xl max-h-[85vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="p-4 border-b border-[rgba(0,0,0,0.10)] flex items-start justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-[rgba(0,0,0,0.45)]">Startup cleanup</p>
            <h2 className="text-lg font-semibold text-text-primary mt-0.5">Stale sessions need review</h2>
            <p className="text-sm text-text-secondary mt-1">
              {sessions.length} idle session{sessions.length === 1 ? '' : 's'} (14+ days, fully committed) still
              {' '}have unmerged commits. Removing them deletes the worktree but keeps the branch, so the commits are
              {' '}preserved. Select any you want to clean up.
            </p>
          </div>
          <button onClick={onClose} className="btn-icon" disabled={running} title="Keep all for now">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {byRepo.map(([repoName, repoSessions]) => (
            <div key={repoName}>
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-[rgba(0,0,0,0.45)] mb-2">{repoName}</p>
              <div className="space-y-1">
                {repoSessions.map((s) => {
                  const isSelected = selected.has(s.sessionId);
                  return (
                    <label
                      key={s.sessionId}
                      className={`flex items-center gap-3 p-2.5 rounded-[10px] cursor-pointer border transition-colors ${
                        isSelected ? 'bg-red-500/5 border-red-500/30' : 'border-[rgba(0,0,0,0.10)] hover:bg-[#FAFAF7]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(s.sessionId)}
                        disabled={running}
                        className="w-4 h-4 rounded border-[rgba(0,0,0,0.10)]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-sm text-text-primary truncate">{s.branchName}</code>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 inline-flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            {s.unmergedCommitCount} unmerged commit{s.unmergedCommitCount === 1 ? '' : 's'}
                          </span>
                          {s.mergedIntoBranches.length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-700">
                              in {s.mergedIntoBranches.join(', ')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-secondary mt-0.5">Idle {s.daysIdle} days</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-600 text-xs whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[rgba(0,0,0,0.10)] space-y-3">
          {running && progress && <div className="text-xs text-text-secondary">{progress}</div>}
          <div className="flex gap-2">
            <button onClick={onClose} className="kb-btn flex-1" disabled={running}>
              Keep all
            </button>
            <button
              onClick={handleRemove}
              disabled={running || selected.size === 0}
              className="flex-1 px-4 py-2 bg-black text-white rounded-full font-medium hover:bg-black/90 transition-colors disabled:opacity-50"
            >
              {running ? 'Removing…' : `Remove ${selected.size} session${selected.size === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="text-[11px] text-text-secondary">
            Worktrees are removed; branches are kept so unmerged commits remain recoverable. Sessions with merged work
            were already cleaned up automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
