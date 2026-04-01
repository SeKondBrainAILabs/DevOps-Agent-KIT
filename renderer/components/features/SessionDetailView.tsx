/**
 * SessionDetailView Component
 * Shows detailed view of a selected session including prompt, activity, files, and contracts
 */

import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FixedSizeList as List } from 'react-window';
import type { SessionReport } from '../../../shared/agent-protocol';
import type { AgentInstance, ContractType, Contract, ActivityLogEntry, DiscoveredFeature } from '../../../shared/types';
import { computeFeatureFileStats, getFeatureRelativePath, getFileTooltip } from '../../../shared/feature-utils';
import { useAgentStore } from '../../store/agentStore';
import { useContractStore } from '../../store/contractStore';
import { CommitsTab } from './CommitsTab';
import { McpTab } from './McpTab';

type DetailTab = 'prompt' | 'activity' | 'commits' | 'files' | 'contracts' | 'terminal' | 'mcp';

// Threshold for switching to virtualized rendering
const VIRTUALIZATION_LINE_THRESHOLD = 100;

/**
 * VirtualizedDiff - Renders large diffs with react-window for performance
 * Falls back to normal rendering for small diffs (<100 lines)
 */
function VirtualizedDiff({ diff, maxHeight = 300 }: { diff: string; maxHeight?: number }): React.ReactElement {
  const lines = useMemo(() => diff.split('\n'), [diff]);

  // Get line class based on diff prefix
  const getLineClass = (line: string): string => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return 'text-green-600 bg-green-50';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return 'text-red-600 bg-red-50';
    } else if (line.startsWith('@@')) {
      return 'text-blue-600';
    }
    return 'text-text-primary';
  };

  // Small diffs render normally (better for copy/paste)
  if (lines.length < VIRTUALIZATION_LINE_THRESHOLD) {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap">
        {lines.map((line, i) => (
          <div key={i} className={getLineClass(line)}>{line}</div>
        ))}
      </pre>
    );
  }

  // Large diffs use virtualization
  return (
    <List
      height={maxHeight}
      itemCount={lines.length}
      itemSize={18}
      width="100%"
      className="text-xs font-mono"
    >
      {({ index, style }) => {
        const line = lines[index];
        return (
          <div style={style} className={`${getLineClass(line)} px-1 truncate`}>
            {line || '\u00A0'}
          </div>
        );
      }}
    </List>
  );
}

/**
 * EscapeKeyHandler - Listens for Escape key and calls onEscape callback.
 * Renders nothing, just attaches/detaches the event listener.
 */
function EscapeKeyHandler({ onEscape }: { onEscape: () => void }): null {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onEscape]);
  return null;
}

interface SessionDetailViewProps {
  session: SessionReport;
  onBack: () => void;
  onDelete?: (sessionId: string) => void;
  onRestart?: (sessionId: string, session: SessionReport, commitChanges: boolean) => Promise<void>;
}

export function SessionDetailView({ session, onBack, onDelete, onRestart }: SessionDetailViewProps): React.ReactElement {
  const [instance, setInstance] = useState<AgentInstance | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('prompt');
  const [copySuccess, setCopySuccess] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const [editingBaseBranch, setEditingBaseBranch] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Load instance data to get the prompt
  useEffect(() => {
    async function loadInstance() {
      if (window.api?.instance?.list) {
        const result = await window.api.instance.list();
        if (result.success && result.data) {
          // Find instance matching this session
          const found = result.data.find(inst => inst.sessionId === session.sessionId);
          setInstance(found || null);
        }
      }
    }
    loadInstance();
  }, [session.sessionId]);

  const handleCopyPrompt = async () => {
    const textToCopy = instance?.prompt || generateDefaultPrompt(session);
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyInstructions = async () => {
    const textToCopy = instance?.instructions || '';
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDelete = () => {
    if (showDeleteConfirm) {
      onDelete?.(session.sessionId);
      setShowDeleteConfirm(false);
    } else {
      setShowDeleteConfirm(true);
      // Auto-hide confirm after 3 seconds
      setTimeout(() => setShowDeleteConfirm(false), 3000);
    }
  };

  const handleRestart = async (commitChanges: boolean) => {
    if (restarting) return;
    setShowRestartConfirm(false);
    setRestarting(true);
    setRestartError(null);
    try {
      await onRestart?.(session.sessionId, session, commitChanges);
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : 'Failed to restart session');
      setRestarting(false);
    }
    // Note: on success, the component will unmount as the session changes, so no need to setRestarting(false)
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setShowErrorPopup(false);
    try {
      const repoPath = session.worktreePath || session.repoPath;
      const baseBranch = session.baseBranch || 'main';

      if (!repoPath) {
        setSyncResult({ success: false, message: 'No repository path configured' });
        setShowErrorPopup(true);
        return;
      }

      console.log(`[SessionDetail] Syncing ${repoPath} with ${baseBranch}...`);

      // First fetch
      const fetchResult = await window.api?.git?.fetch?.(repoPath, 'origin');
      if (!fetchResult?.success) {
        const errorMessage = fetchResult?.error?.message || 'Failed to fetch from remote';
        setSyncResult({ success: false, message: errorMessage });
        setShowErrorPopup(true);
        return;
      }

      // Then rebase
      const rebaseResult = await window.api?.git?.performRebase?.(repoPath, baseBranch);

      if (rebaseResult?.success && rebaseResult.data) {
        const resultMessage = rebaseResult.data.message || (rebaseResult.data.success ? 'Synced successfully' : 'Rebase failed');
        setSyncResult({
          success: rebaseResult.data.success,
          message: resultMessage,
        });

        // Show popup only for failures; success always auto-clears
        if (!rebaseResult.data.success) {
          setShowErrorPopup(true);
        } else {
          // Clear success message after 5 seconds
          setTimeout(() => setSyncResult(null), 5000);
        }
      } else {
        const errorMessage = rebaseResult?.error?.message || 'Rebase failed - check console for details';
        setSyncResult({
          success: false,
          message: errorMessage,
        });
        setShowErrorPopup(true);
      }
    } catch (error) {
      console.error('[SessionDetail] Sync error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Sync failed unexpectedly';
      setSyncResult({
        success: false,
        message: errorMessage,
      });
      setShowErrorPopup(true);
    } finally {
      setSyncing(false);
    }
  };

  const handleEditBaseBranch = async () => {
    if (editingBaseBranch) {
      setEditingBaseBranch(false);
      return;
    }
    setLoadingBranches(true);
    try {
      const repoPath = session.repoPath || session.worktreePath;
      if (repoPath) {
        const result = await window.api?.instance?.validateRepo?.(repoPath);
        if (result?.success && result.data?.branches) {
          setBranches(result.data.branches);
        }
      }
    } catch (err) {
      console.error('[SessionDetail] Failed to load branches:', err);
    } finally {
      setLoadingBranches(false);
      setEditingBaseBranch(true);
    }
  };

  const handleBaseBranchChange = async (newBranch: string) => {
    setEditingBaseBranch(false);
    if (newBranch === (session.baseBranch || 'main')) return;
    try {
      const result = await window.api?.instance?.updateBaseBranch?.(session.sessionId, newBranch);
      if (result?.success) {
        useAgentStore.getState().updateReportedSession(session.sessionId, { baseBranch: newBranch });
        setSyncResult({ success: true, message: `Base branch changed to ${newBranch}` });
        setTimeout(() => setSyncResult(null), 3000);
      } else {
        setSyncResult({ success: false, message: result?.error?.message || 'Failed to change base branch' });
      }
    } catch (err) {
      setSyncResult({ success: false, message: 'Failed to change base branch' });
    }
  };

  const statusColors = {
    active: 'text-green-500',
    idle: 'text-yellow-500',
    error: 'text-red-500',
    completed: 'text-gray-400',
  };

  const repoName = session.repoPath?.split('/').pop() || 'Unknown';

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Error/Warning Popup */}
      {showErrorPopup && syncResult && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className={`bg-surface border rounded-lg shadow-xl max-w-md w-full mx-4 p-6 ${
            syncResult.success ? 'border-yellow-500' : 'border-red-500'
          }`}>
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                {syncResult.success ? (
                  <svg className="w-6 h-6 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <h3 className={`text-lg font-semibold mb-2 ${
                  syncResult.success ? 'text-yellow-500' : 'text-red-500'
                }`}>
                  {syncResult.success ? 'Sync Warning' : 'Sync Failed'}
                </h3>
                <p className="text-text-secondary text-sm whitespace-pre-wrap">{syncResult.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowErrorPopup(false);
                  setSyncResult(null);
                }}
                className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Dismiss
              </button>
              {!syncResult.success && (
                <button
                  onClick={() => {
                    setShowErrorPopup(false);
                    handleSync();
                  }}
                  className="px-4 py-2 text-sm font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-surface-secondary transition-colors"
          >
            <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-text-primary">
              {session.task || session.branchName || 'Session Details'}
            </h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-text-secondary">
              <span className={statusColors[session.status] || 'text-gray-400'}>
                {session.status}
              </span>
              <span>{repoName}</span>
              <span className="font-mono text-xs">{session.branchName}</span>
            </div>
          </div>

          {/* Session Actions */}
          <div className="flex items-center gap-2">
            {/* Sync Result Message */}
            {syncResult && (
              <span className={`text-xs max-w-[200px] truncate ${syncResult.success ? 'text-green-500' : 'text-red-500'}`} title={syncResult.message}>
                {syncResult.message}
              </span>
            )}
            {restartError && (
              <span className="text-xs text-red-500 max-w-[200px] truncate" title={restartError}>
                {restartError}
              </span>
            )}

            {/* Base Branch Selector + Sync Button */}
            <div className="flex items-center gap-1">
              {editingBaseBranch ? (
                <select
                  value={session.baseBranch || 'main'}
                  onChange={(e) => handleBaseBranchChange(e.target.value)}
                  onBlur={() => setEditingBaseBranch(false)}
                  autoFocus
                  className="px-2 py-1.5 rounded-lg text-xs font-mono bg-surface-tertiary border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[140px]"
                >
                  {branches.map((branch) => (
                    <option key={branch} value={branch}>{branch}</option>
                  ))}
                </select>
              ) : (
                <button
                  onClick={handleEditBaseBranch}
                  disabled={loadingBranches}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
                  title="Target branch — used for rebase (sync) and merge. Click to change."
                >
                  {loadingBranches ? '...' : (session.baseBranch || 'main')}
                  <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
              <button
                onClick={handleSync}
                disabled={syncing}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${syncing
                    ? 'bg-blue-500 text-white cursor-wait'
                    : 'bg-surface-secondary text-text-primary hover:bg-blue-50 hover:text-blue-600'
                  }`}
                title={syncing ? 'Syncing...' : `Sync with ${session.baseBranch || 'main'} (fetch & rebase)`}
              >
                <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                </svg>
                {syncing ? 'Syncing...' : 'Sync'}
              </button>
            </div>

            {onRestart && !showRestartConfirm && !restarting && (
              <button
                onClick={() => setShowRestartConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-surface-secondary text-text-primary hover:bg-surface-tertiary"
                title="Restart session"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Restart
              </button>
            )}
            {onRestart && showRestartConfirm && !restarting && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-text-secondary mr-1">Commit changes?</span>
                <button
                  onClick={() => handleRestart(true)}
                  className="px-2 py-1 rounded text-xs font-medium bg-kanvas-blue text-white hover:bg-kanvas-blue/80 transition-colors"
                  title="Commit uncommitted changes, then restart"
                >Yes</button>
                <button
                  onClick={() => handleRestart(false)}
                  className="px-2 py-1 rounded text-xs font-medium bg-surface-tertiary text-text-primary hover:bg-red-50 hover:text-red-600 transition-colors"
                  title="Discard uncommitted changes and restart"
                >No</button>
                <button
                  onClick={() => setShowRestartConfirm(false)}
                  className="px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
                >✕</button>
              </div>
            )}
            {onRestart && restarting && (
              <button disabled className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-kanvas-blue text-white cursor-wait">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Restarting...
              </button>
            )}
            {onDelete && (
              <button
                onClick={handleDelete}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${showDeleteConfirm
                    ? 'bg-red-500 text-white'
                    : 'bg-surface-secondary text-text-secondary hover:text-red-500 hover:bg-red-50'
                  }`}
                title={showDeleteConfirm ? 'Click again to confirm' : 'Delete session'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {showDeleteConfirm ? 'Confirm?' : 'Delete'}
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 flex-wrap">
          {(['prompt', 'activity', 'commits', 'terminal', 'files', 'contracts', 'mcp'] as DetailTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${activeTab === tab
                  ? 'bg-kanvas-blue text-white'
                  : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
                }`}
            >
              {tab === 'mcp' ? 'MCP' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Quick Actions */}
      <QuickActionsBar
        worktreePath={instance?.worktreePath || session.worktreePath || session.repoPath}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'prompt' && (
          <PromptTab
            session={session}
            instance={instance}
            onCopyPrompt={handleCopyPrompt}
            onCopyInstructions={handleCopyInstructions}
            copySuccess={copySuccess}
          />
        )}
        {activeTab === 'activity' && (
          <ActivityTab
            sessionId={session.sessionId}
            repoPath={session.worktreePath || session.repoPath}
            baseBranch={session.baseBranch}
            branchName={session.branchName}
          />
        )}
        {activeTab === 'commits' && (
          <CommitsTab session={session} />
        )}
        {activeTab === 'files' && (
          <FilesTab session={session} />
        )}
        {activeTab === 'contracts' && (
          <ContractsTab session={session} />
        )}
        {activeTab === 'terminal' && (
          <TerminalTab sessionId={session.sessionId} />
        )}
        {activeTab === 'mcp' && (
          <McpTab sessionId={session.sessionId} />
        )}
      </div>
    </div>
  );
}

interface PromptTabProps {
  session: SessionReport;
  instance: AgentInstance | null;
  onCopyPrompt: () => void;
  onCopyInstructions: () => void;
  copySuccess: boolean;
}

function PromptTab({
  session,
  instance,
  onCopyPrompt,
  onCopyInstructions,
  copySuccess
}: PromptTabProps): React.ReactElement {
  const prompt = instance?.prompt || generateDefaultPrompt(session);

  return (
    <div className="h-full flex flex-col p-4 overflow-auto">
      {/* Copy buttons */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={onCopyPrompt}
          className="flex items-center gap-2 px-4 py-2 bg-kanvas-blue text-white rounded-lg
            hover:bg-kanvas-blue/90 transition-colors"
        >
          {copySuccess ? (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy Prompt
            </>
          )}
        </button>
        {instance?.instructions && (
          <button
            onClick={onCopyInstructions}
            className="flex items-center gap-2 px-4 py-2 bg-surface-secondary text-text-primary rounded-lg
              hover:bg-surface-tertiary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Copy Full Instructions
          </button>
        )}
      </div>

      {/* Session info cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <InfoCard label="Repository" value={session.repoPath || 'Unknown'} mono />
        <InfoCard label="Branch" value={session.branchName} mono />
        <InfoCard label="Session ID" value={session.sessionId.slice(0, 16) + '...'} mono />
        <InfoCard label="Commits" value={String(session.commitCount || 0)} />
      </div>

      {/* Prompt display */}
      <div className="flex-1 min-h-0">
        <h3 className="text-sm font-medium text-text-secondary mb-2">Prompt for Agent</h3>
        <div className="h-full bg-surface-secondary rounded-xl border border-border overflow-auto">
          <pre className="p-4 text-sm text-text-primary whitespace-pre-wrap font-mono select-text cursor-text">
            {prompt}
          </pre>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.ReactElement {
  return (
    <div className="p-3 bg-surface-secondary rounded-lg border border-border">
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      <div className={`text-sm text-text-primary truncate ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * ActivityTab - Shows unified timeline for this session
 * Combines activity logs and commits from database + git history
 * Includes verbose mode toggle to show/hide file changes and debug info
 */
function ActivityTab({ sessionId, repoPath, baseBranch, branchName }: { sessionId: string; repoPath?: string; baseBranch?: string; branchName?: string }): React.ReactElement {
  const [verboseMode, setVerboseMode] = useState(false);
  const [historicalLogs, setHistoricalLogs] = useState<ActivityLogEntry[]>([]);
  const [commits, setCommits] = useState<Array<{
    hash: string;
    message: string;
    timestamp: string;
    filesChanged: number;
    additions: number;
    deletions: number;
  }>>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 50;

  // Track when this session view was mounted (to separate historical from live)
  const [sessionResumeTime] = useState(() => new Date().toISOString());

  const recentActivity = useAgentStore((state) => state.recentActivity);

  // Load historical logs and commits from database + git history on mount
  useEffect(() => {
    async function loadHistory() {
      setLoading(true);
      try {
        // Load activity logs
        if (window.api?.activity?.get) {
          const result = await window.api.activity.get(sessionId, PAGE_SIZE, 0);
          if (result.success && result.data) {
            setHistoricalLogs(result.data);
            setHasMore(result.data.length >= PAGE_SIZE);
          }
        }

        // Load commits for this session from database
        const dbCommits: typeof commits = [];
        if (window.api?.activity?.getCommits) {
          const commitResult = await window.api.activity.getCommits(sessionId, 100);
          if (commitResult.success && commitResult.data) {
            dbCommits.push(...commitResult.data);
          }
        }

        // Also load commits from git history if repoPath is available
        const gitCommits: typeof commits = [];
        if (repoPath && window.api?.git?.getCommitHistory) {
          try {
            const gitResult = await window.api.git.getCommitHistory(repoPath, baseBranch || 'main', 100, branchName);
            if (gitResult.success && gitResult.data) {
              // Map git commits to our format
              for (const gc of gitResult.data) {
                gitCommits.push({
                  hash: gc.hash,
                  message: gc.message,
                  timestamp: gc.date,
                  filesChanged: gc.filesChanged,
                  additions: gc.additions,
                  deletions: gc.deletions,
                });
              }
            }
          } catch (gitError) {
            console.warn('Failed to load git commit history:', gitError);
          }
        }

        // Merge commits, avoiding duplicates by hash (prefer git commits as they're more up-to-date)
        const commitsByHash = new Map<string, typeof commits[0]>();
        for (const commit of dbCommits) {
          commitsByHash.set(commit.hash, commit);
        }
        for (const commit of gitCommits) {
          commitsByHash.set(commit.hash, commit);
        }
        setCommits(Array.from(commitsByHash.values()));
      } catch (error) {
        console.error('Failed to load activity history:', error);
      } finally {
        setLoading(false);
      }
    }
    loadHistory();
  }, [sessionId, repoPath, baseBranch, branchName]);

  // Load more historical logs with proper offset
  const loadMore = async () => {
    const newOffset = offset + PAGE_SIZE;
    setLoadingMore(true);
    try {
      if (window.api?.activity?.get) {
        const result = await window.api.activity.get(sessionId, PAGE_SIZE, newOffset);
        if (result.success && result.data) {
          // Append older entries to existing logs
          setHistoricalLogs(prev => [...prev, ...result.data]);
          setOffset(newOffset);
          setHasMore(result.data.length >= PAGE_SIZE);
        }
      }
    } catch (error) {
      console.error('Failed to load more activity:', error);
    } finally {
      setLoadingMore(false);
    }
  };

  // Get live activity (entries received since session resume)
  const liveActivity = recentActivity.filter(
    a => a.sessionId === sessionId && a.timestamp >= sessionResumeTime
  );

  // Filter out entries already in historical logs (by timestamp comparison)
  const historicalTimestamps = new Set(historicalLogs.map(l => l.timestamp));
  const dedupedLiveActivity = liveActivity.filter(a => !historicalTimestamps.has(a.timestamp));

  // Create unified timeline: combine activity logs and commits
  type TimelineEntry =
    | { type: 'activity'; data: ActivityLogEntry }
    | { type: 'commit'; data: { hash: string; message: string; timestamp: string; filesChanged: number; additions: number; deletions: number } };

  const timeline: TimelineEntry[] = [];

  // Add live activity
  for (const entry of dedupedLiveActivity) {
    timeline.push({ type: 'activity', data: entry });
  }

  // Add historical activity
  for (const entry of historicalLogs) {
    timeline.push({ type: 'activity', data: entry });
  }

  // Add commits (avoiding duplicates if they're already in activity as 'commit' type)
  const commitHashesInActivity = new Set(
    historicalLogs.filter(l => l.type === 'commit' && l.commitHash).map(l => l.commitHash)
  );
  for (const commit of commits) {
    if (!commitHashesInActivity.has(commit.hash)) {
      timeline.push({ type: 'commit', data: commit });
    }
  }

  // Sort by timestamp (newest first)
  timeline.sort((a, b) => {
    const aTime = a.type === 'activity' ? a.data.timestamp : a.data.timestamp;
    const bTime = b.type === 'activity' ? b.data.timestamp : b.data.timestamp;
    return new Date(bTime).getTime() - new Date(aTime).getTime();
  });

  // In non-verbose mode, hide file changes to reduce noise
  const filteredTimeline = verboseMode
    ? timeline
    : timeline.filter(entry =>
        entry.type === 'commit' || (entry.type === 'activity' && entry.data.type !== 'file')
      );

  // Legacy: for display calculations
  const allActivity = historicalLogs;

  const formatTime = (timestamp: string): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDate = (timestamp: string): string => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const logTypeStyles: Record<string, { color: string; bg: string; label: string }> = {
    success: { color: 'text-green-600', bg: 'bg-green-50', label: 'Success' },
    error: { color: 'text-red-600', bg: 'bg-red-50', label: 'Error' },
    warning: { color: 'text-yellow-600', bg: 'bg-yellow-50', label: 'Warning' },
    info: { color: 'text-kanvas-blue', bg: 'bg-kanvas-blue/5', label: 'Info' },
    commit: { color: 'text-purple-600', bg: 'bg-purple-50', label: 'Commit' },
    file: { color: 'text-text-secondary', bg: 'bg-surface-tertiary', label: 'File' },
    git: { color: 'text-orange-600', bg: 'bg-orange-50', label: 'Git' },
  };

  const fileChangeCount = allActivity.filter(a => a.type === 'file').length;
  const commitCount = commits.length;
  const historicalCount = historicalLogs.length;

  return (
    <div className="h-full flex flex-col">
      {/* Header with verbose toggle */}
      <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-text-primary">Timeline</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary text-text-secondary">
            {filteredTimeline.length} events
          </span>
          {commitCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              {commitCount} commits
            </span>
          )}
          {!verboseMode && fileChangeCount > 0 && (
            <span className="text-xs text-text-secondary">
              ({fileChangeCount} file changes hidden)
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-text-secondary">Verbose</span>
          <div
            onClick={() => setVerboseMode(!verboseMode)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              verboseMode ? 'bg-kanvas-blue' : 'bg-surface-tertiary'
            }`}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                verboseMode ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </div>
        </label>
      </div>

      {/* Timeline list */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-kanvas-blue border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filteredTimeline.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
                <svg className="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">No Activity Yet</h3>
              <p className="text-sm text-text-secondary max-w-xs">
                {verboseMode
                  ? 'Activity will appear here as the agent works.'
                  : 'Enable verbose mode to see file changes, or wait for commits and status updates.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredTimeline.map((entry, index) => {
              const timestamp = entry.type === 'activity' ? entry.data.timestamp : entry.data.timestamp;
              const isHistorical = timestamp < sessionResumeTime;

              // Render commit entry
              if (entry.type === 'commit') {
                const commit = entry.data;
                return (
                  <div
                    key={`commit-${commit.hash}-${index}`}
                    className={`px-4 py-3 hover:bg-surface-secondary transition-colors ${
                      isHistorical ? 'opacity-70' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center mt-0.5">
                        <svg className="w-3.5 h-3.5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">
                            {commit.hash.slice(0, 7)}
                          </code>
                          <p className="text-sm text-text-primary break-words flex-1">{commit.message}</p>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                            Commit
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-text-secondary">{formatTime(commit.timestamp)}</span>
                          <span className="text-xs text-text-secondary">
                            {commit.filesChanged} files
                          </span>
                          <span className="text-xs text-green-600">+{commit.additions}</span>
                          <span className="text-xs text-red-600">-{commit.deletions}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              // Render activity entry
              const activityEntry = entry.data;
              const style = logTypeStyles[activityEntry.type] || logTypeStyles.info;

              return (
                <React.Fragment key={`activity-${activityEntry.timestamp}-${index}`}>
                  <div
                    className={`px-4 py-3 hover:bg-surface-secondary transition-colors ${
                      isHistorical ? 'opacity-70' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`flex-shrink-0 w-6 h-6 rounded-full ${style.bg} flex items-center justify-center mt-0.5`}>
                        <span className={`text-xs font-bold ${style.color}`}>
                          {activityEntry.type.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-text-primary break-words flex-1">{activityEntry.message}</p>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${style.bg} ${style.color}`}>
                            {style.label}
                          </span>
                        </div>
                        <span className="text-xs text-text-secondary">{formatTime(activityEntry.timestamp)}</span>
                        {activityEntry.details && Object.keys(activityEntry.details).length > 0 && (
                          <div className="mt-2 p-2 rounded-lg bg-surface-tertiary">
                            <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">
                              {JSON.stringify(activityEntry.details, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}

            {/* Load more button */}
            {hasMore && (
              <div className="px-4 py-3 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-sm text-kanvas-blue hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingMore ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="w-3 h-3 border border-kanvas-blue border-t-transparent rounded-full animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    'Load more history...'
                  )}
                </button>
              </div>
            )}

            {/* Historical data indicator */}
            {(historicalCount > 0 || commitCount > 0) && !hasMore && (
              <div className="px-4 py-2 text-center text-xs text-text-secondary bg-surface-secondary">
                Showing {historicalCount} activity entries and {commitCount} commits from session history
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * FilesTab - Shows files changed in this session
 * Combines git diff data with real-time file watcher events
 * Includes git status (staged/unstaged/committed) and manual commit button
 */
function FilesTab({ session }: { session: SessionReport }): React.ReactElement {
  const [gitFiles, setGitFiles] = useState<Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    gitState: 'staged' | 'unstaged' | 'committed' | 'untracked';
    commitHash?: string;
    commitShortHash?: string;
    commitMessage?: string;
  }>>([]);
  const [recentChanges, setRecentChanges] = useState<Array<{ path: string; type: string; timestamp: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'git' | 'recent'>('git');
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);

  // Load git diff files with status
  const loadChangedFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      // Use worktreePath if available, otherwise repoPath
      const repoPath = session.worktreePath || session.repoPath;
      // Use baseBranch if set, otherwise default to main
      const baseBranch = session.baseBranch || 'main';

      if (window.api?.git?.getFilesWithStatus && repoPath) {
        const result = await window.api.git.getFilesWithStatus(repoPath, baseBranch);
        if (result.success && result.data) {
          setGitFiles(result.data);
        } else if (result.error) {
          setError(result.error.message || 'Failed to load files');
        }
      } else if (window.api?.git?.getChangedFiles && repoPath) {
        // Fallback to basic getChangedFiles
        const result = await window.api.git.getChangedFiles(repoPath, baseBranch);
        if (result.success && result.data) {
          setGitFiles(result.data.map(f => ({ ...f, gitState: 'unstaged' as const })));
        } else if (result.error) {
          setError(result.error.message || 'Failed to load files');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChangedFiles();
  }, [session.sessionId, session.worktreePath, session.repoPath, session.baseBranch]);

  // Subscribe to real-time file changes
  useEffect(() => {
    const unsubscribe = window.api?.watcher?.onFileChanged?.((event) => {
      if (event.sessionId === session.sessionId) {
        setRecentChanges(prev => [
          { path: event.filePath, type: event.type, timestamp: event.timestamp },
          ...prev.slice(0, 99), // Keep last 100
        ]);
      }
    });

    return () => unsubscribe?.();
  }, [session.sessionId]);

  // Generate AI commit message with actual diff analysis using AI mode system
  const generateCommitMessage = async () => {
    setGeneratingMessage(true);
    setCommitError(null);
    try {
      const uncommittedFiles = gitFiles.filter(f => f.gitState !== 'committed');
      if (uncommittedFiles.length === 0) {
        setCommitError('No uncommitted files to commit');
        return;
      }

      const repoPath = session.worktreePath || session.repoPath;
      if (!repoPath) {
        setCommitError('No repository path');
        return;
      }

      // Get detailed diff summary with actual code changes
      let diffSummary: {
        totalFiles: number;
        totalAdditions: number;
        totalDeletions: number;
        filesByType: Record<string, number>;
        summary: string;
        files: Array<{ path: string; status: string; additions: number; deletions: number; diff: string }>;
      } | null = null;

      console.log('[CommitMessage] Fetching diff summary...');

      if (window.api?.git?.getDiffSummary) {
        const diffResult = await window.api.git.getDiffSummary(repoPath);
        if (diffResult.success && diffResult.data) {
          diffSummary = diffResult.data;
          console.log('[CommitMessage] Got diff summary:', diffSummary.totalFiles, 'files');
        } else {
          console.warn('[CommitMessage] Failed to get diff summary:', diffResult.error);
        }
      }

      // Prepare variables for the AI mode
      const taskContext = session.task || session.branchName || 'development';

      let changeStats = `${uncommittedFiles.length} files`;
      let fileChanges = '';

      if (diffSummary && diffSummary.files.length > 0) {
        changeStats = `${diffSummary.totalFiles} files, +${diffSummary.totalAdditions}/-${diffSummary.totalDeletions} lines`;

        // Build detailed file changes with actual diffs - include ALL files
        fileChanges = diffSummary.files.map(f => {
          let section = `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
          if (f.diff && f.diff.trim()) {
            // Extract meaningful lines from diff - more context for better analysis
            const diffLines = f.diff.split('\n');
            const meaningfulLines: string[] = [];
            let contextBuffer: string[] = [];

            for (const line of diffLines) {
              // Skip diff headers
              if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
                continue;
              }
              // Keep hunk headers for context
              if (line.startsWith('@@')) {
                if (meaningfulLines.length > 0) meaningfulLines.push('');
                meaningfulLines.push(line);
                contextBuffer = [];
                continue;
              }
              // Keep added/removed lines
              if (line.startsWith('+') || line.startsWith('-')) {
                // Add any buffered context first
                meaningfulLines.push(...contextBuffer);
                contextBuffer = [];
                meaningfulLines.push(line);
              } else if (line.startsWith(' ')) {
                // Buffer context lines (keep last 2)
                contextBuffer.push(line);
                if (contextBuffer.length > 2) contextBuffer.shift();
              }
            }

            // Limit to 50 meaningful lines per file
            const truncatedDiff = meaningfulLines.slice(0, 50).join('\n');
            if (truncatedDiff) {
              section += `\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
            }
          }
          return section;
        }).join('\n\n');
      } else {
        // Simple file list if no diff available
        fileChanges = uncommittedFiles.map(f => {
          const stateIcon = f.gitState === 'staged' ? '[staged]' : f.gitState === 'untracked' ? '[new]' : '[modified]';
          return `- ${stateIcon} ${f.path} (+${f.additions}/-${f.deletions})`;
        }).join('\n');
      }

      console.log('[CommitMessage] Calling AI with commit-message mode...');

      // Use the commit-message mode through chatWithMode API
      if (window.api?.ai?.chatWithMode) {
        try {
          const result = await window.api.ai.chatWithMode({
            modeId: 'commit-message',
            promptKey: diffSummary ? 'generate' : 'simple',
            variables: {
              task_context: taskContext,
              change_stats: changeStats,
              file_changes: fileChanges,
              file_list: fileChanges, // For simple mode
            },
          });

          console.log('[CommitMessage] AI mode result:', result);

          if (result.success && result.data) {
            // Clean up the response
            let message = result.data.trim();
            // Remove surrounding quotes if present
            if ((message.startsWith('"') && message.endsWith('"')) ||
                (message.startsWith("'") && message.endsWith("'"))) {
              message = message.slice(1, -1);
            }
            // Remove markdown code blocks if present
            if (message.startsWith('```')) {
              message = message.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
            }
            setCommitMessage(message.trim());
            return;
          } else {
            console.warn('[CommitMessage] AI mode failed:', result.error);
          }
        } catch (aiError) {
          console.error('[CommitMessage] AI mode error:', aiError);
        }
      } else {
        console.warn('[CommitMessage] chatWithMode not available');
      }

      // Intelligent fallback - generate descriptive message without AI
      console.log('[CommitMessage] Using fallback message generator');
      const fallbackMessage = generateFallbackCommitMessage(uncommittedFiles, session, diffSummary);
      setCommitMessage(fallbackMessage);
    } catch (err) {
      console.error('Failed to generate commit message:', err);
      // Intelligent fallback
      const uncommittedFiles = gitFiles.filter(f => f.gitState !== 'committed');
      const fallbackMessage = generateFallbackCommitMessage(uncommittedFiles, session, null);
      setCommitMessage(fallbackMessage);
    } finally {
      setGeneratingMessage(false);
    }
  };

  // Generate a descriptive fallback message based on file analysis
  const generateFallbackCommitMessage = (
    files: typeof gitFiles,
    sessionInfo: typeof session,
    diffSummary: { filesByType: Record<string, number>; totalAdditions: number; totalDeletions: number; files?: Array<{ path: string; diff: string }> } | null
  ): string => {
    const addedFiles = files.filter(f => f.gitState === 'untracked' || f.status === 'added');
    const modifiedFiles = files.filter(f => f.status === 'modified' || f.gitState === 'unstaged' || f.gitState === 'staged');
    const deletedFiles = files.filter(f => f.status === 'deleted');

    // Analyze file paths to determine scope and type
    const hasTests = files.some(f => f.path.includes('test') || f.path.includes('spec') || f.path.includes('__tests__'));
    const hasDocs = files.some(f => f.path.endsWith('.md') || f.path.includes('docs/'));
    const hasConfig = files.some(f =>
      f.path.includes('config') || f.path.endsWith('.json') || f.path.endsWith('.yml') || f.path.endsWith('.yaml') ||
      f.path.includes('tsconfig') || f.path.includes('package.json')
    );
    const hasStyles = files.some(f => f.path.endsWith('.css') || f.path.endsWith('.scss') || f.path.endsWith('.sass'));
    const hasComponents = files.some(f => f.path.includes('components/') || f.path.includes('views/'));
    const hasServices = files.some(f => f.path.includes('services/') || f.path.includes('api/') || f.path.includes('ipc/'));
    const hasElectron = files.some(f => f.path.includes('electron/') || f.path.includes('preload'));
    const hasRenderer = files.some(f => f.path.includes('renderer/'));

    // Find the most common directory to determine scope
    const dirCounts: Record<string, number> = {};
    files.forEach(f => {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        const dir = parts[0];
        dirCounts[dir] = (dirCounts[dir] || 0) + 1;
      }
    });
    const topDir = Object.entries(dirCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    // Determine commit type based on changes
    let commitType = 'chore';
    if (hasTests && files.every(f => f.path.includes('test') || f.path.includes('spec'))) {
      commitType = 'test';
    } else if (hasDocs && files.every(f => f.path.endsWith('.md') || f.path.includes('docs/'))) {
      commitType = 'docs';
    } else if (hasStyles && files.every(f => f.path.match(/\.(css|scss|sass)$/))) {
      commitType = 'style';
    } else if (addedFiles.length > 0 && addedFiles.length >= modifiedFiles.length) {
      commitType = 'feat';
    } else if (deletedFiles.length > addedFiles.length && deletedFiles.length > modifiedFiles.length) {
      commitType = 'refactor';
    } else if (sessionInfo.task?.toLowerCase().match(/\b(fix|bug|issue|error)\b/)) {
      commitType = 'fix';
    } else {
      commitType = 'feat';
    }

    // Determine scope from directory analysis
    let scope = '';
    if (hasElectron && !hasRenderer) scope = 'electron';
    else if (hasRenderer && !hasElectron) scope = 'renderer';
    else if (hasComponents && !hasServices) scope = 'ui';
    else if (hasServices) scope = 'services';
    else if (hasTests) scope = 'tests';
    else if (hasConfig) scope = 'config';
    else if (topDir && ['electron', 'renderer', 'shared', 'src'].includes(topDir)) scope = topDir;

    // Build description by analyzing file names and changes
    let description = '';

    // Try to extract meaningful description from file names
    const fileNames = files.map(f => {
      const name = f.path.split('/').pop() || '';
      // Remove extension and convert to readable form
      return name.replace(/\.(tsx?|jsx?|css|scss|md|json)$/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    });

    // Find common patterns in file names
    const uniqueNames = [...new Set(fileNames)].filter(n => n.length > 2);

    if (files.length === 1) {
      // Single file - be specific
      const fileName = files[0].path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'file';
      if (addedFiles.length === 1) {
        description = `add ${fileName}`;
      } else if (deletedFiles.length === 1) {
        description = `remove ${fileName}`;
      } else {
        description = `update ${fileName}`;
      }
    } else if (addedFiles.length > 0 && modifiedFiles.length === 0 && deletedFiles.length === 0) {
      // Only additions
      if (addedFiles.length <= 3) {
        description = `add ${addedFiles.map(f => f.path.split('/').pop()?.replace(/\.[^.]+$/, '')).join(', ')}`;
      } else {
        description = `add ${addedFiles.length} new files`;
      }
    } else if (deletedFiles.length > 0 && addedFiles.length === 0 && modifiedFiles.length === 0) {
      // Only deletions
      description = `remove ${deletedFiles.length} files`;
    } else if (uniqueNames.length <= 3 && uniqueNames.length > 0) {
      // Few distinct files - mention them
      description = `update ${uniqueNames.slice(0, 2).join(' and ')}`;
    } else {
      // Many files - describe the change pattern
      const additions = diffSummary?.totalAdditions || 0;
      const deletions = diffSummary?.totalDeletions || 0;

      if (additions > deletions * 2) {
        description = `implement new functionality across ${files.length} files`;
      } else if (deletions > additions * 2) {
        description = `refactor and clean up ${files.length} files`;
      } else {
        description = `update ${files.length} files`;
      }
    }

    // Ensure description starts with lowercase
    description = description.charAt(0).toLowerCase() + description.slice(1);

    // Truncate if too long
    if (description.length > 50) {
      description = description.substring(0, 47) + '...';
    }

    // Build final message
    const scopePart = scope ? `(${scope})` : '';
    return `${commitType}${scopePart}: ${description}`;
  };

  // Execute manual commit
  const handleCommit = async () => {
    if (!commitMessage) return;
    setCommitting(true);
    setCommitError(null);
    setCommitSuccess(false);
    try {
      const repoPath = session.worktreePath || session.repoPath;
      if (!repoPath) {
        setCommitError('No repository path');
        return;
      }

      // Write commit message to .devops-commit file to trigger auto-commit
      const shortSessionId = session.sessionId.replace('sess_', '').slice(0, 8);
      const commitMsgFile = `.devops-commit-${shortSessionId}.msg`;

      // Use the shell to write the commit message file and trigger the watcher
      // This leverages the existing auto-commit infrastructure
      if (window.api?.shell?.openTerminal) {
        // Alternative: directly invoke git commit via IPC
        const result = await window.api.git.commit(session.sessionId, commitMessage);
        if (result.success) {
          setCommitSuccess(true);
          setCommitMessage(null);
          // Refresh files list
          setTimeout(loadChangedFiles, 1000);
        } else {
          setCommitError(result.error?.message || 'Commit failed');
        }
      }
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  const formatTime = (timestamp: string): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Group files by git state
  const uncommittedFiles = gitFiles.filter(f => f.gitState !== 'committed');
  const committedFiles = gitFiles.filter(f => f.gitState === 'committed');
  const hasUncommitted = uncommittedFiles.length > 0;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-kanvas-blue border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with view toggle, manual commit, and refresh */}
      <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('git')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              viewMode === 'git'
                ? 'bg-kanvas-blue text-white'
                : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
            }`}
          >
            Git Diff ({gitFiles.length})
          </button>
          <button
            onClick={() => setViewMode('recent')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              viewMode === 'recent'
                ? 'bg-kanvas-blue text-white'
                : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
            }`}
          >
            Recent ({recentChanges.length})
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Manual Commit Button */}
          {hasUncommitted && viewMode === 'git' && (
            <button
              onClick={generateCommitMessage}
              disabled={generatingMessage || committing}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                generatingMessage || committing
                  ? 'bg-kanvas-blue/50 text-white cursor-wait'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
              title="Generate AI commit message and commit"
            >
              {generatingMessage ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Manual Commit
                </>
              )}
            </button>
          )}
          <button
            onClick={loadChangedFiles}
            disabled={loading}
            className="p-2 rounded-lg bg-surface-secondary hover:bg-surface-tertiary transition-colors"
            title="Refresh"
          >
            <svg className={`w-4 h-4 text-text-secondary ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Commit Message Editor */}
      {commitMessage && (
        <div className="mx-4 mt-4 p-4 bg-surface-secondary rounded-xl border border-kanvas-blue">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-text-secondary mb-2 block">
                AI Generated Commit Message (edit if needed)
              </label>
              <textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                className="w-full h-24 px-3 py-2 text-sm font-mono bg-surface border border-border rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-kanvas-blue resize-none text-text-primary"
                placeholder="Commit message..."
              />
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-text-secondary">
                  {uncommittedFiles.length} file(s) will be committed
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCommitMessage(null)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-surface-tertiary text-text-secondary
                      hover:bg-surface hover:text-text-primary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCommit}
                    disabled={committing || !commitMessage.trim()}
                    className={`flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg transition-colors ${
                      committing
                        ? 'bg-green-600/50 text-white cursor-wait'
                        : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  >
                    {committing ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Committing...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Commit & Push
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error/Success Messages */}
      {commitError && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{commitError}</p>
        </div>
      )}
      {commitSuccess && (
        <div className="mx-4 mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700">Commit successful!</p>
        </div>
      )}

      {/* Error state */}
      {error && viewMode === 'git' && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {viewMode === 'git' ? (
          gitFiles.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
                  <svg className="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-text-primary mb-2">No Git Changes Yet</h3>
                <p className="text-sm text-text-secondary max-w-xs">
                  Shows files changed since branching. Check "Recent" tab for real-time file activity.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Uncommitted Files Section */}
              {uncommittedFiles.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-text-secondary mb-2 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
                    Uncommitted ({uncommittedFiles.length})
                  </h4>
                  <div className="space-y-2">
                    {uncommittedFiles.map((file) => (
                      <div key={file.path} className="p-3 bg-surface-secondary rounded-lg border border-border">
                        <div className="flex items-center gap-3">
                          <GitStateIcon gitState={file.gitState} />
                          <span className="flex-1 font-mono text-sm text-text-primary truncate">{file.path}</span>
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-green-500">+{file.additions}</span>
                            <span className="text-red-500">-{file.deletions}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Committed Files Section */}
              {committedFiles.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-text-secondary mb-2 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    Committed ({committedFiles.length})
                  </h4>
                  <div className="space-y-2">
                    {committedFiles.map((file) => (
                      <div key={file.path} className="p-3 bg-surface-secondary rounded-lg border border-border">
                        <div className="flex items-center gap-3">
                          <GitStateIcon gitState={file.gitState} />
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-sm text-text-primary truncate block">{file.path}</span>
                            {file.commitShortHash && (
                              <div className="flex items-center gap-2 mt-1">
                                <code className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-mono">
                                  {file.commitShortHash}
                                </code>
                                {file.commitMessage && (
                                  <span className="text-xs text-text-secondary truncate">
                                    {file.commitMessage.slice(0, 50)}{file.commitMessage.length > 50 ? '...' : ''}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-green-500">+{file.additions}</span>
                            <span className="text-red-500">-{file.deletions}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : (
          recentChanges.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
                  <svg className="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-text-primary mb-2">No Recent Activity</h3>
                <p className="text-sm text-text-secondary max-w-xs">
                  Real-time file changes will appear here as the agent works.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {recentChanges.map((change, idx) => (
                <div key={`${change.path}-${idx}`} className="p-3 bg-surface-secondary rounded-lg border border-border">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                      change.type === 'add' ? 'bg-green-100 text-green-700' :
                      change.type === 'unlink' ? 'bg-red-100 text-red-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {change.type === 'add' ? 'ADD' : change.type === 'unlink' ? 'DEL' : 'MOD'}
                    </span>
                    <span className="flex-1 font-mono text-sm text-text-primary truncate">{change.path}</span>
                    <span className="text-xs text-text-secondary">{formatTime(change.timestamp)}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * GitStateIcon - Shows the git state of a file (staged, unstaged, committed, untracked)
 */
function GitStateIcon({ gitState }: { gitState: 'staged' | 'unstaged' | 'committed' | 'untracked' }): React.ReactElement {
  const stateStyles: Record<string, { bg: string; text: string; label: string }> = {
    staged: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'S' },
    unstaged: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'M' },
    committed: { bg: 'bg-green-100', text: 'text-green-700', label: 'C' },
    untracked: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'U' },
  };

  const style = stateStyles[gitState] || stateStyles.unstaged;

  return (
    <span
      className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${style.bg} ${style.text}`}
      title={gitState.charAt(0).toUpperCase() + gitState.slice(1)}
    >
      {style.label}
    </span>
  );
}


/**
 * ContractsTab - Shows contracts from House_Rules_Contracts/ directory
 * Matches the existing contract structure in the repo
 */
function ContractsTab({ session }: { session: SessionReport }): React.ReactElement {
  const [activeContractType, setActiveContractType] = useState<ContractType | 'all'>('all');
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractChanges, setContractChanges] = useState<Array<{ file: string; type: string; changeType: string; impactLevel: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Contract generation state
  const [scanPathOption, setScanPathOption] = useState<'main' | 'worktree'>('worktree');
  const [discoveredFeatures, setDiscoveredFeatures] = useState<Array<{
    name: string;
    description?: string;
    basePath: string;
    files: { api: string[]; schema: string[]; tests: { e2e: string[]; unit: string[]; integration: string[] }; fixtures: string[]; config: string[]; other: string[] };
    contractPatternMatches: number;
  }>>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState<string>('');
  // Use global contract store (persists across tab switches)
  const isGenerating = useContractStore((state) => state.isGenerating);
  const setIsGenerating = useContractStore((state) => state.setIsGenerating);
  const generationProgress = useContractStore((state) => state.generationProgress);
  const generationResult = useContractStore((state) => state.generationResult);
  const activityLogs = useContractStore((state) => state.activityLogs);
  const [showActivityLog, setShowActivityLog] = useState(true);
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false);

  // Contract categories - both API and Test contracts
  const contractTypes: { type: ContractType | 'all'; label: string; icon: string; file?: string; isTest?: boolean }[] = [
    { type: 'all', label: 'All', icon: '📋' },
    // API/Schema Contracts
    { type: 'api', label: 'API', icon: '🔌', file: 'API_CONTRACT.md' },
    { type: 'schema', label: 'Schema', icon: '📐', file: 'DATABASE_SCHEMA_CONTRACT.md' },
    { type: 'events', label: 'Events', icon: '⚡', file: 'EVENTS_CONTRACT.md' },
    { type: 'features', label: 'Features', icon: '✨', file: 'FEATURES_CONTRACT.md' },
    { type: 'infra', label: 'Infra', icon: '🏗️', file: 'INFRA_CONTRACT.md' },
    { type: 'integrations', label: '3rd Party', icon: '🔗', file: 'THIRD_PARTY_INTEGRATIONS.md' },
    // Additional Contracts
    { type: 'admin', label: 'Admin', icon: '👤', file: 'ADMIN_CONTRACT.md' },
    { type: 'sql', label: 'SQL', icon: '🗃️', file: 'SQL_CONTRACT.md' },
    { type: 'css', label: 'CSS', icon: '🎨', file: 'CSS_CONTRACT.md' },
    { type: 'prompts', label: 'Prompts', icon: '💬', file: 'PROMPTS_CONTRACT.md' },
    // Test Contracts (Quality Contracts)
    { type: 'e2e', label: 'E2E Tests', icon: '🎭', isTest: true },
    { type: 'unit', label: 'Unit Tests', icon: '🧪', isTest: true },
    { type: 'integration', label: 'Integration', icon: '🔗', isTest: true },
    { type: 'fixtures', label: 'Fixtures', icon: '📦', isTest: true },
  ];

  useEffect(() => {
    async function loadContracts() {
      setLoading(true);
      try {
        // IMPORTANT: Use worktreePath first (where contracts are actually generated)
        const repoPath = session.worktreePath || session.repoPath;

        // Load contract changes in background (non-blocking)
        if (window.api?.contract?.analyzeCommit && repoPath) {
          window.api.contract.analyzeCommit(repoPath).then(result => {
            if (result.success && result.data?.changes) {
              setContractChanges(result.data.changes);
            }
          }).catch(() => {});
        }

        // Load contract files from House_Rules_Contracts/
        // For now, create placeholder entries based on known contract files
        const knownContracts: Contract[] = [
          // API & Schema Contracts
          {
            id: 'api-contract',
            type: 'api',
            name: 'API Contract',
            description: 'REST/GraphQL API endpoints and authentication',
            filePath: `${repoPath}/House_Rules_Contracts/API_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'schema-contract',
            type: 'schema',
            name: 'Database Schema Contract',
            description: 'Database tables, migrations, and data models',
            filePath: `${repoPath}/House_Rules_Contracts/DATABASE_SCHEMA_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'events-contract',
            type: 'events',
            name: 'Events Contract (Feature Bus)',
            description: 'Domain events for cross-service communication',
            filePath: `${repoPath}/House_Rules_Contracts/EVENTS_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'features-contract',
            type: 'features',
            name: 'Features Contract',
            description: 'Feature flags and toggles',
            filePath: `${repoPath}/House_Rules_Contracts/FEATURES_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'infra-contract',
            type: 'infra',
            name: 'Infrastructure Contract',
            description: 'Deployment, services, and infrastructure',
            filePath: `${repoPath}/House_Rules_Contracts/INFRA_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'integrations-contract',
            type: 'integrations',
            name: 'Third-Party Integrations',
            description: 'External service integrations and SDKs',
            filePath: `${repoPath}/House_Rules_Contracts/THIRD_PARTY_INTEGRATIONS.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          // Additional Contracts
          {
            id: 'admin-contract',
            type: 'admin',
            name: 'Admin Contract',
            description: 'Admin panel capabilities, CRUD operations, and permissions',
            filePath: `${repoPath}/House_Rules_Contracts/ADMIN_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'sql-contract',
            type: 'sql',
            name: 'SQL Contract',
            description: 'Reusable SQL queries, stored procedures, and performance hints',
            filePath: `${repoPath}/House_Rules_Contracts/SQL_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'css-contract',
            type: 'css',
            name: 'CSS Contract',
            description: 'Design tokens, themes, and style guidelines',
            filePath: `${repoPath}/House_Rules_Contracts/CSS_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
          {
            id: 'prompts-contract',
            type: 'prompts',
            name: 'Prompts & Skills Contract',
            description: 'AI prompts, skills, modes, and agent configurations',
            filePath: `${repoPath}/House_Rules_Contracts/PROMPTS_CONTRACT.md`,
            status: 'active',
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
          },
        ];

        // Show base contracts immediately
        setContracts(knownContracts);
        setLoading(false);

        // Load test contracts in background (from saved features cache)
        if (window.api?.contractGeneration?.loadDiscoveredFeatures && repoPath) {
          window.api.contractGeneration.loadDiscoveredFeatures(repoPath).then(savedResult => {
            if (savedResult?.success && savedResult.data && savedResult.data.length > 0) {
              // Also update discoveredFeatures state
              setDiscoveredFeatures(savedResult.data);

              // Collect all test files by type (GROUPED)
              const e2eFiles: string[] = [];
              const unitFiles: string[] = [];
              const integrationFiles: string[] = [];
              const fixtureFiles: string[] = [];

              for (const feature of savedResult.data) {
                e2eFiles.push(...(feature.files?.tests?.e2e || []));
                unitFiles.push(...(feature.files?.tests?.unit || []));
                integrationFiles.push(...(feature.files?.tests?.integration || []));
                fixtureFiles.push(...(feature.files?.fixtures || []));
              }

              // Add test contract cards
              const testContracts: Contract[] = [];

              if (e2eFiles.length > 0) {
                testContracts.push({
                  id: 'e2e-all',
                  type: 'e2e',
                  name: 'E2E Tests',
                  description: `${e2eFiles.length} E2E test file(s)`,
                  filePath: `${repoPath}/.devops-kit/contracts/E2E_TESTS.md`,
                  status: 'active',
                  version: '1.0.0',
                  lastUpdated: new Date().toISOString(),
                });
              }

              if (unitFiles.length > 0) {
                testContracts.push({
                  id: 'unit-all',
                  type: 'unit',
                  name: 'Unit Tests',
                  description: `${unitFiles.length} unit test file(s)`,
                  filePath: `${repoPath}/.devops-kit/contracts/UNIT_TESTS.md`,
                  status: 'active',
                  version: '1.0.0',
                  lastUpdated: new Date().toISOString(),
                });
              }

              if (integrationFiles.length > 0) {
                testContracts.push({
                  id: 'integration-all',
                  type: 'integration',
                  name: 'Integration Tests',
                  description: `${integrationFiles.length} integration test file(s)`,
                  filePath: `${repoPath}/.devops-kit/contracts/INTEGRATION_TESTS.md`,
                  status: 'active',
                  version: '1.0.0',
                  lastUpdated: new Date().toISOString(),
                });
              }

              if (fixtureFiles.length > 0) {
                testContracts.push({
                  id: 'fixtures-all',
                  type: 'fixtures',
                  name: 'Test Fixtures',
                  description: `${fixtureFiles.length} fixture file(s)`,
                  filePath: `${repoPath}/.devops-kit/contracts/FIXTURES.md`,
                  status: 'active',
                  version: '1.0.0',
                  lastUpdated: new Date().toISOString(),
                });
              }

              // Append test contracts to existing
              if (testContracts.length > 0) {
                setContracts(prev => {
                  const nonTest = prev.filter(c => !['e2e', 'unit', 'integration', 'fixtures'].includes(c.type));
                  return [...nonTest, ...testContracts];
                });
              }
            }
          }).catch(() => {});
        }

        // Early return - loading already set to false above
        return;
      } catch (error) {
        console.error('Failed to load contracts:', error);
      } finally {
        setLoading(false);
      }
    }
    loadContracts();
  }, [session.sessionId, session.repoPath, session.worktreePath]);

  // Update contracts list when discoveredFeatures change (add grouped test contracts)
  useEffect(() => {
    if (discoveredFeatures.length === 0) return;

    const repoPath = session.worktreePath || session.repoPath;
    if (!repoPath) return;

    // Add GROUPED test contracts from discovered features
    setContracts(prev => {
      // Filter out existing test contracts to avoid duplicates
      const nonTestContracts = prev.filter(c => !['e2e', 'unit', 'integration', 'fixtures'].includes(c.type));

      // Collect all test files by type
      const e2eFiles: string[] = [];
      const unitFiles: string[] = [];
      const integrationFiles: string[] = [];
      const fixtureFiles: string[] = [];

      for (const feature of discoveredFeatures) {
        e2eFiles.push(...(feature.files?.tests?.e2e || []));
        unitFiles.push(...(feature.files?.tests?.unit || []));
        integrationFiles.push(...(feature.files?.tests?.integration || []));
        fixtureFiles.push(...(feature.files?.fixtures || []));
      }

      const newTestContracts: Contract[] = [];

      // Create ONE card per test type (grouped)
      if (e2eFiles.length > 0) {
        newTestContracts.push({
          id: 'e2e-all',
          type: 'e2e',
          name: 'E2E Tests',
          description: `${e2eFiles.length} E2E test file(s) across ${discoveredFeatures.length} features`,
          filePath: `${repoPath}/.devops-kit/contracts/E2E_TESTS.md`,
          status: 'active',
          version: '1.0.0',
          lastUpdated: new Date().toISOString(),
          testFiles: e2eFiles, // Store for later
        } as Contract & { testFiles: string[] });
      }

      if (unitFiles.length > 0) {
        newTestContracts.push({
          id: 'unit-all',
          type: 'unit',
          name: 'Unit Tests',
          description: `${unitFiles.length} unit test file(s) across ${discoveredFeatures.length} features`,
          filePath: `${repoPath}/.devops-kit/contracts/UNIT_TESTS.md`,
          status: 'active',
          version: '1.0.0',
          lastUpdated: new Date().toISOString(),
          testFiles: unitFiles,
        } as Contract & { testFiles: string[] });
      }

      if (integrationFiles.length > 0) {
        newTestContracts.push({
          id: 'integration-all',
          type: 'integration',
          name: 'Integration Tests',
          description: `${integrationFiles.length} integration test file(s) across ${discoveredFeatures.length} features`,
          filePath: `${repoPath}/.devops-kit/contracts/INTEGRATION_TESTS.md`,
          status: 'active',
          version: '1.0.0',
          lastUpdated: new Date().toISOString(),
          testFiles: integrationFiles,
        } as Contract & { testFiles: string[] });
      }

      if (fixtureFiles.length > 0) {
        newTestContracts.push({
          id: 'fixtures-all',
          type: 'fixtures',
          name: 'Test Fixtures',
          description: `${fixtureFiles.length} fixture file(s) across ${discoveredFeatures.length} features`,
          filePath: `${repoPath}/.devops-kit/contracts/FIXTURES.md`,
          status: 'active',
          version: '1.0.0',
          lastUpdated: new Date().toISOString(),
          testFiles: fixtureFiles,
        } as Contract & { testFiles: string[] });
      }

      return [...nonTestContracts, ...newTestContracts];
    });
  }, [discoveredFeatures, session.worktreePath, session.repoPath]);

  // NOTE: Contract generation event listeners are now registered at app-level
  // via useContractGenerationSubscription() hook in App.tsx
  // This ensures events are captured even when switching tabs

  // Get the scan path based on selected option
  const getScanPath = () => {
    if (scanPathOption === 'main') {
      return session.repoPath || session.worktreePath;
    }
    return session.worktreePath || session.repoPath;
  };

  // Load saved discovered features on mount
  useEffect(() => {
    const loadSavedFeatures = async () => {
      const repoPath = getScanPath();
      console.log('[SessionDetailView] loadSavedFeatures called with path:', repoPath);
      console.log('[SessionDetailView] session.repoPath:', session.repoPath);
      console.log('[SessionDetailView] session.worktreePath:', session.worktreePath);
      console.log('[SessionDetailView] scanPathOption:', scanPathOption);
      if (!repoPath) {
        console.log('[SessionDetailView] No repoPath, skipping feature load');
        return;
      }

      try {
        const result = await window.api?.contractGeneration?.loadDiscoveredFeatures(repoPath);
        console.log('[SessionDetailView] loadDiscoveredFeatures result:', result);
        if (result?.success && result.data && Array.isArray(result.data) && result.data.length > 0) {
          console.log('[SessionDetailView] Setting', result.data.length, 'discovered features');
          setDiscoveredFeatures(result.data as typeof discoveredFeatures);
        } else {
          console.log('[SessionDetailView] No features found in database for path:', repoPath);
        }
      } catch (err) {
        console.error('Failed to load saved features:', err);
      }
    };

    loadSavedFeatures();
  }, [session.worktreePath, session.repoPath, scanPathOption]);

  // Discover features in the repository
  const handleDiscoverFeatures = async () => {
    const repoPath = getScanPath();
    if (!repoPath) return;

    setIsDiscovering(true);
    setDiscoveredFeatures([]);
    setGenerationResult(null);
    setDiscoveryStatus('Scanning repository structure...');

    try {
      // Use AI to intelligently filter features (true = use LLM to identify actual features)
      setDiscoveryStatus('Analyzing codebase with AI...');
      const result = await window.api?.contractGeneration?.discoverFeatures(repoPath, true);
      if (result?.success && result.data) {
        setDiscoveryStatus(`Found ${result.data.length} features! Saving...`);
        setDiscoveredFeatures(result.data);
        // Save discovered features for later
        await window.api?.contractGeneration?.saveDiscoveredFeatures(repoPath, result.data);
        setDiscoveryStatus('');
      } else {
        setDiscoveryStatus('No features found');
      }
    } catch (err) {
      console.error('Failed to discover features:', err);
      setDiscoveryStatus('Discovery failed');
    } finally {
      setIsDiscovering(false);
    }
  };

  // Generate contracts for all discovered features
  // forceRefresh=false (default): Incremental mode - only process features with changes
  // forceRefresh=true: Process all features regardless of changes
  const clearGenerationResult = useContractStore((state) => state.clearGenerationResult);
  const handleGenerateAll = async (forceRefresh = false) => {
    const repoPath = getScanPath();
    if (!repoPath || isGenerating) return;

    setIsGenerating(true);
    clearGenerationResult();

    try {
      // Always pass discovered features if available - no need to re-discover
      // forceRefresh=true just means regenerate ALL features, not just changed ones
      await window.api?.contractGeneration?.generateAll(repoPath, {
        includeCodeSamples: true,
        maxFilesPerFeature: 10,
        preDiscoveredFeatures: discoveredFeatures.length > 0 ? discoveredFeatures : undefined,
        forceRefresh,
      });
      // Result comes via onComplete event (handled in useContractGenerationSubscription)
    } catch (err) {
      console.error('Failed to generate contracts:', err);
      setIsGenerating(false);
    }
  };

  // State for generate button dropdown
  const [showGenerateDropdown, setShowGenerateDropdown] = useState(false);

  const filteredContracts = activeContractType === 'all'
    ? contracts
    : contracts.filter(c => c.type === activeContractType);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-kanvas-blue border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with Generate Contracts Button */}
      <div className="p-4 border-b border-border bg-surface flex justify-between items-start gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-text-primary">Contracts</h3>
            {/* Show warning if no repo path */}
            {!getScanPath() && (
              <span className="text-xs text-orange-600 px-2 py-1 bg-orange-50 rounded">
                Missing path - repoPath: "{session.repoPath || ''}" | worktreePath: "{session.worktreePath || ''}"
              </span>
            )}
            <div className="flex gap-2 items-center">
              {/* Path selector */}
              {session.repoPath && session.worktreePath && session.repoPath !== session.worktreePath && (
                <select
                  value={scanPathOption}
                  onChange={(e) => {
                    setScanPathOption(e.target.value as 'main' | 'worktree');
                    setDiscoveredFeatures([]); // Clear on path change
                  }}
                  disabled={isDiscovering || isGenerating}
                  className="px-2 py-1.5 rounded-lg text-sm bg-surface-secondary text-text-primary border border-border"
                >
                  <option value="main">Main Repo</option>
                  <option value="worktree">Worktree</option>
                </select>
              )}
              <button
                onClick={handleDiscoverFeatures}
                disabled={isDiscovering || isGenerating}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${isDiscovering
                    ? 'bg-surface-tertiary text-text-secondary cursor-wait'
                    : 'bg-surface-secondary text-text-primary hover:bg-surface-tertiary'
                  }`}
              >
                {isDiscovering ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-3 h-3 border border-text-secondary border-t-transparent rounded-full" />
                    Discovering...
                  </span>
                ) : (
                  '🔍 Discover Features'
                )}
              </button>
              {/* Split button: Update Contracts (incremental) with Force Refresh dropdown */}
              <div className="relative">
                <div className="flex">
                  <button
                    onClick={() => handleGenerateAll(false)}
                    disabled={isGenerating || !getScanPath()}
                    className={`px-3 py-1.5 rounded-l-lg text-sm font-medium transition-colors
                      ${isGenerating
                        ? 'bg-kanvas-blue text-white cursor-wait'
                        : !getScanPath()
                          ? 'bg-surface-tertiary text-text-secondary cursor-not-allowed'
                          : 'bg-kanvas-blue text-white hover:bg-blue-600'
                      }`}
                    title={discoveredFeatures.length === 0 ? "Will auto-discover features and generate contracts" : "Smart update - only processes features with changes since last run"}
                  >
                    {isGenerating ? (
                      <span className="flex items-center gap-2">
                        <span className="animate-spin w-3 h-3 border border-white border-t-transparent rounded-full" />
                        Generating...
                      </span>
                    ) : (
                      '✨ Update Contracts'
                    )}
                  </button>
                  <button
                    onClick={() => setShowGenerateDropdown(!showGenerateDropdown)}
                    disabled={isGenerating || !getScanPath()}
                    className={`px-2 py-1.5 rounded-r-lg text-sm font-medium transition-colors border-l border-white/20
                      ${isGenerating
                        ? 'bg-kanvas-blue text-white cursor-wait'
                        : !getScanPath()
                          ? 'bg-surface-tertiary text-text-secondary cursor-not-allowed'
                          : 'bg-kanvas-blue text-white hover:bg-blue-600'
                      }`}
                  >
                    <svg className={`w-4 h-4 transition-transform ${showGenerateDropdown ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
                {showGenerateDropdown && (
                  <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg z-10 min-w-[180px]">
                    <button
                      onClick={() => { handleGenerateAll(false); setShowGenerateDropdown(false); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary flex items-center gap-2 rounded-t-lg"
                    >
                      <span className="text-green-500">⚡</span>
                      <div>
                        <div className="font-medium text-text-primary">Smart Update</div>
                        <div className="text-xs text-text-secondary">Only changed features</div>
                      </div>
                    </button>
                    <button
                      onClick={() => { handleGenerateAll(true); setShowGenerateDropdown(false); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary flex items-center gap-2 rounded-b-lg border-t border-border"
                    >
                      <span className="text-orange-500">🔄</span>
                      <div>
                        <div className="font-medium text-text-primary">Force Refresh</div>
                        <div className="text-xs text-text-secondary">Regenerate all contracts</div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Contract Type Filter Tabs */}
          <div className="flex gap-2 flex-wrap">
            {contractTypes.map(({ type, label, icon }) => (
              <button
                key={type}
                onClick={() => setActiveContractType(type)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5
                  ${activeContractType === type
                    ? 'bg-kanvas-blue text-white'
                    : 'bg-surface-secondary text-text-secondary hover:text-text-primary hover:bg-surface-tertiary'
                  }`}
              >
                <span>{icon}</span>
                <span>{label}</span>
                {type !== 'all' && (
                  <span className="text-xs opacity-70">
                    ({contracts.filter(c => c.type === type).length})
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Discovery Progress */}
      {isDiscovering && (
        <div className="mx-4 mt-4 p-3 bg-purple-50 border border-purple-200 rounded-xl">
          <div className="flex items-center gap-3">
            <span className="animate-spin w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full" />
            <div className="flex-1">
              <div className="text-sm font-medium text-purple-800">
                🔍 Discovering Features
              </div>
              <div className="text-xs text-purple-600 mt-0.5">
                {discoveryStatus || 'Initializing...'}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
          <div className="mt-2 h-1.5 bg-purple-100 rounded-full overflow-hidden">
            <div className="h-full bg-purple-400 rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {/* Generation Progress */}
      {isGenerating && generationProgress && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full" />
              <span className="text-sm font-medium text-blue-800">
                Processing: <span className="font-semibold">{generationProgress.currentFeature}</span>
              </span>
              {generationProgress.contractType && (
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                  generationProgress.contractType === 'markdown' ? 'bg-purple-100 text-purple-700' :
                  generationProgress.contractType === 'json' ? 'bg-green-100 text-green-700' :
                  'bg-orange-100 text-orange-700'
                }`}>
                  {generationProgress.contractType === 'markdown' ? '📄 Markdown' :
                   generationProgress.contractType === 'json' ? '📋 JSON' : '👤 Admin'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-blue-700">
                {generationProgress.total > 0 ? Math.round((generationProgress.completed / generationProgress.total) * 100) : 0}%
              </span>
              <span className="text-xs text-blue-600">
                ({generationProgress.completed}/{generationProgress.total} features)
              </span>
            </div>
          </div>
          <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${generationProgress.total > 0 ? (generationProgress.completed / generationProgress.total) * 100 : 0}%` }}
            />
          </div>
          {/* Activity Log */}
          <div className="mt-3">
            <button
              onClick={() => setShowActivityLog(!showActivityLog)}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              <span>{showActivityLog ? '▼' : '▶'}</span>
              Activity Log ({activityLogs.length})
            </button>
            {showActivityLog && activityLogs.length > 0 && (
              <div className="mt-2 max-h-32 overflow-y-auto bg-white/50 rounded p-2 text-xs font-mono">
                {activityLogs.slice(-10).map((log, i) => (
                  <div key={i} className={`py-0.5 ${log.type === 'error' ? 'text-red-600' : log.type === 'success' ? 'text-green-600' : 'text-gray-600'}`}>
                    <span className="text-gray-400">[{log.time}]</span> {log.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Generation Result */}
      {generationResult && (
        <div className={`mx-4 mt-4 p-3 rounded-xl border ${generationResult.failed > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-center gap-2">
            <span>{generationResult.failed > 0 ? '⚠️' : '✅'}</span>
            <span className="text-sm font-medium">
              Generated {generationResult.generated} contracts in {(generationResult.duration / 1000).toFixed(1)}s
              {generationResult.failed > 0 && ` (${generationResult.failed} failed)`}
            </span>
          </div>
        </div>
      )}

      {/* Discovered Features - Table View */}
      {discoveredFeatures.length > 0 && (
        <div className="mx-4 mt-4 p-3 bg-surface-secondary rounded-xl border border-border flex flex-col">
          <div className="flex items-center justify-between flex-shrink-0">
            <button
              onClick={() => setFeaturesCollapsed(!featuresCollapsed)}
              className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-kanvas-blue transition-colors"
            >
              <svg
                className={`w-4 h-4 transition-transform ${featuresCollapsed ? '' : 'rotate-90'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Discovered {discoveredFeatures.length} feature(s)
            </button>
            <button
              onClick={() => setDiscoveredFeatures([])}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              Clear
            </button>
          </div>

          {/* Features Table - Collapsible */}
          {!featuresCollapsed && (
          <>
          <div className="overflow-auto flex-1 min-h-0 max-h-[350px] mt-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="pb-2 pr-4 font-medium">Feature</th>
                  <th className="pb-2 pr-4 font-medium">Location</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="API/Route files">🔌</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="Schema/Type files">📐</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="Config files">⚡</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="Unit tests">🧪</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="Integration tests">🔗</th>
                  <th className="pb-2 pr-2 font-medium text-center" title="E2E tests">🎭</th>
                  <th className="pb-2 font-medium text-center" title="Total files across all categories">Total</th>
                </tr>
              </thead>
              <tbody>
                {discoveredFeatures.map(f => {
                  // Check if this feature has contract changes
                  const featureChanges = contractChanges.filter(c =>
                    c.file.toLowerCase().includes(f.name.toLowerCase()) ||
                    c.file.includes(f.basePath)
                  );
                  const hasChanges = featureChanges.length > 0;
                  const hasBreaking = featureChanges.some(c => c.impactLevel === 'breaking');

                  // Get relative path from repo root
                  const relativePath = f.basePath.split('/').slice(-2).join('/');

                  return (
                    <tr
                      key={f.name}
                      className={`border-b border-border/50 hover:bg-surface transition-colors ${
                        hasBreaking ? 'bg-red-50/50' : hasChanges ? 'bg-yellow-50/50' : ''
                      }`}
                    >
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text-primary">{f.name}</span>
                          {hasChanges && (
                            <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                              hasBreaking ? 'bg-red-200 text-red-800' : 'bg-yellow-200 text-yellow-800'
                            }`}>
                              {hasBreaking ? '⚠️' : '✏️'}
                            </span>
                          )}
                        </div>
                        {f.description && (
                          <div className="text-text-secondary text-[10px] mt-0.5 max-w-[300px] leading-tight">
                            {f.description}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <code className="text-[10px] text-text-secondary bg-surface px-1 py-0.5 rounded">
                          {relativePath}
                        </code>
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.api.length > 0 ? (
                          <span className="text-green-600 font-medium" title={f.files.api.map(p => p.split('/').pop()).join(', ')}>{f.files.api.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.schema.length > 0 ? (
                          <span className="text-blue-600 font-medium" title={f.files.schema.map(p => p.split('/').pop()).join(', ')}>{f.files.schema.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.config.length > 0 ? (
                          <span className="text-purple-600 font-medium" title={f.files.config.map(p => p.split('/').pop()).join(', ')}>{f.files.config.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.tests.unit.length > 0 ? (
                          <span className="text-amber-600 font-medium" title={f.files.tests.unit.map(p => p.split('/').pop()).join(', ')}>{f.files.tests.unit.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.tests.integration.length > 0 ? (
                          <span className="text-indigo-600 font-medium" title={f.files.tests.integration.map(p => p.split('/').pop()).join(', ')}>{f.files.tests.integration.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        {f.files.tests.e2e.length > 0 ? (
                          <span className="text-cyan-600 font-medium" title={f.files.tests.e2e.map(p => p.split('/').pop()).join(', ')}>{f.files.tests.e2e.length}</span>
                        ) : (
                          <span className="text-text-secondary/30">-</span>
                        )}
                      </td>
                      <td className="py-2 text-center text-text-primary font-medium">
                        {f.files.api.length + f.files.schema.length + f.files.config.length +
                         f.files.tests.unit.length + f.files.tests.integration.length + f.files.tests.e2e.length +
                         f.files.fixtures.length + f.files.other.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="mt-3 pt-2 border-t border-border flex flex-wrap gap-3 text-[10px] text-text-secondary">
            <span>🔌 API/Routes</span>
            <span>📐 Schema/Types</span>
            <span>⚡ Config</span>
            <span>🧪 Unit</span>
            <span>🔗 Integration</span>
            <span>🎭 E2E</span>
          </div>
          </>
          )}
        </div>
      )}

      {/* Contract Changes Alert */}
      {contractChanges.length > 0 && (
        <div className="mx-4 mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-xl">
          <div className="flex items-start gap-2">
            <span className="text-yellow-600">⚠️</span>
            <div>
              <p className="text-sm font-medium text-yellow-800">
                {contractChanges.length} contract file(s) changed
              </p>
              <p className="text-xs text-yellow-700 mt-0.5">
                {contractChanges.filter(c => c.impactLevel === 'breaking').length} potentially breaking changes
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Contracts List */}
      <div className="flex-1 overflow-auto p-4">
        {filteredContracts.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
                <span className="text-3xl">📋</span>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">No Contracts Found</h3>
              <p className="text-sm text-text-secondary max-w-xs">
                Create a <code className="text-kanvas-blue">House_Rules_Contracts/</code> directory to track contracts.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredContracts.map((contract) => (
              <ContractCard
                key={contract.id}
                contract={contract}
                repoPath={session.worktreePath || session.repoPath}
                hasChanges={contractChanges.some(c => c.file.includes(contract.name) || contract.filePath.includes(c.file))}
                discoveredFeatures={discoveredFeatures as DiscoveredFeature[]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Cleanup AI preamble and code blocks from contract content
 * This fixes contracts that were generated before cleanup was added to the backend
 */
function cleanupContractContent(content: string): string {
  let cleaned = content.trim();

  // Remove AI preamble patterns at the start
  const preamblePatterns = [
    /^I'll analyze.*?\n+/i,
    /^I will analyze.*?\n+/i,
    /^Let me (analyze|examine|generate|create).*?\n+/i,
    /^I will (analyze|examine|generate|create).*?\n+/i,
    /^Here('s| is) (the|a) (contract|document|markdown|analysis).*?\n+/i,
    /^Based on (the|my) analysis.*?\n+/i,
    /^Looking at (the|this).*?\n+/i,
    /^After (analyzing|examining|reviewing).*?\n+/i,
  ];

  for (const pattern of preamblePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // If content starts with a code fence, check if it's code instead of markdown
  const codeBlockMatch = cleaned.match(/^```(\w+)\n/);
  if (codeBlockMatch) {
    const lang = codeBlockMatch[1].toLowerCase();
    // If it's markdown, extract it
    if (lang === 'markdown' || lang === 'md') {
      cleaned = cleaned.replace(/^```(?:markdown|md)\n?/, '').replace(/\n?```\s*$/, '');
    }
    // If it's code (Python, JS, etc), this is a bad response - return warning
    else if (['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'java', 'go', 'rust'].includes(lang)) {
      return `# Contract Needs Regeneration

> **Note:** This contract contains code instead of proper documentation.
> Click "Force Refresh" to regenerate it properly.

---

*Original content was ${lang} code that should have been markdown documentation.*`;
    }
  }

  // Check if the content looks like Python code without code fences
  if (cleaned.startsWith('import ') || cleaned.startsWith('from ') || cleaned.startsWith('def ') || cleaned.startsWith('class ')) {
    return `# Contract Needs Regeneration

> **Note:** This contract contains Python code instead of proper documentation.
> Click "Force Refresh" to regenerate it properly.`;
  }

  // Check for multiple lines of Python code (common patterns)
  const pythonPatterns = /^(import \w+|from \w+ import|def \w+\(|class \w+:|if __name__|print\()/m;
  const pythonMatches = cleaned.match(pythonPatterns);
  if (pythonMatches && pythonMatches.length > 2) {
    return `# Contract Needs Regeneration

> **Note:** This contract appears to contain code instead of documentation.
> Click "Force Refresh" to regenerate it properly.`;
  }

  return cleaned;
}

/**
 * Extract version from contract content
 * Looks for <!-- Version: X.X.X | Generated: ... --> comment or version: "X.X.X" in JSON
 */
function extractVersionFromContent(content: string): string | null {
  // Try HTML comment format first: <!-- Version: 1.0.1 | Generated: ... -->
  const versionMatch = content.match(/<!--\s*Version:\s*([\d.]+)/i);
  if (versionMatch) {
    return versionMatch[1];
  }

  // Try JSON format: "version": "1.0.0"
  const jsonMatch = content.match(/"version"\s*:\s*"([\d.]+)"/);
  if (jsonMatch) {
    return jsonMatch[1];
  }

  // Try YAML frontmatter: version: 1.0.0
  const yamlMatch = content.match(/^version:\s*([\d.]+)/m);
  if (yamlMatch) {
    return yamlMatch[1];
  }

  return null;
}

/**
 * Extract metrics from contract markdown content
 */
function extractContractMetrics(content: string, type: string): { label: string; count: number }[] {
  const metrics: { label: string; count: number }[] = [];

  switch (type) {
    case 'api': {
      // Count endpoints (lines starting with ### GET, ### POST, etc.)
      const endpointMatches = content.match(/^###?\s+(GET|POST|PUT|DELETE|PATCH)\s+/gm);
      if (endpointMatches) metrics.push({ label: 'Endpoints', count: endpointMatches.length });
      // Count route patterns
      const routeMatches = content.match(/`\/([\w/:]+)`/g);
      if (routeMatches) metrics.push({ label: 'Routes', count: new Set(routeMatches).size });
      break;
    }
    case 'schema': {
      // Count tables/models
      const tableMatches = content.match(/^##\s+\w+/gm);
      if (tableMatches) metrics.push({ label: 'Tables', count: tableMatches.length });
      // Count fields (lines with | field |)
      const fieldMatches = content.match(/^\|\s*\w+\s*\|/gm);
      if (fieldMatches) metrics.push({ label: 'Fields', count: fieldMatches.length });
      break;
    }
    case 'events': {
      // Count events
      const eventMatches = content.match(/^###?\s+\w+/gm);
      if (eventMatches) metrics.push({ label: 'Events', count: eventMatches.length });
      break;
    }
    case 'e2e':
    case 'unit':
    case 'integration': {
      // Count tests (lines with test/it/describe)
      const testMatches = content.match(/^\s*-\s+.*test|^\s*-\s+.*spec|^###?\s+Test/gim);
      if (testMatches) metrics.push({ label: 'Tests', count: testMatches.length });
      break;
    }
    case 'infra': {
      // Count env vars
      const envMatches = content.match(/`[A-Z_]+`/g);
      if (envMatches) metrics.push({ label: 'Env Vars', count: new Set(envMatches).size });
      break;
    }
    case 'features': {
      // Count feature flags
      const flagMatches = content.match(/^\s*-\s+`?\w+`?:/gm);
      if (flagMatches) metrics.push({ label: 'Flags', count: flagMatches.length });
      break;
    }
    case 'integrations': {
      // Count integrations
      const integrationMatches = content.match(/^##\s+\w+/gm);
      if (integrationMatches) metrics.push({ label: 'Services', count: integrationMatches.length });
      break;
    }
    default: {
      // Count sections as generic metric
      const sectionMatches = content.match(/^##\s+/gm);
      if (sectionMatches) metrics.push({ label: 'Sections', count: sectionMatches.length });
    }
  }

  return metrics;
}

/**
 * ContractCard - Individual contract display matching House_Rules_Contracts format
 */
interface FeatureContract {
  name: string;
  path: string;
  jsonPath?: string;
}

function ContractCard({ contract, repoPath, hasChanges, discoveredFeatures }: {
  contract: Contract;
  repoPath?: string;
  hasChanges?: boolean;
  discoveredFeatures?: DiscoveredFeature[];
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffStats, setDiffStats] = useState<{ additions: number; deletions: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<{ label: string; count: number }[]>([]);
  const [extractedVersion, setExtractedVersion] = useState<string | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<string>('repo');
  const [featureContracts, setFeatureContracts] = useState<FeatureContract[]>([]);
  const [fileExists, setFileExists] = useState<boolean>(true);
  const [generating, setGenerating] = useState(false);
  const [viewMode, setViewMode] = useState<'markdown' | 'json'>('markdown');

  // Use global contract store for generation progress
  const generationProgress = useContractStore((state) => state.generationProgress);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // Maximum content size for performance (100KB)
  const MAX_CONTENT_SIZE = 100 * 1024;

  const statusColors: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    modified: 'bg-yellow-100 text-yellow-700',
    deprecated: 'bg-gray-100 text-gray-600',
    breaking: 'bg-red-100 text-red-700',
    beta: 'bg-blue-100 text-blue-700',
  };

  const typeIcons: Record<string, string> = {
    api: '🔌',
    schema: '📐',
    events: '⚡',
    css: '🎨',
    features: '✨',
    infra: '🏗️',
    integrations: '🔗',
    admin: '👤',
    sql: '🗃️',
    prompts: '💬',
    e2e: '🎭',
    unit: '🧪',
    integration: '🔗',
    fixtures: '📦',
  };

  const typeLabels: Record<string, string> = {
    api: 'API Contract',
    schema: 'DB Schema',
    events: 'Events & Messaging',
    css: 'CSS & Styles',
    features: 'Features Overview',
    infra: 'Infrastructure',
    integrations: '3rd Party Integrations',
    admin: 'Admin Panel',
    sql: 'SQL & Migrations',
    prompts: 'Prompts & Skills',
    e2e: 'E2E Tests',
    unit: 'Unit Tests',
    integration: 'Integration Tests',
    fixtures: 'Test Fixtures',
  };

  const loadContent = async (filePath?: string, forceReload = false) => {
    const pathToLoad = filePath || contract.filePath;
    console.log('[ContractCard] loadContent called:', { pathToLoad, forceReload, hasContent: !!content });
    // Only skip if we're loading the same path and already have content AND not forcing reload
    if (content && !filePath && !loading && !forceReload) return;
    setLoading(true);
    setError(null);
    try {
      console.log('[ContractCard] Reading file:', pathToLoad);
      const result = await window.api?.file?.readContent?.(pathToLoad);
      console.log('[ContractCard] File read result:', { success: result?.success, dataLength: result?.data?.length });
      if (result?.success && result.data) {
        setFileExists(true);
        // Check if content needs truncation for performance
        let dataToProcess = result.data;
        let truncated = false;
        if (result.data.length > MAX_CONTENT_SIZE) {
          dataToProcess = result.data.substring(0, MAX_CONTENT_SIZE);
          truncated = true;
          console.log('[ContractCard] Content truncated:', result.data.length, '->', MAX_CONTENT_SIZE);
        }
        setIsTruncated(truncated);
        setRawContent(dataToProcess); // Store for JSON view (truncated if needed)
        // Clean up AI preamble/code from old contracts
        const cleanedContent = cleanupContractContent(dataToProcess);
        console.log('[ContractCard] Content preview:', dataToProcess.substring(0, 200));
        setContent(cleanedContent);
        setMetrics(extractContractMetrics(cleanedContent, contract.type));
        // Extract version from content (before cleanup to get metadata)
        const version = extractVersionFromContent(result.data);
        console.log('[ContractCard] Extracted version:', version);
        if (version) {
          setExtractedVersion(version);
        }
      } else {
        // Check if file doesn't exist vs other error
        const errorMsg = result?.error?.message || 'Failed to load content';
        if (errorMsg.includes('ENOENT') || errorMsg.includes('no such file') || errorMsg.includes('does not exist')) {
          setFileExists(false);
          setError(null); // Don't show error, show generate button instead
        } else {
          setError(errorMsg);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load content';
      if (errorMsg.includes('ENOENT') || errorMsg.includes('no such file')) {
        setFileExists(false);
        setError(null);
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle generating a single contract
  const handleGenerate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[ContractCard] handleGenerate called, selectedFeature:', selectedFeature, 'repoPath:', repoPath);

    if (!repoPath || generating) {
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      // Always regenerate repo-level contract first
      console.log('[ContractCard] Regenerating REPO-level contract:', contract.type);
      const repoResult = await window.api?.contractGeneration?.generateSingle?.(repoPath, contract.type);

      if (!repoResult?.success || !repoResult.data?.success) {
        console.warn('[ContractCard] Repo contract failed:', repoResult?.data?.error);
      }

      // Then regenerate all feature-level contracts
      if (discoveredFeatures && discoveredFeatures.length > 0) {
        console.log('[ContractCard] Regenerating', discoveredFeatures.length, 'feature contracts...');

        for (const feature of discoveredFeatures) {
          console.log('[ContractCard] Regenerating feature:', feature.name);
          try {
            await window.api?.contractGeneration?.generateFeature?.(repoPath, feature, {
              includeCodeSamples: true,
              maxFilesPerFeature: 10,
            });
          } catch (err) {
            console.warn('[ContractCard] Failed to regenerate feature:', feature.name, err);
          }
        }
      }

      // Force reload the currently selected content (must force to bypass cache)
      setFileExists(true);
      setContent(null); // Clear existing content first
      setRawContent(null);
      setExtractedVersion(null);

      console.log('[ContractCard] Forcing content reload after regeneration...');
      // Always reload consolidated view
      if (featureContracts.length > 0) {
        await loadConsolidatedContract();
      } else {
        await loadContent(contract.filePath, true);
      }

      console.log('[ContractCard] All contracts regenerated and content reloaded');
    } catch (err) {
      console.error('[ContractCard] Error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate contracts');
    } finally {
      setGenerating(false);
    }
  };

  // Load feature contracts related to this contract type
  useEffect(() => {
    if (discoveredFeatures && discoveredFeatures.length > 0 && repoPath) {
      const features: FeatureContract[] = discoveredFeatures.map(f => {
        // Sanitize feature name for filename (same as backend)
        const sanitizedName = f.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        return {
          name: f.name,
          // Feature contracts now have unique filenames per feature
          path: `${f.basePath}/CONTRACTS_${sanitizedName}.md`,
          // Also store the JSON path for structured data
          jsonPath: `${repoPath}/.S9N_KIT_DevOpsAgent/contracts/features/${f.name}.contracts.json`,
        };
      });
      setFeatureContracts(features);
    }
  }, [discoveredFeatures, repoPath, contract.type]);

  // Load consolidated contract by merging all feature contracts
  const loadConsolidatedContract = async () => {
    if (featureContracts.length === 0) {
      // No features discovered, show empty state
      setContent('# Consolidated API Contract\n\nNo features discovered yet. Run feature discovery first to generate feature-level contracts.');
      setFileExists(true);
      setLoading(false);
      return;
    }

    const mergedSections: string[] = [];
    mergedSections.push(`# ${contract.name} - Consolidated View`);
    mergedSections.push('');
    mergedSections.push(`> Merged from ${featureContracts.length} feature contracts | Generated: ${new Date().toISOString()}`);
    mergedSections.push('');

    let totalEndpoints = 0;
    let totalTypes = 0;
    let loadedFeatures = 0;

    // Collect JSON data for raw view
    const consolidatedJson: Record<string, unknown> = {
      contractType: contract.type,
      contractName: contract.name,
      generatedAt: new Date().toISOString(),
      features: {} as Record<string, unknown>,
    };

    // Track seen data fingerprints to detect and skip duplicates across features
    const seenSourceFileHashes = new Set<string>();
    const sharedDataSections: string[] = [];

    // Load and merge each feature's contract
    for (const feature of featureContracts) {
      try {
        // Try JSON first for structured data
        if (feature.jsonPath) {
          const jsonResult = await window.api?.file?.readContent?.(feature.jsonPath);
          if (jsonResult?.success && jsonResult.data) {
            try {
              const contractData = JSON.parse(jsonResult.data);

              // Collect for raw JSON view
              (consolidatedJson.features as Record<string, unknown>)[feature.name] = contractData;

              // Extract data based on contract type
              // JSON structure: apis.endpoints[], apis.exports[], schemas[] (flat array)
              const apis = contractData.apis || contractData.apiContract || {};
              const schemasArr = Array.isArray(contractData.schemas) ? contractData.schemas
                : (contractData.schemas?.tables || contractData.schemas?.models || []);
              let hasData = false;

              // Deduplication: skip features with identical source files to avoid repetition
              const dataFingerprint = JSON.stringify((contractData.sourceFiles || []).sort());
              const isDataDuplicate = seenSourceFileHashes.has(dataFingerprint);

              // Skip duplicates entirely (don't show header or "shares codebase" message)
              if (isDataDuplicate) {
                continue;
              }
              seenSourceFileHashes.add(dataFingerprint);

              // Build feature content into a buffer - only add to merged if it has data
              const featureBuffer: string[] = [];
              featureBuffer.push(`---`);
              featureBuffer.push(`## ${feature.name}`);
              featureBuffer.push('');

              if (contract.type === 'api') {
                if (apis.endpoints && apis.endpoints.length > 0) {
                  featureBuffer.push('### Endpoints');
                  featureBuffer.push('');
                  featureBuffer.push('| Method | Path | Description |');
                  featureBuffer.push('|--------|------|-------------|');
                  for (const ep of apis.endpoints) {
                    featureBuffer.push(`| ${ep.method || 'GET'} | ${ep.path || ep.route || 'N/A'} | ${ep.description || '-'} |`);
                    totalEndpoints++;
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
                if (apis.exports && apis.exports.length > 0) {
                  featureBuffer.push(`### Exports (${apis.exports.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Name | Type | File |');
                  featureBuffer.push('|------|------|------|');
                  for (const exp of apis.exports.slice(0, 20)) {
                    const fileName = exp.file?.split('/').pop() || '-';
                    featureBuffer.push(`| ${exp.name} | ${exp.type || '-'} | ${fileName} |`);
                  }
                  if (apis.exports.length > 20) {
                    featureBuffer.push(`| ... | ... | *${apis.exports.length - 20} more* |`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
                if (apis.authentication) {
                  featureBuffer.push(`**Authentication:** ${apis.authentication.method || apis.authentication}`);
                  featureBuffer.push('');
                }
              } else if (contract.type === 'schema') {
                if (schemasArr.length > 0) {
                  featureBuffer.push(`### Tables/Models (${schemasArr.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Name | Type | Columns | Source |');
                  featureBuffer.push('|------|------|---------|--------|');
                  for (const schema of schemasArr) {
                    const colCount = schema.columns?.length || schema.properties?.length || 0;
                    const fileName = schema.file?.split('/').pop() || '-';
                    featureBuffer.push(`| **${schema.name}** | ${schema.type || 'table'} | ${colCount} | ${fileName} |`);
                    totalTypes++;
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
              } else if (contract.type === 'events') {
                // Events from apis.exports - filter for event-related types
                const allExports = apis.exports || [];
                const eventExports = allExports.filter((exp: Record<string, string>) => {
                  const name = (exp.name || '').toLowerCase();
                  return name.includes('event') || name.includes('payload') ||
                    name.includes('emit') || name.includes('listener') ||
                    name.includes('handler') || name.includes('subscribe') ||
                    name.includes('publish') || name.includes('bus') ||
                    name.includes('pulse') || name.includes('hook') ||
                    (exp.type === 'const' && name.includes('_'));
                });

                if (eventExports.length > 0) {
                  featureBuffer.push(`### Event Types & Payloads (${eventExports.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Name | Type | File |');
                  featureBuffer.push('|------|------|------|');
                  for (const exp of eventExports.slice(0, 30)) {
                    const fileName = exp.file?.split('/').pop() || '-';
                    featureBuffer.push(`| ${exp.name} | ${exp.type || '-'} | ${fileName} |`);
                  }
                  if (eventExports.length > 30) {
                    featureBuffer.push(`| ... | ... | *${eventExports.length - 30} more* |`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }

                // Also check for dedicated events data
                const eventData = contractData.events as Record<string, unknown> | undefined;
                if (eventData) {
                  const emitted = eventData.emitted as Array<Record<string, string>> | undefined;
                  if (emitted && emitted.length > 0) {
                    featureBuffer.push(`### Events Emitted (${emitted.length})`);
                    featureBuffer.push('');
                    featureBuffer.push('| Event | Payload | Source |');
                    featureBuffer.push('|-------|---------|--------|');
                    for (const ev of emitted) {
                      featureBuffer.push(`| ${ev.event || ev.eventName || ''} | ${ev.payload || ''} | ${ev.from || ev.emittedFrom || ''} |`);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              } else if (contract.type === 'features') {
                // Features contract: describe what the feature does
                // Derive description from endpoints, exports, and dependencies
                const srcFiles = contractData.sourceFiles as string[] | undefined;
                const featExports = (apis.exports || []) as Array<Record<string, string>>;
                const featEndpoints = (apis.endpoints || []) as Array<Record<string, string>>;
                const featDeps = contractData.dependencies as string[] | undefined;
                const tc = contractData.testCoverage as Record<string, { count: number; files: string[] }> | undefined;

                // Derive stack type from source file paths
                const stackTypes: string[] = [];
                if (srcFiles) {
                  const paths = srcFiles.map((f: string) => f.toLowerCase());
                  if (paths.some(p => p.startsWith('backend/') || p.includes('/routes/') || p.includes('/controllers/'))) stackTypes.push('Backend Service');
                  if (paths.some(p => p.startsWith('frontend/') || p.startsWith('web-app/') || p.includes('/components/'))) stackTypes.push('Frontend App');
                  if (paths.some(p => p.startsWith('ai-worker/') || p.includes('/handlers/'))) stackTypes.push('AI Worker');
                  if (paths.some(p => p.startsWith('packages/') || p.startsWith('shared/'))) stackTypes.push('Shared Package');
                  if (paths.some(p => p.startsWith('extension/') || p.includes('browser'))) stackTypes.push('Browser Extension');
                  if (paths.some(p => p.includes('docker') || p.includes('Dockerfile'))) stackTypes.push('Containerized');
                }

                // Build feature description
                const descParts: string[] = [];
                if (stackTypes.length > 0) descParts.push(stackTypes.join(' + '));
                if (featEndpoints.length > 0) descParts.push(`${featEndpoints.length} API endpoints`);
                const funcExports = featExports.filter(e => e.type === 'function');
                if (funcExports.length > 0) descParts.push(`${funcExports.length} exported functions`);
                if (schemasArr.length > 0) descParts.push(`${schemasArr.length} DB tables`);
                if (featDeps && featDeps.length > 0) descParts.push(`uses ${featDeps.slice(0, 5).join(', ')}${featDeps.length > 5 ? '...' : ''}`);

                if (descParts.length > 0) {
                  featureBuffer.push(`> ${descParts.join(' | ')}`);
                  featureBuffer.push('');
                }

                // Show key functions
                if (funcExports.length > 0) {
                  featureBuffer.push(`### Key Functions (${funcExports.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Function | File |');
                  featureBuffer.push('|----------|------|');
                  for (const exp of funcExports.slice(0, 10)) {
                    const fileName = exp.file?.split('/').pop() || '-';
                    featureBuffer.push(`| \`${exp.name}()\` | ${fileName} |`);
                  }
                  if (funcExports.length > 10) {
                    featureBuffer.push(`| ... | *${funcExports.length - 10} more* |`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
                // Show test summary
                if (tc) {
                  const uCount = tc.unit?.count || 0;
                  const iCount = tc.integration?.count || 0;
                  const eCount = tc.e2e?.count || 0;
                  if (uCount + iCount + eCount > 0) {
                    featureBuffer.push(`**Tests:** ${uCount} unit, ${iCount} integration, ${eCount} e2e`);
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
                // Show source file count if nothing else
                if (!hasData && srcFiles && srcFiles.length > 0) {
                  featureBuffer.push(`**Source files:** ${srcFiles.length}`);
                  featureBuffer.push('');
                  hasData = true;
                }
              } else if (contract.type === 'integrations') {
                // Show external dependencies
                const deps = contractData.dependencies as string[] | undefined;
                if (deps && deps.length > 0) {
                  featureBuffer.push(`### Dependencies (${deps.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Package |');
                  featureBuffer.push('|---------|');
                  for (const dep of deps) {
                    featureBuffer.push(`| \`${dep}\` |`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
              } else if (contract.type === 'infra') {
                // Derive stack classification from source file paths
                const infraSrcFiles = contractData.sourceFiles as string[] | undefined;
                if (infraSrcFiles && infraSrcFiles.length > 0) {
                  const paths = infraSrcFiles.map((f: string) => f.toLowerCase());
                  const stackInfo: string[] = [];
                  if (paths.some(p => p.startsWith('backend/'))) stackInfo.push('Backend');
                  if (paths.some(p => p.startsWith('frontend/') || p.startsWith('web-app/'))) stackInfo.push('Frontend');
                  if (paths.some(p => p.startsWith('ai-worker/'))) stackInfo.push('AI Worker');
                  if (paths.some(p => p.startsWith('packages/'))) stackInfo.push('Shared Package');
                  if (paths.some(p => p.startsWith('extension/'))) stackInfo.push('Browser Extension');
                  const hasDocker = paths.some(p => p.includes('docker') || p.includes('Dockerfile'));
                  const hasPrisma = paths.some(p => p.includes('prisma'));
                  const hasDb = schemasArr.length > 0 || paths.some(p => p.includes('.sql') || p.includes('migration'));

                  if (stackInfo.length > 0 || hasDocker || hasDb) {
                    featureBuffer.push(`### Stack`);
                    featureBuffer.push('');
                    if (stackInfo.length > 0) featureBuffer.push(`- **Type:** ${stackInfo.join(', ')}`);
                    if (hasDocker) featureBuffer.push(`- **Container:** Yes (Docker)`);
                    if (hasDb) featureBuffer.push(`- **Database:** ${hasPrisma ? 'Prisma ORM' : 'SQL'}`);
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
                // Show runtime dependencies
                const infraDeps = contractData.dependencies as string[] | undefined;
                if (infraDeps && infraDeps.length > 0) {
                  featureBuffer.push(`### Runtime Dependencies (${infraDeps.length})`);
                  featureBuffer.push('');
                  for (const dep of infraDeps) {
                    featureBuffer.push(`- \`${dep}\``);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
                // Show database tables
                if (schemasArr.length > 0) {
                  featureBuffer.push(`### Database Tables (${schemasArr.length})`);
                  featureBuffer.push('');
                  featureBuffer.push('| Table | Type |');
                  featureBuffer.push('|-------|------|');
                  for (const s of schemasArr.slice(0, 20)) {
                    featureBuffer.push(`| ${s.name} | ${s.type || 'table'} |`);
                  }
                  if (schemasArr.length > 20) {
                    featureBuffer.push(`| ... | *${schemasArr.length - 20} more* |`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
                // Show config/infra files
                if (infraSrcFiles && infraSrcFiles.length > 0) {
                  const configFiles = infraSrcFiles.filter((f: string) => {
                    const name = f.toLowerCase();
                    return name.includes('config') || name.includes('.env') || name.includes('docker') ||
                      name.includes('yaml') || name.includes('yml') || name.includes('makefile') ||
                      name.includes('package.json') || name.includes('tsconfig') ||
                      name.includes('prisma') || name.includes('migration');
                  });
                  if (configFiles.length > 0) {
                    featureBuffer.push(`### Config & Migration Files (${configFiles.length})`);
                    featureBuffer.push('');
                    for (const f of configFiles) {
                      featureBuffer.push(`- \`${f.split('/').pop()}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              } else if (contract.type === 'sql') {
                // SQL contract: Show migration/SQL files and table names
                const sqlSrcFiles = contractData.sourceFiles as string[] | undefined;
                if (sqlSrcFiles && sqlSrcFiles.length > 0) {
                  const migrationFiles = sqlSrcFiles.filter((f: string) => {
                    const name = f.toLowerCase();
                    return name.includes('migration') || name.endsWith('.sql') ||
                      name.includes('seed') || name.includes('query') || name.includes('queries') ||
                      name.includes('prisma');
                  });
                  if (migrationFiles.length > 0) {
                    featureBuffer.push(`### Migration & SQL Files (${migrationFiles.length})`);
                    featureBuffer.push('');
                    for (const f of migrationFiles) {
                      featureBuffer.push(`- \`${f.split('/').pop()}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
                // Show table names (without column details - Schema contract has those)
                if (schemasArr.length > 0) {
                  featureBuffer.push(`### Tables Used (${schemasArr.length})`);
                  featureBuffer.push('');
                  for (const s of schemasArr) {
                    const colCount = (s.columns as unknown[])?.length || 0;
                    featureBuffer.push(`- **${s.name}** (${s.type || 'table'}${colCount > 0 ? `, ${colCount} columns` : ''})`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
              } else if (contract.type === 'admin') {
                // Show admin actions: first check for adminContract field, then derive from endpoints
                const adminData = contractData.adminContract as Record<string, unknown> | undefined;
                if (adminData) {
                  const entities = adminData.entities as Array<Record<string, unknown>> | undefined;
                  if (entities && entities.length > 0) {
                    featureBuffer.push(`### Admin Entities (${entities.length})`);
                    featureBuffer.push('');
                    featureBuffer.push('| Entity | Operations |');
                    featureBuffer.push('|--------|------------|');
                    for (const ent of entities) {
                      const ops = Array.isArray(ent.operations) ? (ent.operations as string[]).join(', ') : '-';
                      featureBuffer.push(`| **${ent.name}** | ${ops} |`);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                  const adminRoutes = adminData.adminRoutes as Array<Record<string, unknown>> | undefined;
                  if (adminRoutes && adminRoutes.length > 0) {
                    featureBuffer.push(`### Admin Routes (${adminRoutes.length})`);
                    featureBuffer.push('');
                    featureBuffer.push('| Method | Path | Roles |');
                    featureBuffer.push('|--------|------|-------|');
                    for (const r of adminRoutes) {
                      const roles = Array.isArray(r.roles) ? (r.roles as string[]).join(', ') : '-';
                      featureBuffer.push(`| ${r.method || ''} | ${r.path || ''} | ${roles} |`);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                  const perms = adminData.permissions as string[] | undefined;
                  if (perms && perms.length > 0) {
                    featureBuffer.push(`### Permissions (${perms.length})`);
                    featureBuffer.push('');
                    for (const p of perms) {
                      featureBuffer.push(`- \`${p}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
                // Derive admin needs from endpoints (CRUD operations on data entities)
                if (!hasData && apis.endpoints && Array.isArray(apis.endpoints) && apis.endpoints.length > 0) {
                  const allEps = apis.endpoints as Array<Record<string, string>>;
                  const entityMap = new Map<string, Set<string>>();
                  for (const ep of allEps) {
                    const pathParts = (ep.path || '').split('/').filter(Boolean);
                    const resource = pathParts.find((p: string) => p !== 'api' && p !== 'v1' && !p.startsWith(':')) || ep.path;
                    if (resource) {
                      if (!entityMap.has(resource)) entityMap.set(resource, new Set());
                      entityMap.get(resource)!.add(ep.method || 'GET');
                    }
                  }
                  if (entityMap.size > 0) {
                    featureBuffer.push(`### Admin Panel Actions`);
                    featureBuffer.push('');
                    featureBuffer.push('| Resource | Operations |');
                    featureBuffer.push('|----------|------------|');
                    for (const [resource, methods] of entityMap) {
                      featureBuffer.push(`| **${resource}** | ${Array.from(methods).join(', ')} |`);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              } else if (contract.type === 'e2e' || contract.type === 'unit' || contract.type === 'integration') {
                // Show test coverage for the specific test type
                const tcData = contractData.testCoverage as Record<string, { count: number; files: string[] }> | undefined;
                const testKey = contract.type === 'e2e' ? 'e2e' : contract.type === 'unit' ? 'unit' : 'integration';
                const tLabel = contract.type === 'e2e' ? 'E2E' : contract.type === 'unit' ? 'Unit' : 'Integration';
                const testInfo = tcData?.[testKey];
                if (testInfo && testInfo.count > 0) {
                  featureBuffer.push(`### ${tLabel} Tests (${testInfo.count})`);
                  featureBuffer.push('');
                  for (const f of testInfo.files.slice(0, 15)) {
                    featureBuffer.push(`- \`${f.split('/').pop()}\``);
                  }
                  if (testInfo.files.length > 15) {
                    featureBuffer.push(`- *...${testInfo.files.length - 15} more*`);
                  }
                  featureBuffer.push('');
                  hasData = true;
                }
              } else if (contract.type === 'fixtures') {
                // Show fixture files from sourceFiles
                const allSrc = contractData.sourceFiles as string[] | undefined;
                if (allSrc && allSrc.length > 0) {
                  const fixtures = allSrc.filter((f: string) => {
                    const name = f.toLowerCase();
                    return name.includes('fixture') || name.includes('mock') || name.includes('seed') || name.includes('factory');
                  });
                  if (fixtures.length > 0) {
                    featureBuffer.push(`### Fixture Files (${fixtures.length})`);
                    featureBuffer.push('');
                    for (const f of fixtures) {
                      featureBuffer.push(`- \`${f.split('/').pop()}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              } else if (contract.type === 'css') {
                // Show CSS/style related source files
                const allSrc = contractData.sourceFiles as string[] | undefined;
                if (allSrc && allSrc.length > 0) {
                  const cssFiles = allSrc.filter((f: string) => {
                    const name = f.toLowerCase();
                    return name.endsWith('.css') || name.endsWith('.scss') || name.endsWith('.less') ||
                      name.endsWith('.styl') || name.includes('theme') || name.includes('style') ||
                      name.includes('tailwind');
                  });
                  if (cssFiles.length > 0) {
                    featureBuffer.push(`### Style Files (${cssFiles.length})`);
                    featureBuffer.push('');
                    for (const f of cssFiles) {
                      featureBuffer.push(`- \`${f.split('/').pop()}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              } else if (contract.type === 'prompts') {
                // Show prompt/skill related source files
                const allSrc = contractData.sourceFiles as string[] | undefined;
                if (allSrc && allSrc.length > 0) {
                  const promptFiles = allSrc.filter((f: string) => {
                    const name = f.toLowerCase();
                    return name.includes('prompt') || name.includes('skill') || name.includes('mode') ||
                      name.endsWith('.yaml') || name.endsWith('.yml') || name.includes('agent');
                  });
                  if (promptFiles.length > 0) {
                    featureBuffer.push(`### Prompt & Config Files (${promptFiles.length})`);
                    featureBuffer.push('');
                    for (const f of promptFiles) {
                      featureBuffer.push(`- \`${f.split('/').pop()}\``);
                    }
                    featureBuffer.push('');
                    hasData = true;
                  }
                }
              }

              // Only add feature to output if it has actual data - skip empty features entirely
              if (hasData) {
                mergedSections.push(...featureBuffer);
              } else {
                // Don't show the feature at all if it has no data for this contract type
                continue;
              }

              // Count types if available
              if (apis.requestTypes) totalTypes += apis.requestTypes.length;
              if (apis.responseTypes) totalTypes += apis.responseTypes.length;

              loadedFeatures++;
              continue;
            } catch (e) {
              console.warn(`[ContractCard] Failed to parse JSON for ${feature.name}:`, e);
            }
          }
        }

        // Fallback to markdown file
        const mdResult = await window.api?.file?.readContent?.(feature.path);
        if (mdResult?.success && mdResult.data) {
          mergedSections.push(`---`);
          mergedSections.push(`## ${feature.name}`);
          mergedSections.push('');
          // Include the markdown content (but remove its own header)
          const cleanedMd = mdResult.data.replace(/^#\s+.*$/m, '').trim();
          mergedSections.push(cleanedMd);
          mergedSections.push('');
          loadedFeatures++;
        }
      } catch (err) {
        console.warn(`[ContractCard] Failed to load contract for ${feature.name}:`, err);
      }
    }

    // Add summary at the top
    if (loadedFeatures > 0) {
      const summaryIndex = 4; // After the header
      mergedSections.splice(summaryIndex, 0,
        `**Summary:** ${loadedFeatures} features, ${totalEndpoints} endpoints, ${totalTypes} types`,
        ''
      );
    }

    if (loadedFeatures === 0) {
      mergedSections.push('No feature contracts have been generated yet. Generate contracts for individual features first.');
    }

    // Set raw JSON for the Raw view toggle
    consolidatedJson.summary = {
      loadedFeatures,
      totalEndpoints,
      totalTypes,
    };
    setRawContent(JSON.stringify(consolidatedJson, null, 2));

    setContent(mergedSections.join('\n'));
    setFileExists(true);
    setExtractedVersion('consolidated');
    setLoading(false);
  };

  // Handle feature selection change
  const handleFeatureChange = async (featureName: string) => {
    setSelectedFeature(featureName);
    setContent(null); // Clear current content
    setRawContent(null);
    setMetrics([]);
    setExtractedVersion(null);
    setLoading(true);

    try {
      if (featureName === 'repo') {
        // Load consolidated view - merge all feature contracts
        await loadConsolidatedContract();
      } else {
        // Load feature-level contract - try JSON first for structured data
        const feature = featureContracts.find(f => f.name === featureName);
        console.log('[ContractCard] Loading feature:', featureName, 'found:', feature);
        console.log('[ContractCard] JSON path:', feature?.jsonPath);
        console.log('[ContractCard] MD path:', feature?.path);

        if (feature?.jsonPath) {
          // Try to load from JSON file and extract relevant contract type
          const jsonResult = await window.api?.file?.readContent?.(feature.jsonPath);
          console.log('[ContractCard] JSON result:', jsonResult?.success, 'length:', jsonResult?.data?.length);
          if (jsonResult?.success && jsonResult.data) {
            try {
              const contractData = JSON.parse(jsonResult.data);
              // Format the JSON data for this specific contract type
              const formatted = formatContractFromJSON(contractData, contract.type, featureName);
              if (formatted) {
                setContent(formatted);
                setRawContent(jsonResult.data);
                setFileExists(true);
                setExtractedVersion(contractData.version || '1.0.0');
                setLoading(false);
                return;
              }
            } catch (e) {
              console.warn('[ContractCard] Failed to parse JSON contract:', e);
            }
          }
        }
        // Fallback to CONTRACTS.md
        if (feature) {
          await loadContent(feature.path, true);
        }
      }
    } catch (err) {
      console.error('[ContractCard] Error loading feature contract:', err);
      setError('Failed to load contract');
    } finally {
      setLoading(false);
    }
  };

  // Format contract data from JSON for a specific contract type
  const formatContractFromJSON = (data: Record<string, unknown>, contractType: string, featureName: string): string | null => {
    if (!data) return null;

    const lines: string[] = [];
    lines.push(`# ${featureName} - ${typeLabels[contractType] || contractType}`);
    lines.push('');
    lines.push(`> Version: ${data.version || '1.0.0'} | Generated: ${data.lastGenerated || 'N/A'}`);
    lines.push('');

    switch (contractType) {
      case 'api':
        // Handle actual JSON structure: data.apis.endpoints
        const apis = data.apis as Record<string, unknown> | undefined;
        if (apis?.endpoints && Array.isArray(apis.endpoints) && apis.endpoints.length > 0) {
          lines.push('## API Endpoints');
          lines.push('');
          lines.push('| Method | Path | Description | File |');
          lines.push('|--------|------|-------------|------|');
          for (const ep of apis.endpoints) {
            const e = ep as Record<string, string>;
            const fileName = e.file ? e.file.split('/').pop() : '';
            lines.push(`| ${e.method || ''} | ${e.path || ''} | ${e.description || ''} | ${fileName} |`);
          }
          lines.push('');
        } else {
          lines.push('*No API endpoints found for this feature.*');
          lines.push('');
        }
        break;

      case 'schema':
        // Handle actual JSON structure: data.schemas
        const schemas = data.schemas as Array<Record<string, unknown>> | undefined;
        if (schemas && Array.isArray(schemas) && schemas.length > 0) {
          lines.push('## Database Tables / Schemas');
          lines.push('');
          for (const schema of schemas) {
            const s = schema as Record<string, unknown>;
            lines.push(`### ${s.name || 'Table'}`);
            const fileName = typeof s.file === 'string' ? s.file.split('/').pop() : '';
            lines.push(`- **Type**: ${s.type || 'table'}`);
            lines.push(`- **File**: ${fileName}`);
            lines.push('');

            const columns = s.columns as Array<Record<string, unknown>> | undefined;
            if (columns && Array.isArray(columns) && columns.length > 0) {
              lines.push('| Column | Type | Nullable | Primary Key |');
              lines.push('|--------|------|----------|-------------|');
              for (const col of columns) {
                const c = col as Record<string, unknown>;
                lines.push(`| ${c.name || ''} | ${c.type || ''} | ${c.nullable ? 'YES' : 'NO'} | ${c.primaryKey ? '✓' : ''} |`);
              }
              lines.push('');
            }
          }
        } else {
          lines.push('*No database schemas found for this feature.*');
          lines.push('');
        }
        break;

      case 'events':
        // Events from apis.exports - filter for event-related types
        const evApis = data.apis as Record<string, unknown> | undefined;
        const allEvExports = (evApis?.exports || []) as Array<Record<string, string>>;
        const eventExports = allEvExports.filter(exp => {
          const name = (exp.name || '').toLowerCase();
          return name.includes('event') || name.includes('payload') ||
            name.includes('emit') || name.includes('listener') ||
            name.includes('handler') || name.includes('subscribe') ||
            name.includes('publish') || name.includes('bus') ||
            name.includes('pulse') || name.includes('hook') ||
            (exp.type === 'const' && name.includes('_'));
        });

        if (eventExports.length > 0) {
          lines.push('## Event Types & Payloads');
          lines.push('');
          lines.push('| Name | Type | File |');
          lines.push('|------|------|------|');
          for (const exp of eventExports) {
            const fileName = exp.file?.split('/').pop() || '-';
            lines.push(`| ${exp.name} | ${exp.type || '-'} | ${fileName} |`);
          }
          lines.push('');
        }

        // Also check for dedicated events data
        const events = data.events as Record<string, unknown> | undefined;
        if (events) {
          const eventsEmitted = events.emitted as Array<Record<string, string>> | undefined;
          if (eventsEmitted && eventsEmitted.length > 0) {
            lines.push('## Events Emitted');
            lines.push('');
            lines.push('| Event | Payload | Source |');
            lines.push('|-------|---------|--------|');
            for (const ev of eventsEmitted) {
              lines.push(`| ${ev.event || ev.eventName || ''} | ${ev.payload || ''} | ${ev.from || ev.emittedFrom || ''} |`);
            }
            lines.push('');
          }
          const eventsConsumed = events.consumed as Array<Record<string, string>> | undefined;
          if (eventsConsumed && eventsConsumed.length > 0) {
            lines.push('## Events Consumed');
            lines.push('');
            lines.push('| Event | Handler | File |');
            lines.push('|-------|---------|------|');
            for (const ev of eventsConsumed) {
              lines.push(`| ${ev.event || ev.eventName || ''} | ${ev.handler || ''} | ${ev.file || ''} |`);
            }
            lines.push('');
          }
        }

        // Fallback: show all exports if no event-specific data found
        if (eventExports.length === 0 && !events) {
          if (allEvExports.length > 0) {
            lines.push('## Exports');
            lines.push('');
            lines.push('| Name | Type | File |');
            lines.push('|------|------|------|');
            for (const exp of allEvExports.slice(0, 20)) {
              const fileName = exp.file?.split('/').pop() || '-';
              lines.push(`| ${exp.name} | ${exp.type || '-'} | ${fileName} |`);
            }
            if (allEvExports.length > 20) {
              lines.push(`| ... | ... | *${allEvExports.length - 20} more* |`);
            }
            lines.push('');
          } else {
            lines.push('*No events found for this feature.*');
            lines.push('');
          }
        }
        break;

      case 'integrations':
        // Handle dependencies - data.dependencies is string[]
        const depsArr = data.dependencies as string[] | undefined;
        if (depsArr && Array.isArray(depsArr) && depsArr.length > 0) {
          lines.push('## External Dependencies');
          lines.push('');
          lines.push('| Package |');
          lines.push('|---------|');
          for (const pkg of depsArr) {
            lines.push(`| \`${pkg}\` |`);
          }
          lines.push('');
        } else {
          lines.push('*No third-party integrations found for this feature.*');
          lines.push('');
        }
        break;

      case 'features': {
        // Features contract: describe what the feature does
        const featApis = data.apis as Record<string, unknown> | undefined;
        const featExports = (featApis?.exports || []) as Array<Record<string, string>>;
        const featEndpoints = (featApis?.endpoints || []) as Array<Record<string, string>>;
        const featFunctions = featExports.filter(exp => exp.type === 'function');
        const featDepsArr = data.dependencies as string[] | undefined;
        const srcFiles = data.sourceFiles as string[] | undefined;
        const tc = data.testCoverage as Record<string, { count: number; files: string[] }> | undefined;
        let featHasData = false;

        // Derive stack type from source file paths
        if (srcFiles && srcFiles.length > 0) {
          const paths = srcFiles.map((f: string) => f.toLowerCase());
          const stackTypes: string[] = [];
          if (paths.some(p => p.startsWith('backend/') || p.includes('/routes/') || p.includes('/controllers/'))) stackTypes.push('Backend Service');
          if (paths.some(p => p.startsWith('frontend/') || p.startsWith('web-app/') || p.includes('/components/'))) stackTypes.push('Frontend App');
          if (paths.some(p => p.startsWith('ai-worker/') || p.includes('/handlers/'))) stackTypes.push('AI Worker');
          if (paths.some(p => p.startsWith('packages/') || p.startsWith('shared/'))) stackTypes.push('Shared Package');
          if (paths.some(p => p.startsWith('extension/') || p.includes('browser'))) stackTypes.push('Browser Extension');

          const summaryParts: string[] = [];
          if (stackTypes.length > 0) summaryParts.push(stackTypes.join(' + '));
          if (featEndpoints.length > 0) summaryParts.push(`${featEndpoints.length} endpoints`);
          if (featFunctions.length > 0) summaryParts.push(`${featFunctions.length} functions`);
          if (srcFiles.length > 0) summaryParts.push(`${srcFiles.length} source files`);

          if (summaryParts.length > 0) {
            lines.push(`> ${summaryParts.join(' | ')}`);
            lines.push('');
            featHasData = true;
          }
        }

        // Show key functions
        if (featFunctions.length > 0) {
          lines.push('## Key Functions');
          lines.push('');
          lines.push('| Function | File |');
          lines.push('|----------|------|');
          for (const exp of featFunctions.slice(0, 15)) {
            const fileName = exp.file?.split('/').pop() || '-';
            lines.push(`| \`${exp.name}()\` | ${fileName} |`);
          }
          if (featFunctions.length > 15) {
            lines.push(`| ... | *${featFunctions.length - 15} more* |`);
          }
          lines.push('');
          featHasData = true;
        }
        // Show dependencies
        if (featDepsArr && featDepsArr.length > 0) {
          lines.push(`## Dependencies`);
          lines.push('');
          lines.push(`${featDepsArr.map(d => `\`${d}\``).join(', ')}`);
          lines.push('');
          featHasData = true;
        }
        // Show test summary
        if (tc) {
          const uCount = tc.unit?.count || 0;
          const iCount = tc.integration?.count || 0;
          const eCount = tc.e2e?.count || 0;
          if (uCount + iCount + eCount > 0) {
            lines.push(`## Tests`);
            lines.push('');
            lines.push(`${uCount} unit, ${iCount} integration, ${eCount} e2e`);
            lines.push('');
            featHasData = true;
          }
        }
        if (!featHasData) {
          lines.push('*No feature data available. Regenerate contracts to populate.*');
          lines.push('');
        }
        break;
      }

      case 'sql': {
        // SQL contract: Show migration files and table names (without column details)
        // Schema contract shows table structures with columns; SQL shows queries/migrations
        let sqlHasData = false;
        const sqlSrcFiles = data.sourceFiles as string[] | undefined;
        if (sqlSrcFiles && sqlSrcFiles.length > 0) {
          const migFiles = sqlSrcFiles.filter((f: string) => {
            const name = f.toLowerCase();
            return name.includes('migration') || name.endsWith('.sql') ||
              name.includes('seed') || name.includes('query') || name.includes('queries') ||
              name.includes('prisma');
          });
          if (migFiles.length > 0) {
            lines.push('## Migration & SQL Files');
            lines.push('');
            for (const f of migFiles) {
              lines.push(`- \`${f.split('/').pop()}\``);
            }
            lines.push('');
            sqlHasData = true;
          }
        }
        const sqlSchemas = data.schemas as Array<Record<string, unknown>> | undefined;
        if (sqlSchemas && Array.isArray(sqlSchemas) && sqlSchemas.length > 0) {
          lines.push(`## Tables Used (${sqlSchemas.length})`);
          lines.push('');
          for (const s of sqlSchemas) {
            const colCount = (s.columns as unknown[])?.length || 0;
            lines.push(`- **${s.name}** (${s.type || 'table'}${colCount > 0 ? `, ${colCount} columns` : ''})`);
          }
          lines.push('');
          sqlHasData = true;
        }
        if (!sqlHasData) {
          lines.push('*No SQL/migration files found for this feature.*');
          lines.push('');
        }
        break;
      }

      case 'admin': {
        // Show admin contract data if available, otherwise derive from endpoints
        const adminData = data.adminContract as Record<string, unknown> | undefined;
        let adminHasData = false;
        if (adminData) {
          const entities = adminData.entities as Array<Record<string, unknown>> | undefined;
          if (entities && entities.length > 0) {
            lines.push('## Admin Entities');
            lines.push('');
            lines.push('| Entity | Operations |');
            lines.push('|--------|------------|');
            for (const ent of entities) {
              const ops = Array.isArray(ent.operations) ? (ent.operations as string[]).join(', ') : '-';
              lines.push(`| **${ent.name}** | ${ops} |`);
            }
            lines.push('');
            adminHasData = true;
          }
          const adminRoutes = adminData.adminRoutes as Array<Record<string, unknown>> | undefined;
          if (adminRoutes && adminRoutes.length > 0) {
            lines.push('## Admin Routes');
            lines.push('');
            lines.push('| Method | Path | Roles |');
            lines.push('|--------|------|-------|');
            for (const r of adminRoutes) {
              const roles = Array.isArray(r.roles) ? (r.roles as string[]).join(', ') : '-';
              lines.push(`| ${r.method || ''} | ${r.path || ''} | ${roles} |`);
            }
            lines.push('');
            adminHasData = true;
          }
          const perms = adminData.permissions as string[] | undefined;
          if (perms && perms.length > 0) {
            lines.push('## Permissions');
            lines.push('');
            for (const p of perms) {
              lines.push(`- \`${p}\``);
            }
            lines.push('');
            adminHasData = true;
          }
        }
        // Derive admin actions from endpoints if no adminContract field
        if (!adminHasData) {
          const adminApis = data.apis as Record<string, unknown> | undefined;
          if (adminApis?.endpoints && Array.isArray(adminApis.endpoints) && adminApis.endpoints.length > 0) {
            const allEps = adminApis.endpoints as Array<Record<string, string>>;
            // Group endpoints by resource to show manageable entities
            const entityMap = new Map<string, Set<string>>();
            for (const ep of allEps) {
              const pathParts = (ep.path || '').split('/').filter(Boolean);
              const resource = pathParts.find((p: string) => p !== 'api' && p !== 'v1' && !p.startsWith(':')) || ep.path;
              if (resource) {
                if (!entityMap.has(resource)) entityMap.set(resource, new Set());
                entityMap.get(resource)!.add(ep.method || 'GET');
              }
            }
            lines.push('## Admin Panel Actions');
            lines.push('');
            lines.push('| Resource | Operations |');
            lines.push('|----------|------------|');
            for (const [resource, methods] of entityMap) {
              lines.push(`| **${resource}** | ${Array.from(methods).join(', ')} |`);
            }
            lines.push('');
          } else {
            lines.push('*No admin actions identified for this feature.*');
            lines.push('');
          }
        }
        break;
      }

      case 'e2e':
      case 'unit':
      case 'integration': {
        // Show test coverage for the specific test type
        const tcData = data.testCoverage as Record<string, { count: number; files: string[] }> | undefined;
        const tKey = contractType === 'e2e' ? 'e2e' : contractType === 'unit' ? 'unit' : 'integration';
        const tLabel = contractType === 'e2e' ? 'E2E' : contractType === 'unit' ? 'Unit' : 'Integration';
        const tInfo = tcData?.[tKey];
        if (tInfo && tInfo.count > 0) {
          lines.push(`## ${tLabel} Tests (${tInfo.count})`);
          lines.push('');
          for (const f of tInfo.files.slice(0, 20)) {
            lines.push(`- \`${f.split('/').pop()}\``);
          }
          if (tInfo.files.length > 20) {
            lines.push(`- *...${tInfo.files.length - 20} more*`);
          }
          lines.push('');
        } else {
          lines.push(`*No ${tLabel.toLowerCase()} tests found for this feature.*`);
          lines.push('');
        }
        break;
      }

      case 'infra': {
        // Show infrastructure: stack type, dependencies, database tables, config files
        let infraHasData = false;
        const infraSrcFiles = data.sourceFiles as string[] | undefined;
        const infraSchemas = data.schemas as Array<Record<string, unknown>> | undefined;

        // Derive stack classification
        if (infraSrcFiles && infraSrcFiles.length > 0) {
          const paths = infraSrcFiles.map((f: string) => f.toLowerCase());
          const stackTypes: string[] = [];
          if (paths.some(p => p.startsWith('backend/') || p.includes('/routes/'))) stackTypes.push('Backend');
          if (paths.some(p => p.startsWith('frontend/') || p.startsWith('web-app/'))) stackTypes.push('Frontend');
          if (paths.some(p => p.startsWith('ai-worker/'))) stackTypes.push('AI Worker');
          if (paths.some(p => p.startsWith('packages/'))) stackTypes.push('Shared Package');
          if (paths.some(p => p.startsWith('extension/'))) stackTypes.push('Browser Extension');
          const hasDocker = paths.some(p => p.includes('docker') || p.includes('Dockerfile'));
          const hasPrisma = paths.some(p => p.includes('prisma'));
          const hasDb = (infraSchemas && infraSchemas.length > 0) || paths.some(p => p.includes('.sql') || p.includes('migration'));

          if (stackTypes.length > 0 || hasDocker || hasDb) {
            lines.push('## Stack');
            lines.push('');
            if (stackTypes.length > 0) lines.push(`- **Type:** ${stackTypes.join(', ')}`);
            if (hasDocker) lines.push(`- **Container:** Yes (Docker)`);
            if (hasDb) lines.push(`- **Database:** ${hasPrisma ? 'Prisma ORM' : 'SQL'}`);
            lines.push('');
            infraHasData = true;
          }
        }

        const infraDepsArr = data.dependencies as string[] | undefined;
        if (infraDepsArr && infraDepsArr.length > 0) {
          lines.push('## Runtime Dependencies');
          lines.push('');
          for (const dep of infraDepsArr) {
            lines.push(`- \`${dep}\``);
          }
          lines.push('');
          infraHasData = true;
        }
        if (infraSchemas && Array.isArray(infraSchemas) && infraSchemas.length > 0) {
          lines.push(`## Database Tables (${infraSchemas.length})`);
          lines.push('');
          lines.push('| Table | Type |');
          lines.push('|-------|------|');
          for (const s of infraSchemas.slice(0, 20)) {
            lines.push(`| ${s.name} | ${s.type || 'table'} |`);
          }
          if (infraSchemas.length > 20) {
            lines.push(`| ... | *${infraSchemas.length - 20} more* |`);
          }
          lines.push('');
          infraHasData = true;
        }
        if (infraSrcFiles && infraSrcFiles.length > 0) {
          const configFiles = infraSrcFiles.filter((f: string) => {
            const name = f.toLowerCase();
            return name.includes('config') || name.includes('.env') || name.includes('docker') ||
              name.includes('yaml') || name.includes('yml') || name.includes('makefile') ||
              name.includes('package.json') || name.includes('tsconfig') ||
              name.includes('prisma') || name.includes('migration');
          });
          if (configFiles.length > 0) {
            lines.push(`## Config & Migration Files (${configFiles.length})`);
            lines.push('');
            for (const f of configFiles) {
              lines.push(`- \`${f.split('/').pop()}\``);
            }
            lines.push('');
            infraHasData = true;
          }
        }
        if (!infraHasData) {
          lines.push('*No infrastructure data found for this feature.*');
          lines.push('');
        }
        break;
      }

      case 'fixtures': {
        const allSrcFiles = data.sourceFiles as string[] | undefined;
        if (allSrcFiles && allSrcFiles.length > 0) {
          const fixtureFiles = allSrcFiles.filter((f: string) => {
            const name = f.toLowerCase();
            return name.includes('fixture') || name.includes('mock') || name.includes('seed') || name.includes('factory');
          });
          if (fixtureFiles.length > 0) {
            lines.push(`## Fixture Files (${fixtureFiles.length})`);
            lines.push('');
            for (const f of fixtureFiles) {
              lines.push(`- \`${f.split('/').pop()}\``);
            }
            lines.push('');
          } else {
            lines.push('*No fixture files found for this feature.*');
            lines.push('');
          }
        } else {
          lines.push('*No fixture files found for this feature.*');
          lines.push('');
        }
        break;
      }

      case 'css': {
        const cssSrcFiles = data.sourceFiles as string[] | undefined;
        if (cssSrcFiles && cssSrcFiles.length > 0) {
          const cssFiles = cssSrcFiles.filter((f: string) => {
            const name = f.toLowerCase();
            return name.endsWith('.css') || name.endsWith('.scss') || name.endsWith('.less') ||
              name.endsWith('.styl') || name.includes('theme') || name.includes('style') ||
              name.includes('tailwind');
          });
          if (cssFiles.length > 0) {
            lines.push(`## Style Files (${cssFiles.length})`);
            lines.push('');
            for (const f of cssFiles) {
              lines.push(`- \`${f.split('/').pop()}\``);
            }
            lines.push('');
          } else {
            lines.push('*No CSS/style files found for this feature.*');
            lines.push('');
          }
        } else {
          lines.push('*No CSS/style files found for this feature.*');
          lines.push('');
        }
        break;
      }

      case 'prompts': {
        const promptSrcFiles = data.sourceFiles as string[] | undefined;
        if (promptSrcFiles && promptSrcFiles.length > 0) {
          const promptFiles = promptSrcFiles.filter((f: string) => {
            const name = f.toLowerCase();
            return name.includes('prompt') || name.includes('skill') || name.includes('mode') ||
              name.endsWith('.yaml') || name.endsWith('.yml') || name.includes('agent');
          });
          if (promptFiles.length > 0) {
            lines.push(`## Prompt & Config Files (${promptFiles.length})`);
            lines.push('');
            for (const f of promptFiles) {
              lines.push(`- \`${f.split('/').pop()}\``);
            }
            lines.push('');
          } else {
            lines.push('*No prompt/skill files found for this feature.*');
            lines.push('');
          }
        } else {
          lines.push('*No prompt/skill files found for this feature.*');
          lines.push('');
        }
        break;
      }

      default:
        // Generic format - show overview and any available data
        if (data.overview) {
          lines.push(`## Overview`);
          lines.push('');
          lines.push(String(data.overview));
          lines.push('');
        }

        // Show what data is available
        const availableKeys = Object.keys(data).filter(k => !['feature', 'version', 'lastGenerated', 'generatorVersion', 'overview'].includes(k));
        if (availableKeys.length > 0) {
          lines.push(`## Available Data`);
          lines.push('');
          lines.push('This feature contract contains data for: ' + availableKeys.join(', '));
          lines.push('');
        }
    }

    return lines.length > 4 ? lines.join('\n') : null;
  };

  const loadDiff = async () => {
    if (diff || loadingDiff || !repoPath) return;
    setLoadingDiff(true);
    try {
      const result = await window.api?.git?.getDiffSummary?.(repoPath);
      if (result?.success && result.data?.files) {
        // Find diff for this contract file
        const relativePath = contract.filePath.replace(repoPath + '/', '');
        const fileDiff = result.data.files.find((f: { path: string }) =>
          f.path === relativePath ||
          contract.filePath.includes(f.path) ||
          f.path.includes(contract.name)
        );
        if (fileDiff) {
          setDiff(fileDiff.diff);
          setDiffStats({ additions: fileDiff.additions, deletions: fileDiff.deletions });
        }
      }
    } catch (err) {
      console.error('Failed to load diff:', err);
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleOpenFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) {
      await loadContent();
    }
    setShowContent(true);
  };

  const handleOpenInEditor = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Open in VS Code
    const dir = contract.filePath.split('/').slice(0, -1).join('/');
    await window.api?.shell?.openVSCode?.(dir);
  };

  // Load content on mount or when feature contracts change
  useEffect(() => {
    // Always prefer consolidated view when feature contracts are available
    if (featureContracts.length > 0) {
      loadConsolidatedContract();
    } else if (!content && !loading) {
      loadContent();
    }
  }, [featureContracts]); // Re-run when feature contracts are loaded

  // Load diff when expanded and has changes
  useEffect(() => {
    if (expanded && hasChanges && !diff && !loadingDiff) {
      loadDiff();
    }
  }, [expanded, hasChanges]);

  return (
    <>
      <div
        className={`
          bg-surface rounded-xl border transition-all cursor-pointer
          ${expanded ? 'border-kanvas-blue shadow-kanvas' : 'border-border hover:border-kanvas-blue/30 hover:shadow-card-hover'}
        `}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-xl">{typeIcons[contract.type]}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-text-primary truncate">{contract.name}</h4>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[contract.status]}`}>
                  {contract.status}
                </span>
                {contract.breaking && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                    Breaking
                  </span>
                )}
                {hasChanges && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 flex items-center gap-1">
                    {diffStats ? (
                      <>
                        <span className="text-green-600">+{diffStats.additions}</span>
                        <span className="text-red-600">-{diffStats.deletions}</span>
                      </>
                    ) : (
                      'Modified'
                    )}
                  </span>
                )}
              </div>
              {/* Not generated indicator */}
              {!fileExists && !loading && (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    Not Generated
                  </span>
                  {generating && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 flex items-center gap-1">
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Generating...
                    </span>
                  )}
                </div>
              )}
              {/* Metrics pills - show when available */}
              {fileExists && metrics.length > 0 && (
                <div className="flex items-center gap-1.5 mb-1">
                  {metrics.map((m, idx) => (
                    <span key={idx} className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-tertiary text-text-secondary">
                      {m.count} {m.label}
                    </span>
                  ))}
                </div>
              )}
              {contract.description && (
                <p className="text-sm text-text-secondary line-clamp-1">{contract.description}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">v{extractedVersion || contract.version}</span>
              <svg
                className={`w-4 h-4 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
            {/* Actions row */}
            <div className="flex items-center gap-2">
              {!fileExists ? (
                <>
                  <button
                    onClick={handleGenerate}
                    disabled={generating || !repoPath}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-kanvas-blue text-white hover:bg-kanvas-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {generating ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Generating...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Generate Contract
                      </>
                    )}
                  </button>
                  <span className="text-xs text-text-secondary">
                    This contract has not been generated yet
                  </span>
                </>
              ) : (
                <>
                  <button
                    onClick={handleOpenFile}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-kanvas-blue text-white hover:bg-kanvas-blue/90 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    View Contract
                  </button>
                  <button
                    onClick={handleOpenInEditor}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-surface-secondary text-text-primary hover:bg-surface-tertiary transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.583 17.834l-8.042-6.667 8.042-6.667V17.834zm-.001 4.165L1.999 12 17.582 2.001l4.419 2.209v15.58l-4.419 2.209z"/>
                    </svg>
                    Open in Editor
                  </button>
                  <button
                    onClick={handleGenerate}
                    disabled={generating || !repoPath}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-surface-secondary text-text-primary hover:bg-surface-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={!repoPath ? "Repository path not available" : "Regenerate this contract"}
                  >
                    {generating ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Regenerating...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Regenerate
                      </>
                    )}
                  </button>
                </>
              )}
              <div className="flex-1" />
              <code className="text-xs text-text-secondary bg-surface-secondary px-2 py-1 rounded truncate max-w-[200px]">
                {contract.filePath.split('/').slice(-2).join('/')}
              </code>
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-text-secondary">Type:</span>
                <span className="ml-2 text-text-primary">{typeLabels[contract.type]}</span>
              </div>
              <div>
                <span className="text-text-secondary">Last Updated:</span>
                <span className="ml-2 text-text-primary">
                  {new Date(contract.lastUpdated).toLocaleDateString()}
                </span>
              </div>
              {contract.modifiedBy && (
                <div className="col-span-2">
                  <span className="text-text-secondary">Modified By:</span>
                  <span className="ml-2 text-text-primary">{contract.modifiedBy}</span>
                </div>
              )}
            </div>

            {/* Changelog preview */}
            {contract.changeLog && contract.changeLog.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-text-secondary mb-1">Recent Changes:</p>
                <div className="bg-surface-secondary rounded-lg p-2 text-xs">
                  {contract.changeLog.slice(0, 2).map((entry, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-text-secondary">{entry.date}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        entry.impact === 'breaking' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {entry.impact}
                      </span>
                      <span className="text-text-primary truncate">{entry.changes}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Uncommitted Changes Diff */}
            {(hasChanges || diff) && (
              <div className="mt-3">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDiff(!showDiff); }}
                  className="flex items-center gap-2 text-xs font-medium text-text-secondary hover:text-text-primary"
                >
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${showDiff ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Uncommitted Changes
                  {diffStats && (
                    <span className="text-text-secondary">
                      (<span className="text-green-600">+{diffStats.additions}</span>{' '}
                      <span className="text-red-600">-{diffStats.deletions}</span>)
                    </span>
                  )}
                </button>
                {showDiff && (
                  <div className="mt-2 bg-surface-secondary rounded-lg p-3 overflow-auto max-h-[300px]">
                    {loadingDiff ? (
                      <div className="flex items-center gap-2 text-xs text-text-secondary">
                        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Loading diff...
                      </div>
                    ) : diff ? (
                      <VirtualizedDiff diff={diff} maxHeight={280} />
                    ) : (
                      <div className="text-xs text-text-secondary">
                        No diff available. Changes may be committed already.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Contract Content Modal - Escape key handler */}
      {showContent && <EscapeKeyHandler onEscape={() => setShowContent(false)} />}
      {showContent && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowContent(false)}
        >
          <div
            className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] mx-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-surface-secondary flex items-center justify-center">
                  <span className="text-lg">{typeIcons[contract.type]}</span>
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">{contract.name}</h3>
                  <p className="text-xs text-text-secondary">{typeLabels[contract.type]}</p>
                </div>
                {/* Consolidated badge */}
                {featureContracts.length > 0 && (
                  <div className="ml-4">
                    <span className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface-secondary text-text-primary">
                      Repo-Level (Consolidated)
                    </span>
                  </div>
                )}
              </div>
              {/* Right side controls - fixed width to prevent cutoff */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Metrics - hidden on very small widths */}
                {metrics.length > 0 && (
                  <div className="hidden sm:flex items-center gap-1.5 mr-2">
                    {metrics.map((m, idx) => (
                      <span key={idx} className="px-2 py-1 rounded-full text-xs font-medium bg-kanvas-blue/10 text-kanvas-blue whitespace-nowrap">
                        {m.count} {m.label}
                      </span>
                    ))}
                  </div>
                )}
                {/* Regenerate Button */}
                <button
                  onClick={handleGenerate}
                  disabled={generating || !repoPath}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    generating || !repoPath
                      ? 'bg-surface-secondary text-text-secondary opacity-50 cursor-not-allowed'
                      : 'bg-kanvas-blue text-white hover:bg-kanvas-blue/90'
                  }`}
                  title="Regenerate consolidated contract"
                >
                  {generating ? (
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                </button>
                {/* View Mode Toggle */}
                <div className="flex items-center rounded-lg border border-border overflow-hidden">
                  <button
                    onClick={() => setViewMode('markdown')}
                    className={`px-2 py-1.5 text-xs font-medium transition-colors ${
                      viewMode === 'markdown'
                        ? 'bg-kanvas-blue text-white'
                        : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
                    }`}
                    title="Markdown View"
                  >
                    MD
                  </button>
                  <button
                    onClick={() => setViewMode('json')}
                    className={`px-2 py-1.5 text-xs font-medium transition-colors ${
                      viewMode === 'json'
                        ? 'bg-kanvas-blue text-white'
                        : 'bg-surface-secondary text-text-secondary hover:text-text-primary'
                    }`}
                    title="Raw JSON View"
                  >
                    Raw
                  </button>
                </div>
                <button
                  onClick={handleOpenInEditor}
                  className="p-1.5 rounded-lg hover:bg-surface-secondary transition-colors"
                  title="Open in Editor"
                >
                  <svg className="w-4 h-4 text-text-secondary" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.583 17.834l-8.042-6.667 8.042-6.667V17.834zm-.001 4.165L1.999 12 17.582 2.001l4.419 2.209v15.58l-4.419 2.209z"/>
                  </svg>
                </button>
                <button
                  onClick={() => setShowContent(false)}
                  className="p-1.5 rounded-lg hover:bg-surface-secondary transition-colors"
                  title="Close"
                >
                  <svg className="w-4 h-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-4">
              {loading || generating ? (
                <div className="flex flex-col items-center justify-center h-40 gap-4">
                  <div className="flex items-center gap-2 text-text-secondary">
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {generating ? (
                      <span>
                        {generationProgress?.currentFeature
                          ? `Generating: ${generationProgress.currentFeature}`
                          : 'Starting generation...'}
                      </span>
                    ) : 'Loading contract...'}
                  </div>
                  {generating && generationProgress && (
                    <div className="w-full max-w-md space-y-2">
                      <div className="flex justify-between text-xs text-text-secondary">
                        <span>{generationProgress.completed} of {generationProgress.total} features</span>
                        <span>{generationProgress.total > 0 ? Math.round((generationProgress.completed / generationProgress.total) * 100) : 0}%</span>
                      </div>
                      <div className="w-full h-2 bg-surface-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-kanvas-blue rounded-full transition-all duration-300"
                          style={{ width: `${generationProgress.total > 0 ? (generationProgress.completed / generationProgress.total) * 100 : 5}%` }}
                        />
                      </div>
                      {generationProgress.contractType && (
                        <div className="text-xs text-center text-text-secondary">
                          Step: {generationProgress.contractType === 'markdown' ? '📄 Markdown' :
                                 generationProgress.contractType === 'json' ? '📋 JSON' : '👤 Admin'}
                        </div>
                      )}
                    </div>
                  )}
                  {generating && !generationProgress && (
                    <div className="w-64 h-2 bg-surface-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-kanvas-blue rounded-full animate-pulse" style={{ width: '30%' }}></div>
                    </div>
                  )}
                </div>
              ) : error ? (
                <div className="flex items-center justify-center h-32">
                  <div className="text-center">
                    <p className="text-red-500 mb-2">{error}</p>
                    <button
                      onClick={(e) => { e.stopPropagation(); loadContent(); }}
                      className="text-kanvas-blue text-sm hover:underline"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : content ? (
                <>
                  {/* Truncation warning */}
                  {isTruncated && (
                    <div className="p-2 bg-yellow-50 border border-yellow-200 text-yellow-700 text-xs rounded-lg mb-3 flex items-center gap-2">
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>Content truncated for performance (file &gt;100KB). Open in editor to view full file.</span>
                    </div>
                  )}
                  {viewMode === 'markdown' ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none select-text
                    prose-headings:text-text-primary prose-p:text-text-secondary
                    prose-table:border-collapse prose-table:w-full prose-table:my-4
                    prose-th:border prose-th:border-border prose-th:bg-surface-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-text-primary prose-th:font-semibold
                    prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-td:text-text-secondary
                    prose-code:bg-surface-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-kanvas-blue prose-code:font-mono prose-code:text-sm
                    prose-pre:bg-surface-secondary prose-pre:p-4 prose-pre:rounded-lg prose-pre:overflow-auto
                    prose-blockquote:border-l-4 prose-blockquote:border-kanvas-blue prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary
                    prose-ul:list-disc prose-ul:pl-6 prose-ol:list-decimal prose-ol:pl-6
                    prose-li:text-text-secondary prose-li:my-1
                    prose-a:text-kanvas-blue prose-a:no-underline hover:prose-a:underline
                    prose-strong:text-text-primary prose-em:text-text-secondary
                    prose-hr:border-border"
                    style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        table: ({ children }) => (
                          <table className="w-full border-collapse my-4 text-sm">{children}</table>
                        ),
                        thead: ({ children }) => (
                          <thead className="bg-surface-secondary">{children}</thead>
                        ),
                        tbody: ({ children }) => (
                          <tbody>{children}</tbody>
                        ),
                        tr: ({ children }) => (
                          <tr className="border-b border-border">{children}</tr>
                        ),
                        th: ({ children }) => (
                          <th className="border border-border bg-surface-secondary px-3 py-2 text-left text-text-primary font-semibold">{children}</th>
                        ),
                        td: ({ children }) => (
                          <td className="border border-border px-3 py-2 text-text-secondary">{children}</td>
                        ),
                        h1: ({ children }) => (
                          <h1 className="text-2xl font-bold text-text-primary mt-6 mb-4">{children}</h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-xl font-semibold text-text-primary mt-5 mb-3 border-b border-border pb-2">{children}</h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-lg font-medium text-text-primary mt-4 mb-2">{children}</h3>
                        ),
                        p: ({ children }) => (
                          <p className="text-text-secondary my-2">{children}</p>
                        ),
                        code: ({ children, className }) => {
                          const isInline = !className;
                          return isInline ? (
                            <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-kanvas-blue font-mono text-sm">{children}</code>
                          ) : (
                            <code className={className}>{children}</code>
                          );
                        },
                        pre: ({ children }) => (
                          <pre className="bg-surface-secondary p-4 rounded-lg overflow-auto my-4">{children}</pre>
                        ),
                      }}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <pre className="bg-surface-secondary rounded-lg p-4 text-sm font-mono text-text-secondary overflow-auto select-text whitespace-pre-wrap"
                    style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                    {rawContent || content}
                  </pre>
                )}
                </>
              ) : (
                <div className="flex items-center justify-center h-32 text-text-secondary">
                  No content available
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between p-4 border-t border-border text-xs text-text-secondary gap-4">
              <span className="truncate flex-1">
                {contract.filePath}
              </span>
              <span className="flex-shrink-0 whitespace-nowrap">
                <span className="font-medium text-text-primary">v{extractedVersion || '1.0.0'}</span>
                {featureContracts.length > 0 && <span className="text-kanvas-blue ml-1">(consolidated)</span>}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * QuickActionsBar - Quick action buttons for terminal, VS Code, finder, copy path
 */
function QuickActionsBar({ worktreePath }: { worktreePath?: string }): React.ReactElement {
  const [copySuccess, setCopySuccess] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const path = worktreePath || '';

  const handleOpenTerminal = async () => {
    if (!path) return;
    setActionError(null);
    const result = await window.api?.shell?.openTerminal?.(path);
    if (!result?.success) {
      setActionError(result?.error?.message || 'Failed to open terminal');
    }
  };

  const handleOpenVSCode = async () => {
    if (!path) return;
    setActionError(null);
    const result = await window.api?.shell?.openVSCode?.(path);
    if (!result?.success) {
      setActionError(result?.error?.message || 'Failed to open VS Code');
    }
  };

  const handleOpenFinder = async () => {
    if (!path) return;
    setActionError(null);
    const result = await window.api?.shell?.openFinder?.(path);
    if (!result?.success) {
      setActionError(result?.error?.message || 'Failed to open Finder');
    }
  };

  const handleCopyPath = async () => {
    if (!path) return;
    setActionError(null);
    const result = await window.api?.shell?.copyPath?.(path);
    if (result?.success) {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } else {
      setActionError(result?.error?.message || 'Failed to copy path');
    }
  };

  if (!path) return <></>;

  return (
    <div className="px-4 py-2 border-b border-border bg-surface-secondary">
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary mr-2">Quick Actions:</span>

        <button
          onClick={handleOpenTerminal}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium
            bg-surface text-text-primary hover:bg-surface-tertiary transition-colors"
          title="Open Terminal"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Terminal
        </button>

        <button
          onClick={handleOpenVSCode}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium
            bg-surface text-text-primary hover:bg-surface-tertiary transition-colors"
          title="Open in VS Code"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.583 17.834l-8.042-6.667 8.042-6.667V17.834zm-.001 4.165L1.999 12 17.582 2.001l4.419 2.209v15.58l-4.419 2.209z"/>
          </svg>
          VS Code
        </button>

        <button
          onClick={handleOpenFinder}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium
            bg-surface text-text-primary hover:bg-surface-tertiary transition-colors"
          title="Show in Finder"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          Finder
        </button>

        <button
          onClick={handleCopyPath}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium
            bg-surface text-text-primary hover:bg-surface-tertiary transition-colors"
          title="Copy Path"
        >
          {copySuccess ? (
            <>
              <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-green-500">Copied!</span>
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy Path
            </>
          )}
        </button>

        {actionError && (
          <span className="text-xs text-red-500 ml-2">{actionError}</span>
        )}
      </div>
    </div>
  );
}

/**
 * TerminalTab - Shows system logs, git commands, and debug information
 */
function TerminalTab({ sessionId }: { sessionId: string }): React.ReactElement {
  const [logs, setLogs] = useState<Array<{
    id: string;
    timestamp: string;
    level: string;
    message: string;
    source?: string;
    command?: string;
    output?: string;
    exitCode?: number;
  }>>([]);
  const [filter, setFilter] = useState<'all' | 'debug' | 'info' | 'warn' | 'error' | 'git' | 'system'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = React.useRef<HTMLDivElement>(null);

  // Track when this session view was mounted (to separate historical from live)
  const [sessionResumeTime] = useState(() => new Date().toISOString());
  const [historicalCount, setHistoricalCount] = useState(0);

  // Load initial logs from database
  useEffect(() => {
    async function loadLogs() {
      if (window.api?.terminal?.getLogs) {
        const result = await window.api.terminal.getLogs(sessionId, 500);
        if (result.success && result.data) {
          setLogs(result.data);
          setHistoricalCount(result.data.length);
        }
      }
    }
    loadLogs();

    // Subscribe to new logs
    const unsubscribe = window.api?.terminal?.onLog?.((entry) => {
      if (!entry.sessionId || entry.sessionId === sessionId) {
        setLogs((prev) => [entry, ...prev].slice(0, 500));
      }
    });

    return () => unsubscribe?.();
  }, [sessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleClearLogs = async () => {
    if (window.api?.terminal?.clearLogs) {
      await window.api.terminal.clearLogs(sessionId);
      setLogs([]);
    }
  };

  const handleCopyAll = async () => {
    const text = filteredLogs
      .map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}${log.output ? '\n' + log.output : ''}`)
      .join('\n');
    await navigator.clipboard.writeText(text);
  };

  const filteredLogs = filter === 'all'
    ? logs
    : logs.filter((log) => log.level === filter);

  const levelStyles: Record<string, { bg: string; text: string; icon: string }> = {
    debug: { bg: 'bg-gray-100', text: 'text-gray-600', icon: 'D' },
    info: { bg: 'bg-blue-100', text: 'text-blue-600', icon: 'I' },
    warn: { bg: 'bg-yellow-100', text: 'text-yellow-600', icon: 'W' },
    error: { bg: 'bg-red-100', text: 'text-red-600', icon: 'E' },
    git: { bg: 'bg-purple-100', text: 'text-purple-600', icon: 'G' },
    system: { bg: 'bg-green-100', text: 'text-green-600', icon: 'S' },
  };

  const filterCounts = {
    all: logs.length,
    debug: logs.filter((l) => l.level === 'debug').length,
    info: logs.filter((l) => l.level === 'info').length,
    warn: logs.filter((l) => l.level === 'warn').length,
    error: logs.filter((l) => l.level === 'error').length,
    git: logs.filter((l) => l.level === 'git').length,
    system: logs.filter((l) => l.level === 'system').length,
  };

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Header */}
      <div className="px-4 py-2 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-300">Terminal</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">
            {filteredLogs.length} entries
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter buttons */}
          {(['all', 'git', 'info', 'warn', 'error'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                filter === level
                  ? 'bg-kanvas-blue text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
              {filterCounts[level] > 0 && (
                <span className="ml-1 opacity-60">({filterCounts[level]})</span>
              )}
            </button>
          ))}
          <div className="w-px h-4 bg-gray-700 mx-1" />
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1.5 rounded transition-colors ${
              autoScroll ? 'bg-kanvas-blue text-white' : 'bg-gray-700 text-gray-400'
            }`}
            title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
          <button
            onClick={handleCopyAll}
            className="p-1.5 rounded bg-gray-700 text-gray-400 hover:bg-gray-600 transition-colors"
            title="Copy All"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button
            onClick={handleClearLogs}
            className="p-1.5 rounded bg-gray-700 text-gray-400 hover:bg-red-600 hover:text-white transition-colors"
            title="Clear Logs"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-auto font-mono text-xs p-2 space-y-1">
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p>No terminal logs yet</p>
              <p className="text-gray-600 mt-1">Logs will appear as the system operates</p>
            </div>
          </div>
        ) : (
          <>
            {/* Historical data indicator at top */}
            {historicalCount > 0 && (
              <div className="py-2 px-2 mb-2 text-center">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-gray-700" />
                  <span className="text-xs text-gray-500">
                    {historicalCount} entries from previous session
                  </span>
                  <div className="flex-1 h-px bg-gray-700" />
                </div>
              </div>
            )}
            {filteredLogs.slice().reverse().map((log, index, arr) => {
              const style = levelStyles[log.level] || levelStyles.info;
              const isHistorical = log.timestamp < sessionResumeTime;
              const nextLog = arr[index + 1];
              const isLastHistorical = isHistorical && nextLog && nextLog.timestamp >= sessionResumeTime;

              return (
                <React.Fragment key={log.id}>
                  <div className={`flex items-start gap-2 py-1 hover:bg-gray-800 rounded px-1 ${
                    isHistorical ? 'opacity-60' : ''
                  }`}>
                    <span className="text-gray-500 flex-shrink-0 w-20">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold ${style.bg} ${style.text}`}>
                      {style.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      {log.command ? (
                        <>
                          <span className="text-green-400">$ {log.command}</span>
                          {log.exitCode !== undefined && log.exitCode !== 0 && (
                            <span className="text-red-400 ml-2">[exit: {log.exitCode}]</span>
                          )}
                          {log.output && (
                            <pre className="text-gray-400 mt-1 whitespace-pre-wrap break-all">{log.output}</pre>
                          )}
                        </>
                      ) : (
                        <span className={`${
                          log.level === 'error' ? 'text-red-400' :
                          log.level === 'warn' ? 'text-yellow-400' :
                          log.level === 'git' ? 'text-purple-400' :
                          'text-gray-300'
                        }`}>
                          {log.source && <span className="text-gray-500">[{log.source}] </span>}
                          {log.message}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Session resume separator */}
                  {isLastHistorical && (
                    <div className="py-2 my-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-px bg-kanvas-blue/50" />
                        <span className="text-xs text-kanvas-blue font-medium px-2">
                          Session resumed {new Date(sessionResumeTime).toLocaleTimeString()}
                        </span>
                        <div className="flex-1 h-px bg-kanvas-blue/50" />
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
            <div ref={logEndRef} />
          </>
        )}
      </div>
    </div>
  );
}

function generateDefaultPrompt(session: SessionReport): string {
  const shortSessionId = session.sessionId.replace('sess_', '').slice(0, 8);
  const task = session.task || session.branchName || 'development';

  // Determine working directory - prefer worktree for isolated development
  // Priority: explicit worktreePath > inferred worktree > repoPath
  let workDir = session.repoPath;

  if (session.worktreePath && session.worktreePath !== session.repoPath) {
    // Explicit worktree path is set and different from repo
    workDir = session.worktreePath;
  } else if (session.branchName && session.repoPath) {
    // Try to infer worktree path: repoPath/local_deploy/branchName
    const inferredWorktree = `${session.repoPath}/local_deploy/${session.branchName}`;
    workDir = inferredWorktree;
  }

  return `# SESSION ${shortSessionId}

# ⚠️ CRITICAL: WRONG DIRECTORY = WASTED WORK ⚠️
WORKDIR: ${workDir}
YOU MUST WORK ONLY IN THIS DIRECTORY - NOT THE MAIN REPO

🛑 FIRST: Run \`pwd\` and show me the output to prove you're in the worktree
🛑 DO NOT proceed until you confirm you're in: ${workDir}

BRANCH: ${session.branchName}
TASK: ${task}

## MANDATORY FIRST RESPONSE
Before doing ANY other work, you MUST respond with:
✓ Current directory: [output of pwd]
✓ Houserules read: [yes/no - if yes, summarize key rules]
✓ File locks checked: [yes/no]

## 1. SETUP (run first)
\`\`\`bash
# Check if worktree exists, create if not
if [ ! -d "${workDir}" ]; then
  cd "${session.repoPath}"
  git worktree add "${workDir}" ${session.branchName}
fi
cd "${workDir}"
pwd  # Verify: should be ${workDir}

# ⚠️ CRITICAL: Read house rules BEFORE making any changes!
cat houserules.md 2>/dev/null || echo "No houserules.md - create one as you learn the codebase"
\`\`\`

📋 **HOUSE RULES** contain project-specific patterns, conventions, testing requirements, and gotchas.
If houserules.md exists, you MUST follow its rules. If it doesn't exist, create one as you work.

## 2. CONTEXT FILE (critical - survives context compaction)
Create immediately so you can recover after compaction:
\`\`\`bash
cat > .claude-session-${shortSessionId}.md << 'EOF'
# Session ${shortSessionId}
Dir: ${workDir}
Branch: ${session.branchName}
Task: ${task}

## Files to Re-read After Compaction
1. This file: .claude-session-${shortSessionId}.md
2. House rules: houserules.md
3. File locks: .file-coordination/active-edits/

## Progress (update as you work)
- [ ] Task started
- [ ] Files identified
- [ ] Implementation in progress
- [ ] Testing complete
- [ ] Ready for commit

## Key Findings (add to houserules.md too)
- e.g. "Uses Zustand for state" or "Tests need build first"

## Notes (context for after compaction)
- e.g. "Working on AuthService.ts" or "Blocked on X"
EOF
\`\`\`

## 3. AFTER CONTEXT COMPACTION
If you see "context compacted", IMMEDIATELY:
1. cd "${workDir}"
2. cat .claude-session-${shortSessionId}.md
3. cat houserules.md
4. ls .file-coordination/active-edits/

## 4. FILE LOCKS (before editing any file)
\`\`\`bash
ls .file-coordination/active-edits/  # Check for conflicts first
# Replace <FILES> with actual files you're editing:
cat > .file-coordination/active-edits/claude-${shortSessionId}.json << 'EOF'
{"agent":"claude","session":"${shortSessionId}","files":["<file1.ts>","<file2.ts>"],"operation":"edit","reason":"${task}"}
EOF
\`\`\`

## 5. HOUSE RULES (read first, update as you learn)
Update houserules.md with patterns you discover (conventions, architecture, testing, gotchas):
\`\`\`bash
# Replace <CATEGORY> and <RULE> with actual findings:
cat >> houserules.md << 'EOF'

## <CATEGORY> - Claude ${shortSessionId}
- <RULE OR PATTERN>
EOF
\`\`\`

## 6. COMMITS
📝 **Write commit messages to: \`.devops-commit-${shortSessionId}.msg\`** (this session's file)
⚠️ DO NOT use .claude-commit-msg - use the session-specific file above!
**One story = one commit.** If given multiple stories, complete and commit each separately.

---
⛔ STOP: Run setup commands, read houserules.md, then await instructions.`;
}
