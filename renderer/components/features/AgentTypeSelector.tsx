/**
 * AgentTypeSelector Component
 * Visual agent type picker with icons and descriptions
 */

import React from 'react';
import type { AgentType } from '../../../shared/types';

interface AgentTypeInfo {
  type: AgentType;
  name: string;
  description: string;
  launchMethod: string;
  color: string;
  icon: React.ReactElement;
  recommended?: boolean;
}

const AGENT_TYPES: AgentTypeInfo[] = [
  {
    type: 'claude',
    name: 'Claude Code',
    description: 'Full AI coding assistant with terminal access',
    launchMethod: 'CLI',
    color: 'bg-[#CC785C]',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <text x="7" y="18" fontSize="16" fontWeight="bold">C</text>
      </svg>
    ),
    recommended: true,
  },
  {
    type: 'cursor',
    name: 'Cursor',
    description: 'AI-powered code editing and completion',
    launchMethod: 'IDE',
    color: 'bg-kanvas-blue',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    type: 'copilot',
    name: 'GitHub Copilot',
    description: 'AI pair programmer in VS Code',
    launchMethod: 'VS Code',
    color: 'bg-gray-700',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h2v-2h-2v2zm0-4h2V7h-2v6z" />
      </svg>
    ),
  },
  {
    type: 'cline',
    name: 'Cline',
    description: 'Autonomous coding agent for VS Code',
    launchMethod: 'VS Code',
    color: 'bg-purple-500',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    type: 'aider',
    name: 'Aider',
    description: 'Git-aware AI pair programming in terminal',
    launchMethod: 'CLI',
    color: 'bg-green-500',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 9h8M8 13h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  {
    type: 'warp',
    name: 'Warp',
    description: 'AI-powered terminal with natural language',
    launchMethod: 'Terminal',
    color: 'bg-pink-500',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 17l6-6-6-6M12 19h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    type: 'codex',
    name: 'Codex',
    description: 'OpenAI autonomous coding agent with MCP',
    launchMethod: 'CLI',
    color: 'bg-emerald-600',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    type: 'custom',
    name: 'Custom Agent',
    description: 'Any tool with Kanvas integration',
    launchMethod: 'Manual',
    color: 'bg-gray-400',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

interface AgentTypeSelectorProps {
  selectedType: AgentType | null;
  onSelect: (type: AgentType) => void;
  customMcpEnabled?: boolean;
  onCustomMcpChange?: (enabled: boolean) => void;
}

export function AgentTypeSelector({ selectedType, onSelect, customMcpEnabled, onCustomMcpChange }: AgentTypeSelectorProps): React.ReactElement {
  return (
    <div className="space-y-4">
      <label className="label">Select Agent Type</label>

      {/* Agent type grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {AGENT_TYPES.map((agent) => (
          <button
            key={agent.type}
            type="button"
            onClick={() => onSelect(agent.type)}
            className={`
              relative p-4 rounded-xl border-2 text-left transition-all
              ${selectedType === agent.type
                ? 'border-kanvas-blue bg-kanvas-blue/5 shadow-kanvas'
                : 'border-border bg-surface hover:border-kanvas-blue/50 hover:shadow-card'
              }
            `}
          >
            {/* Recommended badge */}
            {agent.recommended && (
              <span className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-accent-gold text-xs font-medium text-white">
                Recommended
              </span>
            )}

            {/* Icon */}
            <div className={`w-12 h-12 rounded-xl ${agent.color} text-white flex items-center justify-center mb-3`}>
              {agent.icon}
            </div>

            {/* Name */}
            <h3 className="font-semibold text-text-primary">{agent.name}</h3>

            {/* Launch method badge */}
            <span className="text-xs text-text-secondary">{agent.launchMethod}</span>

            {/* Selected indicator */}
            {selectedType === agent.type && (
              <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-kanvas-blue flex items-center justify-center">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Selected agent description */}
      {selectedType && (
        <div className="p-4 rounded-xl bg-surface-secondary border border-border">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-lg ${AGENT_TYPES.find(a => a.type === selectedType)?.color} text-white flex items-center justify-center flex-shrink-0`}>
              {AGENT_TYPES.find(a => a.type === selectedType)?.icon}
            </div>
            <div>
              <h4 className="font-medium text-text-primary">
                {AGENT_TYPES.find(a => a.type === selectedType)?.name}
              </h4>
              <p className="text-sm text-text-secondary mt-1">
                {AGENT_TYPES.find(a => a.type === selectedType)?.description}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* MCP toggle — only shown for custom agents */}
      {selectedType === 'custom' && onCustomMcpChange && (
        <div className="p-4 rounded-xl bg-surface-secondary border border-border">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="font-medium text-text-primary text-sm">Does this agent support MCP?</h4>
              <p className="text-xs text-text-secondary mt-0.5">
                Enables MCP server URL in the generated instructions for full KIT dashboard integration.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onCustomMcpChange(!customMcpEnabled)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                customMcpEnabled ? 'bg-kanvas-blue' : 'bg-gray-600'
              }`}
              role="switch"
              aria-checked={customMcpEnabled}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                  customMcpEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          {customMcpEnabled && (
            <p className="mt-2 text-xs text-kanvas-blue">
              ✓ MCP server URL will be included in the setup instructions.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
