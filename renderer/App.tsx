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
import { WorkspaceBrowserView } from './components/features/WorkspaceBrowserView';
import { HomeArtefactLeft } from './components/ui/HomeArtefactLeft';
import { NewSessionWizard } from './components/features/NewSessionWizard';
import { CloseSessionDialog } from './components/features/CloseSessionDialog';
import { SettingsModal } from './components/features/SettingsModal';
import { CreateAgentWizard } from './components/features/CreateAgentWizard';
import { RepoDetailModal } from './components/features/RepoDetailModal';
import { RebaseMergeErrorDialog } from './components/features/RebaseMergeErrorDialog';
import { OnboardingModal } from './components/features/OnboardingModal';
import { StaleSessionsDialog } from './components/features/StaleSessionsDialog';
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
    createAgentWizardRepoPath,
    createAgentWizardTask,
    repoDetailPath,
    closeRepoDetail,
    showOnboarding,
    setShowOnboarding,
  } = useUIStore();

  // Subscribe to agent events from main process
  useAgentSubscription();

  // Subscribe to contract generation events at app-level (persists across tab switches)
  useContractGenerationSubscription();

  // Conflict resolution store
  const showConflictDialog = useConflictStore((state) => state.showDialog);

  // Track last rebase time per session
  const setLastRebaseTime = useAgentStore((state) => state.setLastRebaseTime);
  const removeReportedSession = useAgentStore((state) => state.removeReportedSession);

  // Startup stale-session scan results
  const [staleSessions, setStaleSessions] = React.useState<import('../shared/types').StaleSessionInfo[]>([]);
  const [autoRemovedCount, setAutoRemovedCount] = React.useState(0);
  // Orphaned session recovery — hoisted from MainLayout so the stale-session
  // dialog can suppress the orphaned banner while it's open and can dismiss
  // it when the user picks "Keep all". Before this, the two flows ran
  // independently and the user's "Keep all" in the modal left the redundant
  // "Recover All" bar dangling at the top of the app.
  interface OrphanedSession {
    sessionId: string;
    repoPath: string;
    sessionData: { task?: string; branchName?: string; agentType?: string };
    lastModified: Date;
  }
  const [orphanedSessions, setOrphanedSessions] = React.useState<OrphanedSession[]>([]);
  // Latch: once the user has dismissed the recovery UI in this session (via
  // "Keep all" on the stale dialog, "Dismiss" on the orphaned banner, or by
  // firing "Recover All"), we ignore later orphaned events from the still-in-
  // flight scanAllReposForSessions IPC. Without this latch a slow scan that
  // finishes AFTER dismissal re-populates orphanedSessions and the banner
  // reappears — the "still seeing this issue" v2.6.85 didn't cover.
  const recoveryDismissedRef = React.useRef(false);

  useEffect(() => {
    // Risky stale sessions (unmerged commits) → prompt the user.
    const unsubFound = window.api?.recovery?.onStaleSessionsFound?.((sessions) => {
      if (sessions && sessions.length > 0) setStaleSessions(sessions);
    });
    // Safe stale sessions auto-removed by the main process → drop from the store + show a banner.
    const unsubAuto = window.api?.recovery?.onStaleSessionsAutoRemoved?.((sessions) => {
      if (sessions && sessions.length > 0) {
        sessions.forEach((s) => removeReportedSession(s.sessionId));
        setAutoRemovedCount((n) => n + sessions.length);
      }
    });
    // Orphaned sessions (disk files without matching in-memory instance).
    // Skip when the user has already dismissed recovery in this session — the
    // late arrival would otherwise resurrect the banner they just closed.
    const unsubOrph = window.api?.recovery?.onOrphanedSessionsFound?.((sessions) => {
      if (recoveryDismissedRef.current) return;
      setOrphanedSessions(sessions);
    });
    return () => { unsubFound?.(); unsubAuto?.(); unsubOrph?.(); };
  }, [removeReportedSession]);

  const handleRecoverAll = React.useCallback(async () => {
    const list = orphanedSessions.map(s => ({ sessionId: s.sessionId, repoPath: s.repoPath }));
    try {
      const result = await window.api?.recovery?.recoverMultiple?.(list);
      if (result?.success) {
        setOrphanedSessions([]);
        recoveryDismissedRef.current = true;
      }
    } catch (err) {
      console.error('Recovery failed:', err);
    }
  }, [orphanedSessions]);
  const handleDismissOrphaned = React.useCallback(() => {
    setOrphanedSessions([]);
    recoveryDismissedRef.current = true;
  }, []);

  useEffect(() => {
    const unsubStatus = window.api?.rebaseWatcher?.onStatusChanged?.((data) => {
      if (data?.lastRebaseResult?.timestamp) {
        setLastRebaseTime(data.sessionId, data.lastRebaseResult);
      }
    });
    const unsubCompleted = window.api?.rebaseWatcher?.onAutoRebaseCompleted?.((data) => {
      if (data?.sessionId) {
        setLastRebaseTime(data.sessionId, {
          success: data.success,
          timestamp: new Date().toISOString(),
          message: data.message || '',
        });
      }
    });
    return () => { unsubStatus?.(); unsubCompleted?.(); };
  }, [setLastRebaseTime]);

  // Subscribe to rebase/merge error events
  useEffect(() => {
    const unsubscribe = window.api?.conflict?.onRebaseErrorDetected?.((data) => {
      console.log('[App] Rebase error detected:', data);
      showConflictDialog({
        sessionId: data.sessionId,
        repoPath: data.repoPath,
        baseBranch: (data.baseBranch || 'main').replace(/^origin\//, ''),
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

  // Check onboarding status on mount
  useEffect(() => {
    window.api?.config?.get?.('onboardingCompleted').then((result) => {
      if (result?.success && !result.data) {
        setShowOnboarding(true);
      }
    }).catch(() => {
      // If config read fails, don't block — just skip onboarding
    });
  }, [setShowOnboarding]);

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
  const handleRestartSession = async (sessionId: string, session?: SessionReport, commitChanges = true): Promise<void> => {
    try {
      // Pass session data so restart can work even without stored AgentInstance
      // (e.g., for sessions created outside the Kanvas wizard via CLI)
      const sessionData = session ? {
        repoPath: session.repoPath,
        branchName: session.branchName,
        baseBranch: (session.baseBranch || 'main').replace(/^origin\//, ''),
        worktreePath: session.worktreePath,
        agentType: session.agentType,
        task: session.task,
      } : undefined;

      const result = await window.api.instance?.restart?.(sessionId, sessionData, commitChanges);
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
        throw new Error(result?.error || 'Restart failed — no session data returned');
      }
    } catch (error) {
      console.error('Failed to restart session:', error);
      throw error;
    }
  };

  const mainView = useUIStore((state) => state.mainView);
  const setMainView = useUIStore((state) => state.setMainView);

  // Determine what to show in main content
  // Priority: 1) Commits/Workspaces views (always on top), 2) Session detail, 3) Dashboard
  const mainContent = mainView === 'commits' ? (
    <UniversalCommitsView />
  ) : mainView === 'workspaces' ? (
    <WorkspaceBrowserView />
  ) : mainView === 'artefacts' ? (
    <div className="h-full p-6 overflow-auto">
      <HomeArtefactLeft className="max-w-5xl aspect-[1440/1024] rounded-2xl shadow-card" />
    </div>
  ) : selectedSession ? (
    <SessionDetailView
      session={selectedSession}
      onBack={() => setSelectedSession(null)}
      onDelete={handleDeleteSession}
      onRestart={handleRestartSession}
    />
  ) : (
    <DashboardCanvas agent={selectedAgent} />
  );

  // When selecting a session, switch back to dashboard view. Also close the
  // RepoDetailModal — selecting a session navigates away from the repo view,
  // and otherwise the modal stays mounted at z-50 covering the new
  // SessionDetailView.
  const handleSelectSession = (sessionId: string | null) => {
    if (sessionId) {
      setMainView('dashboard');
      closeRepoDetail();
    }
    setSelectedSession(sessionId);
  };

  return (
    <div className="h-screen flex flex-col bg-surface text-text-primary">
      {/* Main Content */}
      <MainLayout
        sidebar={<Sidebar />}
        statusBar={<StatusBar agent={selectedAgent} />}
        orphanedSessions={orphanedSessions}
        onRecoverOrphaned={handleRecoverAll}
        onDismissOrphaned={handleDismissOrphaned}
        // Hide the orphaned banner while the stale-session dialog is up so the
        // user isn't looking at two overlapping "old sessions from prior run"
        // affordances at the same time.
        suppressOrphanedBanner={staleSessions.length > 0}
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
        <CreateAgentWizard
          onClose={() => setShowCreateAgentWizard(false)}
          initialRepoPath={createAgentWizardRepoPath}
          initialTask={createAgentWizardTask}
        />
      )}
      {repoDetailPath && (
        <RepoDetailModal repoPath={repoDetailPath} onClose={closeRepoDetail} />
      )}

      {/* Onboarding - shown on first launch */}
      {showOnboarding && (
        <OnboardingModal onClose={() => setShowOnboarding(false)} />
      )}

      {/* Rebase/Merge Error Dialog - shown when conflict is detected */}
      <RebaseMergeErrorDialog />

      {/* Startup stale-session review (risky ones with unmerged commits) */}
      {staleSessions.length > 0 && (
        <StaleSessionsDialog
          sessions={staleSessions}
          onClose={() => {
            setStaleSessions([]);
            // Treat "Keep all" as "leave old sessions alone entirely" — also
            // dismiss the orphaned recovery banner and latch the decision so
            // a late orphaned scan can't resurrect the banner the user just
            // closed (the actual v2.6.87 fix; v2.6.85 cleared once but the
            // late-arrival event re-populated).
            setOrphanedSessions([]);
            recoveryDismissedRef.current = true;
          }}
          onRemoved={(ids) => {
            ids.forEach((id) => removeReportedSession(id));
            setStaleSessions((prev) => prev.filter((s) => !ids.includes(s.sessionId)));
          }}
        />
      )}

      {/* Toast: stale sessions auto-removed on startup */}
      {autoRemovedCount > 0 && (
        <div className="fixed bottom-4 right-4 z-50 bg-white border border-[rgba(0,0,0,0.10)] rounded-[14px] shadow-[0_4px_6px_rgba(0,0,0,0.08)] px-4 py-3 max-w-sm animate-slide-up">
          <div className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 mt-1.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-text-primary">
                Cleaned up {autoRemovedCount} stale session{autoRemovedCount === 1 ? '' : 's'} with fully-merged work
              </p>
              <p className="text-xs text-text-secondary mt-0.5">Worktrees idle 14+ days, already merged into main/development.</p>
            </div>
            <button onClick={() => setAutoRemovedCount(0)} className="text-text-secondary hover:text-text-primary" title="Dismiss">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
