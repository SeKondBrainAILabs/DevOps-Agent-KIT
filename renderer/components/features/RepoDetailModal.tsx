/**
 * RepoDetailModal (Epic B / story B2 — MVP slice)
 *
 * Slide-over modal that opens when a RepoStatusCard is clicked. Hosts
 * tabs for Overview / Branches / Worktrees. Future tabs (Working Tree,
 * History, PRs, CI, Sessions, Settings) layer on top.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { RepoStatus } from '../../../shared/types';
import { BranchManagerPanel } from './BranchManagerPanel';
import { WorktreeManagerPanel } from './WorktreeManagerPanel';

export type RepoDetailTab = 'overview' | 'branches' | 'worktrees';

export interface RepoDetailModalProps {
  repoPath: string;
  onClose: () => void;
}

const TABS: { id: RepoDetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'branches', label: 'Branches' },
  { id: 'worktrees', label: 'Worktrees' },
];

export function RepoDetailModal({ repoPath, onClose }: RepoDetailModalProps): React.ReactElement {
  const [tab, setTab] = useState<RepoDetailTab>('overview');
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Esc closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch status for the overview tab
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.api.git.getRepoStatus(repoPath);
        if (cancelled) return;
        if (result.success && result.data) {
          setStatus(result.data);
        } else {
          setStatusError(result.error?.message || 'Failed to load status');
        }
      } catch (err) {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : 'Unknown error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const repoName = useMemo(
    () => repoPath.split('/').filter(Boolean).pop() ?? repoPath,
    [repoPath]
  );

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-stretch justify-end z-50"
      data-testid="repo-detail-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface w-full max-w-4xl border-l border-border flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-text-primary" data-testid="repo-detail-name">
              {repoName}
            </h2>
            <p
              className="text-xs text-text-secondary truncate max-w-xl"
              data-testid="repo-detail-path"
              title={repoPath}
            >
              {repoPath}
            </p>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl"
            aria-label="Close"
            data-testid="repo-detail-close"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 border-b border-border" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm border-b-2 ${
                tab === t.id
                  ? 'border-kanvas-blue text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
              data-testid={`repo-detail-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab body */}
        <div className="flex-1 overflow-hidden">
          {tab === 'overview' && (
            <div className="p-4 space-y-3" data-testid="repo-detail-overview">
              {!status && !statusError && <p className="text-text-secondary text-sm">Loading status…</p>}
              {statusError && <p className="text-red-500 text-sm">{statusError}</p>}
              {status && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <dt className="text-text-secondary">Current branch</dt>
                  <dd className="text-text-primary font-mono">{status.currentBranch}</dd>
                  <dt className="text-text-secondary">Upstream</dt>
                  <dd className="text-text-primary font-mono">{status.upstream || '—'}</dd>
                  <dt className="text-text-secondary">Ahead / behind</dt>
                  <dd className="text-text-primary">
                    ↑ {status.ahead} · ↓ {status.behind}
                  </dd>
                  <dt className="text-text-secondary">Modified / staged / untracked</dt>
                  <dd className="text-text-primary">
                    {status.modifiedCount} · {status.stagedCount} · {status.untrackedCount}
                  </dd>
                  <dt className="text-text-secondary">Stashes / worktrees</dt>
                  <dd className="text-text-primary">
                    {status.stashCount} · {status.worktreeCount}
                  </dd>
                  {status.lastCommit && (
                    <>
                      <dt className="text-text-secondary">Last commit</dt>
                      <dd className="text-text-primary">
                        <span className="font-mono">{status.lastCommit.shortSha}</span>{' '}
                        {status.lastCommit.subject}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          )}
          {tab === 'branches' && <BranchManagerPanel repoPath={repoPath} />}
          {tab === 'worktrees' && <WorktreeManagerPanel repoPath={repoPath} />}
        </div>
      </div>
    </div>
  );
}
