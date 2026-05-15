/**
 * AddWorkspaceDialog (Epic A / story A4–A5 — MVP)
 *
 * Modal that captures a workspace path + optional scan depth & ignore
 * globs, then calls window.api.workspace.add().
 */

import React, { useState } from 'react';
import {
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_SCAN_DEPTH,
} from '../../../shared/workspace-helpers';

export interface AddWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded?: () => void;
}

export function AddWorkspaceDialog({
  open,
  onClose,
  onAdded,
}: AddWorkspaceDialogProps): React.ReactElement | null {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [scanDepth, setScanDepth] = useState(DEFAULT_SCAN_DEPTH);
  const [ignoreGlobs, setIgnoreGlobs] = useState<string>(DEFAULT_IGNORE_GLOBS.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  async function handleBrowse(): Promise<void> {
    setError(null);
    try {
      const result = await window.api.dialog.openDirectory();
      if (result.success && result.data) {
        setPath(result.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick folder');
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!path.trim()) {
      setError('Please pick a folder.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await window.api.workspace.add({
        path: path.trim(),
        name: name.trim() || undefined,
        scanDepth,
        ignoreGlobs: ignoreGlobs
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean),
      });
      if (!result.success) {
        setError(result.error?.message || 'Failed to add workspace');
        return;
      }
      onAdded?.();
      onClose();
      // Reset
      setPath('');
      setName('');
      setScanDepth(DEFAULT_SCAN_DEPTH);
      setIgnoreGlobs(DEFAULT_IGNORE_GLOBS.join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-testid="add-workspace-dialog"
    >
      <div className="bg-surface-secondary border border-border rounded-lg w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Workspace</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="label text-sm text-text-primary">Folder</label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/me/work"
                className="input flex-1 px-2 py-1 border border-border rounded bg-surface text-text-primary"
                disabled={submitting}
                data-testid="workspace-path-input"
              />
              <button
                type="button"
                onClick={handleBrowse}
                disabled={submitting}
                className="px-3 py-1 border border-border rounded text-text-primary hover:bg-surface-tertiary"
                data-testid="browse-button"
              >
                Browse
              </button>
            </div>
          </div>

          <div>
            <label className="label text-sm text-text-primary">Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to folder basename"
              className="input w-full mt-1 px-2 py-1 border border-border rounded bg-surface text-text-primary"
              disabled={submitting}
              data-testid="workspace-name-input"
            />
          </div>

          <div>
            <label className="label text-sm text-text-primary">Scan depth</label>
            <input
              type="number"
              min={0}
              max={10}
              value={scanDepth}
              onChange={(e) => setScanDepth(Number(e.target.value))}
              className="input w-full mt-1 px-2 py-1 border border-border rounded bg-surface text-text-primary"
              disabled={submitting}
              data-testid="scan-depth-input"
            />
            <p className="text-[11px] text-text-secondary mt-1">
              How many directory levels deep to scan for git repos. Default 2.
            </p>
          </div>

          <div>
            <label className="label text-sm text-text-primary">Ignore folders (comma-separated)</label>
            <input
              type="text"
              value={ignoreGlobs}
              onChange={(e) => setIgnoreGlobs(e.target.value)}
              className="input w-full mt-1 px-2 py-1 border border-border rounded bg-surface text-text-primary"
              disabled={submitting}
              data-testid="ignore-globs-input"
            />
          </div>

          {error && (
            <div
              className="p-2 bg-red-500/10 border border-red-500/30 rounded text-red-500 text-sm"
              data-testid="add-workspace-error"
            >
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-3 py-2 border border-border rounded text-text-primary hover:bg-surface-tertiary"
              data-testid="cancel-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 px-3 py-2 bg-kanvas-blue text-white rounded hover:opacity-90 disabled:opacity-50"
              data-testid="submit-button"
            >
              {submitting ? 'Adding…' : 'Add Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
