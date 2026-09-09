/**
 * MainLayout Component
 * Main application layout with sidebar and content area
 *
 * Orphaned-session recovery is controlled from App.tsx (v2.6.85 onwards) so the
 * stale-session dialog can suppress this banner while it's open and clear it
 * on "Keep all". Before that change MainLayout listened to
 * onOrphanedSessionsFound directly, and the user would click "Keep all" in the
 * stale modal only to be greeted by an independent "Recover All" bar at the
 * top of the app that felt like duplicate UI.
 */

import React, { ReactNode, useState } from 'react';
import { useUIStore } from '../../store/uiStore';

interface OrphanedSession {
  sessionId: string;
  repoPath: string;
  sessionData: { task?: string; branchName?: string; agentType?: string };
  lastModified: Date;
}

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  statusBar?: ReactNode;
  orphanedSessions?: OrphanedSession[];
  onRecoverOrphaned?: () => Promise<void> | void;
  onDismissOrphaned?: () => void;
  /** True while the stale-session dialog is open — hides the orphaned banner
   *  to avoid showing two "old sessions" affordances at once. */
  suppressOrphanedBanner?: boolean;
}

export function MainLayout({
  sidebar,
  children,
  statusBar,
  orphanedSessions = [],
  onRecoverOrphaned,
  onDismissOrphaned,
  suppressOrphanedBanner = false,
}: MainLayoutProps): React.ReactElement {
  const { sidebarCollapsed, sidebarWidth } = useUIStore();
  const [isRecovering, setIsRecovering] = useState(false);

  const handleRecoverAll = async () => {
    if (!onRecoverOrphaned) return;
    setIsRecovering(true);
    try {
      await onRecoverOrphaned();
    } finally {
      setIsRecovering(false);
    }
  };

  const showBanner = !suppressOrphanedBanner && orphanedSessions.length > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-density="cozy">
      {/* Recovery Banner */}
      {showBanner && (
        <div className="border-b px-4 py-2" style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.20)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-amber-500">⚠️</span>
              <div>
                <span className="text-sm font-medium text-text-primary">
                  Found {orphanedSessions.length} session{orphanedSessions.length > 1 ? 's' : ''} from a previous run
                </span>
                <span className="text-xs text-text-secondary ml-2">
                  These sessions may have work in progress
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleRecoverAll}
                disabled={isRecovering}
                className="btn-primary"
                style={{ height: 30, fontSize: 12 }}
              >
                {isRecovering ? 'Recovering...' : 'Recover All'}
              </button>
              <button
                onClick={onDismissOrphaned}
                className="kb-btn"
                style={{ height: 30, fontSize: 12 }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <aside
            className="flex-shrink-0 border-r border-[rgba(0,0,0,0.10)] overflow-y-auto bg-surface-secondary"
            style={{ width: sidebarWidth }}
          >
            {sidebar}
          </aside>
        )}

        {/* Main content — paper bg */}
        <main className="flex-1 min-h-0 overflow-hidden bg-surface-secondary flex flex-col">{children}</main>
      </div>

      {/* Status bar */}
      {statusBar && (
        <footer className="h-7 bg-white border-t border-[rgba(0,0,0,0.10)] px-3 flex items-center text-xs">
          {statusBar}
        </footer>
      )}
    </div>
  );
}
