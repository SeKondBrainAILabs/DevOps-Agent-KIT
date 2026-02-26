/**
 * UI Store
 * Zustand store for UI state (modals, sidebar, etc.)
 */

import { create } from 'zustand';

export type MainView = 'dashboard' | 'commits' | 'artefacts';
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
  closeSessionId: string | null;

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
  setMainSplitPosition: (position: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Sidebar
  sidebarCollapsed: false,
  sidebarWidth: 256,
  sidebarTab: 'agents',

  // Main view
  mainView: 'dashboard',

  // Modals
  showNewSessionWizard: false,
  showCloseSessionDialog: false,
  showSettingsModal: false,
  showCreateAgentWizard: false,
  closeSessionId: null,

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

  setShowCreateAgentWizard: (show) => set({ showCreateAgentWizard: show }),

  setMainSplitPosition: (position) => set({ mainSplitPosition: position }),
}));
