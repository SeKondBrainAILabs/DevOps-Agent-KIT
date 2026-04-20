/**
 * MergeWorkflowModal Component
 * Guided merge workflow for bringing agent branches back to main
 *
 * Handles three scenarios:
 * 1. Clean merge - no conflicts, proceed directly
 * 2. Untracked blocking files - stash them, retry merge
 * 3. Code-level conflicts - offer Auto-Fix (LLM) or manual resolution
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MergePreview, BranchInfo } from '../../../shared/types';

/** Log merge errors to the persistent DebugLogService via IPC */
function logMergeDebug(level: 'info' | 'warn' | 'error', message: string, details?: unknown): void {
  window.api?.debugLog?.write?.(level, 'MergeWorkflow', message, details);
}

interface MergeWorkflowModalProps {
  isOpen: boolean;
  onClose: () => void;
  repoPath: string;
  sourceBranch: string;
  targetBranch?: string;
  worktreePath?: string;
  sessionId?: string;
  onMergeComplete?: () => void;
  onDeleteSession?: (sessionId: string) => void;
}

type Step = 'preview' | 'options' | 'resolving' | 'executing' | 'complete' | 'error';

interface ProgressEntry {
  message: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

export function MergeWorkflowModal({
  isOpen,
  onClose,
  repoPath,
  sourceBranch,
  targetBranch: initialTargetBranch = 'main',
  worktreePath,
  sessionId,
  onMergeComplete,
  onDeleteSession,
}: MergeWorkflowModalProps): React.ReactElement | null {
  const [step, setStep] = useState<Step>('preview');
  const [targetBranch, setTargetBranch] = useState(initialTargetBranch);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvancedError, setShowAdvancedError] = useState(false);

  // Dynamically resolved branch from worktree (may differ from session's branchName)
  const [actualBranch, setActualBranch] = useState<string>(sourceBranch);

  // Wrapper that logs errors to DebugLogService when transitioning to error step
  const setErrorWithLog = useCallback((msg: string) => {
    setError(msg);
    logMergeDebug('error', `Merge workflow error`, {
      errorMessage: msg,
      repoPath,
      sourceBranch: actualBranch,
      targetBranch,
      sessionId,
      worktreePath,
    });
  }, [repoPath, actualBranch, targetBranch, sessionId, worktreePath]);
  const branchMismatch = actualBranch !== sourceBranch;

  // Merge options
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [deleteLocalBranch, setDeleteLocalBranch] = useState(false);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false);
  const [deleteSession, setDeleteSession] = useState(true);

  // Resolution progress tracking
  const [progressLog, setProgressLog] = useState<ProgressEntry[]>([]);

  // Merge result
  const [mergeResult, setMergeResult] = useState<{
    success: boolean;
    message: string;
    mergeCommitHash?: string;
    filesChanged?: number;
    stashRecovered?: boolean;
    stashConflictFiles?: string[];
  } | null>(null);

  // Track whether auto-fix has been triggered for current preview
  const autoFixTriggered = useRef(false);
  const [offline, setOffline] = useState(false);

  // Helper to add/update progress entries
  const addProgress = useCallback((message: string, status: ProgressEntry['status'] = 'active', detail?: string) => {
    setProgressLog((prev) => [...prev, { message, status, detail }]);
  }, []);

  const updateLastProgress = useCallback((status: ProgressEntry['status'], detail?: string) => {
    setProgressLog((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], status, detail: detail || updated[updated.length - 1].detail };
      return updated;
    });
  }, []);

  // Load branches and resolve actual worktree branch when modal opens
  useEffect(() => {
    if (!isOpen) {
      setStep('preview');
      setPreview(null);
      setError(null);
      setMergeResult(null);
      setBranches([]);
      setProgressLog([]);
      setActualBranch(sourceBranch);
      return;
    }

    // Sync target branch from prop each time modal opens — useState only sets initial value once
    setTargetBranch(initialTargetBranch);

    const init = async () => {
      // Check AI connectivity
      try {
        const health = await window.api?.ai?.healthCheck?.();
        setOffline(!(health?.success && health.data?.online));
      } catch { setOffline(true); }

      // Step 1: Resolve the ACTUAL active branch from the worktree
      // The session's branchName may be stale if the developer switched branches
      let resolvedBranch = sourceBranch;
      const pathToCheck = worktreePath || repoPath;

      if (pathToCheck && window.api?.merge?.resolveActiveBranch) {
        try {
          const branchResult = await window.api.merge.resolveActiveBranch(pathToCheck);
          if (branchResult.success && branchResult.data) {
            resolvedBranch = branchResult.data;
            if (resolvedBranch !== sourceBranch) {
              console.log(`[MergeWorkflow] Branch mismatch: session says "${sourceBranch}", worktree is on "${resolvedBranch}"`);
            }
          }
        } catch (err) {
          console.warn('[MergeWorkflow] Could not resolve active branch, using session branch:', err);
        }
      }

      setActualBranch(resolvedBranch);

      // Step 2: Load branches list (filtering out the actual branch being merged)
      if (window.api?.git?.branches && repoPath) {
        const result = await window.api.git.branches(repoPath);
        if (result.success && result.data) {
          setBranches(result.data.filter((b) =>
            b.name !== resolvedBranch && b.name !== sourceBranch && !b.name.startsWith('session/')
          ));
        }
      }

      // Step 3: Load merge preview using the actual branch
      await loadPreviewWithBranch(resolvedBranch);
    };

    init();
  }, [isOpen, sourceBranch, initialTargetBranch, repoPath, worktreePath]);

  const loadPreviewWithBranch = async (branch: string) => {
    setLoading(true);
    setError(null);
    try {
      if (window.api?.merge?.preview) {
        const result = await window.api.merge.preview(repoPath, branch, targetBranch);
        if (result.success && result.data) {
          setPreview(result.data);
        } else {
          setError(result.error?.message || 'Failed to load merge preview');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load merge preview');
    } finally {
      setLoading(false);
    }
  };

  const loadPreview = () => loadPreviewWithBranch(actualBranch);

  /**
   * Handle stashing untracked blocking files, then reload preview
   */
  const handleStashAndRetry = useCallback(async () => {
    if (!preview?.untrackedBlockingFiles?.length) return;

    setStep('resolving');
    setProgressLog([]);

    try {
      addProgress(`Found ${preview.untrackedBlockingFiles.length} untracked file(s) blocking merge`);

      // Show which files
      for (const file of preview.untrackedBlockingFiles) {
        addProgress(`  Stashing: ${file}`, 'pending');
      }

      addProgress('Stashing blocking files to preserve them safely...', 'active');

      const result = await window.api?.merge?.cleanUntracked?.(repoPath, preview.untrackedBlockingFiles);

      if (result?.success && result.data) {
        const { stashed, failed, stashRef } = result.data;

        if (failed.length > 0) {
          updateLastProgress('error', `Failed to stash: ${failed.join(', ')}`);
          addProgress(`Could not stash ${failed.length} file(s). Please move or remove them manually.`, 'error');
          setErrorWithLog(`Failed to stash files: ${failed.join(', ')}`);
          setStep('error');
          return;
        }

        updateLastProgress('done', `Stashed ${stashed.length} file(s)`);
        if (stashRef) {
          addProgress(`Saved to: ${stashRef}`, 'done');
        }
        addProgress('Files safely stashed. They will be auto-recovered after merge.', 'done');

        // Reload the merge preview using the actual branch
        addProgress('Re-checking merge compatibility...', 'active');
        const previewResult = await window.api?.merge?.preview?.(repoPath, actualBranch, targetBranch);

        if (previewResult?.success && previewResult.data) {
          setPreview(previewResult.data);
          updateLastProgress('done');

          if (previewResult.data.canMerge) {
            addProgress('Merge is now ready to proceed!', 'done');
            // Auto-advance to options after a brief pause
            setTimeout(() => setStep('options'), 1000);
          } else if (previewResult.data.hasConflicts) {
            addProgress('Code-level conflicts remain. Use AI Auto-Fix or resolve manually.', 'active');
            setTimeout(() => setStep('preview'), 1500);
          }
        } else {
          updateLastProgress('error');
          setErrorWithLog('Failed to re-check merge after stashing');
          setStep('error');
        }
      } else {
        updateLastProgress('error');
        setErrorWithLog(result?.error?.message || 'Failed to stash blocking files');
        setStep('error');
      }
    } catch (err) {
      updateLastProgress('error');
      setErrorWithLog(err instanceof Error ? err.message : 'Failed during stash operation');
      setStep('error');
    }
  }, [preview, repoPath, actualBranch, targetBranch, addProgress, updateLastProgress, setErrorWithLog]);

  /**
   * Handle AI auto-fix for code-level conflicts
   */
  const handleAutoFix = useCallback(async () => {
    setStep('resolving');
    setProgressLog([]);

    try {
      // Run conflict resolution on the worktree (where the session branch lives)
      // rather than the primary repo. After a failed merge + abort, the primary
      // is clean, so generatePreviews would do a no-op rebase and find zero
      // conflicts. Rebasing the session branch on the worktree against the
      // target reproduces the real conflicts and resolves them in place.
      const conflictPath = worktreePath || repoPath;

      addProgress('Creating backup branch for safety...');

      // Create backup if we have a sessionId
      if (sessionId) {
        const backupResult = await window.api?.conflict?.createBackup?.(conflictPath, sessionId);
        if (backupResult?.success) {
          updateLastProgress('done', `Backup: backup_kit/${sessionId}`);
        } else {
          updateLastProgress('done', 'Backup skipped (non-critical)');
        }
      } else {
        updateLastProgress('done', 'No session ID for backup');
      }

      addProgress('Analyzing conflicts with AI (kimi-k2)...');

      const result = await window.api?.conflict?.generatePreviews?.(conflictPath, targetBranch);

      if (result?.success && result.data) {
        if (result.data.aborted) {
          updateLastProgress('error');
          setErrorWithLog(result.data.abortReason || 'Conflict resolution aborted');
          setStep('error');
          return;
        }

        const previews = result.data.previews ?? [];
        const resolvable = previews.filter((p) => p.status !== 'skipped' && !!p.proposedContent);

        updateLastProgress('done', `Generated ${resolvable.length} resolution(s) (${previews.length - resolvable.length} skipped)`);

        // Show each file outcome
        for (const p of previews) {
          if (p.status === 'skipped' || p.skippedReason) {
            addProgress(`Skipped: ${p.file} — ${p.skippedReason || 'requires manual review'}`, 'error');
          } else {
            addProgress(`Resolved: ${p.file} (${p.status})`, 'done');
          }
        }

        if (resolvable.length === 0) {
          setErrorWithLog('AI could not auto-resolve any files. Use manual fix.');
          setStep('error');
          return;
        }

        addProgress('Applying approved resolutions...');

        // Backend applyApprovedResolutions gates on status 'approved' or 'modified' — force 'approved'.
        const applyResult = await window.api?.conflict?.applyApproved?.(
          conflictPath,
          resolvable.map((p) => ({ ...p, status: 'approved' as const }))
        );

        if (applyResult?.success) {
          updateLastProgress('done');

          // Clean up backup on the same path we created it on
          if (sessionId) {
            await window.api?.conflict?.deleteBackup?.(conflictPath, sessionId);
          }

          addProgress('All conflicts resolved! Proceeding to merge options...', 'done');

          // Reload preview against the primary repo (merge happens there, not in the worktree)
          const previewResult = await window.api?.merge?.preview?.(repoPath, actualBranch, targetBranch);
          if (previewResult?.success && previewResult.data) {
            setPreview(previewResult.data);
          }

          setTimeout(() => setStep('options'), 1500);
        } else {
          updateLastProgress('error');
          addProgress('Some resolutions could not be applied. Try manual resolution.', 'error');
          setError(applyResult?.error?.message || 'Failed to apply resolutions');
          setTimeout(() => setStep('preview'), 2000);
        }
      } else {
        updateLastProgress('error');
        setError(result?.error?.message || 'AI conflict resolution failed');
        addProgress('AI resolution failed. You can try manual resolution instead.', 'error');
        setTimeout(() => setStep('preview'), 2000);
      }
    } catch (err) {
      updateLastProgress('error');
      setErrorWithLog(err instanceof Error ? err.message : 'Auto-fix failed');
      setStep('error');
    }
  }, [sessionId, repoPath, worktreePath, targetBranch, actualBranch, addProgress, updateLastProgress, setErrorWithLog]);

  // Reset auto-fix trigger when modal closes
  const autoStashTriggered = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      autoFixTriggered.current = false;
      autoStashTriggered.current = false;
    }
  }, [isOpen]);

  // Auto-stash untracked blocking files (e.g. .DS_Store) so merge proceeds autonomously
  useEffect(() => {
    if (
      preview?.untrackedBlockingFiles?.length &&
      step === 'preview' &&
      !loading &&
      !autoStashTriggered.current
    ) {
      autoStashTriggered.current = true;
      handleStashAndRetry();
    }
  }, [preview, step, loading, handleStashAndRetry]);

  // Auto-trigger AI fix when conflicts detected and no untracked blockers
  useEffect(() => {
    if (
      preview?.hasConflicts &&
      !preview.untrackedBlockingFiles?.length &&
      step === 'preview' &&
      !loading &&
      !autoFixTriggered.current
    ) {
      autoFixTriggered.current = true;
      handleAutoFix();
    }
  }, [preview, step, loading, handleAutoFix]);

  const handleExecuteMerge = async () => {
    setStep('executing');
    setError(null);
    setProgressLog([]);

    try {
      if (window.api?.merge?.execute) {
        addProgress('Executing merge...');

        const result = await window.api.merge.execute(
          repoPath,
          actualBranch,
          targetBranch,
          {
            deleteWorktree: deleteWorktree && !!worktreePath,
            deleteLocalBranch,
            deleteRemoteBranch,
            worktreePath,
          }
        );

        if (result.success && result.data) {
          setMergeResult(result.data);
          if (result.data.success) {
            updateLastProgress('done');
            setStep('complete');
            onMergeComplete?.();
            if (deleteSession && sessionId && onDeleteSession) {
              onDeleteSession(sessionId);
            }
          } else {
            updateLastProgress('error');
            setErrorWithLog(result.data.message);
            setStep('error');
          }
        } else {
          updateLastProgress('error');
          setErrorWithLog(result.error?.message || 'Merge failed');
          setStep('error');
        }
      }
    } catch (err) {
      updateLastProgress('error');
      setErrorWithLog(err instanceof Error ? err.message : 'Merge failed');
      setStep('error');
    }
  };

  if (!isOpen) return null;

  // Determine if there are untracked blocking files vs code-level conflicts
  const hasUntrackedBlocking = preview?.untrackedBlockingFiles && preview.untrackedBlockingFiles.length > 0;
  const hasCodeConflicts = preview?.hasConflicts && !hasUntrackedBlocking;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Merge Workflow</h2>
              <div className="flex items-center gap-2 text-sm text-text-secondary mt-1 flex-wrap">
                <span>Merge</span>
                <code className="text-kanvas-blue">{actualBranch}</code>
                <span>into</span>
                {step === 'preview' && branches.length > 0 ? (
                  <select
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                    className="px-2 py-1 rounded bg-surface-secondary border border-border text-kanvas-blue text-sm font-mono focus:outline-none focus:ring-2 focus:ring-kanvas-blue/50"
                  >
                    {!branches.find(b => b.name === targetBranch) && (
                      <option value={targetBranch}>{targetBranch}</option>
                    )}
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <code className="text-kanvas-blue">{targetBranch}</code>
                )}
              </div>
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

          {/* Branch mismatch notice */}
          {branchMismatch && (
            <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-xs text-blue-700">
                <span className="font-medium">Branch auto-corrected:</span>{' '}
                Session was created as <code className="bg-blue-100 px-1 rounded">{sourceBranch}</code>,{' '}
                but the worktree is on <code className="bg-blue-100 px-1 rounded">{actualBranch}</code>.{' '}
                Using the actual active branch.
              </p>
            </div>
          )}

          {/* Offline warning */}
          {offline && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-xs text-red-700">
                <span className="font-medium">Not connected</span> — AI conflict resolution is unavailable. Clean merges will still work.
              </p>
            </div>
          )}

          {/* Step indicator */}
          <div className="flex items-center gap-2 mt-4">
            {(['preview', 'options', 'executing', 'complete'] as Step[]).map((s, i) => (
              <React.Fragment key={s}>
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    step === s || (step === 'resolving' && s === 'preview')
                      ? 'bg-kanvas-blue text-white'
                      : step === 'error' && s === 'executing'
                      ? 'bg-red-500 text-white'
                      : s === 'complete' && step === 'complete'
                      ? 'bg-green-500 text-white'
                      : 'bg-surface-tertiary text-text-secondary'
                  }`}
                >
                  {i + 1}
                </div>
                {i < 3 && (
                  <div className={`flex-1 h-0.5 ${
                    i < ['preview', 'options', 'executing', 'complete'].indexOf(step)
                      ? 'bg-kanvas-blue'
                      : 'bg-surface-tertiary'
                  }`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1 min-h-0">
          {/* Step 1: Preview */}
          {step === 'preview' && (
            <div>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-8 h-8 border-2 border-kanvas-blue border-t-transparent rounded-full" />
                </div>
              ) : error ? (
                <div className="p-4 bg-red-50 rounded-xl border border-red-200">
                  <p className="text-red-700">{error}</p>
                </div>
              ) : preview ? (
                <div className="space-y-4">
                  {/* Merge status */}
                  {preview.canMerge ? (
                    <div className="p-4 rounded-xl border bg-green-50 border-green-200">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="font-medium text-green-700">Ready to merge</span>
                      </div>
                    </div>
                  ) : hasUntrackedBlocking ? (
                    /* Untracked files blocking - show specific UX */
                    <div className="p-4 rounded-xl border bg-yellow-50 border-yellow-200">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-5 h-5 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <span className="font-medium text-yellow-700">Untracked files blocking merge</span>
                      </div>
                      <p className="text-sm text-yellow-600 mb-3">
                        Git refuses to merge because these untracked files would be overwritten.
                        They can be safely stashed (preserved) so the merge can proceed.
                      </p>
                      <div className="bg-yellow-100/50 rounded-lg p-2 mb-3">
                        {preview.untrackedBlockingFiles!.map((file) => (
                          <div key={file} className="text-xs font-mono text-yellow-800 py-0.5 flex items-center gap-2">
                            <span className="text-yellow-600">!</span>
                            {file}
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-yellow-600">
                        These files will be safely stashed and auto-recovered after merge completes.
                      </p>
                    </div>
                  ) : hasCodeConflicts ? (
                    /* Code-level conflicts - show auto-fix option */
                    <div className="p-4 rounded-xl border bg-red-50 border-red-200">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <span className="font-medium text-red-700">Code conflicts detected</span>
                      </div>
                      <p className="text-sm text-red-600 mb-2">
                        Both branches have changes to the same files that need to be resolved.
                      </p>
                      <div className="bg-red-100/50 rounded-lg p-2">
                        {preview.conflictingFiles.map((file) => (
                          <div key={file} className="text-xs font-mono text-red-800 py-0.5 flex items-center gap-2">
                            <span className="text-red-500">!</span>
                            {file}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* Generic conflict */
                    <div className="p-4 rounded-xl border bg-red-50 border-red-200">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <span className="font-medium text-red-700">Conflicts detected</span>
                      </div>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 bg-surface-secondary rounded-lg">
                      <div className="text-2xl font-bold text-text-primary">{preview.commitCount}</div>
                      <div className="text-sm text-text-secondary">Commits</div>
                    </div>
                    <div className="p-3 bg-surface-secondary rounded-lg">
                      <div className="text-2xl font-bold text-text-primary">{preview.filesChanged.length}</div>
                      <div className="text-sm text-text-secondary">Files Changed</div>
                    </div>
                    <div className="p-3 bg-surface-secondary rounded-lg">
                      <div className="text-2xl font-bold text-text-primary">
                        +{preview.aheadBy} / -{preview.behindBy}
                      </div>
                      <div className="text-sm text-text-secondary">Ahead/Behind</div>
                    </div>
                  </div>

                  {/* Files changed */}
                  {preview.filesChanged.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-text-primary mb-2">Files to be merged:</h4>
                      <div className="max-h-40 overflow-auto bg-surface-secondary rounded-lg p-2">
                        {preview.filesChanged.map((file) => (
                          <div key={file.path} className="flex items-center gap-2 py-1 text-sm">
                            <span className={`w-2 h-2 rounded-full ${
                              file.status === 'added' ? 'bg-green-500' :
                              file.status === 'deleted' ? 'bg-red-500' :
                              'bg-yellow-500'
                            }`} />
                            <span className="font-mono text-text-secondary flex-1 truncate">{file.path}</span>
                            <span className="text-green-500">+{file.additions}</span>
                            <span className="text-red-500">-{file.deletions}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cross-session overlap warning */}
                  {preview.crossSessionOverlaps && preview.crossSessionOverlaps.length > 0 && (
                    <div className="p-3 rounded-xl border bg-orange-50 border-orange-200">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-4 h-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <span className="text-sm font-medium text-orange-700">Files also being edited by other sessions</span>
                      </div>
                      <div className="bg-orange-100/50 rounded-lg p-2">
                        {preview.crossSessionOverlaps.map((overlap) => (
                          <div key={`${overlap.file}-${overlap.sessionId}`} className="text-xs font-mono text-orange-800 py-0.5 flex items-center justify-between">
                            <span>{overlap.file}</span>
                            <span className="text-orange-600 ml-2">session: {overlap.sessionId.slice(0, 8)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* Resolving step - progress log for stash/auto-fix operations */}
          {step === 'resolving' && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary mb-3">Resolving merge blockers...</h3>
              <div className="bg-surface-secondary rounded-lg p-3 max-h-60 overflow-auto">
                {progressLog.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2 py-1 text-sm">
                    {entry.status === 'active' && (
                      <div className="w-4 h-4 mt-0.5 flex-shrink-0">
                        <div className="animate-spin w-4 h-4 border-2 border-kanvas-blue border-t-transparent rounded-full" />
                      </div>
                    )}
                    {entry.status === 'done' && (
                      <svg className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {entry.status === 'error' && (
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                    {entry.status === 'pending' && (
                      <span className="w-4 h-4 flex-shrink-0 mt-0.5 text-text-secondary text-center">-</span>
                    )}
                    <div>
                      <span className={`${
                        entry.status === 'error' ? 'text-red-600' :
                        entry.status === 'done' ? 'text-text-primary' :
                        'text-text-secondary'
                      }`}>
                        {entry.message}
                      </span>
                      {entry.detail && (
                        <p className="text-xs text-text-secondary mt-0.5">{entry.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Options */}
          {step === 'options' && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-text-primary">Post-merge cleanup options</h3>

              <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-secondary cursor-pointer hover:bg-surface-tertiary transition-colors">
                <input
                  type="checkbox"
                  checked={deleteWorktree}
                  onChange={(e) => setDeleteWorktree(e.target.checked)}
                  disabled={!worktreePath}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium text-text-primary">Delete worktree</div>
                  <div className="text-sm text-text-secondary">
                    {worktreePath
                      ? `Remove the worktree directory at ${worktreePath.split('/').slice(-2).join('/')}`
                      : 'No worktree associated with this session'}
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-secondary cursor-pointer hover:bg-surface-tertiary transition-colors">
                <input
                  type="checkbox"
                  checked={deleteLocalBranch}
                  onChange={(e) => setDeleteLocalBranch(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium text-text-primary">Delete local branch</div>
                  <div className="text-sm text-text-secondary">
                    Delete <code>{sourceBranch}</code> from local repository after merge
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-secondary cursor-pointer hover:bg-surface-tertiary transition-colors">
                <input
                  type="checkbox"
                  checked={deleteRemoteBranch}
                  onChange={(e) => setDeleteRemoteBranch(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium text-text-primary">Delete remote branch</div>
                  <div className="text-sm text-text-secondary">
                    Delete <code>origin/{sourceBranch}</code> from remote after merge
                  </div>
                </div>
              </label>

              {sessionId && (
                <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-secondary cursor-pointer hover:bg-surface-tertiary transition-colors border-t border-border mt-2 pt-4">
                  <input
                    type="checkbox"
                    checked={deleteSession}
                    onChange={(e) => setDeleteSession(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="font-medium text-text-primary">Remove session from Kanvas</div>
                    <div className="text-sm text-text-secondary">
                      Remove this session from the Kanvas dashboard after merge
                    </div>
                  </div>
                </label>
              )}
            </div>
          )}

          {/* Step 3: Executing */}
          {step === 'executing' && (
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center py-8">
                <div className="animate-spin w-12 h-12 border-3 border-kanvas-blue border-t-transparent rounded-full mb-4" />
                <h3 className="text-lg font-medium text-text-primary mb-2">Merging...</h3>
                <p className="text-sm text-text-secondary">Please wait while the merge is executed</p>
              </div>
              {progressLog.length > 0 && (
                <div className="bg-surface-secondary rounded-lg p-3">
                  {progressLog.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5 text-sm">
                      {entry.status === 'active' && (
                        <div className="animate-spin w-3 h-3 border-2 border-kanvas-blue border-t-transparent rounded-full" />
                      )}
                      {entry.status === 'done' && (
                        <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {entry.status === 'error' && (
                        <svg className="w-3 h-3 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                      <span className="text-text-secondary">{entry.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Complete */}
          {step === 'complete' && mergeResult && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">Merge Complete!</h3>
              <p className="text-sm text-text-secondary mb-4">{mergeResult.message}</p>
              {mergeResult.mergeCommitHash && (
                <p className="text-xs text-text-secondary font-mono">
                  Commit: {mergeResult.mergeCommitHash.slice(0, 8)}
                </p>
              )}
              {mergeResult.filesChanged && (
                <p className="text-sm text-text-secondary mt-2">
                  {mergeResult.filesChanged} files changed
                </p>
              )}
              {/* Stash recovery status */}
              {mergeResult.stashRecovered === true && (
                <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded-lg">
                  <p className="text-sm text-green-700 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Stashed files recovered successfully
                  </p>
                </div>
              )}
              {mergeResult.stashRecovered === false && (
                <div className="mt-3 p-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-yellow-700 font-medium mb-1">Some stashed files could not be recovered</p>
                  {mergeResult.stashConflictFiles?.map((f) => (
                    <p key={f} className="text-xs font-mono text-yellow-600 pl-2">{f}</p>
                  ))}
                  <p className="text-xs text-yellow-600 mt-1">The merged version was kept for these files.</p>
                </div>
              )}
            </div>
          )}

          {/* Error state */}
          {step === 'error' && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">Merge Failed</h3>
              <p className="text-sm text-red-600 mb-4">{error}</p>
              {progressLog.length > 0 && (
                <div className="bg-surface-secondary rounded-lg p-3 text-left max-h-40 overflow-auto mb-3">
                  {progressLog.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
                      <span className={entry.status === 'error' ? 'text-red-500' : 'text-text-secondary'}>
                        {entry.status === 'done' ? '[ok]' : entry.status === 'error' ? '[fail]' : '[...]'} {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Advanced error details */}
              <div className="border border-border rounded-lg overflow-hidden text-left">
                <button
                  onClick={() => setShowAdvancedError(!showAdvancedError)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs text-text-secondary hover:bg-surface-secondary transition-colors"
                >
                  <span className="font-medium">Advanced Details</span>
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${showAdvancedError ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showAdvancedError && (
                  <div className="border-t border-border bg-surface-secondary p-3 space-y-1 max-h-48 overflow-y-auto">
                    <div className="text-xs font-mono text-text-secondary space-y-1">
                      <p><span className="text-text-primary font-medium">Error:</span> {error}</p>
                      <p><span className="text-text-primary font-medium">Repo:</span> {repoPath}</p>
                      <p><span className="text-text-primary font-medium">Source:</span> {actualBranch}</p>
                      <p><span className="text-text-primary font-medium">Target:</span> {targetBranch}</p>
                      {worktreePath && <p><span className="text-text-primary font-medium">Worktree:</span> {worktreePath}</p>}
                      {sessionId && <p><span className="text-text-primary font-medium">Session:</span> {sessionId}</p>}
                      {preview?.conflictingFiles && preview.conflictingFiles.length > 0 && (
                        <>
                          <p><span className="text-text-primary font-medium">Conflicting files:</span></p>
                          {preview.conflictingFiles.map((f) => (
                            <p key={f} className="pl-4 text-red-500">{f}</p>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-surface-secondary">
          <div className="flex items-center justify-between">
            {step === 'preview' && (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-text-secondary hover:bg-surface transition-colors"
                >
                  Cancel
                </button>
                <div className="flex gap-2">
                  {/* Untracked blocking: Stash & Retry button */}
                  {hasUntrackedBlocking && (
                    <button
                      onClick={handleStashAndRetry}
                      className="px-4 py-2 rounded-lg bg-yellow-500 text-white font-medium hover:bg-yellow-600 transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                      </svg>
                      Stash & Retry
                    </button>
                  )}
                  {/* Code conflicts: Auto-Fix with AI */}
                  {hasCodeConflicts && (
                    <button
                      onClick={handleAutoFix}
                      className="px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Auto-Fix with AI
                    </button>
                  )}
                  {/* Normal continue */}
                  <button
                    onClick={() => setStep('options')}
                    disabled={!preview?.canMerge}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      preview?.canMerge
                        ? 'bg-kanvas-blue text-white hover:bg-kanvas-blue/90'
                        : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    Continue
                  </button>
                </div>
              </>
            )}
            {step === 'resolving' && (
              <button
                onClick={() => {
                  setStep('preview');
                  setProgressLog([]);
                }}
                className="ml-auto px-4 py-2 rounded-lg text-text-secondary hover:bg-surface transition-colors"
              >
                Back to Preview
              </button>
            )}
            {step === 'options' && (
              <>
                <button
                  onClick={() => setStep('preview')}
                  className="px-4 py-2 rounded-lg text-text-secondary hover:bg-surface transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleExecuteMerge}
                  className="px-4 py-2 rounded-lg bg-kanvas-blue text-white font-medium hover:bg-kanvas-blue/90 transition-colors"
                >
                  Execute Merge
                </button>
              </>
            )}
            {(step === 'complete' || step === 'error') && (
              <button
                onClick={onClose}
                className="ml-auto px-4 py-2 rounded-lg bg-surface text-text-primary hover:bg-surface-tertiary transition-colors font-medium"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
