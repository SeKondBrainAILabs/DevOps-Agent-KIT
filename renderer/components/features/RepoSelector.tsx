/**
 * RepoSelector Component
 * Repository selection with validation and recent repos list
 */

import React, { useState, useEffect } from 'react';
import type { RepoValidation, RecentRepo } from '../../../shared/types';

interface RepoSelectorProps {
  selectedPath: string | null;
  onSelect: (path: string, validation: RepoValidation) => void;
  error?: string;
}

export function RepoSelector({ selectedPath, onSelect, error }: RepoSelectorProps): React.ReactElement {
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [validation, setValidation] = useState<RepoValidation | null>(null);

  // Load recent repos on mount
  useEffect(() => {
    window.api.instance.getRecentRepos().then((result) => {
      if (result.success && result.data) {
        setRecentRepos(result.data);
      }
    });
  }, []);

  // Validate when path changes
  useEffect(() => {
    if (selectedPath) {
      validatePath(selectedPath);
    }
  }, [selectedPath]);

  const validatePath = async (path: string) => {
    setIsValidating(true);
    try {
      const result = await window.api.instance.validateRepo(path);

      if (result.success && result.data) {
        // Happy path: we got a RepoValidation object from the main process
        setValidation(result.data);
        if (result.data.isValid) {
          onSelect(path, result.data);
        }
      } else {
        // Validation failed at the IPC layer (e.g. git not available, command error, etc.)
        console.error('Repository validation failed:', result.error);
        setValidation({
          isValid: false,
          isGitRepo: false,
          repoName: '',
          currentBranch: '',
          remoteUrl: undefined,
          hasKanvasDir: false,
          branches: [],
          error: result.error?.message || 'Failed to validate repository',
        });
      }
    } catch (err) {
      console.error('Validation error:', err);
      setValidation({
        isValid: false,
        isGitRepo: false,
        repoName: '',
        currentBranch: '',
        remoteUrl: undefined,
        hasKanvasDir: false,
        branches: [],
        error: err instanceof Error ? err.message : 'Unexpected validation error',
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleBrowse = async () => {
    const result = await window.api.dialog.openDirectory();
    if (result.success && result.data) {
      validatePath(result.data);
    }
  };

  const handleSelectRecent = (repo: RecentRepo) => {
    validatePath(repo.path);
  };

  const handleRemoveRecent = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    await window.api.instance.removeRecentRepo(path);
    setRecentRepos(recentRepos.filter(r => r.path !== path));
  };

  return (
    <div className="space-y-4">
      {/* Browse button */}
      <div>
        <label className="label">Repository Folder</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={selectedPath || ''}
            readOnly
            placeholder="Select a repository folder..."
            className="input flex-1"
          />
          <button
            type="button"
            onClick={handleBrowse}
            className="btn-secondary whitespace-nowrap"
          >
            Browse...
          </button>
        </div>
      </div>

      {/* Validation status */}
      {selectedPath && (
        <div className={`p-4 rounded-[14px] border ${
          isValidating
            ? 'bg-surface-secondary border-[rgba(0,0,0,0.10)]'
            : validation?.isValid
            ? 'bg-green-50 border-green-200'
            : 'bg-red-50 border-red-200'
        }`}>
          {isValidating ? (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-kanvas-blue border-t-transparent rounded-full animate-spin" />
              <span className="text-text-secondary">Validating repository...</span>
            </div>
          ) : validation?.isValid ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-green-700">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="font-medium">{validation.repoName}</span>
              </div>
              <div className="flex items-center gap-4 text-sm text-text-secondary">
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  {validation.currentBranch}
                </span>
                {validation.remoteUrl && (
                  <span className="truncate max-w-[200px]" title={validation.remoteUrl}>
                    {validation.remoteUrl}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-red-700">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span>{validation?.error || error || 'Invalid repository'}</span>
            </div>
          )}
        </div>
      )}

      {/* Recent repos */}
      {recentRepos.length > 0 && !selectedPath && (
        <div>
          <label className="label">Recent Repositories</label>
          <div className="space-y-2">
            {recentRepos.map((repo) => (
              <button
                key={repo.path}
                type="button"
                onClick={() => handleSelectRecent(repo)}
                className="w-full p-3 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface hover:bg-surface-secondary
                         flex items-center gap-3 text-left transition-colors group"
              >
                <div className="w-10 h-10 rounded-lg bg-kanvas-blue/10 flex items-center justify-center">
                  <svg className="w-5 h-5 text-kanvas-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-text-primary truncate">{repo.name}</p>
                  <p className="text-sm text-text-secondary truncate">{repo.path}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">
                    {repo.agentCount} session{repo.agentCount !== 1 ? 's' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => handleRemoveRecent(e, repo.path)}
                    className="p-1 rounded-full opacity-0 group-hover:opacity-100 hover:bg-red-100 text-text-secondary hover:text-red-600 transition-all"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
