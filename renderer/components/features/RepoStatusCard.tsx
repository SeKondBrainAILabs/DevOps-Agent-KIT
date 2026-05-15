/**
 * RepoStatusCard Component (Epic B / story B1 — MVP slice)
 *
 * Atomic UI unit for the Workspace Browser. Karol's spec calls for
 * branch / ahead-behind / uncommitted / worktree / CI / PR data; this
 * MVP renders the data we have today (path, name, depth, last-touched
 * timestamp) plus action buttons that hook into existing IPC.
 *
 * Hooks for richer data (`getRepoStatus`, GitHub PR/CI counts) will
 * be added once GitHubService (E1) and the GitService extension land.
 */

import React from 'react';
import type { DiscoveredRepo } from '../../../shared/types';

export interface RepoStatusCardProps {
  repo: DiscoveredRepo;
  /** Optional pre-fetched status block — when absent, only basics render. */
  status?: RepoStatusBlock | null;
  /** Click anywhere on the card body. */
  onSelect?: (repo: DiscoveredRepo) => void;
  /** Open in IDE / terminal — caller wires to QuickActionService. */
  onOpenIde?: (repo: DiscoveredRepo) => void;
  onOpenTerminal?: (repo: DiscoveredRepo) => void;
  /** Start a new agent session for this repo. */
  onNewSession?: (repo: DiscoveredRepo) => void;
}

export interface RepoStatusBlock {
  currentBranch?: string;
  ahead?: number;
  behind?: number;
  modifiedCount?: number;
  stagedCount?: number;
  untrackedCount?: number;
  stashCount?: number;
  worktreeCount?: number;
  /** 'in-place' | 'worktree' — for the C5 mode badge. */
  worktreeMode?: 'in-place' | 'worktree';
  activeSessionCount?: number;
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function RepoStatusCard({
  repo,
  status,
  onSelect,
  onOpenIde,
  onOpenTerminal,
  onNewSession,
}: RepoStatusCardProps): React.ReactElement {
  const uncommittedTotal =
    (status?.modifiedCount ?? 0) + (status?.stagedCount ?? 0) + (status?.untrackedCount ?? 0);
  const isSingleSession = status?.worktreeMode === 'in-place';

  return (
    <div
      data-testid="repo-status-card"
      className="bg-surface-secondary border border-border rounded-xl p-4 shadow-sm hover:shadow-kanvas transition-shadow cursor-pointer"
      onClick={() => onSelect?.(repo)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect?.(repo);
      }}
    >
      {/* Header: name + mode badge */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-kanvas-blue/10 text-kanvas-blue flex items-center justify-center font-semibold flex-shrink-0">
            {repo.name.charAt(0).toUpperCase()}
          </span>
          <h3 className="font-semibold text-text-primary truncate" title={repo.name}>
            {repo.name}
          </h3>
        </div>
        {isSingleSession && (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30"
            data-testid="single-session-badge"
            title="Worktrees disabled for this repo — only one active session at a time."
          >
            Single-session
          </span>
        )}
      </div>

      {/* Path */}
      <p
        className="text-xs text-text-secondary truncate mb-3"
        title={repo.path}
        data-testid="repo-path"
      >
        {repo.path}
      </p>

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary mb-3">
        {status?.currentBranch && (
          <span data-testid="branch-chip" className="font-mono text-text-primary">
            ⎇ {status.currentBranch}
          </span>
        )}
        {(status?.ahead ?? 0) > 0 && (
          <span title={`${status?.ahead} ahead of remote`}>↑ {status?.ahead}</span>
        )}
        {(status?.behind ?? 0) > 0 && (
          <span title={`${status?.behind} behind remote`}>↓ {status?.behind}</span>
        )}
        {uncommittedTotal > 0 && (
          <span data-testid="uncommitted-count">
            ✎ {uncommittedTotal}
          </span>
        )}
        {(status?.stashCount ?? 0) > 0 && <span>⌹ {status?.stashCount}</span>}
        {(status?.worktreeCount ?? 0) > 0 && <span>⌥ {status?.worktreeCount}</span>}
        {(status?.activeSessionCount ?? 0) > 0 && (
          <span data-testid="active-session-count" className="text-kanvas-blue">
            ◉ {status?.activeSessionCount} active
          </span>
        )}
      </div>

      {/* Last touched */}
      {repo.discoveredAt && (
        <p className="text-[11px] text-text-secondary mb-3" data-testid="last-touched">
          Discovered {formatRelative(repo.discoveredAt)}
        </p>
      )}

      {/* Action footer */}
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <button
          type="button"
          className="text-xs text-text-secondary hover:text-text-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpenIde?.(repo);
          }}
          data-testid="open-ide"
        >
          IDE
        </button>
        <button
          type="button"
          className="text-xs text-text-secondary hover:text-text-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(repo);
          }}
          data-testid="open-terminal"
        >
          Terminal
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="text-xs px-2 py-1 rounded bg-kanvas-blue text-white hover:opacity-90"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession?.(repo);
          }}
          data-testid="new-session"
        >
          New session
        </button>
      </div>
    </div>
  );
}
