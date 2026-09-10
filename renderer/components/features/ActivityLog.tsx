/**
 * ActivityLog Component
 * Color-coded activity log entries reported by agents
 * Kanvas is a DASHBOARD - it displays activity reported by agents
 */

import React from 'react';
import type { LogType } from '../../../shared/types';
import type { AgentActivityReport } from '../../../shared/agent-protocol';
import { formatDateTime } from '../../../shared/format-datetime';

interface ActivityLogProps {
  entries: AgentActivityReport[];
}

const logTypeStyles: Record<LogType, { icon: string; color: string; bg: string }> = {
  success: { icon: 'check-circle', color: 'text-green-600', bg: 'bg-green-50' },
  error: { icon: 'x-circle', color: 'text-red-600', bg: 'bg-red-50' },
  warning: { icon: 'alert-triangle', color: 'text-yellow-600', bg: 'bg-yellow-50' },
  info: { icon: 'info', color: 'text-kanvas-blue', bg: 'bg-kanvas-blue/5' },
  commit: { icon: 'git-commit', color: 'text-purple-600', bg: 'bg-purple-50' },
  file: { icon: 'file', color: 'text-text-secondary', bg: 'bg-surface-tertiary' },
  git: { icon: 'git-branch', color: 'text-orange-600', bg: 'bg-orange-50' },
};

function LogIcon({ type }: { type: LogType }): React.ReactElement {
  const style = logTypeStyles[type] || logTypeStyles.info;

  const icons: Record<string, React.ReactElement> = {
    'check-circle': (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    'x-circle': (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    'alert-triangle': (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    info: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
    'git-commit': (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <line x1="1.05" y1="12" x2="7" y2="12" />
        <line x1="17.01" y1="12" x2="22.96" y2="12" />
      </svg>
    ),
    file: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
    'git-branch': (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    ),
  };

  return <span className={style.color}>{icons[style.icon]}</span>;
}

export function ActivityLog({ entries }: ActivityLogProps): React.ReactElement {
  const formatTime = (timestamp: string): string => formatDateTime(timestamp);

  if (entries.length === 0) {
    return (
      <div className="p-6 text-center">
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
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        </div>
        <p className="text-sm text-text-secondary">No activity yet</p>
        <p className="text-xs text-text-secondary/60 mt-1">
          Activity will appear here as agents report
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {entries.map((entry, index) => {
        const style = logTypeStyles[entry.type] || logTypeStyles.info;

        return (
          <div
            key={`${entry.timestamp}-${index}`}
            className="px-4 py-3 hover:bg-surface-secondary transition-colors"
          >
            <div className="flex items-start gap-3">
              {/* Icon with background */}
              <div className={`flex-shrink-0 w-6 h-6 rounded-full ${style.bg} flex items-center justify-center mt-0.5`}>
                <LogIcon type={entry.type} />
              </div>

              <div className="flex-1 min-w-0">
                {/* Message */}
                <p className="text-sm text-text-primary break-words">
                  {entry.message}
                </p>

                {/* Meta */}
                <div className="flex items-center gap-2 mt-1.5 text-xs text-text-secondary">
                  <span>{formatTime(entry.timestamp)}</span>
                  {entry.sessionId && (
                    <>
                      <span className="text-border">•</span>
                      <span className="truncate max-w-[100px]" title={entry.sessionId}>
                        {entry.sessionId.slice(0, 8)}
                      </span>
                    </>
                  )}
                </div>

                {/* Details if present */}
                {entry.details && Object.keys(entry.details).length > 0 && (
                  <div className="mt-2 p-2 rounded-lg bg-surface-tertiary">
                    <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * ActivityLogCompact - Smaller version for tight spaces
 */
export function ActivityLogCompact({ entries }: ActivityLogProps): React.ReactElement {
  const formatTime = (timestamp: string): string => formatDateTime(timestamp);

  if (entries.length === 0) {
    return (
      <div className="p-4 text-center text-text-secondary text-sm">
        No activity
      </div>
    );
  }

  return (
    <div className="font-mono text-xs">
      {entries.slice(0, 20).map((entry, index) => {
        const style = logTypeStyles[entry.type] || logTypeStyles.info;

        return (
          <div
            key={`${entry.timestamp}-${index}`}
            className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-secondary"
          >
            <span className={`flex-shrink-0 mt-0.5 ${style.color}`}>
              <LogIcon type={entry.type} />
            </span>
            <span className="text-text-secondary flex-shrink-0">
              {formatTime(entry.timestamp)}
            </span>
            <span className="text-text-primary truncate">{entry.message}</span>
          </div>
        );
      })}
    </div>
  );
}
