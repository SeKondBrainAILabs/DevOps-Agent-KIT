/**
 * BranchManagerPanel (Epic C / story C1 — MVP slice)
 *
 * Tab content inside RepoDetailModal. Lists branches with the C7 hygiene
 * flags (stale / merged / deleted-on-remote / has-worktree / current),
 * a filter chip row, and the safe-to-delete leaderboard.
 *
 * Backend wire: window.api.git.listBranchesForRepo(repoPath)
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { RepoBranchRow } from '../../../shared/types';
import {
  classifyBranch,
  matchesBranchFilter,
  type BranchFilterChip,
} from '../../../shared/branch-hygiene';

export interface BranchManagerPanelProps {
  repoPath: string;
}

const CHIPS: { id: BranchFilterChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'merged', label: 'Merged' },
  { id: 'stale', label: 'Stale' },
  { id: 'deleted-on-remote', label: 'Deleted on remote' },
  { id: 'has-worktree', label: 'Has worktree' },
];

function formatRelative(ms: number): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function BranchManagerPanel({ repoPath }: BranchManagerPanelProps): React.ReactElement {
  const [rows, setRows] = useState<RepoBranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chip, setChip] = useState<BranchFilterChip>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await window.api.git.listBranchesForRepo(repoPath);
        if (cancelled) return;
        if (result.success && result.data) {
          setRows(result.data);
        } else {
          setError(result.error?.message || 'Failed to list branches');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const enriched = useMemo(
    () =>
      rows.map((r) => ({
        row: r,
        flags: classifyBranch({
          name: r.name,
          lastCommitMs: r.lastCommitMs,
          mergedIntoDefault: r.mergedIntoDefault,
          deletedOnRemote: r.deletedOnRemote,
          hasWorktree: r.hasWorktree,
          isCurrent: r.isCurrent,
        }),
      })),
    [rows]
  );

  const visible = useMemo(
    () => enriched.filter((e) => matchesBranchFilter(e.flags, chip)),
    [enriched, chip]
  );

  const safeToDeleteCount = enriched.filter((e) => e.flags.safeToDelete).length;

  return (
    <div className="flex flex-col h-full" data-testid="branch-manager-panel">
      <div className="p-3 border-b border-border flex items-center gap-2 flex-wrap">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setChip(c.id)}
            className={`text-xs px-2 py-1 rounded border ${
              chip === c.id
                ? 'bg-kanvas-blue text-white border-kanvas-blue'
                : 'border-border text-text-secondary hover:bg-surface-tertiary'
            }`}
            data-testid={`chip-${c.id}`}
          >
            {c.label}
          </button>
        ))}
        <div className="flex-1" />
        {safeToDeleteCount > 0 && (
          <span
            className="text-xs text-text-secondary"
            data-testid="safe-to-delete-count"
          >
            {safeToDeleteCount} safe to delete
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {loading && <p className="p-3 text-text-secondary text-sm">Loading branches…</p>}
        {error && (
          <p
            className="p-3 text-red-500 text-sm"
            data-testid="branch-error"
          >
            {error}
          </p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="p-3 text-text-secondary text-sm" data-testid="branch-empty">
            No branches match this filter.
          </p>
        )}
        {!loading && visible.length > 0 && (
          <table className="w-full text-sm" data-testid="branch-table">
            <thead className="text-text-secondary text-xs uppercase">
              <tr>
                <th className="text-left p-2">Branch</th>
                <th className="text-left p-2">Last commit</th>
                <th className="text-left p-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, flags }) => (
                <tr
                  key={row.name}
                  className="border-t border-border hover:bg-surface-secondary"
                  data-testid={`branch-row-${row.name}`}
                >
                  <td className="p-2 font-mono text-text-primary">
                    {flags.isCurrent && <span className="text-kanvas-blue mr-1">●</span>}
                    {row.name}
                  </td>
                  <td className="p-2 text-text-secondary">{formatRelative(row.lastCommitMs)}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      {flags.merged && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/30">
                          merged
                        </span>
                      )}
                      {flags.stale && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30">
                          stale
                        </span>
                      )}
                      {flags.deletedOnRemote && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/30">
                          gone-on-remote
                        </span>
                      )}
                      {flags.hasWorktree && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-kanvas-blue/10 text-kanvas-blue border border-kanvas-blue/30">
                          worktree
                        </span>
                      )}
                      {flags.safeToDelete && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-text-secondary/10 text-text-secondary border border-text-secondary/30"
                          data-testid={`safe-tag-${row.name}`}
                        >
                          safe to delete
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
