/**
 * Agent Store
 * Manages state for agents that report into Kanvas
 * Kanvas is a DASHBOARD - it monitors agents, not the other way around
 */

import { create } from 'zustand';
import type { AgentInfo, SessionReport, AgentActivityReport } from '../../shared/agent-protocol';

interface RegisteredAgent extends AgentInfo {
  isAlive: boolean;
  sessions: string[];
  lastHeartbeat?: string;
}

export interface AgentState {
  agents: Map<string, RegisteredAgent>;
  reportedSessions: Map<string, SessionReport>;
  recentActivity: AgentActivityReport[];
  selectedAgentId: string | null;
  selectedAgentType: string | null;  // For grouped agent view
  selectedSessionId: string | null;  // For session detail view
  viewedCommitCounts: Map<string, number>;  // sessionId → commitCount at last view
  lastRebaseTimes: Map<string, { success: boolean; timestamp: string; message: string }>;
  isInitialized: boolean;

  // Actions
  setLastRebaseTime: (sessionId: string, data: { success: boolean; timestamp: string; message: string }) => void;
  setAgents: (agents: RegisteredAgent[]) => void;
  addAgent: (agent: RegisteredAgent) => void;
  removeAgent: (agentId: string) => void;
  updateAgentStatus: (agentId: string, isAlive: boolean, lastHeartbeat?: string) => void;
  updateAgentHeartbeat: (agentId: string, timestamp: string) => void;

  addReportedSession: (session: SessionReport) => void;
  removeReportedSession: (sessionId: string) => void;
  updateReportedSession: (sessionId: string, updates: Partial<SessionReport>) => void;

  addActivity: (activity: AgentActivityReport) => void;
  clearActivity: () => void;

  setSelectedAgent: (agentId: string | null) => void;
  setSelectedAgentType: (agentType: string | null) => void;
  setSelectedSession: (sessionId: string | null) => void;
  setInitialized: (initialized: boolean) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: new Map(),
  reportedSessions: new Map(),
  recentActivity: [],
  selectedAgentId: null,
  selectedAgentType: null,
  selectedSessionId: null,
  viewedCommitCounts: new Map(),
  lastRebaseTimes: new Map(),
  isInitialized: false,

  setLastRebaseTime: (sessionId, data) =>
    set((state) => {
      const newMap = new Map(state.lastRebaseTimes);
      newMap.set(sessionId, data);
      return { lastRebaseTimes: newMap };
    }),

  setAgents: (agents) =>
    set({
      agents: new Map(agents.map((a) => [a.agentId, a])),
    }),

  addAgent: (agent) =>
    set((state) => {
      const newAgents = new Map(state.agents);
      newAgents.set(agent.agentId, agent);
      return { agents: newAgents };
    }),

  removeAgent: (agentId) =>
    set((state) => {
      const newAgents = new Map(state.agents);
      newAgents.delete(agentId);
      return {
        agents: newAgents,
        selectedAgentId: state.selectedAgentId === agentId ? null : state.selectedAgentId,
      };
    }),

  updateAgentStatus: (agentId, isAlive, lastHeartbeat) =>
    set((state) => {
      const agent = state.agents.get(agentId);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(agentId, {
        ...agent,
        isAlive,
        lastHeartbeat: lastHeartbeat || agent.lastHeartbeat,
      });
      return { agents: newAgents };
    }),

  updateAgentHeartbeat: (agentId, timestamp) =>
    set((state) => {
      const agent = state.agents.get(agentId);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(agentId, {
        ...agent,
        lastHeartbeat: timestamp,
        isAlive: true,
      });
      return { agents: newAgents };
    }),

  addReportedSession: (session) =>
    set((state) => {
      const newSessions = new Map(state.reportedSessions);
      newSessions.set(session.sessionId, session);

      // Update agent's session list
      const agent = state.agents.get(session.agentId);
      if (agent && !agent.sessions.includes(session.sessionId)) {
        const newAgents = new Map(state.agents);
        newAgents.set(session.agentId, {
          ...agent,
          sessions: [...agent.sessions, session.sessionId],
        });
        return { reportedSessions: newSessions, agents: newAgents };
      }

      return { reportedSessions: newSessions };
    }),

  removeReportedSession: (sessionId) =>
    set((state) => {
      const session = state.reportedSessions.get(sessionId);
      const newSessions = new Map(state.reportedSessions);
      newSessions.delete(sessionId);

      // Update agent's session list
      if (session) {
        const agent = state.agents.get(session.agentId);
        if (agent) {
          const newAgents = new Map(state.agents);
          newAgents.set(session.agentId, {
            ...agent,
            sessions: agent.sessions.filter((id) => id !== sessionId),
          });
          return { reportedSessions: newSessions, agents: newAgents };
        }
      }

      return { reportedSessions: newSessions };
    }),

  updateReportedSession: (sessionId, updates) =>
    set((state) => {
      const session = state.reportedSessions.get(sessionId);
      if (!session) return state;

      const newSessions = new Map(state.reportedSessions);
      newSessions.set(sessionId, { ...session, ...updates });
      return { reportedSessions: newSessions };
    }),

  addActivity: (activity) =>
    set((state) => ({
      recentActivity: [activity, ...state.recentActivity].slice(0, 50), // Keep last 50 (reduced from 100 for performance)
    })),

  clearActivity: () =>
    set({ recentActivity: [] }),

  setSelectedAgent: (agentId) =>
    set({ selectedAgentId: agentId }),

  setSelectedAgentType: (agentType) =>
    set({ selectedAgentType: agentType, selectedSessionId: null }),

  setSelectedSession: (sessionId) =>
    set((state) => {
      if (sessionId) {
        const session = state.reportedSessions.get(sessionId);
        if (session) {
          const newViewed = new Map(state.viewedCommitCounts);
          newViewed.set(sessionId, session.commitCount || 0);
          return { selectedSessionId: sessionId, viewedCommitCounts: newViewed };
        }
      }
      return { selectedSessionId: sessionId };
    }),

  setInitialized: (initialized) =>
    set({ isInitialized: initialized }),
}));

// Selectors
export const selectAgentList = (state: AgentState) => Array.from(state.agents.values());
export const selectAliveAgents = (state: AgentState) =>
  Array.from(state.agents.values()).filter((a) => a.isAlive);
export const selectAgentById = (state: AgentState, agentId: string) =>
  state.agents.get(agentId);
export const selectSessionsByAgent = (state: AgentState, agentId: string) => {
  const agent = state.agents.get(agentId);
  if (!agent) return [];
  return agent.sessions
    .map((id) => state.reportedSessions.get(id))
    .filter((s): s is SessionReport => s !== undefined);
};
export const selectSessionsByAgentType = (state: AgentState, agentType: string) => {
  return Array.from(state.reportedSessions.values())
    .filter((s) => s.agentType === agentType);
};
export const selectAllSessions = (state: AgentState) =>
  Array.from(state.reportedSessions.values());
export const selectSessionById = (state: AgentState, sessionId: string) =>
  state.reportedSessions.get(sessionId);
