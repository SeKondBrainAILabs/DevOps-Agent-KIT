/**
 * AgentList Component
 * Displays all agents reporting into Kanvas
 * Kanvas is a DASHBOARD - agents report INTO it
 *
 * Collapsible tree: Repo → Agent Type → Session
 * Compact rows with columnar session info
 */

import React, { useMemo, useState } from 'react';
import { AgentCardSkeleton } from './AgentCard';
import { MergeWorkflowModal } from './MergeWorkflowModal';
import { useAgentStore } from '../../store/agentStore';
import type { SessionReport } from '../../../shared/agent-protocol';
import type { AgentType } from '../../../shared/types';

const AGENT_TYPE_COLORS: Record<string, string> = {
  claude: 'bg-[#CC785C]',
  cursor: 'bg-kanvas-blue',
  copilot: 'bg-gray-600',
  cline: 'bg-purple-500',
  aider: 'bg-green-500',
  warp: 'bg-pink-500',
  custom: 'bg-gray-400',
};

const AGENT_TYPE_ICONS: Record<string, React.ReactElement> = {
  claude: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.709 15.955l4.397-10.985c.2-.5.349-.852.746-.852.396 0 .546.352.746.852l4.397 10.985c.13.325.2.558.2.703 0 .396-.332.614-.83.614-.382 0-.614-.145-.745-.527l-1.107-2.834H6.39l-1.107 2.834c-.13.382-.363.527-.745.527-.498 0-.83-.218-.83-.614 0-.145.07-.378.2-.703zm3.065-4.03h4.354L9.952 5.798l-2.178 6.128z" />
    </svg>
  ),
  cursor: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12h8M12 8v8" strokeLinecap="round" />
    </svg>
  ),
  copilot: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  ),
  cline: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  ),
  aider: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  ),
  warp: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  ),
  custom: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  ),
};

const AGENT_TYPE_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  cline: 'Cline',
  aider: 'Aider',
  warp: 'Warp AI',
  custom: 'Custom Agent',
};

/* ── Data structures ── */

interface AgentBucket {
  agentType: AgentType;
  sessions: SessionReport[];
  aliveCount: number;
}

interface RepoGroup {
  repoName: string;
  repoPath: string;
  agents: AgentBucket[];
  totalSessions: number;
}

/* ── Main component ── */

export function AgentList(): React.ReactElement {
  const isInitialized = useAgentStore((state) => state.isInitialized);
  const reportedSessions = useAgentStore((state) => state.reportedSessions);
  const selectedSessionId = useAgentStore((state) => state.selectedSessionId);
  const setSelectedSession = useAgentStore((state) => state.setSelectedSession);

  // Build tree: Repo → AgentType → Sessions
  const repoGroups = useMemo(() => {
    const repos = new Map<string, RepoGroup>();
    const sessions = Array.from(reportedSessions.values());

    for (const session of sessions) {
      const agentType = (session.agentType || 'custom') as AgentType;
      const repoPath = session.repoPath || session.worktreePath || 'Unknown';
      const repoName = repoPath.split('/').pop() || repoPath;
      const isActive = session.status === 'active';

      // Find or create repo
      let repo = repos.get(repoPath);
      if (!repo) {
        repo = { repoName, repoPath, agents: [], totalSessions: 0 };
        repos.set(repoPath, repo);
      }
      repo.totalSessions++;

      // Find or create agent bucket within repo
      let agent = repo.agents.find((a) => a.agentType === agentType);
      if (!agent) {
        agent = { agentType, sessions: [], aliveCount: 0 };
        repo.agents.push(agent);
      }
      agent.sessions.push(session);
      if (isActive) agent.aliveCount++;
    }

    // Sort: sessions newest-first, agents by count desc, repos by total desc
    for (const repo of repos.values()) {
      for (const agent of repo.agents) {
        agent.sessions.sort((a, b) => {
          const ta = a.updated || a.created || '';
          const tb = b.updated || b.created || '';
          return tb.localeCompare(ta);
        });
      }
      repo.agents.sort((a, b) => b.sessions.length - a.sessions.length);
    }

    return Array.from(repos.values()).sort(
      (a, b) => b.totalSessions - a.totalSessions
    );
  }, [reportedSessions]);

  if (!isInitialized) {
    return (
      <div className="space-y-3">
        <AgentCardSkeleton />
        <AgentCardSkeleton />
      </div>
    );
  }

  const totalSessions = repoGroups.reduce((sum, r) => sum + r.totalSessions, 0);

  if (reportedSessions.size === 0 || repoGroups.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-surface-tertiary flex items-center justify-center">
          <svg className="w-6 h-6 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-text-primary mb-1">No Agents Connected</h3>
        <p className="text-xs text-text-secondary">Start a session to see it here</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Repositories
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded-full bg-kanvas-blue/10 text-kanvas-blue">
          {totalSessions} sessions
        </span>
      </div>

      {/* Repo tree */}
      <div className="space-y-1">
        {repoGroups.map((repo) => (
          <RepoNode
            key={repo.repoPath}
            repo={repo}
            selectedSessionId={selectedSessionId}
            onSelectSession={(id) =>
              setSelectedSession(selectedSessionId === id ? null : id)
            }
          />
        ))}
      </div>
    </div>
  );
}

/* ── Repo Node (top level) ── */

function RepoNode({
  repo,
  selectedSessionId,
  onSelectSession,
}: {
  repo: RepoGroup;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg
                   hover:bg-surface-secondary transition-colors"
      >
        <Chevron open={expanded} />
        <svg className="w-4 h-4 text-kanvas-blue flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="text-[13px] font-medium text-text-primary truncate flex-1 text-left">
          {repo.repoName}
        </span>
        {repo.totalSessions > 1 && (
          <span className="text-[11px] text-text-secondary flex-shrink-0">
            {repo.totalSessions}
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-4 border-l border-border/50 pl-2 mt-0.5 space-y-0.5">
          {repo.agents.length === 1 ? (
            /* Single agent — skip the agent row, show sessions directly */
            <SessionList
              agent={repo.agents[0]}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
            />
          ) : (
            repo.agents.map((agent) => (
              <AgentNode
                key={agent.agentType}
                agent={agent}
                selectedSessionId={selectedSessionId}
                onSelectSession={onSelectSession}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Agent Node (middle level) ── */

function AgentNode({
  agent,
  selectedSessionId,
  onSelectSession,
}: {
  agent: AgentBucket;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const typeColor = AGENT_TYPE_COLORS[agent.agentType] || AGENT_TYPE_COLORS.custom;
  const typeIcon = AGENT_TYPE_ICONS[agent.agentType] || AGENT_TYPE_ICONS.custom;
  const typeName = AGENT_TYPE_NAMES[agent.agentType] || agent.agentType;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-1 py-1 rounded-md
                   hover:bg-surface-secondary transition-colors"
      >
        <Chevron open={expanded} size="sm" />
        <span className={`w-6 h-6 rounded-md ${typeColor} flex items-center justify-center
                          text-white flex-shrink-0`}>
          {typeIcon}
        </span>
        <span className="text-xs font-medium text-text-primary truncate flex-1 text-left">
          {typeName}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {agent.aliveCount > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          )}
          {agent.sessions.length > 1 && (
            <span className="text-[11px] text-text-secondary">{agent.sessions.length}</span>
          )}
        </span>
      </button>

      {expanded && (
        <SessionList
          agent={agent}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
        />
      )}
    </div>
  );
}

/* ── Session List (shared between single-agent shortcut and agent node) ── */

function SessionList({
  agent,
  selectedSessionId,
  onSelectSession,
}: {
  agent: AgentBucket;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}): React.ReactElement {
  return (
    <div className="ml-3 border-l border-border/40 pl-1.5 mt-0.5 space-y-px">
      {agent.sessions.map((session, idx) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          index={idx + 1}
          isSelected={selectedSessionId === session.sessionId}
          onClick={() => onSelectSession(session.sessionId)}
        />
      ))}
    </div>
  );
}

/* ── Session Row (leaf) ── */

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  idle: 'bg-yellow-500',
  error: 'bg-red-500',
  completed: 'bg-gray-400',
};

function SessionRow({
  session,
  index,
  isSelected,
  onClick,
}: {
  session: SessionReport;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const removeReportedSession = useAgentStore((state) => state.removeReportedSession);

  const statusColor = STATUS_COLORS[session.status] || 'bg-gray-400';
  const branch = session.branchName || '';
  // Extract trailing suffix like "-mr4c", "-l63a", "-UXUPG" from branch name
  const suffix = branch.match(/-([a-zA-Z0-9]{3,5})$/)?.[1] || branch.slice(-5);
  const timeAgo = session.updated ? getTimeAgo(new Date(session.updated)) : null;
  const lastRebaseInfo = useAgentStore((state) => state.lastRebaseTimes.get(session.sessionId));
  const syncedAgo = lastRebaseInfo ? getTimeAgo(new Date(lastRebaseInfo.timestamp)) : null;
  // Color: green < 2h, yellow < 24h, red >= 24h, gray = never
  const syncColor = !lastRebaseInfo
    ? 'text-text-secondary'
    : !lastRebaseInfo.success
      ? 'text-red-400'
      : (Date.now() - new Date(lastRebaseInfo.timestamp).getTime()) < 2 * 3600 * 1000
        ? 'text-green-500'
        : (Date.now() - new Date(lastRebaseInfo.timestamp).getTime()) < 24 * 3600 * 1000
          ? 'text-yellow-500'
          : 'text-orange-400';

  // New commits since last viewed
  const viewedCount = useAgentStore((state) => state.viewedCommitCounts.get(session.sessionId));
  const totalCommits = session.commitCount || 0;
  const newCommits = viewedCount !== undefined ? totalCommits - viewedCount : totalCommits;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (showConfirm) {
      const repoPath = session.repoPath || session.worktreePath || '';
      window.api?.instance?.deleteSession?.(session.sessionId, repoPath);
      removeReportedSession(session.sessionId);
      setShowConfirm(false);
    } else {
      setShowConfirm(true);
      setTimeout(() => setShowConfirm(false), 3000);
    }
  };

  return (
    <>
      <div
        onClick={onClick}
        title={`${branch}\n${session.task || ''}`}
        className={`
          w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors cursor-pointer group
          ${isSelected
            ? 'bg-kanvas-blue/10 text-kanvas-blue'
            : 'hover:bg-surface-secondary text-text-primary'
          }
        `}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColor}`} />
        <span className="text-xs truncate flex-1">{index}-{suffix}</span>
        {newCommits > 0 && (
          <span className="text-[10px] font-medium text-green-600 flex-shrink-0">
            +{newCommits}
          </span>
        )}
        {/* Last sync indicator — green/yellow/orange based on staleness */}
        <span
          className={`text-[10px] flex-shrink-0 group-hover:hidden ${syncColor}`}
          title={lastRebaseInfo
            ? `Last synced: ${new Date(lastRebaseInfo.timestamp).toLocaleString()} — ${lastRebaseInfo.message}`
            : 'Not yet synced this session'}
        >
          {syncedAgo ? `↕ ${syncedAgo}` : timeAgo || ''}
        </span>
        {/* Merge & Delete buttons — visible on hover */}
        <span className={`flex items-center gap-0.5 flex-shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMergeModal(true); }}
            className="p-0.5 rounded text-text-secondary hover:text-kanvas-blue hover:bg-kanvas-blue/10 transition-colors"
            title={`Merge to ${session.baseBranch || 'main'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            className={`p-0.5 rounded transition-all ${showConfirm ? 'bg-red-500 text-white' : 'text-text-secondary hover:text-red-500 hover:bg-red-500/10'}`}
            title={showConfirm ? 'Click again to confirm' : 'Delete session'}
          >
            {showConfirm ? (
              <span className="text-[9px] px-0.5 font-medium">Del?</span>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            )}
          </button>
        </span>
      </div>

      <MergeWorkflowModal
        isOpen={showMergeModal}
        onClose={() => setShowMergeModal(false)}
        repoPath={session.repoPath || session.worktreePath || ''}
        sourceBranch={session.branchName}
        targetBranch={session.baseBranch || 'main'}
        worktreePath={session.worktreePath}
        sessionId={session.sessionId}
        onMergeComplete={() => setShowMergeModal(false)}
        onDeleteSession={() => {
          removeReportedSession(session.sessionId);
        }}
      />
    </>
  );
}

/* ── Shared components ── */

function Chevron({ open, size = 'md' }: { open: boolean; size?: 'sm' | 'md' }): React.ReactElement {
  const px = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <svg
      className={`${px} text-text-secondary transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * AgentListCompact - Smaller version for tight spaces
 */
export function AgentListCompact(): React.ReactElement {
  const agentsMap = useAgentStore((state) => state.agents);
  const selectedAgentType = useAgentStore((state) => state.selectedAgentType);
  const setSelectedAgentType = useAgentStore((state) => state.setSelectedAgentType);

  const agents = useMemo(() => Array.from(agentsMap.values()), [agentsMap]);
  const aliveAgents = agents.filter((a) => a.isAlive);

  const typeGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const agent of aliveAgents) {
      groups.set(agent.agentType, (groups.get(agent.agentType) || 0) + 1);
    }
    return Array.from(groups.entries());
  }, [aliveAgents]);

  return (
    <div className="flex flex-wrap gap-2">
      {typeGroups.map(([agentType, count]) => (
        <button
          key={agentType}
          onClick={() => setSelectedAgentType(
            selectedAgentType === agentType ? null : agentType
          )}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-lg
            text-sm transition-colors
            ${selectedAgentType === agentType
              ? 'bg-kanvas-blue text-white'
              : 'bg-surface-tertiary text-text-primary hover:bg-surface-secondary'
            }
          `}
        >
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {AGENT_TYPE_NAMES[agentType] || agentType}
          <span className="text-xs opacity-70">({count})</span>
        </button>
      ))}
      {typeGroups.length === 0 && (
        <span className="text-sm text-text-secondary">No active agents</span>
      )}
    </div>
  );
}
