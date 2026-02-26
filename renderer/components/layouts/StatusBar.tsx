/**
 * StatusBar Component
 * Shows agent status and key metrics at the bottom of the window
 * Follows SeKondBrain design aesthetics
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../store/agentStore';
import type { AgentInfo } from '../../../shared/agent-protocol';

interface RegisteredAgent extends AgentInfo {
  isAlive: boolean;
  sessions: string[];
  lastHeartbeat?: string;
}

interface RestartRecord {
  timestamp: string;
  exitCode: number;
  reason: 'crash' | 'unresponsive' | 'manual';
}

interface WorkerStatus {
  workerAlive: boolean;
  workerReady: boolean;
  workerPid: number | null;
  restartCount: number;
  activeMonitors: number;
  uptimeMs: number;
  workerUptimeSec: number;
  lastPingLatencyMs: number;
  restartHistory: RestartRecord[];
  spawnedAt: string | null;
}

interface McpStatus {
  port: number | null;
  url: string | null;
  isRunning: boolean;
  connectionCount: number;
  startedAt: string | null;
}

interface StatusBarProps {
  agent: RegisteredAgent | null | undefined;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildWorkerTooltip(status: WorkerStatus, isRestarting: boolean): string {
  if (isRestarting) return 'Restarting worker...';
  if (!status.workerReady) {
    return `Worker down (${status.restartCount} restarts) · Click to restart`;
  }

  const lines = [
    `PID ${status.workerPid} · ${status.activeMonitors} monitors`,
    `Uptime: ${formatUptime(status.workerUptimeSec)}`,
    status.lastPingLatencyMs > 0 ? `Latency: ${status.lastPingLatencyMs}ms` : null,
    status.restartHistory.length > 0
      ? `Restarts: ${status.restartHistory.length} (last: ${status.restartHistory[status.restartHistory.length - 1].reason})`
      : null,
    'Click to restart',
  ].filter(Boolean);
  return lines.join(' · ');
}

export function StatusBar({ agent }: StatusBarProps): React.ReactElement {
  const reportedSessions = useAgentStore((state) => state.reportedSessions);
  const agents = useAgentStore((state) => state.agents);
  const sessions = useMemo(() => Array.from(reportedSessions.values()), [reportedSessions]);

  // App version from Electron
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    window.api?.app?.getVersion?.().then((v: string) => setAppVersion(v)).catch(() => {});
  }, []);

  // Worker process status
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    // Fetch initial status
    window.api?.worker?.status?.().then((result) => {
      if (result?.success && result.data) setWorkerStatus(result.data);
    }).catch(() => {});

    // Listen for status changes
    const unsubscribe = window.api?.worker?.onStatusChanged?.((status) => {
      setWorkerStatus(status);
      setIsRestarting(false);
    });

    return () => unsubscribe?.();
  }, []);

  const handleWorkerRestart = useCallback(async () => {
    setIsRestarting(true);
    try {
      await window.api?.worker?.restart?.();
    } catch {
      setIsRestarting(false);
    }
  }, []);

  // MCP server status
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);

  useEffect(() => {
    // Fetch initial MCP status
    window.api?.mcp?.status?.().then((result) => {
      if (result?.success && result.data) setMcpStatus(result.data);
    }).catch(() => {});

    // Listen for MCP server started events
    const unsubscribe = window.api?.mcp?.onServerStarted?.((data) => {
      setMcpStatus((prev) => ({
        port: data.port,
        url: data.url,
        isRunning: true,
        connectionCount: prev?.connectionCount ?? 0,
        startedAt: new Date().toISOString(),
      }));
    });

    // Poll MCP status every 30s to keep connection count fresh
    const interval = setInterval(() => {
      window.api?.mcp?.status?.().then((result) => {
        if (result?.success && result.data) setMcpStatus(result.data);
      }).catch(() => {});
    }, 30000);

    return () => {
      unsubscribe?.();
      clearInterval(interval);
    };
  }, []);

  // Agent counts from the agents map
  const totalAgents = agents.size;
  const aliveAgents = useMemo(() => {
    let count = 0;
    for (const a of agents.values()) {
      if (a.isAlive) count++;
    }
    return count;
  }, [agents]);

  // Session counts
  const totalSessions = sessions.length;

  return (
    <div className="h-7 px-4 bg-surface border-t border-border flex items-center gap-4 text-xs">
      {/* Kanvas branding */}
      <span className="flex items-center gap-1.5 text-kanvas-blue font-medium">
        <div className="w-3 h-3 rounded bg-kanvas-blue flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-2 h-2 text-white" fill="currentColor">
            <circle cx="12" cy="12" r="5" />
          </svg>
        </div>
        Kanvas
      </span>

      <span className="text-border">|</span>

      {/* Agent count */}
      <span className="flex items-center gap-1.5 text-text-secondary">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span>{totalAgents} agent{totalAgents !== 1 ? 's' : ''}</span>
      </span>

      {/* Session count */}
      <span className="flex items-center gap-1.5 text-text-secondary">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span>{totalSessions} session{totalSessions !== 1 ? 's' : ''}</span>
      </span>

      {/* Selected agent info */}
      {agent && (
        <>
          <span className="text-border">|</span>
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${agent.isAlive ? 'bg-green-500' : 'bg-gray-400'}`} />
            <span className="text-text-primary font-medium">{agent.agentName}</span>
            <span className="text-text-secondary">
              ({agent.sessions.length} sessions)
            </span>
          </span>
        </>
      )}

      {/* Worker process status */}
      {workerStatus && (
        <>
          <span className="text-border">|</span>
          <span
            className="flex items-center gap-1.5 cursor-pointer hover:text-text-primary transition-colors"
            onClick={handleWorkerRestart}
            title={buildWorkerTooltip(workerStatus, isRestarting)}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isRestarting
                  ? 'bg-yellow-500 animate-pulse'
                  : workerStatus.workerReady
                    ? 'bg-green-500'
                    : workerStatus.workerAlive
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
              }`}
            />
            <svg className="w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728M9.172 15.828a4 4 0 010-5.656m5.656 0a4 4 0 010 5.656M12 12h.008v.008H12V12z" />
            </svg>
            <span className="text-text-secondary">
              {isRestarting
                ? 'Restarting...'
                : workerStatus.workerReady
                  ? `${workerStatus.activeMonitors} monitors`
                  : 'Worker down'}
            </span>
          </span>
        </>
      )}

      {/* MCP server status */}
      {mcpStatus && (
        <>
          <span className="text-border">|</span>
          <span
            className="flex items-center gap-1.5 cursor-pointer hover:text-text-primary transition-colors"
            title={
              mcpStatus.isRunning
                ? [
                    `MCP Server: Running`,
                    `URL: ${mcpStatus.url}`,
                    `Port: ${mcpStatus.port}`,
                    `Connections: ${mcpStatus.connectionCount}`,
                    mcpStatus.startedAt ? `Up since: ${new Date(mcpStatus.startedAt).toLocaleTimeString()}` : null,
                    'Click to copy URL',
                  ].filter(Boolean).join(' · ')
                : 'MCP Server: Down · Agents cannot use MCP tools'
            }
            onClick={() => {
              if (mcpStatus.url) {
                navigator.clipboard.writeText(mcpStatus.url);
              }
            }}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                mcpStatus.isRunning ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <svg className="w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-text-secondary">
              {mcpStatus.isRunning
                ? `MCP :${mcpStatus.port}${mcpStatus.connectionCount > 0 ? ` · ${mcpStatus.connectionCount} conn` : ''}`
                : 'MCP down'}
            </span>
          </span>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Keyboard shortcuts hint */}
      <span className="text-text-secondary hidden md:inline">
        <kbd className="px-1 py-0.5 rounded bg-surface-tertiary text-text-secondary font-mono text-[10px]">Ctrl</kbd>
        <span className="mx-0.5">+</span>
        <kbd className="px-1 py-0.5 rounded bg-surface-tertiary text-text-secondary font-mono text-[10px]">N</kbd>
        <span className="ml-1">New</span>
      </span>

      {/* Version */}
      {appVersion && <span className="text-text-secondary/60">v{appVersion}</span>}
    </div>
  );
}
