/**
 * WorktreeManagerPanel (Epic C / story C2 — MVP slice)
 *
 * Tab content inside RepoDetailModal. Lists git worktrees with a
 * dangling-vs-live classification (G2). Read-only for now — the
 * "Prune" / "Open in IDE" actions stub out CTAs that the service
 * will wire up next.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { classifyDanglingWorktrees, type WorktreeRecord } from '../../../shared/dangling-worktrees';

export interface WorktreeManagerPanelProps {
  repoPath: string;
}

interface RawWorktree {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

export function WorktreeManagerPanel({ repoPath }: WorktreeManagerPanelProps): React.ReactElement {
  const [raw, setRaw] = useState<RawWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await window.api.git.listWorktrees(repoPath);
        if (cancelled) return;
        if (result.success && result.data) {
          setRaw(result.data);
        } else {
          setError(result.error?.message || 'Failed to list worktrees');
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

  const records: WorktreeRecord[] = useMemo(
    () =>
      raw.map((w) => ({
        path: w.path,
        branch: w.branch || '(detached)',
        // We don't have an existsOnDisk check yet from the renderer; assume
        // exists. The Cleanup Wizard runs the real check via fs.access.
        existsOnDisk: true,
        isPrimary: w.path === repoPath,
      })),
    [raw, repoPath]
  );

  const { live, dangling, banner } = classifyDanglingWorktrees(records);

  return (
    <div className="flex flex-col h-full" data-testid="worktree-manager-panel">
      {banner && (
        <div
          className="p-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/30"
          data-testid="dangling-banner"
        >
          {banner}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {loading && <p className="p-3 text-text-secondary text-sm">Loading worktrees…</p>}
        {error && (
          <p className="p-3 text-red-500 text-sm" data-testid="worktree-error">
            {error}
          </p>
        )}
        {!loading && !error && records.length === 0 && (
          <p className="p-3 text-text-secondary text-sm" data-testid="worktree-empty">
            No worktrees yet. The main repo path always counts as the primary worktree.
          </p>
        )}
        {!loading && records.length > 0 && (
          <table className="w-full text-sm" data-testid="worktree-table">
            <thead className="text-text-secondary text-xs uppercase">
              <tr>
                <th className="text-left p-2">Path</th>
                <th className="text-left p-2">Branch</th>
                <th className="text-left p-2">Role</th>
              </tr>
            </thead>
            <tbody>
              {[...live, ...dangling].map((w) => (
                <tr
                  key={w.path}
                  className="border-t border-border hover:bg-surface-secondary"
                  data-testid={`worktree-row-${w.path}`}
                >
                  <td className="p-2 font-mono text-text-primary truncate max-w-[400px]" title={w.path}>
                    {w.path}
                  </td>
                  <td className="p-2 text-text-secondary">{w.branch}</td>
                  <td className="p-2">
                    {w.isPrimary && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-kanvas-blue/10 text-kanvas-blue border border-kanvas-blue/30">
                        primary
                      </span>
                    )}
                    {!w.existsOnDisk && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/30 ml-1">
                        dangling
                      </span>
                    )}
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
