/**
 * CloseSessionDialog Component
 * Confirmation dialog for closing sessions with merge options
 */

import React, { useState, useEffect } from 'react';
import { useSessionStore } from '../../store/sessionStore';
// BranchInfo no longer needed — branch names stored as plain strings

interface CloseSessionDialogProps {
  sessionId: string;
  onClose: () => void;
}

export function CloseSessionDialog({
  sessionId,
  onClose,
}: CloseSessionDialogProps): React.ReactElement {
  const { getSessionById, removeSession } = useSessionStore();
  const session = getSessionById(sessionId);

  const [merge, setMerge] = useState(true);
  const [mergeTarget, setMergeTarget] = useState(session?.baseBranch || 'main');
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);       // primary branches only
  const [allBranches, setAllBranches] = useState<string[]>([]);  // full list for advanced dialog
  const [showAdvancedBranches, setShowAdvancedBranches] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load branches from the ROOT repo PATH (not git.branches(sessionId), which
  // resolves the worktree from a registry only populated while the watcher runs
  // — so it returns nothing for idle/restored sessions). listBranchesForRepo is
  // path-based and only ever returns local branches.
  useEffect(() => {
    const repoPath = session?.repoPath || session?.worktreePath;
    if (repoPath) {
      window.api.git.listBranchesForRepo(repoPath).then((result) => {
        if (result.success && result.data) {
          const PRIMARY = ['main', 'master', 'development', 'develop', 'dev'];
          const isSessionBranch = (name: string) =>
            name.startsWith('origin/') || name.startsWith('remotes/') ||
            /^(codex|cursor|copilot|aider|warp|cline|session)-session-/.test(name) ||
            name.startsWith('session/');
          const filtered = result.data.filter(b => b.name && !isSessionBranch(b.name)).map(b => b.name);
          const primaries = filtered.filter(b => PRIMARY.includes(b));
          const currentTarget = mergeTarget.replace(/^origin\//, '');
          // Default picker: primary branches only (+ current target if not already in list)
          const primaryList = primaries.includes(currentTarget) ? primaries : [currentTarget, ...primaries];
          setBranches(primaryList);
          setAllBranches(filtered);
        }
      });
    }
  }, [sessionId, session?.repoPath]);

  if (!session) {
    return <div>Session not found</div>;
  }

  const handleClose = async () => {
    setError(null);
    setIsClosing(true);

    try {
      const result = await window.api.session.close({
        sessionId,
        merge,
        mergeTarget: merge ? mergeTarget : undefined,
        deleteRemote,
      });

      if (result.success) {
        removeSession(sessionId);
        onClose();
      } else {
        setError(result.error?.message || 'Failed to close session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsClosing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/15 backdrop-blur-[2px] flex items-center justify-center z-50">
      <div className="bg-white border border-[rgba(0,0,0,0.10)] rounded-[22px] shadow-[0_4px_6px_rgba(0,0,0,0.08)] w-full max-w-md animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[rgba(0,0,0,0.10)]">
          <h2 className="text-lg font-semibold text-gray-100">Close Session</h2>
          <button onClick={onClose} className="btn-icon" disabled={isClosing}>
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

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Session info */}
          <div className="p-3 bg-surface-secondary rounded-[14px] border border-[rgba(0,0,0,0.10)]">
            <p className="font-medium text-gray-200">{session.name}</p>
            <p className="text-sm text-gray-400 mt-1">{session.branchName}</p>
            <p className="text-sm text-gray-500 mt-1">
              {session.commitCount} commits
            </p>
          </div>

          {/* Warning about uncommitted changes */}
          {session.status === 'watching' && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-md text-yellow-400 text-sm">
              <strong>Warning:</strong> This session is actively watching for
              changes. Make sure all changes are committed before closing.
            </div>
          )}

          {/* Merge options */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={merge}
                onChange={(e) => setMerge(e.target.checked)}
                className="w-4 h-4 rounded border-border bg-surface-tertiary"
                disabled={isClosing}
              />
              <span className="text-gray-300">Merge before closing</span>
            </label>
          </div>

          {merge && (
            <div>
              <label className="label">Merge target branch</label>
              <select
                value={mergeTarget}
                onChange={(e) => {
                  if (e.target.value === '__advanced__') {
                    setShowAdvancedBranches(true);
                  } else {
                    setMergeTarget(e.target.value);
                  }
                }}
                className="select"
                disabled={isClosing}
              >
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
                <option value="__advanced__">Advanced…</option>
              </select>
              {/* Advanced branch dialog */}
              {showAdvancedBranches && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setShowAdvancedBranches(false)}>
                  <div className="bg-white rounded-[18px] border border-[rgba(0,0,0,0.10)] shadow-[0_8px_24px_rgba(0,0,0,0.12)] p-4 w-72 max-h-80 overflow-y-auto" onClick={e => e.stopPropagation()}>
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">All branches</p>
                    {allBranches.map(branch => (
                      <button
                        key={branch}
                        className="w-full text-left px-3 py-2 rounded-[10px] hover:bg-surface-secondary text-sm text-text-primary font-mono transition-colors"
                        onClick={() => { setShowAdvancedBranches(false); setMergeTarget(branch); }}
                      >
                        {branch}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delete remote option */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteRemote}
                onChange={(e) => setDeleteRemote(e.target.checked)}
                className="w-4 h-4 rounded border-border bg-surface-tertiary"
                disabled={isClosing}
              />
              <span className="text-gray-300">Delete remote branch</span>
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="kb-btn flex-1"
              disabled={isClosing}
            >
              Cancel
            </button>
            <button
              onClick={handleClose}
              className="flex-1 px-4 py-2 bg-red-500 text-white rounded-full font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
              disabled={isClosing}
            >
              {isClosing ? 'Closing...' : 'Close Session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
