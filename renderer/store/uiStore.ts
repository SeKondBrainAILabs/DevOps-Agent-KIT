/**
 * UI Store
 * Zustand store for UI state (modals, sidebar, etc.)
 */

import { create } from 'zustand';

export type MainView = 'dashboard' | 'commits' | 'artefacts' | 'workspaces';
export type SidebarTab = 'artefacts' | 'agents';

interface UIState {
  // Sidebar
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarTab: SidebarTab;

  // Main view
  mainView: MainView;

  // Modals
  showNewSessionWizard: boolean;
  showCloseSessionDialog: boolean;
  showSettingsModal: boolean;
  showCreateAgentWizard: boolean;
  /** Optional repo path to pre-fill when CreateAgentWizard opens (Day 2). */
  createAgentWizardRepoPath: string | null;
  showOnboarding: boolean;
  closeSessionId: string | null;
  /** Repo path whose RepoDetailModal is currently open (Day 2). */
  repoDetailPath: string | null;

  // Split pane
  mainSplitPosition: number;

  // Actions
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setMainView: (view: MainView) => void;
  setShowNewSessionWizard: (show: boolean) => void;
  setShowCloseSessionDialog: (show: boolean, sessionId?: string) => void;
  setShowSettingsModal: (show: boolean) => void;
  setShowCreateAgentWizard: (show: boolean) => void;
  /** Open the wizard with a specific repo path pre-selected (Day 2). */
  openCreateAgentWizardForRepo: (repoPath: string) => void;
  setShowOnboarding: (show: boolean) => void;
  /** Open / close the RepoDetailModal (Day 2). */
  openRepoDetail: (repoPath: string) => void;
  closeRepoDetail: () => void;
  setMainSplitPosition: (position: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Sidebar
  sidebarCollapsed: false,
  sidebarWidth: 300,
  sidebarTab: 'agents',

  // Main view
  mainView: 'dashboard',

  // Modals
  showNewSessionWizard: false,
  showCloseSessionDialog: false,
  showSettingsModal: false,
  showCreateAgentWizard: false,
  createAgentWizardRepoPath: null,
  showOnboarding: false,
  closeSessionId: null,
  repoDetailPath: null,

  // Split pane
  mainSplitPosition: 60, // percentage

  // Actions
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  setMainView: (view) => set({ mainView: view }),

  setShowNewSessionWizard: (show) => set({ showNewSessionWizard: show }),

  setShowCloseSessionDialog: (show, sessionId) =>
    set({ showCloseSessionDialog: show, closeSessionId: sessionId || null }),

  setShowSettingsModal: (show) => set({ showSettingsModal: show }),

  setShowCreateAgentWizard: (show) =>
    set((state) => ({
      showCreateAgentWizard: show,
      // Clear prefill when explicitly closing; leave alone when opening so
      // openCreateAgentWizardForRepo's prefill survives.
      createAgentWizardRepoPath: show ? state.createAgentWizardRepoPath : null,
    })),

  openCreateAgentWizardForRepo: (repoPath) =>
    set({ showCreateAgentWizard: true, createAgentWizardRepoPath: repoPath }),

  setShowOnboarding: (show) => set({ showOnboarding: show }),

  openRepoDetail: (repoPath) => set({ repoDetailPath: repoPath }),
  closeRepoDetail: () => set({ repoDetailPath: null }),

  setMainSplitPosition: (position) => set({ mainSplitPosition: position }),
}));
