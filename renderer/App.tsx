/**
 * Main Application Component
 * SeKondBrain Kanvas for KIT
 *
 * Kanvas is a DASHBOARD that agents report INTO.
 * It monitors and displays activity from DevOps Agent and other AI agents.
 */

import React, { useEffect } from 'react';
import { MainLayout } from './components/layouts/MainLayout';
import { Sidebar } from './components/layouts/Sidebar';
import { StatusBar } from './components/layouts/StatusBar';
import { DashboardCanvas } from './components/features/DashboardCanvas';
import { SessionDetailView } from './components/features/SessionDetailView';
import { UniversalCommitsView } from './components/features/UniversalCommitsView';
import { HomeArtefactLeft } from './components/ui/HomeArtefactLeft';
import { NewSessionWizard } from './components/features/NewSessionWizard';
import { CloseSessionDialog } from './components/features/CloseSessionDialog';
import { SettingsModal } from './components/features/SettingsModal';
import { CreateAgentWizard } from './components/features/CreateAgentWizard';
import { RebaseMergeErrorDialog } from './components/features/RebaseMergeErrorDialog';
import { useAgentStore, selectAgentList, selectSessionById } from './store/agentStore';
import { useUIStore } from './store/uiStore';
import { useConflictStore } from './store/conflictStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAgentSubscription } from './hooks/useAgentSubscription';
import { useContractGenerationSubscription } from './hooks/useContractGenerationSubscription';
import type { SessionReport } from '../shared/agent-protocol';

export default function App(): React.ReactElement {
  const agentsMap = useAgentStore((state) => state.agents);
  const agents = React.useMemo(() => Array.from(agentsMap.values()), [agentsMap]);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const selectedSessionId = useAgentStore((state) => state.selectedSessionId);
  const setSelectedSession = useAgentStore((state) => state.setSelectedSession);
  const selectedSession = useAgentStore((state) =>
    selectedSessionId ? selectSessionById(state, selectedSessionId) : undefined
  );

  const {
    showNewSessionWizard,
    setShowNewSessionWizard,
    showCloseSessionDialog,
    setShowCloseSessionDialog,
    closeSessionId,
    showSettingsModal,
    setShowSettingsModal,
    showCreateAgentWizard,
    setShowCreateAgentWizard,
  } = useUIStore();

  // Subscribe to agent events from main process
  useAgentSubscription();

  // Subscribe to contract generation events at app-level (persists across tab switches)
  useContractGenerationSubscription();

  // Conflict resolution store
  const showConflictDialog = useConflictStore((state) => state.showDialog);

  // Subscribe to rebase/merge error events
  useEffect(() => {
    const unsubscribe = window.api?.conflict?.onRebaseErrorDetected?.((data) => {
      console.log('[App] Rebase error detected:', data);
      showConflictDialog({
        sessionId: data.sessionId,
        repoPath: data.repoPath,
        baseBranch: data.baseBranch,
        currentBranch: data.currentBranch,
        conflictedFiles: data.conflictedFiles,
        errorMessage: data.errorMessage,
        rawError: data.rawError,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [showConflictDialog]);

  // Initialize agent listener on mount
  useEffect(() => {
    // Initialize with a default directory
    // In production, this would come from user selection
    if (window.api?.agent?.initialize) {
      window.api.agent.initialize('.');
    }
  }, []);

  // Keyboard shortcuts
  useKeyboardShortcuts([
    { key: 'n', ctrl: true, action: () => setShowNewSessionWizard(true) },
    { key: 'w', ctrl: true, action: () => selectedAgentId && setShowCloseSessionDialog(true, selectedAgentId) },
    { key: 'Tab', ctrl: true, action: () => handleNextAgent() },
    { key: ',', ctrl: true, action: () => setShowSettingsModal(true) },
  ]);

  const handleNextAgent = () => {
    if (agents.length === 0) return;

    const currentIndex = agents.findIndex((a) => a.agentId === selectedAgentId);
    const nextIndex = (currentIndex + 1) % agents.length;
    setSelectedAgent(agents[nextIndex].agentId);
  };

  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.agentId === selectedAgentId)
    : null;

  const removeReportedSession = useAgentStore((state) => state.removeReportedSession);

  // Handle session deletion
  const handleDeleteSession = async (sessionId: string): Promise<void> => {
    try {
      const result = await window.api.instance?.delete?.(sessionId);
      if (result?.success) {
        removeReportedSession(sessionId);
        setSelectedSession(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  // Handle session restart - reinitializes repo, creates new session with same config
  const handleRestartSession = async (sessionId: string, session?: SessionReport): Promise<void> => {
    try {
      // Pass session data so restart can work even without stored AgentInstance
      // (e.g., for sessions created outside the Kanvas wizard via CLI)
      const sessionData = session ? {
        repoPath: session.repoPath,
        branchName: session.branchName,
        baseBranch: session.baseBranch,
        worktreePath: session.worktreePath,
        agentType: session.agentType,
        task: session.task,
      } : undefined;

      const result = await window.api.instance?.restart?.(sessionId, sessionData);
      if (result?.success && result.data) {
        // Remove old session from store
        removeReportedSession(sessionId);
        // Select the new session (it will be added to store via IPC event)
        const newSessionId = result.data.sessionId;
        if (newSessionId) {
          // Small delay to allow IPC event to populate the store
          setTimeout(() => setSelectedSession(newSessionId), 100);
        }
        console.log(`Session restarted: ${sessionId} -> ${newSessionId}`);
      } else {
        console.error('Failed to restart session:', result?.error);
      }
    } catch (error) {
      console.error('Failed to restart session:', error);
    }
  };

  const mainView = useUIStore((state) => state.mainView);
  const setMainView = useUIStore((state) => state.setMainView);

  // Determine what to show in main content
  // Priority: 1) Session detail, 2) Commits view, 3) Artefacts view, 4) Dashboard
  const mainContent = selectedSession ? (
    <SessionDetailView
      session={selectedSession}
      onBack={() => setSelectedSession(null)}
      onDelete={handleDeleteSession}
      onRestart={handleRestartSession}
    />
  ) : mainView === 'commits' ? (
    <UniversalCommitsView />
  ) : mainView === 'artefacts' ? (
    <div className="h-full p-6 overflow-auto">
      <HomeArtefactLeft className="max-w-5xl aspect-[1440/1024] rounded-2xl shadow-card" />
    </div>
  ) : (
    <DashboardCanvas agent={selectedAgent} />
  );

  // When selecting a session, switch back to dashboard view
  const handleSelectSession = (sessionId: string | null) => {
    if (sessionId) {
      setMainView('dashboard');
    }
    setSelectedSession(sessionId);
  };

  return (
    <div className="h-screen flex flex-col bg-surface text-text-primary">
      {/* Main Content */}
      <MainLayout
        sidebar={<Sidebar />}
        statusBar={<StatusBar agent={selectedAgent} />}
      >
        {mainContent}
      </MainLayout>

      {/* Modals */}
      {showNewSessionWizard && (
        <NewSessionWizard onClose={() => setShowNewSessionWizard(false)} />
      )}

      {showCloseSessionDialog && closeSessionId && (
        <CloseSessionDialog
          sessionId={closeSessionId}
          onClose={() => setShowCloseSessionDialog(false)}
        />
      )}

      {showSettingsModal && (
        <SettingsModal onClose={() => setShowSettingsModal(false)} />
      )}

      {showCreateAgentWizard && (
        <CreateAgentWizard onClose={() => setShowCreateAgentWizard(false)} />
      )}

      {/* Rebase/Merge Error Dialog - shown when conflict is detected */}
      <RebaseMergeErrorDialog />
    </div>
  );
}
