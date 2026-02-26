/**
 * Sidebar Component
 * Two-column layout: narrow icon rail + main sidebar content.
 * Top tabs switch between "Artefacts" and "Agents" views.
 * Kanvas is a DASHBOARD - agents report INTO it.
 */

import React, { useState, useEffect } from 'react';
import { AgentList } from '../features/AgentList';
import { KanvasLogo } from '../ui/KanvasLogo';
import { FileCoordinationButton } from '../features/FileCoordinationPanel';
import { MergeWorkflowModal } from '../features/MergeWorkflowModal';
import { useAgentStore } from '../../store/agentStore';
import { useUIStore } from '../../store/uiStore';
import type { SidebarTab } from '../../store/uiStore';
import type { SessionReport } from '../../../shared/agent-protocol';

export function Sidebar(): React.ReactElement {
  const { sidebarTab, setSidebarTab, setShowNewSessionWizard, setShowSettingsModal, setShowCreateAgentWizard, setMainView } = useUIStore();
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const reportedSessions = useAgentStore((state) => state.reportedSessions);
  const selectedSessionId = useAgentStore((state) => state.selectedSessionId);
  const setSelectedSession = useAgentStore((state) => state.setSelectedSession);
  const removeReportedSession = useAgentStore((state) => state.removeReportedSession);

  const allSessions = Array.from(reportedSessions.values());
  const sessions = selectedAgentId
    ? allSessions.filter((session) => session.agentId === selectedAgentId)
    : allSessions;

  const handleDeleteSession = async (sessionId: string): Promise<void> => {
    try {
      const session = reportedSessions.get(sessionId);
      const repoPath = session?.repoPath;
      const result = await window.api.instance?.deleteSession?.(sessionId, repoPath);
      if (result?.success) {
        removeReportedSession(sessionId);
        if (selectedSessionId === sessionId) {
          setSelectedSession(null);
        }
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleTabChange = (tab: SidebarTab) => {
    setSidebarTab(tab);
    if (tab === 'artefacts') {
      setMainView('artefacts');
    } else {
      setMainView('dashboard');
    }
  };

  return (
    <div className="h-full flex bg-surface">
      {/* Icon Rail */}
      <IconRail />

      {/* Main Sidebar Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header: Logo wordmark + Tabs */}
        <div className="border-b border-border">
          <div className="flex items-center gap-1 px-3 pt-3 pb-0">
            <button
              onClick={() => handleTabChange('artefacts')}
              className={`
                px-3 py-2.5 text-sm font-medium transition-colors rounded-t-lg
                ${sidebarTab === 'artefacts'
                  ? 'text-text-primary border-b-2 border-kanvas-blue'
                  : 'text-text-secondary hover:text-text-primary'
                }
              `}
            >
              Artefacts
            </button>
            <button
              onClick={() => handleTabChange('agents')}
              className={`
                px-3 py-2.5 text-sm font-medium transition-colors rounded-t-lg
                ${sidebarTab === 'agents'
                  ? 'text-text-primary border-b-2 border-kanvas-blue'
                  : 'text-text-secondary hover:text-text-primary'
                }
              `}
            >
              Agents
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {sidebarTab === 'agents' ? (
            <AgentList />
          ) : (
            <ArtefactsPlaceholder />
          )}
        </div>

        {/* Agent Actions */}
        <div className="p-3 border-t border-border space-y-2">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wider px-1">
            Agent Actions
          </p>
          <button
            onClick={() => setShowCreateAgentWizard(true)}
            className="w-full py-2.5 px-4 rounded-xl bg-kanvas-blue text-white font-medium text-sm
                       hover:bg-kanvas-blue-dark transition-colors shadow-kanvas flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Instance
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => setShowNewSessionWizard(true)}
              className="flex-1 py-2 px-3 rounded-xl border border-border text-text-primary text-sm
                         hover:bg-surface-secondary transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Init. Directory
            </button>
            <FileCoordinationButton currentSessionId={selectedSessionId || undefined} />
          </div>
          <button
            onClick={() => setMainView('commits')}
            className="w-full py-2 px-4 rounded-xl border border-border text-text-primary text-sm
                       hover:bg-surface-secondary transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            View Commits
          </button>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="w-full py-2 px-4 rounded-xl border border-border text-text-primary text-sm
                       hover:bg-surface-secondary transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * IconRail - Narrow vertical icon strip on far left of sidebar.
 * Contains logo, quick-add, navigation icons, and user avatar.
 */
function IconRail(): React.ReactElement {
  const { setShowCreateAgentWizard, setSidebarTab, setMainView } = useUIStore();

  return (
    <div className="w-12 flex flex-col items-center py-3 border-r border-border bg-surface gap-1">
      {/* Logo */}
      <div className="mb-2">
        <KanvasLogo size="md" />
      </div>

      {/* Add new */}
      <button
        onClick={() => setShowCreateAgentWizard(true)}
        className="w-9 h-9 rounded-xl bg-kanvas-blue/10 text-kanvas-blue
                   flex items-center justify-center hover:bg-kanvas-blue/20 transition-colors"
        title="Create Instance"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {/* Navigation icons */}
      <div className="mt-3 flex flex-col gap-1">
        <IconRailButton
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
          title="Sessions"
          onClick={() => { setSidebarTab('agents'); setMainView('dashboard'); }}
        />
        <IconRailButton
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          }
          title="Agents"
          onClick={() => { setSidebarTab('agents'); setMainView('dashboard'); }}
        />
        <IconRailButton
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          }
          title="Connections"
        />
        <IconRailButton
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          }
          title="Organization"
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User avatar */}
      <div
        className="w-9 h-9 rounded-full bg-gradient-to-br from-kanvas-blue to-sk-purple
                   flex items-center justify-center text-white text-xs font-bold cursor-pointer
                   hover:opacity-80 transition-opacity"
        title="Profile"
      >
        U
      </div>
    </div>
  );
}

function IconRailButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className="w-9 h-9 rounded-xl text-text-secondary
                 flex items-center justify-center hover:bg-surface-secondary
                 hover:text-text-primary transition-colors"
      title={title}
    >
      {icon}
    </button>
  );
}

/**
 * ArtefactsPlaceholder - shown in sidebar when Artefacts tab is active.
 * The main artefact content is rendered in the main content area.
 */
function ArtefactsPlaceholder(): React.ReactElement {
  return (
    <div className="text-center py-8">
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-surface-tertiary flex items-center justify-center">
        <svg className="w-6 h-6 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      </div>
      <p className="text-sm font-medium text-text-primary">Artefacts</p>
      <p className="text-xs text-text-secondary mt-1">Project artefacts and documentation</p>
    </div>
  );
}

/**
 * SessionList - Displays sessions grouped by repository
 */
interface SessionListProps {
  sessions: SessionReport[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  onDeleteSession: (sessionId: string) => void;
}

function SessionList({ sessions, selectedSessionId, onSelectSession, onDeleteSession }: SessionListProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-surface-tertiary flex items-center justify-center">
          <svg
            className="w-6 h-6 text-text-secondary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </div>
        <p className="text-sm text-text-secondary">No sessions yet</p>
        <p className="text-xs text-text-secondary mt-1">Create an agent instance to get started</p>
      </div>
    );
  }

  const sessionsByRepo = sessions.reduce((acc, session) => {
    const repoPath = session.repoPath || session.worktreePath || 'Unknown';
    const repoName = repoPath.split('/').pop() || repoPath;
    if (!acc[repoName]) {
      acc[repoName] = { repoPath, sessions: [] };
    }
    acc[repoName].sessions.push(session);
    return acc;
  }, {} as Record<string, { repoPath: string; sessions: SessionReport[] }>);

  const repoNames = Object.keys(sessionsByRepo).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">
          Sessions by Repository
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary text-text-secondary">
          {sessions.length} total
        </span>
      </div>

      {repoNames.map((repoName) => {
        const { repoPath, sessions: repoSessions } = sessionsByRepo[repoName];
        return (
          <RepoSessionGroup
            key={repoPath}
            repoName={repoName}
            repoPath={repoPath}
            sessions={repoSessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
          />
        );
      })}
    </div>
  );
}

/**
 * RepoSessionGroup - Collapsible group of sessions for a repository
 */
function RepoSessionGroup({
  repoName,
  repoPath,
  sessions,
  selectedSessionId,
  onSelectSession,
  onDeleteSession,
}: {
  repoName: string;
  repoPath: string;
  sessions: SessionReport[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  onDeleteSession: (sessionId: string) => void;
}): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2.5 flex items-center gap-2 hover:bg-surface-secondary transition-colors"
      >
        <svg
          className={`w-4 h-4 text-text-secondary transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <svg className="w-4 h-4 text-kanvas-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
        <span className="flex-1 text-left text-sm font-medium text-text-primary truncate">
          {repoName}
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary text-text-secondary">
          {sessions.length}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border divide-y divide-border">
          {sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              isSelected={selectedSessionId === session.sessionId}
              onClick={() => onSelectSession(
                selectedSessionId === session.sessionId ? null : session.sessionId
              )}
              onDelete={() => onDeleteSession(session.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * SessionCard - Individual session display within repo group
 * Status indicator colors:
 * - Green (pulsing): Active - changes in last 30 seconds
 * - Orange: Dormant - no recent activity
 * - Red: Error/damaged config
 */
function SessionCard({
  session,
  isSelected,
  onClick,
  onDelete,
}: {
  session: SessionReport;
  isSelected: boolean;
  onClick: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [, forceUpdate] = useState(0);
  const [configValid, setConfigValid] = useState<boolean | null>(null);
  const recentActivity = useAgentStore((state) => state.recentActivity);

  useEffect(() => {
    const checkConfig = async () => {
      const pathToCheck = session.worktreePath || session.repoPath;
      if (!pathToCheck) {
        setConfigValid(false);
        return;
      }
      if (window.api?.git?.status) {
        try {
          const result = await window.api.git.status(session.sessionId);
          setConfigValid(result.success);
        } catch {
          setConfigValid(false);
        }
      } else {
        setConfigValid(true);
      }
    };
    checkConfig();
  }, [session.sessionId, session.worktreePath, session.repoPath]);

  useEffect(() => {
    const interval = setInterval(() => forceUpdate(n => n + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  const getActivityStatus = (): { color: string; label: string; title: string } => {
    if (session.status === 'error' || configValid === false) {
      return { color: 'bg-red-500', label: 'Error', title: 'Session config issue - worktree or branch may be missing' };
    }

    const sessionActivity = recentActivity.filter(a => a.sessionId === session.sessionId);
    const lastActivity = sessionActivity[0];

    if (lastActivity) {
      const lastActivityTime = new Date(lastActivity.timestamp).getTime();
      const now = Date.now();
      const secondsSinceActivity = (now - lastActivityTime) / 1000;

      if (secondsSinceActivity < 30) {
        return {
          color: 'bg-green-500 animate-pulse',
          label: 'Active',
          title: `Active - last activity ${Math.round(secondsSinceActivity)}s ago`
        };
      }
    }

    if (session.updated) {
      const updatedTime = new Date(session.updated).getTime();
      const secondsSinceUpdate = (Date.now() - updatedTime) / 1000;
      if (secondsSinceUpdate < 30) {
        return {
          color: 'bg-green-500 animate-pulse',
          label: 'Active',
          title: 'Active - recently updated'
        };
      }
    }

    return { color: 'bg-orange-400', label: 'Dormant', title: 'Dormant - no recent activity' };
  };

  const status = getActivityStatus();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (showConfirm) {
      onDelete();
      setShowConfirm(false);
    } else {
      setShowConfirm(true);
      setTimeout(() => setShowConfirm(false), 3000);
    }
  };

  return (
    <div
      onClick={onClick}
      className={`
        px-3 py-2.5 transition-colors cursor-pointer group
        ${isSelected
          ? 'bg-kanvas-blue/10 border-l-2 border-kanvas-blue'
          : 'hover:bg-surface-secondary border-l-2 border-transparent'
        }
      `}
    >
      <div className="flex items-start gap-2">
        <span
          className={`w-2 h-2 mt-1.5 rounded-full flex-shrink-0 ${status.color}`}
          title={status.title}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={`text-sm truncate flex-1 ${isSelected ? 'text-kanvas-blue font-medium' : 'text-text-primary'}`}>
              {session.task || 'Untitled session'}
            </p>
            <span className="text-xs text-text-secondary flex-shrink-0">
              {session.agentType}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-kanvas-blue font-mono truncate">
              {session.branchName}
            </span>
            {session.commitCount > 0 && (
              <span className="text-xs text-text-secondary">
                {session.commitCount} commits
              </span>
            )}
          </div>
        </div>
        <div className={`flex items-center gap-1 flex-shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMergeModal(true);
            }}
            className="p-1 rounded text-text-secondary hover:text-kanvas-blue hover:bg-kanvas-blue/10 transition-colors"
            title={`Merge to ${session.baseBranch || 'main'}`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            className={`
              p-1 rounded transition-all
              ${showConfirm
                ? 'bg-red-500 text-white'
                : 'text-text-secondary hover:text-red-500 hover:bg-red-500/10'
              }
            `}
            title={showConfirm ? 'Click again to confirm' : 'Delete session'}
          >
            {showConfirm ? (
              <span className="text-xs px-1">Delete?</span>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <MergeWorkflowModal
        isOpen={showMergeModal}
        onClose={() => setShowMergeModal(false)}
        repoPath={session.repoPath || session.worktreePath || ''}
        sourceBranch={session.branchName}
        targetBranch={session.baseBranch || 'main'}
        worktreePath={session.worktreePath}
        sessionId={session.sessionId}
        onMergeComplete={() => {
          setShowMergeModal(false);
        }}
        onDeleteSession={() => {
          onDelete();
        }}
      />
    </div>
  );
}
