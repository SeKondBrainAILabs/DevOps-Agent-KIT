/**
 * WorkspaceBrowserView (Epic A / story A5 — MVP)
 *
 * Top-level view rendered when `mainView === 'workspaces'`. Shows the
 * configured workspaces, a switcher, and a grid of RepoStatusCards
 * for the active workspace's discovered repos.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DiscoveredRepo,
  Workspace,
  WorkspaceRepoChangeEvent,
} from '../../../shared/types';
import {
  DEFAULT_REPO_SORT_KEY,
  getRepoComparator,
  type RepoSortKey,
} from '../../../shared/repo-sort';
import { RepoStatusCard, type RepoStatusBlock } from './RepoStatusCard';
import { AddWorkspaceDialog } from './AddWorkspaceDialog';
import { useUIStore } from '../../store/uiStore';

export function WorkspaceBrowserView(): React.ReactElement {
  const openCreateAgentWizardForRepo = useUIStore((s) => s.openCreateAgentWizardForRepo);
  const openRepoDetail = useUIStore((s) => s.openRepoDetail);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<RepoSortKey>(DEFAULT_REPO_SORT_KEY);
  /** Per-repoPath status block — populated lazily as we learn about repos. */
  const [statusByPath, setStatusByPath] = useState<Record<string, RepoStatusBlock>>({});

  const [recentReposFallback, setRecentReposFallback] = useState<DiscoveredRepo[]>([]);

  const refreshWorkspaces = useCallback(async () => {
    const listRes = await window.api.workspace.list();
    const list = listRes.success && listRes.data ? listRes.data : [];
    if (listRes.success) setWorkspaces(list);

    const activeRes = await window.api.workspace.getActive();
    if (activeRes.success && activeRes.data) setActiveId(activeRes.data.id);
    else if (list.length) setActiveId(list[0].id);

    // When the user has no workspaces yet but already has recentRepos from
    // their existing Kanvas sessions, surface those so the page isn't empty
    // on first visit. They're not yet a real workspace — there's an inline
    // CTA to "pin parent folder as workspace" in the empty-state UI.
    if (list.length === 0) {
      try {
        const recents = await window.api.instance?.getRecentRepos?.();
        if (recents?.success && Array.isArray(recents.data)) {
          const now = new Date().toISOString();
          setRecentReposFallback(
            recents.data.map((r: { path: string; name: string; lastUsed?: string }) => ({
              workspaceId: '__recent__',
              path: r.path,
              name: r.name,
              depth: 0,
              discoveredAt: r.lastUsed ?? now,
            }))
          );
        }
      } catch {
        // ignore — fallback just stays empty
      }
    } else {
      setRecentReposFallback([]);
    }
  }, []);

  /** Common parent dir (POSIX) of a non-empty list of paths. */
  const commonParent = useCallback((paths: string[]): string | null => {
    if (paths.length === 0) return null;
    const split = paths.map((p) => p.split('/'));
    const head = split[0];
    let i = 0;
    for (; i < head.length; i++) {
      const segment = head[i];
      if (!split.every((parts) => parts[i] === segment)) break;
    }
    if (i === 0) return '/';
    const joined = head.slice(0, i).join('/');
    return joined || '/';
  }, []);

  const scanActive = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.workspace.scan(id);
      if (res.success && res.data) {
        setRepos(res.data.repos);
      } else {
        setError(res.error?.message || 'Scan failed');
        setRepos([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  // Scan when active workspace changes
  useEffect(() => {
    if (!activeId) {
      setRepos([]);
      return;
    }
    void scanActive(activeId);
    // Also start watching for new repos
    void window.api.workspace.startWatching(activeId);
  }, [activeId, scanActive]);

  // Subscribe to repo-change events
  useEffect(() => {
    const unsubscribe = window.api.workspace.onRepoChange((event: WorkspaceRepoChangeEvent) => {
      if (event.workspaceId !== activeId) return;
      setRepos((prev) => {
        if (event.kind === 'repo-added') {
          if (prev.some((r) => r.path === event.repoPath)) return prev;
          const name = event.repoPath.split('/').filter(Boolean).pop() ?? event.repoPath;
          return [
            ...prev,
            {
              workspaceId: event.workspaceId,
              path: event.repoPath,
              name,
              depth: event.depth,
              discoveredAt: event.at,
            },
          ];
        }
        return prev.filter((r) => r.path !== event.repoPath);
      });
    });
    return unsubscribe;
  }, [activeId]);

  // Pre-fetch worktree-mode + active session count + git repo status for
  // each repo so the card shows real branch / ahead-behind / uncommitted /
  // stash / worktree counts in addition to the C5 single-session badge.
  useEffect(() => {
    let cancelled = false;
    const target = workspaces.length === 0 ? recentReposFallback : repos;
    (async () => {
      const updates: Record<string, RepoStatusBlock> = {};
      for (const repo of target) {
        try {
          const [modeRes, countRes, statusRes] = await Promise.all([
            window.api.repoWorkspace.getWorktreeMode(repo.path),
            window.api.repoWorkspace.getActiveSessionCount(repo.path),
            window.api.git.getRepoStatus(repo.path),
          ]);
          const block: RepoStatusBlock = {
            worktreeMode: modeRes.success ? modeRes.data : undefined,
            activeSessionCount: countRes.success ? countRes.data : 0,
          };
          if (statusRes.success && statusRes.data) {
            const s = statusRes.data;
            block.currentBranch = s.currentBranch;
            block.ahead = s.ahead;
            block.behind = s.behind;
            block.modifiedCount = s.modifiedCount;
            block.stagedCount = s.stagedCount;
            block.untrackedCount = s.untrackedCount;
            block.stashCount = s.stashCount;
            block.worktreeCount = s.worktreeCount;
          }
          updates[repo.path] = block;
        } catch {
          // ignore — leave block undefined
        }
      }
      if (!cancelled) setStatusByPath((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, recentReposFallback, workspaces.length]);

  // When no workspace exists, the recent-repos fallback drives the grid
  // so the user immediately sees their work — even before they configure
  // a real workspace folder.
  const showingFallback = workspaces.length === 0 && recentReposFallback.length > 0;
  const sourceRepos = showingFallback ? recentReposFallback : repos;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? sourceRepos.filter(
          (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
        )
      : [...sourceRepos];
    const cmp = getRepoComparator(sortKey);
    list.sort((a, b) =>
      cmp(
        { name: a.name, workingTreeMtimeMs: Date.parse(a.discoveredAt), lastCommitMs: Date.parse(a.discoveredAt), sizeBytes: 0 },
        { name: b.name, workingTreeMtimeMs: Date.parse(b.discoveredAt), lastCommitMs: Date.parse(b.discoveredAt), sizeBytes: 0 }
      )
    );
    return list;
  }, [sourceRepos, filter, sortKey]);

  const fallbackParent = useMemo(
    () => (showingFallback ? commonParent(recentReposFallback.map((r) => r.path)) : null),
    [showingFallback, recentReposFallback, commonParent]
  );

  const handlePinFallbackParent = useCallback(async () => {
    if (!fallbackParent) return;
    const result = await window.api.workspace.add({ path: fallbackParent });
    if (result.success && result.data) {
      void refreshWorkspaces();
    }
  }, [fallbackParent, refreshWorkspaces]);

  return (
    <div className="flex-1 flex flex-col bg-surface" data-testid="workspace-browser">
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <h1 className="text-lg font-semibold text-text-primary">Workspaces</h1>
        <select
          className="px-2 py-1 border border-border rounded bg-surface-secondary text-text-primary text-sm"
          value={activeId ?? ''}
          onChange={async (e) => {
            const next = e.target.value || null;
            setActiveId(next);
            if (next) await window.api.workspace.setActive(next);
          }}
          data-testid="workspace-switcher"
        >
          {workspaces.length === 0 && <option value="">— no workspaces —</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="text-sm px-2 py-1 border border-border rounded text-text-primary hover:bg-surface-tertiary"
          data-testid="add-workspace-button"
        >
          + Add workspace
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => activeId && void scanActive(activeId)}
          disabled={!activeId || loading}
          className="text-sm px-2 py-1 border border-border rounded text-text-primary hover:bg-surface-tertiary disabled:opacity-50"
          data-testid="rescan-button"
        >
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {/* Filter / sort bar */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repos…"
          className="px-2 py-1 border border-border rounded bg-surface-secondary text-text-primary text-sm flex-1 max-w-xs"
          data-testid="repo-filter"
        />
        <label className="text-xs text-text-secondary">Sort:</label>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as RepoSortKey)}
          className="px-2 py-1 border border-border rounded bg-surface-secondary text-text-primary text-sm"
          data-testid="sort-select"
        >
          <option value="last-touched">Last touched</option>
          <option value="alphabetical">Alphabetical</option>
          <option value="size">Size</option>
        </select>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="mb-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-red-500 text-sm">
            {error}
          </div>
        )}
        {workspaces.length === 0 && recentReposFallback.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary" data-testid="empty-state-no-workspace">
            <p className="mb-3">No workspaces yet.</p>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="px-3 py-1 bg-kanvas-blue text-white rounded text-sm"
            >
              Add your first workspace
            </button>
          </div>
        )}
        {showingFallback && (
          <div
            className="mb-3 p-3 border border-border rounded-lg bg-surface-secondary"
            data-testid="recent-repos-banner"
          >
            <p className="text-sm text-text-primary mb-2">
              Showing {recentReposFallback.length} repos from your recent sessions.
              Add a workspace to enable folder scanning + filesystem watching.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="text-sm px-3 py-1 bg-kanvas-blue text-white rounded"
              >
                + Add workspace
              </button>
              {fallbackParent && (
                <button
                  type="button"
                  onClick={() => void handlePinFallbackParent()}
                  className="text-sm px-3 py-1 border border-border rounded text-text-primary hover:bg-surface-tertiary"
                  data-testid="pin-parent-button"
                  title={`Create a workspace at ${fallbackParent}`}
                >
                  Pin {fallbackParent} as workspace
                </button>
              )}
            </div>
          </div>
        )}
        {workspaces.length > 0 && filtered.length === 0 && !loading && (
          <p className="text-text-secondary text-sm" data-testid="empty-state-no-repos">
            {repos.length === 0
              ? 'No git repositories found in this workspace.'
              : 'No repos match your filter.'}
          </p>
        )}
        {filtered.length > 0 && (
          <div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
            data-testid="repo-grid"
          >
            {filtered.map((repo) => (
              <RepoStatusCard
                key={repo.path}
                repo={repo}
                status={statusByPath[repo.path] ?? null}
                onSelect={(r) => openRepoDetail(r.path)}
                onOpenIde={() => window.api.shell?.openVSCode?.(repo.path)}
                onOpenTerminal={() => window.api.shell?.openTerminal?.(repo.path)}
                onNewSession={() => openCreateAgentWizardForRepo(repo.path)}
              />
            ))}
          </div>
        )}
      </div>

      <AddWorkspaceDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshWorkspaces();
        }}
      />
    </div>
  );
}
