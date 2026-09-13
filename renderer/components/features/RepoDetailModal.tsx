/**
 * RepoDetailModal (Epic B / story B2 — MVP slice)
 *
 * Slide-over modal that opens when a RepoStatusCard is clicked. Hosts
 * tabs for Overview / Branches / Worktrees. Future tabs (Working Tree,
 * History, PRs, CI, Sessions, Settings) layer on top.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

interface RepoStashEntry {
  ref: string;
  message: string;
  createdAt: string;
}

function formatStashTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleString();
}

export function RepoDetailModal({ repoPath, onClose }: RepoDetailModalProps): React.ReactElement {
  const [tab, setTab] = useState<RepoDetailTab>('overview');
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [stashes, setStashes] = useState<RepoStashEntry[]>([]);
  const [stashLoading, setStashLoading] = useState(true);
  const [stashError, setStashError] = useState<string | null>(null);
  const [stashActionInFlight, setStashActionInFlight] = useState<string | null>(null);
  const [overviewActionError, setOverviewActionError] = useState<string | null>(null);

  // Esc closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const result = await window.api.git.getRepoStatus(repoPath);
      if (result.success && result.data) {
        setStatus(result.data);
      } else {
        setStatusError(result.error?.message || 'Failed to load status');
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStatusLoading(false);
    }
  }, [repoPath]);

  const refreshStashes = useCallback(async (): Promise<void> => {
    setStashLoading(true);
    setStashError(null);
    try {
      const result = await window.api.git.stashList(repoPath);
      if (result.success && result.data) {
        setStashes(result.data);
      } else {
        setStashError(result.error?.message || 'Failed to load stashes');
      }
    } catch (err) {
      setStashError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStashLoading(false);
    }
  }, [repoPath]);

  const refreshOverview = useCallback(async (): Promise<void> => {
    await Promise.all([refreshStatus(), refreshStashes()]);
  }, [refreshStatus, refreshStashes]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  const handlePullCurrentBranch = useCallback(async (): Promise<void> => {
    const branchName = status?.currentBranch?.trim();
    if (!branchName) return;
    setOverviewActionError(null);
    setStashActionInFlight('pull-current-branch');
    try {
      const result = await window.api.git.performRebase(repoPath, branchName);
      if (!result.success || !result.data?.success) {
        throw new Error(result.error?.message || result.data?.message || 'Failed to pull latest changes');
      }
      await refreshOverview();
    } catch (err) {
      setOverviewActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setStashActionInFlight((current) => (current === 'pull-current-branch' ? null : current));
    }
  }, [repoPath, status?.currentBranch, refreshOverview]);

  const handleStashPop = useCallback(async (stashRef: string): Promise<void> => {
    setOverviewActionError(null);
    const actionKey = `pop:${stashRef}`;
    setStashActionInFlight(actionKey);
    try {
      const result = await window.api.git.stashPop(repoPath, stashRef);
      if (!result.success) {
        throw new Error(result.error?.message || `Failed to apply ${stashRef}`);
      }
      await refreshOverview();
    } catch (err) {
      setOverviewActionError(err instanceof Error ? err.message : 'Failed to apply stash');
    } finally {
      setStashActionInFlight((current) => (current === actionKey ? null : current));
    }
  }, [repoPath, refreshOverview]);

  const handleStashDrop = useCallback(async (stashRef: string): Promise<void> => {
    const confirmed = window.confirm(`Drop ${stashRef}? This cannot be undone.`);
    if (!confirmed) return;
    setOverviewActionError(null);
    const actionKey = `drop:${stashRef}`;
    setStashActionInFlight(actionKey);
    try {
      const result = await window.api.git.stashDrop(repoPath, stashRef);
      if (!result.success) {
        throw new Error(result.error?.message || `Failed to drop ${stashRef}`);
      }
      await refreshOverview();
    } catch (err) {
      setOverviewActionError(err instanceof Error ? err.message : 'Failed to drop stash');
    } finally {
      setStashActionInFlight((current) => (current === actionKey ? null : current));
    }
  }, [repoPath, refreshOverview]);

  const handleStashClear = useCallback(async (): Promise<void> => {
    if (stashes.length === 0) return;
    const confirmed = window.confirm('Clear all stashes in this repository? This cannot be undone.');
    if (!confirmed) return;
    setOverviewActionError(null);
    setStashActionInFlight('clear-all');
    try {
      const result = await window.api.git.stashClear(repoPath);
      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to clear stashes');
      }
      await refreshOverview();
    } catch (err) {
      setOverviewActionError(err instanceof Error ? err.message : 'Failed to clear stashes');
    } finally {
      setStashActionInFlight((current) => (current === 'clear-all' ? null : current));
    }
  }, [repoPath, stashes.length, refreshOverview]);

  const repoName = useMemo(
    () => repoPath.split('/').filter(Boolean).pop() ?? repoPath,
    [repoPath]
  );

  return (
    <div
      className="fixed inset-0 bg-black/15 backdrop-blur-[2px] flex items-stretch justify-end z-50"
      data-testid="repo-detail-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white w-full max-w-4xl border-l border-[rgba(0,0,0,0.10)] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-[rgba(0,0,0,0.10)]">
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
        <div className="flex gap-1 px-4 py-2 border-b border-[rgba(0,0,0,0.10)]" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-1.5 text-sm rounded-full font-medium transition-colors ${
                tab === t.id
                  ? 'bg-black text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-[rgba(0,0,0,0.05)]'
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
            <div className="p-4 space-y-4 overflow-y-auto h-full" data-testid="repo-detail-overview">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void refreshOverview()}
                  className="text-xs px-2.5 py-1 rounded border border-border text-text-primary hover:bg-surface-tertiary"
                  data-testid="repo-detail-refresh-overview"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => window.api.shell?.openTerminal?.(repoPath)}
                  className="text-xs px-2.5 py-1 rounded border border-border text-text-primary hover:bg-surface-tertiary"
                  data-testid="repo-detail-open-terminal"
                >
                  Open terminal
                </button>
                <button
                  type="button"
                  onClick={() => window.api.shell?.openVSCode?.(repoPath)}
                  className="text-xs px-2.5 py-1 rounded border border-border text-text-primary hover:bg-surface-tertiary"
                  data-testid="repo-detail-open-ide"
                >
                  Open IDE
                </button>
                <button
                  type="button"
                  onClick={() => void handlePullCurrentBranch()}
                  disabled={!status?.currentBranch || stashActionInFlight === 'pull-current-branch'}
                  className="text-xs px-2.5 py-1 rounded border border-kanvas-blue bg-kanvas-blue text-white hover:opacity-90 disabled:opacity-50"
                  data-testid="repo-detail-pull-current-branch"
                >
                  {stashActionInFlight === 'pull-current-branch' ? 'Pulling…' : 'Pull current branch'}
                </button>
              </div>

              {(statusError || stashError || overviewActionError) && (
                <div className="space-y-1">
                  {statusError && <p className="text-red-500 text-sm">{statusError}</p>}
                  {stashError && <p className="text-red-500 text-sm">{stashError}</p>}
                  {overviewActionError && <p className="text-red-500 text-sm">{overviewActionError}</p>}
                </div>
              )}

              {(statusLoading || stashLoading) && (
                <p className="text-text-secondary text-sm">Loading repository details…</p>
              )}
              {status && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm border border-border rounded-lg p-3 bg-surface-secondary">
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

              <div
                className="border border-border rounded-lg bg-surface-secondary p-3 space-y-2"
                data-testid="repo-detail-stash-section"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">
                    {`Stash manager (${stashes.length})`}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleStashClear()}
                    disabled={stashes.length === 0 || stashActionInFlight === 'clear-all'}
                    className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                    data-testid="repo-detail-stash-clear"
                  >
                    {stashActionInFlight === 'clear-all' ? 'Clearing…' : 'Clear all'}
                  </button>
                </div>
                {stashes.length === 0 ? (
                  <p className="text-xs text-text-secondary" data-testid="repo-detail-stash-empty">
                    No stashes found for this repository.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {stashes.map((stash, index) => {
                      const popActionKey = `pop:${stash.ref}`;
                      const dropActionKey = `drop:${stash.ref}`;
                      const popBusy = stashActionInFlight === popActionKey;
                      const dropBusy = stashActionInFlight === dropActionKey;
                      return (
                        <div
                          key={`${stash.ref}-${stash.createdAt}`}
                          className="p-2 border border-border rounded bg-surface"
                          data-testid={`repo-detail-stash-row-${index}`}
                        >
                          <p className="text-xs text-text-primary font-mono">{stash.ref}</p>
                          <p className="text-xs text-text-secondary break-all">{stash.message || '(no message)'}</p>
                          <p className="text-[11px] text-text-secondary/80">
                            {formatStashTimestamp(stash.createdAt)}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => void handleStashPop(stash.ref)}
                              disabled={popBusy}
                              className="text-[11px] px-2 py-1 rounded border border-kanvas-blue/40 text-kanvas-blue hover:bg-kanvas-blue/10 disabled:opacity-50"
                              data-testid={`repo-detail-stash-pop-${index}`}
                            >
                              {popBusy ? 'Applying…' : 'Pop'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleStashDrop(stash.ref)}
                              disabled={dropBusy}
                              className="text-[11px] px-2 py-1 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                              data-testid={`repo-detail-stash-drop-${index}`}
                            >
                              {dropBusy ? 'Dropping…' : 'Drop'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {tab === 'branches' && <BranchManagerPanel repoPath={repoPath} />}
          {tab === 'worktrees' && <WorktreeManagerPanel repoPath={repoPath} />}
        </div>
      </div>
    </div>
  );
}
