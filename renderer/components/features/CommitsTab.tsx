/**
 * CommitsTab Component
 * Shows commit history for a session with expandable diff views
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { SessionReport } from '../../../shared/agent-protocol';
import type { GitCommitWithFiles, CommitDiffDetail } from '../../../shared/types';
import { DiffViewer, DiffSummary } from '../ui/DiffViewer';

interface CommitsTabProps {
  session: SessionReport;
}

interface CommitWithExpansion extends GitCommitWithFiles {
  expanded?: boolean;
  diffDetail?: CommitDiffDetail;
  loadingDiff?: boolean;
}

export function CommitsTab({ session }: CommitsTabProps): React.ReactElement {
  const [commits, setCommits] = useState<CommitWithExpansion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load commit history
  const loadCommits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const repoPath = session.worktreePath || session.repoPath;
      const baseBranch = session.baseBranch || 'main';

      if (!window.api?.git?.getCommitHistory || !repoPath) {
        setError('Commit history API not available');
        return;
      }

      // Resolve the actual current branch from the worktree (may differ from session.branchName)
      let resolvedBranch = session.branchName;
      if (repoPath && window.api?.merge?.resolveActiveBranch) {
        try {
          const branchResult = await window.api.merge.resolveActiveBranch(repoPath);
          if (branchResult.success && branchResult.data) {
            resolvedBranch = branchResult.data;
          }
        } catch {
          // Fall back to session.branchName
        }
      }

      // Try with resolved branch first; if empty results, fall back to no branch filter
      const result = await window.api.git.getCommitHistory(repoPath, baseBranch, 100, resolvedBranch);
      if (result.success && result.data) {
        if (result.data.length > 0) {
          setCommits(result.data.map(c => ({ ...c, expanded: false })));
          return;
        }
        // Empty — might be because baseBranch isn't a local ref; try origin/baseBranch
        const fallbackResult = await window.api.git.getCommitHistory(repoPath, `origin/${baseBranch}`, 100, resolvedBranch);
        if (fallbackResult.success && fallbackResult.data) {
          setCommits(fallbackResult.data.map(c => ({ ...c, expanded: false })));
        } else {
          setCommits([]);
        }
      } else if (result.error) {
        // Try origin/baseBranch as fallback
        const fallbackResult = await window.api.git.getCommitHistory(repoPath, `origin/${baseBranch}`, 100, resolvedBranch);
        if (fallbackResult.success && fallbackResult.data) {
          setCommits(fallbackResult.data.map(c => ({ ...c, expanded: false })));
        } else {
          setError(result.error.message || 'Failed to load commits');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [session.worktreePath, session.repoPath, session.baseBranch, session.branchName]);

  useEffect(() => {
    loadCommits();
  }, [loadCommits]);

  // Load diff detail for a commit
  const loadDiffDetail = useCallback(async (commitHash: string) => {
    const repoPath = session.worktreePath || session.repoPath;
    if (!repoPath || !window.api?.git?.getCommitDiff) return;

    setCommits(prev => prev.map(c =>
      c.hash === commitHash ? { ...c, loadingDiff: true } : c
    ));

    try {
      const result = await window.api.git.getCommitDiff(repoPath, commitHash);
      if (result.success && result.data) {
        setCommits(prev => prev.map(c =>
          c.hash === commitHash
            ? { ...c, diffDetail: result.data, loadingDiff: false }
            : c
        ));
      }
    } catch (err) {
      console.error('Failed to load diff:', err);
      setCommits(prev => prev.map(c =>
        c.hash === commitHash ? { ...c, loadingDiff: false } : c
      ));
    }
  }, [session.worktreePath, session.repoPath]);

  // Toggle commit expansion
  const toggleCommit = useCallback((commitHash: string) => {
    setCommits(prev => {
      const commit = prev.find(c => c.hash === commitHash);
      if (!commit) return prev;

      const newExpanded = !commit.expanded;

      // Load diff if expanding and not already loaded
      if (newExpanded && !commit.diffDetail && !commit.loadingDiff) {
        loadDiffDetail(commitHash);
      }

      return prev.map(c =>
        c.hash === commitHash ? { ...c, expanded: newExpanded } : c
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
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-6 w-32 bg-surface-secondary rounded animate-pulse" />
          <div className="h-8 w-20 bg-surface-secondary rounded animate-pulse" />
        </div>
        {[1, 2, 3].map(i => (
          <div key={i} className="p-4 border border-border rounded-xl">
            <div className="flex items-center gap-3">
              <div className="h-4 w-16 bg-surface-secondary rounded animate-pulse" />
              <div className="h-4 flex-1 bg-surface-secondary rounded animate-pulse" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-3 w-20 bg-surface-secondary rounded animate-pulse" />
              <div className="h-3 w-24 bg-surface-secondary rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-text-primary">Commits</h3>
          <button
            onClick={loadCommits}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-kanvas-blue hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Retry
          </button>
        </div>
        <div className="p-4 bg-red-50 text-red-700 rounded-xl text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-text-primary">Commits</h3>
          <button
            onClick={loadCommits}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-kanvas-blue hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg className="w-16 h-16 text-text-secondary/30 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-text-secondary">No commits yet in this session</p>
          <p className="text-sm text-text-secondary/70 mt-1">
            Commits will appear here as you make changes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-text-primary">Commits</h3>
          <span className="px-2 py-0.5 text-xs bg-surface-secondary text-text-secondary rounded-full">
            {commits.length}
          </span>
        </div>
        <button
          onClick={loadCommits}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-kanvas-blue hover:bg-surface-secondary rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Commit list */}
      <div className="space-y-3">
        {commits.map((commit) => (
          <CommitCard
            key={commit.hash}
            commit={commit}
            onToggle={() => toggleCommit(commit.hash)}
            formatRelativeTime={formatRelativeTime}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Individual commit card with expandable diff
 */
function CommitCard({
  commit,
  onToggle,
  formatRelativeTime,
}: {
  commit: CommitWithExpansion;
  onToggle: () => void;
  formatRelativeTime: (date: string) => string;
}): React.ReactElement {
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-surface">
      {/* Commit header - always visible */}
      <div
        className="p-4 cursor-pointer hover:bg-surface-secondary transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-start gap-3">
          {/* Expand/collapse icon */}
          <svg
            className={`w-4 h-4 mt-1 text-text-secondary transition-transform flex-shrink-0 ${
              commit.expanded ? 'rotate-90' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>

          <div className="flex-1 min-w-0">
            {/* Commit message */}
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-kanvas-blue bg-kanvas-blue/10 px-1.5 py-0.5 rounded">
                {commit.shortHash}
              </span>
              <span className="text-sm font-medium text-text-primary truncate">
                {commit.message}
              </span>
            </div>

            {/* Commit metadata */}
            <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary">
              <span>{formatRelativeTime(commit.date)}</span>
              <span>•</span>
              <span>{commit.author}</span>
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

      {/* Expanded content - file list and diffs */}
      {commit.expanded && (
        <div className="border-t border-border bg-surface-secondary">
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
