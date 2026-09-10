/**
 * StatusBar Component
 * Shows agent status and key metrics at the bottom of the window
 * Follows SeKondBrain design aesthetics
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../store/agentStore';
import type { AgentInfo } from '../../../shared/agent-protocol';
import type { AppUpdateInfo } from '../../../shared/types';
import { formatDateTimeShort } from '../../../shared/format-datetime';

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

  // Auto-update state
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateAction, setUpdateAction] = useState<'idle' | 'downloading' | 'ready'>('idle');

  useEffect(() => {
    // Seed current status (catches updates detected before this component mounts)
    window.api?.update?.getStatus?.().then((result) => {
      if (result?.success && result.data?.updateAvailable) {
        setUpdateInfo(result.data);
        setUpdateAction(result.data.downloaded ? 'ready' : 'idle');
      }
    }).catch(() => {});

    const unsubAvailable = window.api?.update?.onAvailable?.((info) => {
      setUpdateInfo(info);
      setUpdateAction('idle');
    });
    const unsubProgress = window.api?.update?.onProgress?.((info) => {
      setUpdateInfo(info);
      setUpdateAction('downloading');
    });
    const unsubDownloaded = window.api?.update?.onDownloaded?.((info) => {
      setUpdateInfo(info);
      setUpdateAction('ready');
    });
    const unsubError = window.api?.update?.onError?.((info) => {
      setUpdateInfo(info);
      setUpdateAction('idle');
    });

    return () => {
      unsubAvailable?.();
      unsubProgress?.();
      unsubDownloaded?.();
      unsubError?.();
    };
  }, []);

  const handleUpdateClick = useCallback(async () => {
    if (updateAction === 'ready') {
      window.api?.update?.install?.();
    } else if (updateAction === 'idle' && updateInfo?.updateAvailable) {
      setUpdateAction('downloading');
      try {
        await window.api?.update?.download?.();
      } catch {
        setUpdateAction('idle');
      }
    }
  }, [updateAction, updateInfo]);

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
    <div className="h-7 px-4 bg-white flex items-center gap-4 text-xs">
      {/* KIT branding */}
      <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--c-blue)', fontFamily: 'var(--f-mono)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        KIT
      </span>

      <span className="text-[rgba(0,0,0,0.15)]">|</span>

      {/* Agent count */}
      <span className="flex items-center gap-1.5" style={{ color: 'var(--c-muted)' }}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span>{totalAgents} agent{totalAgents !== 1 ? 's' : ''}</span>
      </span>

      {/* Session count */}
      <span className="flex items-center gap-1.5" style={{ color: 'var(--c-muted)' }}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span>{totalSessions} session{totalSessions !== 1 ? 's' : ''}</span>
      </span>

      {/* Selected agent info */}
      {agent && (
        <>
          <span className="text-[rgba(0,0,0,0.15)]">|</span>
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
          <span className="text-[rgba(0,0,0,0.15)]">|</span>
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
          <span className="text-[rgba(0,0,0,0.15)]">|</span>
          <span
            className="flex items-center gap-1.5 cursor-pointer hover:text-text-primary transition-colors"
            title={
              mcpStatus.isRunning
                ? [
                    `MCP Server: Running`,
                    `URL: ${mcpStatus.url}`,
                    `Port: ${mcpStatus.port}`,
                    `Connections: ${mcpStatus.connectionCount}`,
                    mcpStatus.startedAt ? `Up since: ${formatDateTimeShort(mcpStatus.startedAt)}` : null,
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

      {/* Auto-update notification */}
      {updateInfo?.updateAvailable && (
        <>
          <span className="text-[rgba(0,0,0,0.15)]">|</span>
          <button
            onClick={handleUpdateClick}
            disabled={updateAction === 'downloading'}
            title={
              updateInfo.error
                ? `Update error: ${updateInfo.error}`
                : updateAction === 'ready'
                  ? `v${updateInfo.latestVersion} downloaded — click to restart and install`
                  : updateAction === 'downloading'
                    ? `Downloading v${updateInfo.latestVersion}… ${updateInfo.progress ? Math.round(updateInfo.progress.percent) + '%' : ''}`
                    : `v${updateInfo.latestVersion} available — click to download`
            }
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '1px 8px', borderRadius: 999,
              background: updateAction === 'ready' ? 'var(--c-blue)' : 'var(--c-paper)',
              border: `1px solid ${updateAction === 'ready' ? 'var(--c-blue)' : 'var(--border-1)'}`,
              color: updateAction === 'ready' ? '#fff' : 'var(--c-muted)',
              fontSize: 11, fontFamily: 'var(--f-mono)', cursor: updateAction === 'downloading' ? 'default' : 'pointer',
              opacity: updateAction === 'downloading' ? 0.7 : 1,
            }}
          >
            {updateAction === 'ready' ? (
              <>
                <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Restart to update v{updateInfo.latestVersion}
              </>
            ) : updateAction === 'downloading' ? (
              <>
                <svg style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {updateInfo.progress ? `${Math.round(updateInfo.progress.percent)}%` : 'Downloading…'}
              </>
            ) : (
              <>
                <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                </svg>
                v{updateInfo.latestVersion} available
              </>
            )}
          </button>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Keyboard shortcuts hint */}
      <span className="hidden md:inline" style={{ color: 'var(--c-muted)' }}>
        <kbd style={{ padding: '1px 5px', background: 'var(--c-paper)', border: '1px solid var(--border-1)', borderRadius: 6, fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--c-muted)' }}>Ctrl</kbd>
        <span className="mx-0.5">+</span>
        <kbd style={{ padding: '1px 5px', background: 'var(--c-paper)', border: '1px solid var(--border-1)', borderRadius: 6, fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--c-muted)' }}>N</kbd>
        <span className="ml-1">New</span>
      </span>

      {/* Version */}
      {appVersion && <span style={{ color: 'var(--c-muted)', opacity: 0.6 }}>v{appVersion}</span>}
    </div>
  );
}
