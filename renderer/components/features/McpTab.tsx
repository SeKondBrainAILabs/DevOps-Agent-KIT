/**
 * McpTab Component
 * Shows MCP tool call activity for a session with real-time updates
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { formatDateTime } from '../../../shared/format-datetime';

interface McpCallEntry {
  timestamp: string;
  toolName: string;
  sessionId: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

interface McpTabProps {
  sessionId: string;
}

const TOOL_COLORS: Record<string, string> = {
  kit_commit: 'text-green-400',
  kit_commit_all: 'text-green-400',
  kit_lock_file: 'text-yellow-400',
  kit_unlock_file: 'text-yellow-400',
  kit_get_session_info: 'text-blue-400',
  kit_log_activity: 'text-purple-400',
  kit_get_commit_history: 'text-blue-400',
  kit_request_review: 'text-cyan-400',
};

const POLL_INTERVAL_MS = 3000;

export function McpTab({ sessionId }: McpTabProps): React.ReactElement {
  const [calls, setCalls] = useState<McpCallEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Agent-session policy: the live count against the cap, plus the kill switch.
  // Lives here rather than only in Settings because this is where the user is
  // already watching MCP traffic — if agent sessions are what alarmed them,
  // the control belongs next to the evidence.
  const [policy, setPolicy] = useState<{
    active: number;
    limits: { enabled: boolean; maxConcurrentGlobal: number; maxConcurrentPerRepo: number };
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const knownTimestampsRef = useRef<Set<string>>(new Set());

  const fetchPolicy = useCallback(() => {
    window.api?.mcp?.getAgentSessionCount?.()
      .then((r) => { if (r?.success && r.data) setPolicy(r.data); })
      .catch(() => { /* panel is informational; a failed poll must not break it */ });
  }, []);

  const toggleAgentSessions = useCallback((enabled: boolean) => {
    window.api?.mcp?.setAgentSessionPolicy?.({ enabled })
      .then((r) => {
        if (r?.success && r.data) {
          setPolicy((prev) => (prev ? { ...prev, limits: r.data } : prev));
        }
      })
      .catch(() => { /* leave the toggle showing its previous state */ });
  }, []);

  const fetchCalls = useCallback((initial = false) => {
    if (initial) setLoading(true);
    window.api?.mcp?.getCallLog?.(200)
      .then((result) => {
        if (result?.success && result.data) {
          const filtered = (result.data as McpCallEntry[]).filter(
            (c) => c.sessionId === sessionId
          );
          const sorted = filtered.reverse(); // newest first
          if (initial) {
            knownTimestampsRef.current = new Set(sorted.map(c => c.timestamp));
            setCalls(sorted);
          } else {
            // Only add genuinely new entries to avoid flicker
            const newEntries = sorted.filter(c => !knownTimestampsRef.current.has(c.timestamp));
            if (newEntries.length > 0) {
              newEntries.forEach(c => knownTimestampsRef.current.add(c.timestamp));
              setCalls((prev) => [...newEntries, ...prev]);
            }
          }
        }
      })
      .finally(() => { if (initial) setLoading(false); });
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    knownTimestampsRef.current = new Set();
    fetchCalls(true);
    fetchPolicy();
  }, [fetchCalls, fetchPolicy]);

  // Poll every 3s as the reliable update path
  useEffect(() => {
    const id = setInterval(() => {
      fetchCalls(false);
      fetchPolicy();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchCalls, fetchPolicy]);

  // Also subscribe to push events for sub-second updates when they work
  useEffect(() => {
    const unsub = window.api?.mcp?.onToolCalled?.((entry: McpCallEntry) => {
      if (entry.sessionId === sessionId && !knownTimestampsRef.current.has(entry.timestamp)) {
        knownTimestampsRef.current.add(entry.timestamp);
        setCalls((prev) => [entry, ...prev]);
      }
    });
    return () => { unsub?.(); };
  }, [sessionId]);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [calls.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      setAutoScroll(scrollRef.current.scrollTop < 10);
    }
  }, []);

  const formatTime = (ts: string) => formatDateTime(ts);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        Loading MCP activity...
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span className="text-sm">No MCP tool calls for this session yet</span>
        <span className="text-xs text-text-tertiary">Calls will appear here in real-time when the agent uses MCP tools</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(0,0,0,0.10)]">
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-secondary">
            {calls.length} tool call{calls.length !== 1 ? 's' : ''}
          </span>
          {policy && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${
                policy.active >= policy.limits.maxConcurrentGlobal
                  ? 'text-red-400 border-red-400/40'
                  : 'text-text-secondary border-[rgba(0,0,0,0.15)]'
              }`}
              title={
                `${policy.active} of ${policy.limits.maxConcurrentGlobal} agent-created sessions in use ` +
                `(max ${policy.limits.maxConcurrentPerRepo} per repo).`
              }
            >
              agent sessions {policy.active} / {policy.limits.maxConcurrentGlobal}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {policy && (
            <label
              className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer"
              title={
                policy.limits.enabled
                  ? 'Agents may create KIT sessions. Turning this off blocks new ones; closing always works.'
                  : 'Agents cannot create KIT sessions. Closing existing ones still works.'
              }
            >
              <input
                type="checkbox"
                checked={policy.limits.enabled}
                onChange={(e) => toggleAgentSessions(e.target.checked)}
                className="accent-accent"
              />
              allow agent sessions
            </label>
          )}
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
              }}
              className="text-xs text-accent hover:text-accent/80 transition-colors"
            >
              Scroll to latest
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${autoScroll ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-xs text-text-tertiary">
              {autoScroll ? 'Live' : 'Paused'}
            </span>
          </div>
        </div>
      </div>

      {/* Call log */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="divide-y divide-border">
          {calls.map((call, idx) => (
            <div
              key={`${call.timestamp}-${idx}`}
              className={`px-4 py-2.5 hover:bg-surface-secondary/50 transition-colors ${
                !call.success ? 'bg-red-500/5' : ''
              }`}
            >
              <div
                className="flex items-center gap-3 cursor-pointer"
                onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              >
                {/* Timestamp */}
                <span className="text-xs text-text-tertiary font-mono w-20 shrink-0">
                  {formatTime(call.timestamp)}
                </span>

                {/* Tool name */}
                <span className={`text-sm font-mono font-medium ${TOOL_COLORS[call.toolName] || 'text-gray-300'}`}>
                  {call.toolName}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Duration */}
                <span className="text-xs text-text-tertiary font-mono">
                  {formatDuration(call.durationMs)}
                </span>

                {/* Status badge */}
                {call.success ? (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    OK
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    Error
                  </span>
                )}
              </div>

              {/* Expanded error detail */}
              {expandedIdx === idx && call.error && (
                <div className="mt-2 ml-[5.5rem] p-2 bg-red-500/10 border border-red-500/20 rounded text-xs font-mono text-red-300 whitespace-pre-wrap">
                  {call.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
