/**
 * UniversalCommitsView Component
 * Aggregates and displays commits across all sessions
 * Provides filtering by session, repo, and time range
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAgentStore } from '../../store/agentStore';
import type { SessionReport } from '../../../shared/agent-protocol';
import type { GitCommitWithFiles, CommitDiffDetail } from '../../../shared/types';
import { DiffViewer, DiffSummary } from '../ui/DiffViewer';

interface UniversalCommit extends GitCommitWithFiles {
  sessionId: string;
  sessionName: string;
  agentType: string;
  repoName: string;
  repoPath: string;
  expanded?: boolean;
  diffDetail?: CommitDiffDetail;
  loadingDiff?: boolean;
}

type TimeFilter = 'all' | '24h' | '7d' | '30d';

export function UniversalCommitsView(): React.ReactElement {
  const reportedSessions = useAgentStore((state) => state.reportedSessions);
  const sessions = useMemo(() => Array.from(reportedSessions.values()), [reportedSessions]);

  const [commits, setCommits] = useState<UniversalCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedSession, setSelectedSession] = useState<string>('all');
  const [selectedRepo, setSelectedRepo] = useState<string>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');

  // Get unique repos
  const repos = useMemo(() => {
    const repoSet = new Set<string>();
    sessions.forEach(s => {
      if (s.repoPath) {
        repoSet.add(s.repoPath);
      }
    });
    return Array.from(repoSet);
  }, [sessions]);

  // Load commits from all sessions
  const loadAllCommits = useCallback(async () => {
    setLoading(true);
    setError(null);

    const allCommits: UniversalCommit[] = [];

    try {
      for (const session of sessions) {
        const repoPath = session.worktreePath || session.repoPath;
        const baseBranch = session.baseBranch || 'main';

        if (!repoPath || !window.api?.git?.getCommitHistory) continue;

        try {
          // Pass session.branchName so the query is `${baseBranch}..${branchName}`
          // and only this session's commits come back. Without it, GitService
          // falls back to `git log HEAD`, which for in-place (no-worktree) sessions
          // returns the user's full branch history instead of just the session's
          // commits — see also CommitsTab.tsx and SessionDetailView.tsx which pass
          // branchName correctly.
          const result = await window.api.git.getCommitHistory(
            repoPath,
            baseBranch,
            20,
            session.branchName
          );
          if (result.success && result.data) {
            const repoName = session.repoPath?.split('/').pop() || 'Unknown';

            for (const commit of result.data) {
              allCommits.push({
                ...commit,
                sessionId: session.sessionId,
                sessionName: session.task || session.branchName,
                agentType: session.agentType,
                repoName,
                repoPath: repoPath,
                expanded: false,
              });
            }
          }
        } catch (err) {
          console.error(`Failed to load commits for session ${session.sessionId}:`, err);
        }
      }

      // Sort by date (newest first)
      allCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      setCommits(allCommits);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [sessions]);

  useEffect(() => {
    loadAllCommits();
  }, [loadAllCommits]);

  // Apply filters
  const filteredCommits = useMemo(() => {
    let filtered = commits;

    // Session filter
    if (selectedSession !== 'all') {
      filtered = filtered.filter(c => c.sessionId === selectedSession);
    }

    // Repo filter
    if (selectedRepo !== 'all') {
      filtered = filtered.filter(c => c.repoPath === selectedRepo);
    }

    // Time filter
    if (timeFilter !== 'all') {
      const now = new Date();
      let cutoff: Date;

      switch (timeFilter) {
        case '24h':
          cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          cutoff = new Date(0);
      }

      filtered = filtered.filter(c => new Date(c.date) >= cutoff);
    }

    return filtered;
  }, [commits, selectedSession, selectedRepo, timeFilter]);

  // Group commits by date
  const groupedCommits = useMemo(() => {
    const groups: Record<string, UniversalCommit[]> = {};

    for (const commit of filteredCommits) {
      const date = new Date(commit.date);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let groupKey: string;

      if (date.toDateString() === today.toDateString()) {
        groupKey = 'Today';
      } else if (date.toDateString() === yesterday.toDateString()) {
        groupKey = 'Yesterday';
      } else {
        groupKey = date.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        });
      }

      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(commit);
    }

    return groups;
  }, [filteredCommits]);

  // Load diff for a commit
  const loadDiffDetail = useCallback(async (commit: UniversalCommit) => {
    if (!window.api?.git?.getCommitDiff) return;

    setCommits(prev => prev.map(c =>
      c.hash === commit.hash && c.sessionId === commit.sessionId
        ? { ...c, loadingDiff: true }
        : c
    ));

    try {
      const result = await window.api.git.getCommitDiff(commit.repoPath, commit.hash);
      if (result.success && result.data) {
        setCommits(prev => prev.map(c =>
          c.hash === commit.hash && c.sessionId === commit.sessionId
            ? { ...c, diffDetail: result.data, loadingDiff: false }
            : c
        ));
      }
    } catch (err) {
      console.error('Failed to load diff:', err);
      setCommits(prev => prev.map(c =>
        c.hash === commit.hash && c.sessionId === commit.sessionId
          ? { ...c, loadingDiff: false }
          : c
      ));
    }
  }, []);

  // Toggle commit expansion
  const toggleCommit = useCallback((commit: UniversalCommit) => {
    setCommits(prev => {
      const found = prev.find(c => c.hash === commit.hash && c.sessionId === commit.sessionId);
      if (!found) return prev;

      const newExpanded = !found.expanded;

      // Load diff if expanding and not already loaded
      if (newExpanded && !found.diffDetail && !found.loadingDiff) {
        loadDiffDetail(commit);
      }

      return prev.map(c =>
        c.hash === commit.hash && c.sessionId === commit.sessionId
          ? { ...c, expanded: newExpanded }
          : c
      );
    });
  }, [loadDiffDetail]);

  // Format relative time
  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;

    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="h-full bg-surface p-6">
        <div className="mb-6">
          <div className="h-8 w-48 bg-surface-secondary rounded animate-pulse mb-4" />
          <div className="flex gap-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-8 w-28 bg-surface-secondary rounded animate-pulse" />
            ))}
          </div>
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="p-4 border border-[rgba(0,0,0,0.10)] rounded-[14px]">
              <div className="flex items-center gap-3">
                <div className="h-4 w-16 bg-surface-secondary rounded animate-pulse" />
                <div className="h-4 flex-1 bg-surface-secondary rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-surface flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-[rgba(0,0,0,0.10)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-text-primary">All Commits</h2>
          <button
            onClick={loadAllCommits}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-kanvas-blue hover:bg-surface-secondary rounded-full transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          {/* Session filter */}
          <select
            value={selectedSession}
            onChange={(e) => setSelectedSession(e.target.value)}
            className="px-3 py-1.5 text-sm border border-[rgba(0,0,0,0.10)] rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-kanvas-blue"
          >
            <option value="all">All Sessions</option>
            {sessions.map(s => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.task || s.branchName}
              </option>
            ))}
          </select>

          {/* Repo filter */}
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="px-3 py-1.5 text-sm border border-[rgba(0,0,0,0.10)] rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-kanvas-blue"
          >
            <option value="all">All Repos</option>
            {repos.map(repo => (
              <option key={repo} value={repo}>
                {repo.split('/').pop()}
              </option>
            ))}
          </select>

          {/* Time filter */}
          <select
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
            className="px-3 py-1.5 text-sm border border-[rgba(0,0,0,0.10)] rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-kanvas-blue"
          >
            <option value="all">All Time</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>

          {/* Stats */}
          <div className="ml-auto flex items-center gap-2 text-sm text-text-secondary">
            <span>{filteredCommits.length} commits</span>
            <span>•</span>
            <span>{sessions.length} sessions</span>
          </div>
        </div>
      </div>

      {/* Commit list */}
      <div className="flex-1 overflow-y-auto p-6">
        {error ? (
          <div className="p-4 bg-red-50 text-red-700 rounded-[14px] text-sm">
            {error}
          </div>
        ) : filteredCommits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg className="w-16 h-16 text-text-secondary/30 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p className="text-text-secondary">No commits found</p>
            <p className="text-sm text-text-secondary/70 mt-1">
              {selectedSession !== 'all' || selectedRepo !== 'all' || timeFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'Commits will appear here as sessions make changes'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedCommits).map(([date, dateCommits]) => (
              <div key={date}>
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="text-sm font-semibold text-text-secondary">{date}</h3>
                  <span className="text-xs text-text-secondary/70">
                    ({dateCommits.length} commit{dateCommits.length !== 1 ? 's' : ''})
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="space-y-2">
                  {dateCommits.map((commit) => (
                    <UniversalCommitCard
                      key={`${commit.sessionId}-${commit.hash}`}
                      commit={commit}
                      onToggle={() => toggleCommit(commit)}
                      formatRelativeTime={formatRelativeTime}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Individual commit card for universal view
 */
function UniversalCommitCard({
  commit,
  onToggle,
  formatRelativeTime,
}: {
  commit: UniversalCommit;
  onToggle: () => void;
  formatRelativeTime: (date: string) => string;
}): React.ReactElement {
  const agentColors: Record<string, string> = {
    claude: 'bg-orange-100 text-orange-700',
    cursor: 'bg-purple-100 text-purple-700',
    copilot: 'bg-blue-100 text-blue-700',
    cline: 'bg-green-100 text-green-700',
    aider: 'bg-pink-100 text-pink-700',
    warp: 'bg-cyan-100 text-cyan-700',
    custom: 'bg-gray-100 text-gray-700',
  };

  return (
    <div className="border border-[rgba(0,0,0,0.10)] rounded-[14px] overflow-hidden bg-surface">
      {/* Commit header */}
      <div
        className="p-3 cursor-pointer hover:bg-surface-secondary transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-start gap-3">
          {/* Expand icon */}
          <svg
            className={`w-4 h-4 mt-0.5 text-text-secondary transition-transform flex-shrink-0 ${
              commit.expanded ? 'rotate-90' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>

          <div className="flex-1 min-w-0">
            {/* Session and commit info */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-1.5 py-0.5 text-xs rounded ${agentColors[commit.agentType] || agentColors.custom}`}>
                {commit.sessionName}
              </span>
              <span className="font-mono text-xs text-kanvas-blue bg-kanvas-blue/10 px-1.5 py-0.5 rounded">
                {commit.shortHash}
              </span>
              <span className="text-sm text-text-primary truncate">
                {commit.message}
              </span>
            </div>

            {/* Metadata */}
            <div className="flex items-center gap-3 mt-1 text-xs text-text-secondary">
              <span>{formatRelativeTime(commit.date)}</span>
              <span>•</span>
              <span>{commit.author}</span>
              <span>•</span>
              <span className="text-text-secondary/70">{commit.repoName}</span>
              <span>•</span>
              <DiffSummary
                filesChanged={commit.filesChanged}
                additions={commit.additions}
                deletions={commit.deletions}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Expanded diff */}
      {commit.expanded && (
        <div className="border-t border-[rgba(0,0,0,0.10)] bg-surface-secondary">
          {commit.loadingDiff ? (
            <div className="p-4 flex items-center justify-center">
              <svg className="w-5 h-5 text-kanvas-blue animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="ml-2 text-sm text-text-secondary">Loading diff...</span>
            </div>
          ) : commit.diffDetail ? (
            <div className="p-4 space-y-3">
              {commit.diffDetail.files.map((file, index) => (
                <DiffViewer
                  key={`${commit.hash}-${file.path}-${index}`}
                  diff={file.diff}
                  filePath={file.path}
                  language={file.language}
                  additions={file.additions}
                  deletions={file.deletions}
                  defaultCollapsed={index > 0}
                  maxLines={50}
                />
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-text-secondary text-center">
              Failed to load diff details
            </div>
          )}
        </div>
      )}
    </div>
  );
}
