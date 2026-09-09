/**
 * StaleBranchesDialog Component
 * Lists all branches in a repo with staleness, merged status, and zero-diff
 * indicators. Lets the user pick branches to archive (rename to archive/<name>-<date>)
 * and optionally delete locally + remotely.
 */

import React, { useEffect, useState } from 'react';

interface StaleBranchInfo {
  name: string;
  lastCommitDate: string;
  lastCommitIso: string;
  daysSinceLastCommit: number;
  isMerged: boolean;
  hasNoDiffVsBase: boolean;
  aheadCount: number;
  behindCount: number;
  isStale: boolean;
  safeToPrune: boolean;
}

interface StaleBranchesDialogProps {
  repoPath: string;
  /** Initial base branch to compare against. Defaults to 'main'. */
  baseBranch?: string;
  /** Candidate primary branches for the base-branch selector. */
  baseBranchCandidates?: string[];
  onClose: () => void;
}

export function StaleBranchesDialog({
  repoPath,
  baseBranch: initialBaseBranch = 'main',
  baseBranchCandidates = ['main', 'development', 'develop', 'master'],
  onClose,
}: StaleBranchesDialogProps): React.ReactElement {
  const [baseBranch, setBaseBranch] = useState(initialBaseBranch);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<StaleBranchInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>('');

  const load = async (base = baseBranch) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.api?.git?.analyzeStaleBranches?.(repoPath, base, 30);
      if (result?.success && result.data) {
        setBranches(result.data);
        // Pre-select all safe-to-prune branches
        setSelected(new Set(result.data.filter(b => b.safeToPrune).map(b => b.name)));
      } else {
        setError(result?.error?.message || 'Failed to analyze branches');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(baseBranch); }, [repoPath, baseBranch]);

  const toggleBranch = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleArchive = async () => {
    setRunning(true);
    setError(null);
    const selectedBranches = Array.from(selected);
    let done = 0;
    const errors: string[] = [];

    for (const branchName of selectedBranches) {
      setProgress(`Archiving ${branchName} (${done + 1}/${selectedBranches.length})...`);
      try {
        const result = await window.api?.git?.archiveBranch?.(repoPath, branchName, {
          deleteOriginal: true,
          deleteRemote,
        });
        if (!result?.success) {
          errors.push(`${branchName}: ${result?.error?.message || 'unknown error'}`);
        }
      } catch (err) {
        errors.push(`${branchName}: ${err instanceof Error ? err.message : 'error'}`);
      }
      done++;
    }

    setProgress('');
    setRunning(false);
    if (errors.length > 0) {
      setError(`Completed with errors:\n${errors.join('\n')}`);
    }
    // Reload list to reflect changes
    await load();
    setSelected(new Set());
  };

  const safeCount = branches.filter(b => b.safeToPrune).length;
  const staleCount = branches.filter(b => b.isStale && !b.safeToPrune).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary border border-[rgba(0,0,0,0.10)] rounded-[14px] w-full max-w-3xl max-h-[85vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[rgba(0,0,0,0.10)]">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Branch Cleanup</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-text-secondary">Base:</span>
              <select
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="text-xs border border-[rgba(0,0,0,0.10)] rounded-md px-1.5 py-0.5 bg-surface-secondary text-text-primary focus:outline-none focus:ring-1 focus:ring-kanvas-blue/50"
                disabled={running}
              >
                {baseBranchCandidates.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              {!loading && (
                <span className="text-xs text-text-secondary">
                  {safeCount} safe to prune, {staleCount} stale
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="btn-icon" disabled={running}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center gap-2 text-text-secondary text-sm">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Analyzing branches...
            </div>
          )}

          {!loading && branches.length === 0 && !error && (
            <p className="text-text-secondary text-sm">No branches to clean up.</p>
          )}

          {!loading && branches.length > 0 && (
            <div className="space-y-1">
              {branches.map((b) => {
                const isSelected = selected.has(b.name);
                const reason = b.isMerged
                  ? 'Merged into base'
                  : b.hasNoDiffVsBase
                    ? 'No diff vs base'
                    : b.isStale
                      ? `Stale (${b.daysSinceLastCommit}d)`
                      : null;

                return (
                  <label
                    key={b.name}
                    className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-500/10 border border-blue-500/30' : 'hover:bg-surface-tertiary border border-transparent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleBranch(b.name)}
                      className="w-4 h-4 rounded border-[rgba(0,0,0,0.10)] bg-surface-tertiary"
                      disabled={running}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-sm text-gray-200 truncate">{b.name}</code>
                        {b.isMerged && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">merged</span>
                        )}
                        {b.hasNoDiffVsBase && !b.isMerged && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">no diff</span>
                        )}
                        {b.isStale && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">stale</span>
                        )}
                      </div>
                      <div className="text-xs text-text-secondary mt-0.5">
                        Last commit {b.lastCommitDate}
                        {b.aheadCount > 0 && ` · ${b.aheadCount} ahead`}
                        {b.behindCount > 0 && ` · ${b.behindCount} behind`}
                        {reason && ` · ${reason}`}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-xs whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[rgba(0,0,0,0.10)] space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={deleteRemote}
              onChange={(e) => setDeleteRemote(e.target.checked)}
              className="w-4 h-4 rounded border-[rgba(0,0,0,0.10)] bg-surface-tertiary"
              disabled={running}
            />
            <span className="text-gray-300 text-sm">
              Also delete remote branches (origin/...)
            </span>
          </label>

          {running && progress && (
            <div className="text-xs text-text-secondary">{progress}</div>
          )}

          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary flex-1" disabled={running}>
              Cancel
            </button>
            <button
              onClick={handleArchive}
              className="btn-primary flex-1"
              disabled={running || loading || selected.size === 0}
            >
              {running
                ? 'Archiving...'
                : `Archive ${selected.size} branch${selected.size === 1 ? '' : 'es'}`}
            </button>
          </div>
          <p className="text-[11px] text-text-secondary">
            Archived branches are renamed to <code>archive/&lt;name&gt;-&lt;yyyymmdd&gt;</code>, preserving the commits.
          </p>
        </div>
      </div>
    </div>
  );
}
