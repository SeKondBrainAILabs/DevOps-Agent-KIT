/**
 * SettingsModal Component
 * Application settings, credentials, and maintenance
 */

import React, { useState, useEffect, useMemo } from 'react';
import type { AppConfig, AgentType, RepoVersionInfo, RepoVersionSettings, AppUpdateInfo } from '../../../shared/types';
import { useAgentStore } from '../../store/agentStore';

interface SettingsModalProps {
  onClose: () => void;
}

interface OrphanedSession {
  sessionId: string;
  repoPath: string;
  sessionData: {
    task?: string;
    branchName?: string;
    agentType?: string;
  };
  lastModified: Date;
}

const agentTypes: { value: AgentType; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'cline', label: 'Cline' },
  { value: 'aider', label: 'Aider' },
  { value: 'warp', label: 'Warp' },
  { value: 'custom', label: 'Custom' },
];

interface McpStatus {
  port: number | null;
  url: string | null;
  isRunning: boolean;
  connectionCount: number;
  startedAt: string | null;
}

type Tab = 'general' | 'credentials' | 'maintenance' | 'mcp' | 'debug';

export function SettingsModal({ onClose }: SettingsModalProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [groqApiKey, setGroqApiKey] = useState('');
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  // Maintenance state
  const [orphanedSessions, setOrphanedSessions] = useState<OrphanedSession[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>('');

  // Debug log state
  const [logStats, setLogStats] = useState<{ memoryEntries: number; fileSize: number; rotatedFiles: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isClearingLogs, setIsClearingLogs] = useState(false);

  // MCP server state
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [claudeCodeConfig, setClaudeCodeConfig] = useState<{
    installed: boolean;
    path: string;
    currentUrl: string | null;
    portMismatch: boolean;
  } | null>(null);
  const [claudeDesktopConfig, setClaudeDesktopConfig] = useState<{
    installed: boolean;
    path: string;
    currentUrl: string | null;
    portMismatch: boolean;
  } | null>(null);
  const [isInstallingMcp, setIsInstallingMcp] = useState<string | null>(null);
  const [manualSetupOpen, setManualSetupOpen] = useState(false);
  const [mcpJsonCopied, setMcpJsonCopied] = useState<string | null>(null);

  // Version management state
  const [selectedRepoPath, setSelectedRepoPath] = useState<string>('');
  const [repoVersion, setRepoVersion] = useState<RepoVersionInfo | null>(null);
  const [versionError, setVersionError] = useState<string>('');
  const [versionSettings, setVersionSettings] = useState<RepoVersionSettings>({ autoVersionBump: true });
  const [isBumping, setIsBumping] = useState(false);

  // Auto-update state
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  // Derive unique repos from reported sessions
  const reportedSessions = useAgentStore((s) => s.reportedSessions);
  const selectedSessionId = useAgentStore((s) => s.selectedSessionId);
  const uniqueRepos = useMemo(() => {
    const repos = new Map<string, string>(); // repoPath -> repoName
    reportedSessions.forEach((session) => {
      if (session.repoPath && !repos.has(session.repoPath)) {
        const name = session.repoPath.split('/').pop() || session.repoPath;
        repos.set(session.repoPath, name);
      }
    });
    return repos;
  }, [reportedSessions]);

  // Load settings
  useEffect(() => {
    window.api.config.getAll().then((result) => {
      if (result.success && result.data) {
        setConfig(result.data);
      }
    });

    window.api.credential.has('groqApiKey').then((result) => {
      if (result.success) {
        setHasGroqKey(result.data ?? false);
      }
    });

    window.api.app.getVersion().then((version) => {
      setAppVersion(version);
    });

    // Load current update status
    window.api.update?.getStatus?.().then((result) => {
      if (result?.success && result.data) {
        setUpdateInfo(result.data);
      }
    });

    // Listen for update events
    const unsubs = [
      window.api.update?.onAvailable?.((info) => setUpdateInfo(info)),
      window.api.update?.onNotAvailable?.((info) => { setUpdateInfo(info); setIsCheckingUpdate(false); }),
      window.api.update?.onProgress?.((info) => setUpdateInfo(info)),
      window.api.update?.onDownloaded?.((info) => setUpdateInfo(info)),
      window.api.update?.onError?.((info) => { setUpdateInfo(info); setIsCheckingUpdate(false); }),
    ];
    return () => { unsubs.forEach((fn) => fn?.()); };
  }, []);

  // Auto-select repo from currently selected session, or first available
  useEffect(() => {
    if (selectedRepoPath) return; // already selected
    // Try to use the currently selected session's repo
    if (selectedSessionId) {
      const session = reportedSessions.get(selectedSessionId);
      if (session?.repoPath) {
        setSelectedRepoPath(session.repoPath);
        return;
      }
    }
    // Fall back to first available repo
    const firstRepo = uniqueRepos.keys().next().value;
    if (firstRepo) {
      setSelectedRepoPath(firstRepo);
    }
  }, [selectedSessionId, reportedSessions, uniqueRepos, selectedRepoPath]);

  // Fetch version and settings when selectedRepoPath changes
  useEffect(() => {
    if (!selectedRepoPath) {
      setRepoVersion(null);
      setVersionError('');
      return;
    }
    setVersionError('');
    window.api.version.getRepoVersion(selectedRepoPath).then((result) => {
      if (result.success && result.data) {
        setRepoVersion(result.data);
        setVersionError('');
      } else {
        setRepoVersion(null);
        setVersionError(result.error?.code === 'NO_PACKAGE_JSON' ? 'No package.json found' : (result.error?.message || 'Failed to read version'));
      }
    });
    window.api.version.getSettings(selectedRepoPath).then((result) => {
      if (result.success && result.data) {
        setVersionSettings(result.data);
      }
    });
  }, [selectedRepoPath]);

  const handleBump = async (component: 'major' | 'minor' | 'patch') => {
    if (!selectedRepoPath || isBumping) return;
    setIsBumping(true);
    setMessage(null);
    try {
      const result = await window.api.version.bump(selectedRepoPath, component);
      if (result.success && result.data) {
        setRepoVersion(result.data);
        setMessage({ type: 'success', text: `Version bumped to ${result.data.version}` });
      } else {
        setMessage({ type: 'error', text: result.error?.message || 'Failed to bump version' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to bump version' });
    } finally {
      setIsBumping(false);
    }
  };

  const handleAutoVersionBumpToggle = async (enabled: boolean) => {
    const newSettings = { ...versionSettings, autoVersionBump: enabled };
    setVersionSettings(newSettings);
    if (selectedRepoPath) {
      await window.api.version.setSettings(selectedRepoPath, newSettings);
    }
  };

  const handleSaveGeneral = async () => {
    if (!config) return;
    setIsSaving(true);
    setMessage(null);

    try {
      await window.api.config.set('theme', config.theme);
      await window.api.config.set('defaultAgentType', config.defaultAgentType);
      await window.api.config.set('autoWatch', config.autoWatch);
      await window.api.config.set('autoPush', config.autoPush);
      setMessage({ type: 'success', text: 'Settings saved successfully' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCredentials = async () => {
    if (!groqApiKey.trim()) {
      setMessage({ type: 'error', text: 'Please enter an API key' });
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      const result = await window.api.credential.set('groqApiKey', groqApiKey.trim());
      if (result.success) {
        setHasGroqKey(true);
        setGroqApiKey('');
        setMessage({ type: 'success', text: 'API key saved successfully' });
      } else {
        setMessage({ type: 'error', text: result.error?.message || 'Failed to save API key' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save API key' });
    } finally {
      setIsSaving(false);
    }
  };

  // Maintenance handlers
  const handleScanOrphaned = async () => {
    setIsScanning(true);
    setMessage(null);
    try {
      const result = await window.api.recovery?.scanAll?.();
      if (result?.success && result.data) {
        setOrphanedSessions(result.data);
        setMessage({
          type: 'success',
          text: `Found ${result.data.length} orphaned session(s)`,
        });
      } else {
        setMessage({ type: 'error', text: 'Failed to scan for orphaned sessions' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Scan failed' });
    } finally {
      setIsScanning(false);
    }
  };

  const handleRecoverSession = async (sessionId: string, repoPath: string) => {
    setIsRecovering(true);
    setMessage(null);
    try {
      const result = await window.api.recovery?.recoverSession?.(sessionId, repoPath);
      if (result?.success) {
        setOrphanedSessions(prev => prev.filter(s => s.sessionId !== sessionId));
        setMessage({ type: 'success', text: 'Session recovered successfully' });
      } else {
        setMessage({ type: 'error', text: 'Failed to recover session' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Recovery failed' });
    } finally {
      setIsRecovering(false);
    }
  };

  const handleDeleteOrphaned = async (sessionId: string, repoPath: string) => {
    try {
      const result = await window.api.recovery?.deleteOrphaned?.(sessionId, repoPath);
      if (result?.success) {
        setOrphanedSessions(prev => prev.filter(s => s.sessionId !== sessionId));
        setMessage({ type: 'success', text: 'Orphaned session deleted' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Delete failed' });
    }
  };

  const handleQuickCleanup = async () => {
    if (!selectedRepo) {
      setMessage({ type: 'error', text: 'Please select a repository first' });
      return;
    }
    setIsCleaning(true);
    setMessage(null);
    try {
      const result = await window.api.cleanup?.quick?.(selectedRepo);
      if (result?.success) {
        setMessage({
          type: 'success',
          text: `Cleanup complete: pruned worktrees, removed ${result.data?.kanvasCleanup?.removedSessionFiles || 0} stale files`,
        });
      } else {
        setMessage({ type: 'error', text: 'Cleanup failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Cleanup failed' });
    } finally {
      setIsCleaning(false);
    }
  };

  const handleSelectRepo = async () => {
    const result = await window.api.dialog.openDirectory();
    if (result.success && result.data) {
      setSelectedRepo(result.data);
    }
  };

  const handleClearAllSessions = async () => {
    if (!confirm('Are you sure you want to clear all sessions? This cannot be undone.')) {
      return;
    }
    setIsClearing(true);
    setMessage(null);
    try {
      const result = await window.api.instance?.clearAll?.();
      if (result?.success) {
        setMessage({
          type: 'success',
          text: `Cleared ${result.data?.count || 0} session(s)`,
        });
        // Force reload the page to reset all state
        setTimeout(() => window.location.reload(), 1000);
      } else {
        setMessage({ type: 'error', text: 'Failed to clear sessions' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to clear sessions' });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary border border-border rounded-lg w-full max-w-lg animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-gray-100">Settings</h2>
          <button onClick={onClose} className="btn-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'general'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('credentials')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'credentials'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Credentials
          </button>
          <button
            onClick={() => setActiveTab('maintenance')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'maintenance'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Maintenance
          </button>
          <button
            onClick={() => {
              setActiveTab('mcp');
              // Load MCP status when switching to tab
              window.api?.mcp?.status?.().then((result) => {
                if (result?.success && result.data) setMcpStatus(result.data);
              });
              // Check Claude Code + Desktop config status
              window.api?.mcp?.checkClaudeCodeConfig?.().then((result) => {
                if (result?.success && result.data) setClaudeCodeConfig(result.data);
              });
              window.api?.mcp?.checkClaudeDesktopConfig?.().then((result) => {
                if (result?.success && result.data) setClaudeDesktopConfig(result.data);
              });
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'mcp'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            MCP
          </button>
          <button
            onClick={() => {
              setActiveTab('debug');
              // Load log stats when switching to debug tab
              window.api.debugLog?.getStats?.().then((result) => {
                if (result?.success && result.data) {
                  setLogStats(result.data);
                }
              });
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'debug'
                ? 'text-accent border-b-2 border-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Debug
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {activeTab === 'general' && config && (
            <>
              {/* Repo Version Management */}
              <div className="bg-surface-tertiary rounded-lg p-3 mb-4 space-y-3">
                <div className="text-xs text-gray-500 uppercase tracking-wide">Repo Version</div>

                {uniqueRepos.size === 0 ? (
                  <div className="text-sm text-gray-400">No repos connected</div>
                ) : (
                  <>
                    {/* Repo selector (only if multiple repos) */}
                    {uniqueRepos.size > 1 && (
                      <select
                        value={selectedRepoPath}
                        onChange={(e) => setSelectedRepoPath(e.target.value)}
                        className="select text-sm w-full"
                      >
                        {Array.from(uniqueRepos.entries()).map(([repoPath, name]) => (
                          <option key={repoPath} value={repoPath}>{name}</option>
                        ))}
                      </select>
                    )}

                    {/* Version display or error */}
                    {versionError ? (
                      <div className="text-sm text-gray-400">{versionError}</div>
                    ) : repoVersion ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-mono font-semibold text-gray-100">{repoVersion.version}</span>
                          <span className="text-xs text-gray-500 truncate ml-2">
                            {uniqueRepos.get(selectedRepoPath) || selectedRepoPath.split('/').pop()}
                          </span>
                        </div>

                        {/* Bump buttons */}
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleBump('patch')}
                            disabled={isBumping}
                            className="flex-1 py-1.5 px-2 rounded bg-surface-secondary hover:bg-surface-primary border border-border text-sm text-gray-200 transition-colors disabled:opacity-50"
                          >
                            <div className="font-medium">Patch</div>
                            <div className="text-xs text-gray-500 font-mono">
                              {repoVersion.major}.{repoVersion.minor}.{repoVersion.patch + 1}
                            </div>
                          </button>
                          <button
                            onClick={() => handleBump('minor')}
                            disabled={isBumping}
                            className="flex-1 py-1.5 px-2 rounded bg-surface-secondary hover:bg-surface-primary border border-border text-sm text-gray-200 transition-colors disabled:opacity-50"
                          >
                            <div className="font-medium">Minor</div>
                            <div className="text-xs text-gray-500 font-mono">
                              {repoVersion.major}.{repoVersion.minor + 1}.0
                            </div>
                          </button>
                          <button
                            onClick={() => handleBump('major')}
                            disabled={isBumping}
                            className="flex-1 py-1.5 px-2 rounded bg-surface-secondary hover:bg-surface-primary border border-border text-sm text-gray-200 transition-colors disabled:opacity-50"
                          >
                            <div className="font-medium">Major</div>
                            <div className="text-xs text-gray-500 font-mono">
                              {repoVersion.major + 1}.0.0
                            </div>
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-sm text-gray-400">Loading...</div>
                    )}

                    {/* Separator */}
                    <div className="border-t border-border" />

                    {/* Auto version bump toggle */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-gray-200">Auto version bump</div>
                        <div className="text-xs text-gray-500">Bump on daily rollover</div>
                      </div>
                      <button
                        onClick={() => handleAutoVersionBumpToggle(!versionSettings.autoVersionBump)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          versionSettings.autoVersionBump ? 'bg-accent' : 'bg-gray-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                            versionSettings.autoVersionBump ? 'translate-x-[18px]' : 'translate-x-[2px]'
                          }`}
                        />
                      </button>
                    </div>
                  </>
                )}

                {/* Kanvas Dashboard version + update section */}
                <div className="pt-1 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">
                      Kanvas for Kit v{appVersion || '...'}
                    </span>

                    {/* Update actions */}
                    {updateInfo?.downloaded ? (
                      <button
                        onClick={() => window.api.update?.install?.()}
                        className="px-2 py-0.5 text-xs rounded bg-green-600 hover:bg-green-700 text-white transition-colors"
                      >
                        Restart to Update
                      </button>
                    ) : updateInfo?.downloading ? (
                      <span className="text-xs text-accent">
                        Downloading... {updateInfo.progress ? `${Math.round(updateInfo.progress.percent)}%` : ''}
                      </span>
                    ) : updateInfo?.updateAvailable ? (
                      <button
                        onClick={async () => {
                          try { await window.api.update?.download?.(); } catch {}
                        }}
                        className="px-2 py-0.5 text-xs rounded bg-accent hover:bg-accent/80 text-white transition-colors"
                      >
                        Download v{updateInfo.latestVersion}
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          setIsCheckingUpdate(true);
                          setMessage(null);
                          try {
                            const result = await window.api.update?.check?.();
                            if (result?.success && result.data) {
                              setUpdateInfo(result.data);
                              if (!result.data.updateAvailable) {
                                setMessage({ type: 'success', text: 'You are on the latest version' });
                              }
                            }
                          } catch {
                            setMessage({ type: 'error', text: 'Update check failed' });
                          } finally {
                            setIsCheckingUpdate(false);
                          }
                        }}
                        disabled={isCheckingUpdate}
                        className="px-2 py-0.5 text-xs rounded bg-surface-secondary hover:bg-surface-primary border border-border text-gray-300 transition-colors disabled:opacity-50"
                      >
                        {isCheckingUpdate ? 'Checking...' : 'Check for Updates'}
                      </button>
                    )}
                  </div>

                  {/* Update error */}
                  {updateInfo?.error && (
                    <div className="text-xs text-red-400">
                      Update error: {updateInfo.error}
                    </div>
                  )}

                  {/* Download progress bar */}
                  {updateInfo?.downloading && updateInfo.progress && (
                    <div className="w-full bg-surface-secondary rounded-full h-1.5">
                      <div
                        className="bg-accent h-1.5 rounded-full transition-all"
                        style={{ width: `${updateInfo.progress.percent}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Theme */}
              <div>
                <label className="label">Theme</label>
                <select
                  value={config.theme}
                  onChange={(e) => setConfig({ ...config, theme: e.target.value as AppConfig['theme'] })}
                  className="select"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </div>

              {/* Default agent */}
              <div>
                <label className="label">Default Agent Type</label>
                <select
                  value={config.defaultAgentType}
                  onChange={(e) => setConfig({ ...config, defaultAgentType: e.target.value as AgentType })}
                  className="select"
                >
                  {agentTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Auto watch */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.autoWatch}
                    onChange={(e) => setConfig({ ...config, autoWatch: e.target.checked })}
                    className="w-4 h-4 rounded border-border bg-surface-tertiary"
                  />
                  <span className="text-gray-300">Auto-start file watcher</span>
                </label>
              </div>

              {/* Auto push */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.autoPush}
                    onChange={(e) => setConfig({ ...config, autoPush: e.target.checked })}
                    className="w-4 h-4 rounded border-border bg-surface-tertiary"
                  />
                  <span className="text-gray-300">Auto-push after commits</span>
                </label>
              </div>

              <button
                onClick={handleSaveGeneral}
                className="btn-primary w-full"
                disabled={isSaving}
              >
                {isSaving ? 'Saving...' : 'Save Settings'}
              </button>

              {/* Replay Onboarding */}
              <button
                onClick={async () => {
                  await window.api?.config?.set?.('onboardingCompleted', false);
                  const { useUIStore: uiStore } = await import('../../store/uiStore');
                  uiStore.getState().setShowOnboarding(true);
                  onClose();
                }}
                className="w-full mt-2 py-2 px-4 rounded border border-border text-sm text-text-secondary hover:text-text-primary hover:border-kanvas-blue/50 transition-colors"
              >
                Replay Onboarding Guide
              </button>
            </>
          )}

          {activeTab === 'credentials' && (
            <>
              {/* Groq API Key */}
              <div>
                <label className="label">Groq API Key</label>
                {hasGroqKey ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value="••••••••••••••••"
                      disabled
                      className="input flex-1"
                    />
                    <span className="badge badge-success">Configured</span>
                  </div>
                ) : (
                  <input
                    type="password"
                    value={groqApiKey}
                    onChange={(e) => setGroqApiKey(e.target.value)}
                    placeholder="gsk_..."
                    className="input"
                  />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Get your API key at{' '}
                  <a
                    href="https://console.groq.com/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    console.groq.com
                  </a>
                </p>
              </div>

              {!hasGroqKey && (
                <button
                  onClick={handleSaveCredentials}
                  className="btn-primary w-full"
                  disabled={isSaving || !groqApiKey.trim()}
                >
                  {isSaving ? 'Saving...' : 'Save API Key'}
                </button>
              )}

              {hasGroqKey && (
                <button
                  onClick={() => {
                    setHasGroqKey(false);
                    setGroqApiKey('');
                  }}
                  className="btn-secondary w-full"
                >
                  Update API Key
                </button>
              )}
            </>
          )}

          {activeTab === 'maintenance' && (
            <>
              {/* Session Recovery */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Session Recovery</h3>
                <p className="text-xs text-gray-400">
                  Scan for orphaned sessions in your repositories that can be recovered.
                </p>
                <button
                  onClick={handleScanOrphaned}
                  disabled={isScanning}
                  className="btn-secondary w-full"
                >
                  {isScanning ? 'Scanning...' : 'Scan for Orphaned Sessions'}
                </button>

                {orphanedSessions.length > 0 && (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {orphanedSessions.map((session) => (
                      <div
                        key={session.sessionId}
                        className="flex items-center justify-between p-2 bg-surface-tertiary rounded-lg text-sm"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-200 truncate">
                            {session.sessionData.task || session.sessionData.branchName || 'Unknown'}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
                            {session.repoPath.split('/').pop()}
                          </div>
                        </div>
                        <div className="flex gap-1 ml-2">
                          <button
                            onClick={() => handleRecoverSession(session.sessionId, session.repoPath)}
                            disabled={isRecovering}
                            className="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded"
                          >
                            Recover
                          </button>
                          <button
                            onClick={() => handleDeleteOrphaned(session.sessionId, session.repoPath)}
                            className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border my-4" />

              {/* Clear All Sessions */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Clear All Sessions</h3>
                <p className="text-xs text-gray-400">
                  Remove all sessions from Kanvas. This clears the session list but does not delete files from repositories.
                </p>
                <button
                  onClick={handleClearAllSessions}
                  disabled={isClearing}
                  className="w-full py-2 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {isClearing ? 'Clearing...' : 'Clear All Sessions'}
                </button>
              </div>

              <div className="border-t border-border my-4" />

              {/* Repo Cleanup */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Repository Cleanup</h3>
                <p className="text-xs text-gray-400">
                  Clean up stale worktrees, branches, and Kanvas files.
                </p>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={selectedRepo}
                    placeholder="Select a repository..."
                    readOnly
                    className="input flex-1 text-sm"
                  />
                  <button onClick={handleSelectRepo} className="btn-secondary px-3">
                    Browse
                  </button>
                </div>

                <button
                  onClick={handleQuickCleanup}
                  disabled={isCleaning || !selectedRepo}
                  className="btn-primary w-full"
                >
                  {isCleaning ? 'Cleaning...' : 'Quick Cleanup'}
                </button>

                <p className="text-xs text-gray-500">
                  Quick cleanup will prune stale worktrees and remove old session files.
                </p>
              </div>

              <div className="border-t border-border my-4" />

              {/* Reload App */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Reload App</h3>
                <p className="text-xs text-gray-400">
                  Reload the application to reset all UI state. Sessions and data are preserved.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="btn-secondary w-full"
                >
                  Reload App
                </button>
              </div>
            </>
          )}

          {activeTab === 'mcp' && (
            <>
              {/* MCP Server Status */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">MCP Server</h3>
                <p className="text-xs text-gray-400">
                  The MCP server lets coding agents (Claude Code, Cursor, Cline) commit, lock files, and interact with Kanvas via MCP protocol tools.
                </p>

                <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
                  {/* Status row */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">Status</span>
                    <span className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${mcpStatus?.isRunning ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className={`text-sm font-medium ${mcpStatus?.isRunning ? 'text-green-400' : 'text-red-400'}`}>
                        {mcpStatus?.isRunning ? 'Running' : 'Stopped'}
                      </span>
                    </span>
                  </div>

                  {/* Port */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">Port</span>
                    <span className="text-sm font-mono text-gray-200">
                      {mcpStatus?.port || '—'}
                    </span>
                  </div>

                  {/* Connections */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">Active Connections</span>
                    <span className="text-sm font-mono text-gray-200">
                      {mcpStatus?.connectionCount ?? 0}
                    </span>
                  </div>

                  {/* Uptime */}
                  {mcpStatus?.startedAt && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-300">Started</span>
                      <span className="text-sm text-gray-200">
                        {new Date(mcpStatus.startedAt).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                </div>

                {/* URL + Copy */}
                {mcpStatus?.url && (
                  <div className="space-y-1.5">
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Server URL</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={mcpStatus.url}
                        readOnly
                        className="input flex-1 font-mono text-sm"
                      />
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(mcpStatus.url!);
                          setMcpCopied(true);
                          setTimeout(() => setMcpCopied(false), 2000);
                        }}
                        className="btn-secondary px-3"
                        title="Copy URL"
                      >
                        {mcpCopied ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-border my-4" />

              {/* Available Tools */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Available MCP Tools</h3>
                <p className="text-xs text-gray-400">
                  These tools are exposed to connected agents via the MCP protocol.
                </p>
                <div className="bg-surface-tertiary rounded-lg divide-y divide-border text-sm">
                  {[
                    { name: 'kit_commit', desc: 'Stage, commit, record, and optionally push' },
                    { name: 'kit_commit_all', desc: 'Commit across all repos in multi-repo session' },
                    { name: 'kit_lock_file', desc: 'Declare file edit intent (conflict detection)' },
                    { name: 'kit_unlock_file', desc: 'Release file locks' },
                    { name: 'kit_get_session_info', desc: 'Session config and metadata' },
                    { name: 'kit_log_activity', desc: 'Log to KIT dashboard timeline' },
                    { name: 'kit_get_commit_history', desc: 'Recent commits for session branch' },
                    { name: 'kit_request_review', desc: 'Signal work ready for review' },
                  ].map((tool) => (
                    <div key={tool.name} className="px-3 py-2 flex items-center gap-3">
                      <span className="font-mono text-accent text-xs">{tool.name}</span>
                      <span className="text-gray-400 text-xs">{tool.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-border my-4" />

              {/* Agent MCP Setup */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Agent Setup</h3>
                <p className="text-xs text-gray-400">
                  One-click install for supported tools. For other agents (Cursor, Cline), use Manual Setup below to copy the JSON config.
                </p>

                {/* Claude Code row */}
                {(() => {
                  const cfg = claudeCodeConfig;
                  const isInstalled = cfg?.installed && !cfg?.portMismatch;
                  const isMismatch = cfg?.installed && cfg?.portMismatch;
                  return (
                    <div className={`rounded-lg p-3 text-sm ${
                      isInstalled ? 'bg-green-500/10 border border-green-500/30'
                        : isMismatch ? 'bg-yellow-500/10 border border-yellow-500/30'
                        : 'bg-surface-tertiary border border-border'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-200 font-medium">Claude Code</span>
                          <span className="text-xs text-gray-500 font-mono">~/.claude/settings.json</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {isInstalled && (
                            <>
                              <span className="text-green-400 text-xs flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                Installed
                              </span>
                              <button
                                onClick={async () => {
                                  await window.api?.mcp?.uninstallClaudeCode?.();
                                  const result = await window.api?.mcp?.checkClaudeCodeConfig?.();
                                  if (result?.success && result.data) setClaudeCodeConfig(result.data);
                                  setMessage({ type: 'success', text: 'Removed from Claude Code' });
                                }}
                                className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                              >
                                Remove
                              </button>
                            </>
                          )}
                          {isMismatch && (
                            <button
                              onClick={async () => {
                                setIsInstallingMcp('claude-code');
                                try {
                                  await window.api?.mcp?.installClaudeCode?.();
                                  const check = await window.api?.mcp?.checkClaudeCodeConfig?.();
                                  if (check?.success && check.data) setClaudeCodeConfig(check.data);
                                  setMessage({ type: 'success', text: 'Claude Code config updated' });
                                } finally { setIsInstallingMcp(null); }
                              }}
                              disabled={isInstallingMcp === 'claude-code'}
                              className="text-xs bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 px-2 py-1 rounded transition-colors"
                            >
                              {isInstallingMcp === 'claude-code' ? 'Updating...' : 'Update Port'}
                            </button>
                          )}
                          {!cfg?.installed && mcpStatus?.isRunning && (
                            <button
                              onClick={async () => {
                                setIsInstallingMcp('claude-code');
                                try {
                                  const result = await window.api?.mcp?.installClaudeCode?.();
                                  if (result?.success) {
                                    setMessage({ type: 'success', text: 'Installed for Claude Code' });
                                  } else {
                                    setMessage({ type: 'error', text: `Failed: ${(result as any)?.error?.message || 'Unknown'}` });
                                  }
                                  const check = await window.api?.mcp?.checkClaudeCodeConfig?.();
                                  if (check?.success && check.data) setClaudeCodeConfig(check.data);
                                } finally { setIsInstallingMcp(null); }
                              }}
                              disabled={isInstallingMcp === 'claude-code'}
                              className="text-xs bg-accent/20 text-accent hover:bg-accent/30 px-2 py-1 rounded transition-colors"
                            >
                              {isInstallingMcp === 'claude-code' ? 'Installing...' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>
                      {isMismatch && (
                        <p className="text-xs text-yellow-400/70 mt-1">
                          Port changed: {cfg?.currentUrl} &rarr; {mcpStatus?.url}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Claude Desktop row */}
                {(() => {
                  const cfg = claudeDesktopConfig;
                  const isInstalled = cfg?.installed && !cfg?.portMismatch;
                  const isMismatch = cfg?.installed && cfg?.portMismatch;
                  return (
                    <div className={`rounded-lg p-3 text-sm ${
                      isInstalled ? 'bg-green-500/10 border border-green-500/30'
                        : isMismatch ? 'bg-yellow-500/10 border border-yellow-500/30'
                        : 'bg-surface-tertiary border border-border'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-200 font-medium">Claude Desktop</span>
                          <span className="text-xs text-gray-500 font-mono truncate max-w-[180px]">claude_desktop_config.json</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {isInstalled && (
                            <>
                              <span className="text-green-400 text-xs flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                Installed
                              </span>
                              <button
                                onClick={async () => {
                                  await window.api?.mcp?.uninstallClaudeDesktop?.();
                                  const result = await window.api?.mcp?.checkClaudeDesktopConfig?.();
                                  if (result?.success && result.data) setClaudeDesktopConfig(result.data);
                                  setMessage({ type: 'success', text: 'Removed from Claude Desktop' });
                                }}
                                className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                              >
                                Remove
                              </button>
                            </>
                          )}
                          {isMismatch && (
                            <button
                              onClick={async () => {
                                setIsInstallingMcp('claude-desktop');
                                try {
                                  await window.api?.mcp?.installClaudeDesktop?.();
                                  const check = await window.api?.mcp?.checkClaudeDesktopConfig?.();
                                  if (check?.success && check.data) setClaudeDesktopConfig(check.data);
                                  setMessage({ type: 'success', text: 'Claude Desktop config updated' });
                                } finally { setIsInstallingMcp(null); }
                              }}
                              disabled={isInstallingMcp === 'claude-desktop'}
                              className="text-xs bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 px-2 py-1 rounded transition-colors"
                            >
                              {isInstallingMcp === 'claude-desktop' ? 'Updating...' : 'Update Port'}
                            </button>
                          )}
                          {!cfg?.installed && mcpStatus?.isRunning && (
                            <button
                              onClick={async () => {
                                setIsInstallingMcp('claude-desktop');
                                try {
                                  const result = await window.api?.mcp?.installClaudeDesktop?.();
                                  if (result?.success) {
                                    setMessage({ type: 'success', text: 'Installed for Claude Desktop' });
                                  } else {
                                    setMessage({ type: 'error', text: `Failed: ${(result as any)?.error?.message || 'Unknown'}` });
                                  }
                                  const check = await window.api?.mcp?.checkClaudeDesktopConfig?.();
                                  if (check?.success && check.data) setClaudeDesktopConfig(check.data);
                                } finally { setIsInstallingMcp(null); }
                              }}
                              disabled={isInstallingMcp === 'claude-desktop'}
                              className="text-xs bg-accent/20 text-accent hover:bg-accent/30 px-2 py-1 rounded transition-colors"
                            >
                              {isInstallingMcp === 'claude-desktop' ? 'Installing...' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>
                      {isMismatch && (
                        <p className="text-xs text-yellow-400/70 mt-1">
                          Port changed: {cfg?.currentUrl} &rarr; {mcpStatus?.url}
                        </p>
                      )}
                    </div>
                  );
                })()}

                <p className="text-xs text-gray-500">
                  Restart the target app after installing to pick up the new config.
                </p>
              </div>

              <div className="border-t border-border my-4" />

              {/* Manual Setup (collapsible) */}
              <div className="space-y-3">
                <button
                  onClick={() => setManualSetupOpen(!manualSetupOpen)}
                  className="flex items-center gap-2 text-sm font-medium text-gray-200 hover:text-white transition-colors w-full"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`transition-transform ${manualSetupOpen ? 'rotate-90' : ''}`}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  Manual Setup
                </button>

                {manualSetupOpen && mcpStatus?.url && (
                  <div className="space-y-4 pl-5">
                    {/* Global settings.json */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-gray-500 uppercase tracking-wide">~/.claude/settings.json</label>
                      <div className="bg-surface-tertiary rounded-lg p-3 relative">
                        <pre className="text-xs font-mono text-gray-300 whitespace-pre overflow-x-auto pr-8">
{JSON.stringify({ mcpServers: { kit: { type: 'streamable-http', url: mcpStatus.url } } }, null, 2)}
                        </pre>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify({ mcpServers: { kit: { type: 'streamable-http', url: mcpStatus.url } } }, null, 2));
                            setMcpJsonCopied('global');
                            setTimeout(() => setMcpJsonCopied(null), 2000);
                          }}
                          className="absolute top-2 right-2 btn-secondary px-2 py-1 text-xs"
                        >
                          {mcpJsonCopied === 'global' ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>

                    {/* .mcp.json */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-gray-500 uppercase tracking-wide">.mcp.json (project root)</label>
                      <div className="bg-surface-tertiary rounded-lg p-3 relative">
                        <pre className="text-xs font-mono text-gray-300 whitespace-pre overflow-x-auto pr-8">
{JSON.stringify({ mcpServers: { kit: { type: 'streamable-http', url: mcpStatus.url } } }, null, 2)}
                        </pre>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify({ mcpServers: { kit: { type: 'streamable-http', url: mcpStatus.url } } }, null, 2));
                            setMcpJsonCopied('mcp');
                            setTimeout(() => setMcpJsonCopied(null), 2000);
                          }}
                          className="absolute top-2 right-2 btn-secondary px-2 py-1 text-xs"
                        >
                          {mcpJsonCopied === 'mcp' ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>

                    {/* Refresh button */}
                    <button
                      onClick={() => {
                        window.api?.mcp?.status?.().then((result) => {
                          if (result?.success && result.data) setMcpStatus(result.data);
                        });
                        window.api?.mcp?.checkClaudeCodeConfig?.().then((result) => {
                          if (result?.success && result.data) setClaudeCodeConfig(result.data);
                        });
                        window.api?.mcp?.checkClaudeDesktopConfig?.().then((result) => {
                          if (result?.success && result.data) setClaudeDesktopConfig(result.data);
                        });
                        setMessage({ type: 'success', text: 'MCP status refreshed' });
                      }}
                      className="btn-secondary w-full"
                    >
                      Refresh Status
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'debug' && (
            <>
              {/* Log Statistics */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Debug Logs</h3>
                <p className="text-xs text-gray-400">
                  Export debug logs to share with support or diagnose issues.
                </p>

                {logStats && (
                  <div className="bg-surface-tertiary rounded-lg p-3 space-y-1 text-sm">
                    <div className="flex justify-between text-gray-300">
                      <span>In-memory entries:</span>
                      <span className="font-mono">{logStats.memoryEntries}</span>
                    </div>
                    <div className="flex justify-between text-gray-300">
                      <span>Log file size:</span>
                      <span className="font-mono">{(logStats.fileSize / 1024).toFixed(1)} KB</span>
                    </div>
                    <div className="flex justify-between text-gray-300">
                      <span>Rotated files:</span>
                      <span className="font-mono">{logStats.rotatedFiles}</span>
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setIsExporting(true);
                      setMessage(null);
                      try {
                        const result = await window.api.debugLog?.export?.();
                        if (result?.success && result.data) {
                          // Create and download JSON file
                          const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `kanvas-debug-log-${new Date().toISOString().split('T')[0]}.json`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                          setMessage({ type: 'success', text: `Exported ${result.data.entries.length} log entries` });
                        } else {
                          setMessage({ type: 'error', text: 'Failed to export logs' });
                        }
                      } catch {
                        setMessage({ type: 'error', text: 'Export failed' });
                      } finally {
                        setIsExporting(false);
                      }
                    }}
                    disabled={isExporting}
                    className="btn-primary flex-1"
                  >
                    {isExporting ? 'Exporting...' : 'Export Logs'}
                  </button>

                  <button
                    onClick={() => {
                      window.api.debugLog?.openFolder?.();
                    }}
                    className="btn-secondary px-4"
                    title="Open log folder"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>
                </div>
              </div>

              <div className="border-t border-border my-4" />

              {/* Clear Logs */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Clear Logs</h3>
                <p className="text-xs text-gray-400">
                  Remove all debug logs from memory and disk.
                </p>
                <button
                  onClick={async () => {
                    if (!confirm('Are you sure you want to clear all debug logs?')) return;
                    setIsClearingLogs(true);
                    setMessage(null);
                    try {
                      const result = await window.api.debugLog?.clear?.();
                      if (result?.success) {
                        setLogStats({ memoryEntries: 0, fileSize: 0, rotatedFiles: 0 });
                        setMessage({ type: 'success', text: 'Debug logs cleared' });
                      } else {
                        setMessage({ type: 'error', text: 'Failed to clear logs' });
                      }
                    } catch {
                      setMessage({ type: 'error', text: 'Clear failed' });
                    } finally {
                      setIsClearingLogs(false);
                    }
                  }}
                  disabled={isClearingLogs}
                  className="btn-secondary w-full"
                >
                  {isClearingLogs ? 'Clearing...' : 'Clear All Logs'}
                </button>
              </div>
            </>
          )}

          {/* Message */}
          {message && (
            <div
              className={`p-3 rounded-md text-sm ${
                message.type === 'success'
                  ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}
            >
              {message.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
