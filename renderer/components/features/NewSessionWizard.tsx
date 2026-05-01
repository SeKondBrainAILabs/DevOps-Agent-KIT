/**
 * NewSessionWizard Component
 * Modal form for creating new sessions
 */

import React, { useEffect, useState } from 'react';
import type { AgentType, WorktreeMode } from '../../../shared/types';
import { evaluateSingleSessionGuard } from '../../../shared/single-session-guard';

interface NewSessionWizardProps {
  onClose: () => void;
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

export function NewSessionWizard({
  onClose,
}: NewSessionWizardProps): React.ReactElement {
  const [repoPath, setRepoPath] = useState('');
  const [taskName, setTaskName] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // C5 Single-Session Mode: when worktrees are disabled for the chosen repo
  // and an active session exists, block the "Create Session" CTA.
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>('worktree');
  const [activeSessionCount, setActiveSessionCount] = useState(0);

  useEffect(() => {
    if (!repoPath) {
      setWorktreeMode('worktree');
      setActiveSessionCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [modeRes, countRes] = await Promise.all([
          window.api.repoWorkspace.getWorktreeMode(repoPath),
          window.api.repoWorkspace.getActiveSessionCount(repoPath),
        ]);
        if (cancelled) return;
        if (modeRes.success && modeRes.data) setWorktreeMode(modeRes.data);
        if (countRes.success && typeof countRes.data === 'number') {
          setActiveSessionCount(countRes.data);
        }
      } catch {
        // Non-fatal — fall back to default (allow creation)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const singleSessionGuard = evaluateSingleSessionGuard(worktreeMode, activeSessionCount);

  const handleSelectDirectory = async () => {
    const result = await window.api.dialog.openDirectory();
    if (result.success && result.data) {
      setRepoPath(result.data);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!repoPath) {
      setError('Please select a repository');
      return;
    }

    if (!taskName) {
      setError('Please enter a task name');
      return;
    }

    setIsCreating(true);

    try {
      const result = await window.api.session.create({
        repoPath,
        task: taskName,
        agentType,
      });

      if (result.success) {
        onClose();
      } else {
        setError(result.error?.message || 'Failed to create session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary border border-border rounded-lg w-full max-w-md animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-gray-100">New Session</h2>
          <button
            onClick={onClose}
            className="btn-icon"
            disabled={isCreating}
          >
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

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Repository Path */}
          <div>
            <label className="label">Repository</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/path/to/repository"
                className="input flex-1"
                disabled={isCreating}
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                className="btn-secondary"
                disabled={isCreating}
              >
                Browse
              </button>
            </div>
          </div>

          {/* Task Name */}
          <div>
            <label className="label">Task Name</label>
            <input
              type="text"
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              placeholder="feature-login-page"
              className="input"
              disabled={isCreating}
            />
            <p className="text-xs text-gray-500 mt-1">
              Use kebab-case for best results (e.g., add-user-auth)
            </p>
          </div>

          {/* Agent Type */}
          <div>
            <label className="label">Agent Type</label>
            <select
              value={agentType}
              onChange={(e) => setAgentType(e.target.value as AgentType)}
              className="select"
              disabled={isCreating}
            >
              {agentTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Single-Session Mode notice (C5) */}
          {singleSessionGuard.blocked && (
            <div
              className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-md text-amber-300 text-sm"
              data-testid="single-session-mode-notice"
            >
              <strong>Single-Session Mode active.</strong>{' '}
              {singleSessionGuard.error?.message}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary flex-1"
              disabled={isCreating}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={isCreating || singleSessionGuard.blocked}
              title={
                singleSessionGuard.blocked
                  ? singleSessionGuard.error?.message
                  : undefined
              }
            >
              {isCreating ? 'Creating...' : 'Create Session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
