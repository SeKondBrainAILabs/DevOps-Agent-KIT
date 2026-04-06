/**
 * DeleteSessionDialog Component
 * Shows safety info (uncommitted changes, unpushed commits) and lets the user
 * choose whether to delete the worktree, local branch, and remote branch.
 */

import React, { useState, useEffect } from 'react';

interface DeleteSafetyInfo {
  hasWorktree: boolean;
  worktreePath: string | null;
  hasUncommittedChanges: boolean;
  unpushedCommitCount: number;
  hasRemoteBranch: boolean;
  branchName: string;
  repoPath: string;
}

interface DeleteSessionDialogProps {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteSessionDialog({
  sessionId,
  sessionName,
  onClose,
  onDeleted,
}: DeleteSessionDialogProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [safety, setSafety] = useState<DeleteSafetyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Cleanup options
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [deleteLocalBranch, setDeleteLocalBranch] = useState(true);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false);

  // Load safety info on mount
  useEffect(() => {
    setLoading(true);
    window.api?.instance?.deleteSafetyCheck?.(sessionId)
      .then((result) => {
        if (result?.success && result.data) {
          setSafety(result.data);
          // Default remote deletion to true if remote exists and it's safe
          if (result.data.hasRemoteBranch && !result.data.hasUncommittedChanges && result.data.unpushedCommitCount === 0) {
            setDeleteRemoteBranch(true);
          }
        } else {
          setError(result?.error?.message || 'Failed to check session safety');
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to check'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      const result = await window.api?.instance?.deleteWithCleanup?.(sessionId, {
        deleteWorktree,
        deleteLocalBranch,
        deleteRemoteBranch,
      });
      if (result?.success) {
        onDeleted();
      } else {
        setError(result?.error?.message || 'Failed to delete session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsDeleting(false);
    }
  };

  const hasDanger = safety?.hasUncommittedChanges || (safety?.unpushedCommitCount ?? 0) > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary border border-border rounded-lg w-full max-w-md animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-gray-100">Delete Session</h2>
          <button onClick={onClose} className="btn-icon" disabled={isDeleting}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Session info */}
          <div className="p-3 bg-surface-tertiary rounded-md">
            <p className="font-medium text-gray-200">{sessionName}</p>
            {safety && (
              <p className="text-sm text-gray-400 mt-1">{safety.branchName}</p>
            )}
          </div>

          {loading && (
            <div className="flex items-center gap-2 text-text-secondary text-sm">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Checking for uncommitted changes...
            </div>
          )}

          {/* Safety warnings */}
          {safety && hasDanger && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-md text-sm space-y-1">
              {safety.hasUncommittedChanges && (
                <p className="text-yellow-400 font-medium">
                  Warning: Uncommitted changes detected in worktree
                </p>
              )}
              {safety.unpushedCommitCount > 0 && (
                <p className="text-yellow-400 font-medium">
                  Warning: {safety.unpushedCommitCount} unpushed commit{safety.unpushedCommitCount > 1 ? 's' : ''} will be lost
                </p>
              )}
              <p className="text-yellow-500/70">
                These changes have not been saved to the remote and will be permanently lost.
              </p>
            </div>
          )}

          {safety && !hasDanger && (
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-md text-green-400 text-sm">
              Safe to delete — no uncommitted changes or unpushed commits.
            </div>
          )}

          {/* Cleanup options */}
          {safety && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-300">Cleanup options:</p>

              {safety.hasWorktree && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteWorktree}
                    onChange={(e) => setDeleteWorktree(e.target.checked)}
                    className="w-4 h-4 rounded border-border bg-surface-tertiary"
                    disabled={isDeleting}
                  />
                  <span className="text-gray-300 text-sm">
                    Delete local worktree
                    <span className="text-gray-500 text-xs ml-1">({safety.worktreePath})</span>
                  </span>
                </label>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteLocalBranch}
                  onChange={(e) => setDeleteLocalBranch(e.target.checked)}
                  className="w-4 h-4 rounded border-border bg-surface-tertiary"
                  disabled={isDeleting}
                />
                <span className="text-gray-300 text-sm">
                  Delete local branch <code className="text-xs text-gray-400">{safety.branchName}</code>
                </span>
              </label>

              {safety.hasRemoteBranch && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteRemoteBranch}
                    onChange={(e) => setDeleteRemoteBranch(e.target.checked)}
                    className="w-4 h-4 rounded border-border bg-surface-tertiary"
                    disabled={isDeleting}
                  />
                  <span className="text-gray-300 text-sm">
                    Delete remote branch <code className="text-xs text-gray-400">origin/{safety.branchName}</code>
                  </span>
                </label>
              )}

              {!safety.hasRemoteBranch && (
                <p className="text-xs text-gray-500 ml-6">No remote branch found</p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary flex-1" disabled={isDeleting}>
              Cancel
            </button>
            <button
              onClick={handleDelete}
              className="btn-primary flex-1 bg-red-600 hover:bg-red-700"
              disabled={isDeleting || loading}
            >
              {isDeleting ? 'Deleting...' : hasDanger ? 'Delete Anyway' : 'Delete Session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
