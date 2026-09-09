/**
 * AgentCard Component
 * Displays information about an agent that has reported into Kanvas
 * Follows SeKondBrain design aesthetics
 */

import React from 'react';
import type { AgentInfo, AgentCapability } from '../../../shared/agent-protocol';

interface RegisteredAgent extends AgentInfo {
  isAlive: boolean;
  sessions: string[];
  lastHeartbeat?: string;
}

interface AgentCardProps {
  agent: RegisteredAgent;
  isSelected?: boolean;
  onClick?: () => void;
}

const AGENT_TYPE_COLORS: Record<string, string> = {
  claude: 'bg-[#CC785C]', // Claude's signature color
  cursor: 'bg-kanvas-blue',
  copilot: 'bg-gray-600',
  cline: 'bg-purple-500',
  aider: 'bg-green-500',
  warp: 'bg-pink-500',
  custom: 'bg-gray-400',
};

const AGENT_TYPE_ICONS: Record<string, string> = {
  claude: 'C',
  cursor: 'Cu',
  copilot: 'Co',
  cline: 'Cl',
  aider: 'Ai',
  warp: 'W',
  custom: '?',
};

const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  'file-watching': 'Watch',
  'auto-commit': 'Commit',
  'code-generation': 'Gen',
  'code-review': 'Review',
  'chat': 'Chat',
  'test-execution': 'Test',
  'deployment': 'Deploy',
};

export function AgentCard({ agent, isSelected = false, onClick }: AgentCardProps): React.ReactElement {
  const typeColor = AGENT_TYPE_COLORS[agent.agentType] || AGENT_TYPE_COLORS.custom;
  const typeIcon = AGENT_TYPE_ICONS[agent.agentType] || AGENT_TYPE_ICONS.custom;

  const timeAgo = agent.lastHeartbeat
    ? getTimeAgo(new Date(agent.lastHeartbeat))
    : 'unknown';

  return (
    <div
      onClick={onClick}
      className={`
        relative p-4 rounded-[14px] border transition-all cursor-pointer
        ${isSelected
          ? 'border-kanvas-blue bg-surface-secondary shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          : 'border-[rgba(0,0,0,0.10)] bg-surface hover:border-kanvas-blue/50 hover:shadow-card-hover'
        }
      `}
    >
      {/* Status indicator */}
      <div className={`
        absolute top-3 right-3 w-2.5 h-2.5 rounded-full
        ${agent.isAlive ? 'bg-green-500 animate-pulse-slow' : 'bg-gray-400'}
      `} />

      {/* Agent header */}
      <div className="flex items-start gap-3 mb-3">
        {/* Agent type badge */}
        <div className={`
          w-10 h-10 rounded-lg ${typeColor}
          flex items-center justify-center
          text-white font-bold text-sm
        `}>
          {typeIcon}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-text-primary truncate">
            {agent.agentName}
          </h3>
          <p className="text-sm text-text-secondary">
            {agent.agentType.charAt(0).toUpperCase() + agent.agentType.slice(1)} Agent
          </p>
        </div>
      </div>

      {/* Session count */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm text-text-secondary">Sessions:</span>
        <span className={`
          text-sm font-medium px-2 py-0.5 rounded-full
          ${agent.sessions.length > 0
            ? 'bg-kanvas-blue/10 text-kanvas-blue'
            : 'bg-gray-100 text-text-secondary'
          }
        `}>
          {agent.sessions.length}
        </span>
      </div>

      {/* Capabilities */}
      <div className="flex flex-wrap gap-1 mb-3">
        {agent.capabilities.slice(0, 4).map((cap) => (
          <span
            key={cap}
            className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary text-text-secondary"
          >
            {CAPABILITY_LABELS[cap]}
          </span>
        ))}
        {agent.capabilities.length > 4 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary text-text-secondary">
            +{agent.capabilities.length - 4}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>v{agent.version}</span>
        <span className={agent.isAlive ? 'text-green-600' : 'text-gray-400'}>
          {agent.isAlive ? `Active ${timeAgo}` : `Last seen ${timeAgo}`}
        </span>
      </div>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * AgentCardSkeleton - Loading state
 */
export function AgentCardSkeleton(): React.ReactElement {
  return (
    <div className="p-4 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface animate-pulse">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg bg-surface-tertiary" />
        <div className="flex-1">
          <div className="h-5 bg-surface-tertiary rounded w-3/4 mb-2" />
          <div className="h-4 bg-surface-tertiary rounded w-1/2" />
        </div>
      </div>
      <div className="flex gap-2 mb-3">
        <div className="h-4 bg-surface-tertiary rounded w-16" />
        <div className="h-4 bg-surface-tertiary rounded w-8" />
      </div>
      <div className="flex gap-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-5 bg-surface-tertiary rounded w-12" />
        ))}
      </div>
    </div>
  );
}
