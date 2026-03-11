/**
 * useAgentSubscription Hook
 * Subscribes to agent events from the main process
 * Kanvas monitors agents that report into it
 */

import { useEffect } from 'react';
import { useAgentStore } from '../store/agentStore';

export function useAgentSubscription(): void {
  const {
    setAgents,
    addAgent,
    removeAgent,
    updateAgentStatus,
    updateAgentHeartbeat,
    addReportedSession,
    removeReportedSession,
    addActivity,
    setInitialized,
  } = useAgentStore();

  useEffect(() => {
    // Guard: ensure window.api is available (preload script loaded)
    if (!window.api?.agent) {
      console.warn('window.api.agent not available - preload may not be loaded');
      return;
    }

    // Load initial agent list
    window.api.agent.list().then((result) => {
      if (result.success && result.data) {
        setAgents(result.data);
      }
    }).catch((err) => {
      console.error('Failed to load agents:', err);
    });

    // Load persisted Kanvas instances and populate sessions from the store.
    // This eliminates the race condition where emitStoredSessions() fires
    // before the renderer's event listeners are ready (S9N-925 fix).
    const loadStoredInstances = async () => {
      try {
        const result = await window.api?.instance?.list?.();
        if (result?.success && result.data) {
          for (const inst of result.data) {
            if (!inst.sessionId) continue;
            const shortId = inst.sessionId.replace('sess_', '').slice(0, 8);
            const agentId = `kanvas-${inst.config.agentType}-${shortId}`;
            const repoName = inst.config.repoPath?.split('/').pop() || 'unknown';

            addAgent({
              agentId,
              agentType: inst.config.agentType,
              agentName: `${inst.config.agentType.charAt(0).toUpperCase()}${inst.config.agentType.slice(1)} (${repoName})`,
              version: '1.0.0',
              pid: 0,
              startedAt: inst.createdAt,
              repoPath: inst.config.repoPath,
              capabilities: ['code-generation', 'file-editing'],
              sessions: [inst.sessionId],
              lastHeartbeat: new Date().toISOString(),
              isAlive: inst.status === 'running' || inst.status === 'active',
            });

            addReportedSession({
              sessionId: inst.sessionId,
              agentId,
              agentType: inst.config.agentType,
              task: inst.config.taskDescription || inst.config.branchName || `${inst.config.agentType} session`,
              branchName: inst.config.branchName,
              baseBranch: inst.config.baseBranch,
              worktreePath: inst.worktreePath || inst.config.repoPath,
              repoPath: inst.config.repoPath,
              status: inst.status === 'running' ? 'active' : 'idle',
              created: inst.createdAt,
              updated: new Date().toISOString(),
              commitCount: 0,
            });
          }
          console.log(`[useAgentSubscription] Loaded ${result.data.length} stored instance(s)`);
        }
      } catch (err) {
        console.error('Failed to load stored instances:', err);
      } finally {
        setInitialized(true);
      }
    };
    loadStoredInstances();

    // Subscribe to agent registered events
    const unsubRegistered = window.api.agent.onRegistered((agent) => {
      addAgent(agent);
    });

    // Subscribe to agent unregistered events
    const unsubUnregistered = window.api.agent.onUnregistered((agentId) => {
      removeAgent(agentId);
    });

    // Subscribe to agent heartbeat events
    const unsubHeartbeat = window.api.agent.onHeartbeat(({ agentId, timestamp }) => {
      updateAgentHeartbeat(agentId, timestamp);
    });

    // Subscribe to agent status change events
    const unsubStatusChanged = window.api.agent.onStatusChanged(({ agentId, isAlive, lastHeartbeat }) => {
      updateAgentStatus(agentId, isAlive, lastHeartbeat);
    });

    // Subscribe to session reported events
    const unsubSessionReported = window.api.agent.onSessionReported((session) => {
      console.log('[useAgentSubscription] Session reported:', session);
      addReportedSession(session);
    });

    // Subscribe to activity reported events (from external agents)
    const unsubActivityReported = window.api.agent.onActivityReported((activity) => {
      addActivity(activity);
    });

    // Subscribe to internal activity log events (from WatcherService, etc.)
    const unsubLogEntry = window.api.activity?.onLog?.((entry) => {
      // Convert ActivityLogEntry to AgentActivityReport format
      addActivity({
        agentId: `internal-${entry.sessionId?.slice(0, 8) || 'system'}`,
        sessionId: entry.sessionId,
        type: entry.type,
        message: entry.message,
        details: entry.details,
        timestamp: entry.timestamp,
      });
    });

    // Cleanup subscriptions
    return () => {
      unsubRegistered();
      unsubUnregistered();
      unsubHeartbeat();
      unsubStatusChanged();
      unsubSessionReported();
      unsubActivityReported();
      unsubLogEntry?.();
    };
  }, [
    setAgents,
    addAgent,
    removeAgent,
    updateAgentStatus,
    updateAgentHeartbeat,
    addReportedSession,
    removeReportedSession,
    addActivity,
    setInitialized,
  ]);
}
