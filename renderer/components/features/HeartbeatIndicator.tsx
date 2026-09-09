/**
 * HeartbeatIndicator Component
 * Shows agent connection status and last heartbeat time
 */

import React, { useState, useEffect } from 'react';

interface HeartbeatIndicatorProps {
  sessionId: string;
  className?: string;
}

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown' | 'timeout';

interface HeartbeatState {
  status: ConnectionStatus;
  lastHeartbeat: string | null;
  agentId?: string;
  missedHeartbeats: number;
}

export function HeartbeatIndicator({
  sessionId,
  className = '',
}: HeartbeatIndicatorProps): React.ReactElement {
  const [heartbeat, setHeartbeat] = useState<HeartbeatState>({
    status: 'unknown',
    lastHeartbeat: null,
    missedHeartbeats: 0,
  });

  useEffect(() => {
    // Subscribe to heartbeat events
    const unsubHeartbeat = window.api?.agent?.onHeartbeat?.((data) => {
      if (data.sessionId === sessionId) {
        setHeartbeat((prev) => ({
          ...prev,
          status: 'connected',
          lastHeartbeat: data.timestamp,
          agentId: data.agentId,
          missedHeartbeats: 0,
        }));
      }
    });

    const unsubStatus = window.api?.agent?.onStatusChanged?.((data) => {
      if (data.sessionId === sessionId) {
        setHeartbeat((prev) => ({
          ...prev,
          status: data.isConnected ? 'connected' : 'disconnected',
          lastHeartbeat: data.lastHeartbeat,
          agentId: data.agentId,
          missedHeartbeats: data.missedHeartbeats || 0,
        }));
      }
    });

    return () => {
      unsubHeartbeat?.();
      unsubStatus?.();
    };
  }, [sessionId]);

  const getTimeAgo = (timestamp: string | null): string => {
    if (!timestamp) return 'Never';
    const seconds = Math.round((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
  };

  const statusConfig: Record<ConnectionStatus, {
    color: string;
    bgColor: string;
    label: string;
    icon: React.ReactNode;
  }> = {
    connected: {
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      label: 'Connected',
      icon: (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
      ),
    },
    disconnected: {
      color: 'text-red-600',
      bgColor: 'bg-red-100',
      label: 'Disconnected',
      icon: <span className="h-2 w-2 rounded-full bg-red-500" />,
    },
    timeout: {
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-100',
      label: 'Timeout',
      icon: <span className="h-2 w-2 rounded-full bg-yellow-500" />,
    },
    unknown: {
      color: 'text-gray-500',
      bgColor: 'bg-gray-100',
      label: 'Unknown',
      icon: <span className="h-2 w-2 rounded-full bg-gray-400" />,
    },
  };

  const config = statusConfig[heartbeat.status];

  return (
    <div
      className={`flex items-center gap-2 ${className}`}
      title={`Last heartbeat: ${getTimeAgo(heartbeat.lastHeartbeat)}`}
    >
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded ${config.bgColor}`}>
        {config.icon}
        <span className={`text-xs font-medium ${config.color}`}>
          {config.label}
        </span>
      </div>
      {heartbeat.lastHeartbeat && (
        <span className="text-xs text-text-secondary">
          {getTimeAgo(heartbeat.lastHeartbeat)}
        </span>
      )}
      {heartbeat.missedHeartbeats > 0 && (
        <span className="text-xs text-yellow-600">
          ({heartbeat.missedHeartbeats} missed)
        </span>
      )}
    </div>
  );
}

/**
 * HeartbeatBadge - Compact badge version for session cards
 */
export function HeartbeatBadge({ sessionId }: { sessionId: string }): React.ReactElement {
  const [isConnected, setIsConnected] = useState(false);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);

  useEffect(() => {
    const unsubHeartbeat = window.api?.agent?.onHeartbeat?.((data) => {
      if (data.sessionId === sessionId) {
        setIsConnected(true);
        setLastHeartbeat(data.timestamp);
      }
    });

    const unsubStatus = window.api?.agent?.onStatusChanged?.((data) => {
      if (data.sessionId === sessionId) {
        setIsConnected(data.isConnected);
        setLastHeartbeat(data.lastHeartbeat);
      }
    });

    return () => {
      unsubHeartbeat?.();
      unsubStatus?.();
    };
  }, [sessionId]);

  if (!lastHeartbeat) {
    return (
      <span
        className="w-2 h-2 rounded-full bg-gray-400"
        title="No heartbeat received"
      />
    );
  }

  if (isConnected) {
    return (
      <span className="relative flex h-2 w-2" title="Agent connected">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
      </span>
    );
  }

  return (
    <span
      className="w-2 h-2 rounded-full bg-red-500"
      title="Agent disconnected"
    />
  );
}

/**
 * TimeoutWarning - Toast-style warning when agent doesn't connect within timeout
 */
export function TimeoutWarning({
  sessionId,
  timeoutMs = 5 * 60 * 1000, // 5 minutes default
  onDismiss,
}: {
  sessionId: string;
  timeoutMs?: number;
  onDismiss?: () => void;
}): React.ReactElement | null {
  const [showWarning, setShowWarning] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);

  useEffect(() => {
    // Start timeout
    const timeout = setTimeout(() => {
      if (!hasConnected) {
        setShowWarning(true);
      }
    }, timeoutMs);

    // Listen for heartbeat to cancel warning
    const unsubHeartbeat = window.api?.agent?.onHeartbeat?.((data) => {
      if (data.sessionId === sessionId) {
        setHasConnected(true);
        setShowWarning(false);
      }
    });

    return () => {
      clearTimeout(timeout);
      unsubHeartbeat?.();
    };
  }, [sessionId, timeoutMs, hasConnected]);

  if (!showWarning) return null;

  return (
    <div className="fixed bottom-4 right-4 max-w-sm bg-yellow-50 border border-yellow-200 rounded-[14px] shadow-lg p-4 z-50">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="w-6 h-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-medium text-yellow-800">Agent Not Connected</h4>
          <p className="text-sm text-yellow-700 mt-1">
            The agent hasn't connected within the expected timeframe. Please verify:
          </p>
          <ul className="text-sm text-yellow-700 mt-2 list-disc list-inside">
            <li>The agent is running</li>
            <li>The session ID is correct</li>
            <li>Environment variables are set</li>
          </ul>
        </div>
        <button
          onClick={() => {
            setShowWarning(false);
            onDismiss?.();
          }}
          className="flex-shrink-0 p-1 rounded hover:bg-yellow-100 transition-colors"
        >
          <svg className="w-4 h-4 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
