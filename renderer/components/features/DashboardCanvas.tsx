/**
 * DashboardCanvas Component
 * Main content area showing agent activity and sessions
 * Kanvas is a DASHBOARD - this displays what agents report
 */

import React from 'react';
import { ActivityLog } from './ActivityLog';
import { KanvasLogo } from '../ui/KanvasLogo';
import { useAgentStore, selectSessionsByAgent } from '../../store/agentStore';
import { useUIStore } from '../../store/uiStore';
import type { AgentInfo, SessionReport } from '../../../shared/agent-protocol';

interface RegisteredAgent extends AgentInfo {
  isAlive: boolean;
  sessions: string[];
  lastHeartbeat?: string;
}

interface DashboardCanvasProps {
  agent: RegisteredAgent | null | undefined;
}

export function DashboardCanvas({ agent }: DashboardCanvasProps): React.ReactElement {
  const reportedSessions = useAgentStore((state) => state.reportedSessions);
  const recentActivity = useAgentStore((state) => state.recentActivity);

  // Get sessions for this agent or all sessions
  const allSessions = Array.from(reportedSessions.values());
  const sessions = agent
    ? allSessions.filter((session) => session.agentId === agent.agentId)
    : allSessions;

  if (!agent) {
    return <WelcomeScreen />;
  }

  return (
    <div className="h-full flex flex-col bg-surface-secondary">
      {/* Agent Header */}
      <AgentHeader agent={agent} sessionsCount={sessions.length} />

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Sessions Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {sessions.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {sessions.map((session) => (
                <SessionDetailCard key={session.sessionId} session={session} />
              ))}
            </div>
          ) : (
            <EmptySessionsState agentName={agent.agentName} />
          )}
        </div>

        {/* Activity Feed */}
        <div className="w-80 border-l border-border bg-surface overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-text-primary text-sm">Activity Feed</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ActivityLog
              entries={recentActivity.filter((a) => a.agentId === agent.agentId).slice(0, 50)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * AgentHeader - Shows agent info at top of canvas
 */
function AgentHeader({ agent, sessionsCount }: { agent: RegisteredAgent; sessionsCount: number }): React.ReactElement {
  return (
    <div className="p-6 bg-surface border-b border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Status indicator */}
          <div className={`
            w-3 h-3 rounded-full
            ${agent.isAlive ? 'bg-green-500 animate-pulse-slow' : 'bg-gray-400'}
          `} />

          <div>
            <h2 className="text-xl font-semibold text-text-primary">
              {agent.agentName}
            </h2>
            <p className="text-sm text-text-secondary">
              {agent.agentType.charAt(0).toUpperCase() + agent.agentType.slice(1)} Agent
              {' '}
              <span className="text-text-secondary/60">v{agent.version}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Stats */}
          <div className="text-right">
            <p className="text-2xl font-bold text-kanvas-blue">{sessionsCount}</p>
            <p className="text-xs text-text-secondary">Active Sessions</p>
          </div>

          <div className="text-right">
            <p className="text-2xl font-bold text-text-primary">{agent.capabilities.length}</p>
            <p className="text-xs text-text-secondary">Capabilities</p>
          </div>

          {/* Status badge */}
          <span className={`
            px-3 py-1.5 rounded-full text-sm font-medium
            ${agent.isAlive
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-600'
            }
          `}>
            {agent.isAlive ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Capabilities */}
      <div className="flex flex-wrap gap-2 mt-4">
        {agent.capabilities.map((cap) => (
          <span
            key={cap}
            className="px-3 py-1 rounded-full bg-surface-tertiary text-text-secondary text-xs"
          >
            {formatCapability(cap)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * SessionDetailCard - Detailed session display
 */
function SessionDetailCard({ session }: { session: SessionReport }): React.ReactElement {
  const statusConfig: Record<string, { color: string; label: string }> = {
    idle: { color: 'bg-gray-100 text-gray-600', label: 'Idle' },
    active: { color: 'bg-green-100 text-green-700', label: 'Active' },
    watching: { color: 'bg-blue-100 text-blue-700', label: 'Watching' },
    paused: { color: 'bg-yellow-100 text-yellow-700', label: 'Paused' },
    error: { color: 'bg-red-100 text-red-700', label: 'Error' },
    closed: { color: 'bg-gray-100 text-gray-500', label: 'Closed' },
  };

  const status = statusConfig[session.status] || statusConfig.idle;

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface hover:shadow-card-hover transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-text-primary truncate">
            {session.task}
          </h4>
          <p className="text-sm text-text-secondary mt-0.5">
            {session.branchName}
          </p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${status.color}`}>
          {status.label}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <p className="text-lg font-semibold text-text-primary">{session.commitCount}</p>
          <p className="text-xs text-text-secondary">Commits</p>
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary truncate">{session.agentType}</p>
          <p className="text-xs text-text-secondary">Agent</p>
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary truncate">
            {formatDate(session.updated)}
          </p>
          <p className="text-xs text-text-secondary">Updated</p>
        </div>
      </div>

      {/* Last commit */}
      {session.lastCommit && (
        <div className="p-3 rounded-xl bg-surface-secondary">
          <p className="text-xs text-text-secondary mb-1">Last Commit</p>
          <p className="text-sm text-text-primary font-mono truncate">
            {session.lastCommit}
          </p>
        </div>
      )}

      {/* Path */}
      <div className="mt-3 pt-3 border-t border-border">
        <p className="text-xs text-text-secondary truncate" title={session.worktreePath}>
          {session.worktreePath}
        </p>
      </div>
    </div>
  );
}

/**
 * WelcomeScreen - Shown when no agent is selected
 */
function WelcomeScreen(): React.ReactElement {
  const { setShowCreateAgentWizard, setShowNewSessionWizard } = useUIStore();

  const handleFeatureClick = (feature: string) => {
    switch (feature) {
      case 'monitor':
      case 'activity':
        // Open Create Agent Wizard to add a new agent
        setShowCreateAgentWizard(true);
        break;
      case 'branch':
        // Open New Session Wizard
        setShowNewSessionWizard(true);
        break;
      case 'shield':
        // For now, also open Create Agent Wizard
        setShowCreateAgentWizard(true);
        break;
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-surface-secondary">
      <div className="text-center max-w-lg px-6">
        {/* Kanvas Logo */}
        <div className="mx-auto mb-6 shadow-kanvas-lg rounded-2xl overflow-hidden">
          <KanvasLogo size="xl" />
        </div>

        <h1 className="text-2xl font-bold text-text-primary mb-2">
          Welcome to Kanvas for Kit
        </h1>
        <p className="text-text-secondary mb-8">
          Your multi-agent development dashboard. Start a DevOps Agent session or connect another AI agent to see their activity here.
        </p>

        <div className="grid grid-cols-2 gap-4 text-left">
          <FeatureCard
            icon="monitor"
            title="Monitor Agents"
            description="Track all your AI agents in one place"
            onClick={() => handleFeatureClick('monitor')}
          />
          <FeatureCard
            icon="activity"
            title="Live Activity"
            description="See commits, changes, and updates in real-time"
            onClick={() => handleFeatureClick('activity')}
          />
          <FeatureCard
            icon="branch"
            title="Session Management"
            description="View and manage all development sessions"
            onClick={() => handleFeatureClick('branch')}
          />
          <FeatureCard
            icon="shield"
            title="File Coordination"
            description="Prevent conflicts between multiple agents"
            onClick={() => handleFeatureClick('shield')}
          />
        </div>

        {/* Primary CTA */}
        <button
          onClick={() => setShowCreateAgentWizard(true)}
          className="mt-8 btn-primary px-8 py-3 text-base"
        >
          Create Agent Instance
        </button>
      </div>
    </div>
  );
}

/**
 * EmptySessionsState - Shown when agent has no sessions
 */
function EmptySessionsState({ agentName }: { agentName: string }): React.ReactElement {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
          <svg
            className="w-8 h-8 text-text-secondary"
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
        <h3 className="text-lg font-medium text-text-primary mb-2">
          No Active Sessions
        </h3>
        <p className="text-sm text-text-secondary">
          {agentName} hasn't reported any sessions yet.
        </p>
      </div>
    </div>
  );
}

/**
 * FeatureCard - Feature highlight in welcome screen (clickable)
 */
function FeatureCard({
  icon,
  title,
  description,
  onClick
}: {
  icon: string;
  title: string;
  description: string;
  onClick?: () => void;
}): React.ReactElement {
  const icons: Record<string, React.ReactElement> = {
    monitor: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    activity: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    branch: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    ),
    shield: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  };

  return (
    <button
      onClick={onClick}
      className="p-4 rounded-xl bg-surface border border-border text-left
                 hover:border-kanvas-blue/30 hover:shadow-card-hover hover:bg-surface-secondary
                 transition-all duration-200 cursor-pointer group"
    >
      <div className="w-10 h-10 rounded-lg bg-kanvas-blue/10 text-kanvas-blue flex items-center justify-center mb-3
                      group-hover:bg-kanvas-blue group-hover:text-white transition-colors">
        {icons[icon]}
      </div>
      <h4 className="font-medium text-text-primary text-sm mb-1">{title}</h4>
      <p className="text-xs text-text-secondary">{description}</p>
    </button>
  );
}

// Utility functions
function formatCapability(cap: string): string {
  return cap
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}
