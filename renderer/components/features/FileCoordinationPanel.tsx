/**
 * FileCoordinationPanel Component
 * Displays file locks and allows force-release of stale locks
 */

import React, { useState, useEffect } from 'react';
import type { FileLock } from '../../../shared/types';

interface FileCoordinationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId?: string;
}

export function FileCoordinationPanel({
  isOpen,
  onClose,
  currentSessionId,
}: FileCoordinationPanelProps): React.ReactElement | null {
  const [locks, setLocks] = useState<FileLock[]>([]);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState<string | null>(null);

  // Load locks
  useEffect(() => {
    if (!isOpen) return;

    async function loadLocks() {
      setLoading(true);
      try {
        if (window.api?.lock?.list) {
          const result = await window.api.lock.list();
          if (result.success && result.data) {
            setLocks(result.data);
          }
        }
      } catch (error) {
        console.error('Failed to load locks:', error);
      } finally {
        setLoading(false);
      }
    }

    loadLocks();

    // Poll for updates (30 seconds when panel is open - reduced from 5s for performance)
    const interval = setInterval(loadLocks, 30000);
    return () => clearInterval(interval);
  }, [isOpen]);

  // Subscribe to lock changes
  useEffect(() => {
    const unsubscribe = window.api?.lockExtended?.onLockChanged?.((newLocks) => {
      setLocks(newLocks as FileLock[]);
    });
    return () => unsubscribe?.();
  }, []);

  const handleForceRelease = async (sessionId: string) => {
    setReleasing(sessionId);
    try {
      if (window.api?.lockExtended?.forceRelease) {
        await window.api.lockExtended.forceRelease(sessionId);
        // Refresh locks
        const result = await window.api.lock?.list?.();
        if (result?.success && result.data) {
          setLocks(result.data);
        }
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
    } finally {
      setReleasing(null);
    }
  };

  const isLockStale = (lock: FileLock): boolean => {
    const declaredAt = new Date(lock.declaredAt);
    const expiresAt = new Date(declaredAt.getTime() + lock.estimatedDuration * 60 * 1000);
    return new Date() > expiresAt;
  };

  const getTimeSinceLock = (declaredAt: string): string => {
    const minutes = Math.round((Date.now() - new Date(declaredAt).getTime()) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">File Coordination</h2>
            <p className="text-sm text-text-secondary">Active file locks across all sessions</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-secondary transition-colors"
          >
            <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-auto max-h-[60vh]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-2 border-kanvas-blue border-t-transparent rounded-full" />
            </div>
          ) : locks.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-tertiary flex items-center justify-center">
                <svg className="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">No Active Locks</h3>
              <p className="text-sm text-text-secondary">
                Files are currently available for editing.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {locks.map((lock) => {
                const isStale = isLockStale(lock);
                const isCurrentSession = lock.sessionId === currentSessionId;

                return (
                  <div
                    key={lock.sessionId}
                    className={`p-4 rounded-xl border transition-all ${
                      isStale
                        ? 'border-yellow-200 bg-yellow-50'
                        : isCurrentSession
                        ? 'border-kanvas-blue/30 bg-kanvas-blue/5'
                        : 'border-border bg-surface-secondary'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            lock.operation === 'edit'
                              ? 'bg-orange-100 text-orange-700'
                              : lock.operation === 'read'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-red-100 text-red-700'
                          }`}>
                            {lock.operation.toUpperCase()}
                          </span>
                          <span className="text-xs text-text-secondary">
                            {lock.agentType}
                          </span>
                          {isCurrentSession && (
                            <span className="px-2 py-0.5 rounded bg-kanvas-blue/10 text-kanvas-blue text-xs">
                              Current Session
                            </span>
                          )}
                          {isStale && (
                            <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-700 text-xs">
                              Stale
                            </span>
                          )}
                        </div>

                        <div className="text-sm text-text-primary font-medium mb-1">
                          Session: {lock.sessionId.slice(0, 20)}...
                        </div>

                        {lock.reason && (
                          <p className="text-sm text-text-secondary mb-2">{lock.reason}</p>
                        )}

                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {lock.files.slice(0, 5).map((file) => (
                            <span
                              key={file}
                              className="px-2 py-0.5 rounded bg-surface text-xs text-text-secondary font-mono"
                            >
                              {file.split('/').pop()}
                            </span>
                          ))}
                          {lock.files.length > 5 && (
                            <span className="px-2 py-0.5 rounded bg-surface text-xs text-text-secondary">
                              +{lock.files.length - 5} more
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-4 text-xs text-text-secondary">
                          <span>Locked {getTimeSinceLock(lock.declaredAt)}</span>
                          <span>Duration: {lock.estimatedDuration}m</span>
                        </div>
                      </div>

                      {(isStale || isCurrentSession) && (
                        <button
                          onClick={() => handleForceRelease(lock.sessionId)}
                          disabled={releasing === lock.sessionId}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            releasing === lock.sessionId
                              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                              : 'bg-red-100 text-red-700 hover:bg-red-200'
                          }`}
                        >
                          {releasing === lock.sessionId ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Releasing...
                            </span>
                          ) : (
                            'Release Lock'
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-surface-secondary">
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              Stale locks (past estimated duration) can be force-released.
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-surface text-text-primary hover:bg-surface-tertiary transition-colors text-sm font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * FileCoordinationButton - Button to open the file coordination panel
 */
export function FileCoordinationButton({
  currentSessionId,
}: {
  currentSessionId?: string;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [lockCount, setLockCount] = useState(0);

  // Poll for lock count
  useEffect(() => {
    async function checkLocks() {
      if (window.api?.lock?.list) {
        const result = await window.api.lock.list();
        if (result.success && result.data) {
          setLockCount(result.data.length);
        }
      }
    }

    checkLocks();
    // Poll for lock count (60 seconds - reduced from 10s for performance)
    const interval = setInterval(checkLocks, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="relative flex-1 py-2 px-2 rounded-xl border border-border text-text-primary text-[13px] leading-5
          hover:bg-surface-secondary transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
        title="File Coordination"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
        </svg>
        Locks
        {lockCount > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-orange-500 text-white text-xs flex items-center justify-center">
            {lockCount}
          </span>
        )}
      </button>

      <FileCoordinationPanel
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        currentSessionId={currentSessionId}
      />
    </>
  );
}
