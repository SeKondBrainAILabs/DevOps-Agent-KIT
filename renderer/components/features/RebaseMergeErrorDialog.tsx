/**
 * RebaseMergeErrorDialog Component
 * Modal dialog for handling rebase/merge conflicts with auto-fix (LLM) or manual resolution
 *
 * Flow:
 * Error Detected → Show Details → [Choose Path]
 *                                     │
 *                     ┌───────────────┴───────────────┐
 *                     ▼                               ▼
 *               Auto-Fix (LLM)                   Manual Fix
 *                     │                               │
 *             Create backup_kit/<session>        Show terminal
 *                     │                          instructions
 *             Generate AI plan                        │
 *                     │                          User confirms
 *             User reviews & approves            "I fixed it"
 *                     │                               │
 *             Apply resolutions                       │
 *                     │                               │
 *             Success → Delete backup_kit       ◄─────┘
 */

import React, { useState, useEffect } from 'react';
import { useConflictStore, type ConflictResolutionStep } from '../../store/conflictStore';

/** Log errors to the persistent DebugLogService via IPC */
function logToDebug(level: 'info' | 'warn' | 'error', message: string, details?: unknown): void {
  window.api?.debugLog?.write?.(level, 'ConflictResolution', message, details);
}

export function RebaseMergeErrorDialog(): React.ReactElement | null {
  const {
    isDialogOpen,
    errorDetails,
    currentStep,
    previews,
    backupBranch,
    isProcessing,
    resultMessage,
    resultSuccess,
    hideDialog,
    setStep,
    setPreviews,
    setPreviewApproval,
    setBackupBranch,
    setIsProcessing,
    setResult,
    reset,
  } = useConflictStore();

  const [manualFixAcknowledged, setManualFixAcknowledged] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Log the error to DebugLogService when dialog opens
  useEffect(() => {
    if (isDialogOpen && errorDetails) {
      logToDebug('error', `Rebase/merge conflict dialog opened`, {
        sessionId: errorDetails.sessionId,
        repoPath: errorDetails.repoPath,
        baseBranch: errorDetails.baseBranch,
        currentBranch: errorDetails.currentBranch,
        conflictedFiles: errorDetails.conflictedFiles,
        errorMessage: errorDetails.errorMessage,
      });
    }
  }, [isDialogOpen, errorDetails]);

  if (!isDialogOpen || !errorDetails) {
    return null;
  }

  // Handle auto-fix path
  const handleAutoFix = async () => {
    setStep('generating');
    setIsProcessing(true);

    try {
      // Create backup branch before applying AI changes
      const backupBranchName = `backup_kit/${errorDetails.sessionId}`;
      const backupResult = await window.api?.conflict?.createBackup?.(
        errorDetails.repoPath,
        errorDetails.sessionId
      );

      if (backupResult?.success) {
        setBackupBranch(backupBranchName);
        console.log(`[ConflictResolution] Created backup: ${backupBranchName}`);
      } else {
        console.warn('[ConflictResolution] Could not create backup branch, continuing anyway');
      }

      // Generate AI resolution previews
      const result = await window.api?.conflict?.generatePreviews?.(
        errorDetails.repoPath,
        errorDetails.baseBranch
      );

      if (result?.success && result.data) {
        const previewsWithApproval = (result.data as Array<{
          filePath: string;
          oursContent: string;
          theirsContent: string;
          resolvedContent: string;
          resolution: 'ours' | 'theirs' | 'merged';
        }>).map((p) => ({
          ...p,
          approved: true, // Default to approved
        }));
        setPreviews(previewsWithApproval);
        setStep('review_plan');
      } else {
        setResult(false, result?.error?.message || 'Failed to generate resolution previews');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error during auto-fix';
      logToDebug('error', `Auto-fix failed`, { errorMessage: msg, sessionId: errorDetails.sessionId });
      setResult(false, msg);
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle applying approved resolutions
  const handleApplyResolutions = async () => {
    setStep('applying');
    setIsProcessing(true);

    try {
      const approvedPreviews = previews.filter((p) => p.approved);

      if (approvedPreviews.length === 0) {
        setResult(false, 'No resolutions approved. Please approve at least one file.');
        return;
      }

      const result = await window.api?.conflict?.applyApproved?.(
        errorDetails.repoPath,
        approvedPreviews
      );

      if (result?.success) {
        // Delete backup branch on success
        if (backupBranch) {
          await window.api?.conflict?.deleteBackup?.(errorDetails.repoPath, errorDetails.sessionId);
          console.log(`[ConflictResolution] Deleted backup: ${backupBranch}`);
        }
        setResult(true, `Successfully resolved ${approvedPreviews.length} conflict(s)`);
      } else {
        setResult(false, result?.error?.message || 'Failed to apply resolutions');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error applying resolutions';
      logToDebug('error', `Apply resolutions failed`, { errorMessage: msg, sessionId: errorDetails.sessionId });
      setResult(false, msg);
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle manual fix path
  const handleManualFix = () => {
    setStep('manual');
    setManualFixAcknowledged(false);
  };

  // Handle manual fix completion
  const handleManualFixComplete = async () => {
    setIsProcessing(true);

    try {
      // Check if rebase is still in progress
      const inProgress = await window.api?.conflict?.isRebaseInProgress?.(errorDetails.repoPath);

      if (inProgress?.success && !inProgress.data) {
        setResult(true, 'Conflicts resolved manually. Rebase completed.');
      } else {
        setResult(false, 'Rebase still in progress. Please complete the rebase manually.');
      }
    } catch (error) {
      setResult(false, error instanceof Error ? error.message : 'Failed to verify rebase status');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle abort
  const handleAbort = async () => {
    setIsProcessing(true);

    try {
      await window.api?.conflict?.abortRebase?.(errorDetails.repoPath);
      setResult(true, 'Rebase aborted. Repository restored to previous state.');
    } catch (error) {
      setResult(false, error instanceof Error ? error.message : 'Failed to abort rebase');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle close
  const handleClose = () => {
    reset();
    hideDialog();
  };

  // Render step content
  const renderStepContent = () => {
    switch (currentStep) {
      case 'error':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-6 h-6 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <h4 className="font-semibold text-red-700">Rebase/Merge Conflict Detected</h4>
                  <p className="text-sm text-red-600 mt-1">{errorDetails.errorMessage}</p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-text-primary">Conflicted Files:</h4>
              <div className="max-h-32 overflow-y-auto bg-surface-secondary rounded-lg p-2">
                {errorDetails.conflictedFiles.map((file) => (
                  <div key={file} className="text-xs font-mono text-text-secondary py-0.5 flex items-center gap-2">
                    <span className="text-red-500">!</span>
                    {file}
                  </div>
                ))}
              </div>
            </div>

            {/* Advanced error details (collapsible) */}
            <div className="border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="w-full px-3 py-2 flex items-center justify-between text-xs text-text-secondary hover:bg-surface-secondary transition-colors"
              >
                <span className="font-medium">Advanced Details</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showAdvanced && (
                <div className="border-t border-border bg-surface-secondary p-3 space-y-2 max-h-48 overflow-y-auto">
                  <div className="text-xs font-mono text-text-secondary space-y-1">
                    <p><span className="text-text-primary font-medium">Error:</span> {errorDetails.errorMessage}</p>
                    {errorDetails.rawError && errorDetails.rawError !== errorDetails.errorMessage && (
                      <>
                        <p className="mt-2"><span className="text-text-primary font-medium">Git Output:</span></p>
                        <pre className="pl-2 text-red-400 whitespace-pre-wrap break-all bg-black/10 rounded p-2 mt-1">{errorDetails.rawError}</pre>
                      </>
                    )}
                    <p><span className="text-text-primary font-medium">Session:</span> {errorDetails.sessionId}</p>
                    <p><span className="text-text-primary font-medium">Repo:</span> {errorDetails.repoPath}</p>
                    <p><span className="text-text-primary font-medium">Current branch:</span> {errorDetails.currentBranch}</p>
                    <p><span className="text-text-primary font-medium">Base branch:</span> {errorDetails.baseBranch}</p>
                    <p><span className="text-text-primary font-medium">Conflicted files ({errorDetails.conflictedFiles.length}):</span></p>
                    {errorDetails.conflictedFiles.map((file) => (
                      <p key={file} className="pl-4 text-red-500">{file}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-sm text-text-secondary mb-3">How would you like to resolve these conflicts?</p>
              <div className="flex gap-3">
                <button
                  onClick={handleAutoFix}
                  className="flex-1 px-4 py-2.5 bg-kanvas-blue text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Auto-Fix with AI
                </button>
                <button
                  onClick={handleManualFix}
                  className="flex-1 px-4 py-2.5 bg-surface-secondary text-text-primary rounded-lg hover:bg-surface-tertiary transition-colors text-sm font-medium flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                  Fix Manually
                </button>
              </div>
            </div>
          </div>
        );

      case 'generating':
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-4">
            <div className="animate-spin w-10 h-10 border-3 border-kanvas-blue border-t-transparent rounded-full" />
            <p className="text-text-secondary">Analyzing conflicts and generating resolution plan...</p>
            {backupBranch && (
              <p className="text-xs text-text-secondary">
                Backup created: <code className="bg-surface-secondary px-1.5 py-0.5 rounded">{backupBranch}</code>
              </p>
            )}
          </div>
        );

      case 'review_plan':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-700">
                Review the AI-generated resolutions below. Toggle approval for each file before applying.
              </p>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-2">
              {previews.map((preview) => (
                <div
                  key={preview.filePath}
                  className={`p-3 rounded-lg border ${
                    preview.approved ? 'bg-green-50 border-green-200' : 'bg-surface-secondary border-border'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={preview.approved}
                        onChange={(e) => setPreviewApproval(preview.filePath, e.target.checked)}
                        className="w-4 h-4 rounded border-border text-kanvas-blue focus:ring-kanvas-blue"
                      />
                      <span className="text-sm font-mono text-text-primary">{preview.filePath}</span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      preview.resolution === 'merged' ? 'bg-purple-100 text-purple-700' :
                      preview.resolution === 'ours' ? 'bg-green-100 text-green-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {preview.resolution}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleApplyResolutions}
                disabled={isProcessing || previews.every((p) => !p.approved)}
                className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply {previews.filter((p) => p.approved).length} Resolution(s)
              </button>
              <button
                onClick={handleAbort}
                className="px-4 py-2.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors text-sm font-medium"
              >
                Abort
              </button>
            </div>
          </div>
        );

      case 'applying':
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-4">
            <div className="animate-spin w-10 h-10 border-3 border-green-500 border-t-transparent rounded-full" />
            <p className="text-text-secondary">Applying approved resolutions...</p>
          </div>
        );

      case 'manual':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-surface-secondary rounded-lg">
              <h4 className="font-medium text-text-primary mb-2">Manual Resolution Instructions</h4>
              <ol className="text-sm text-text-secondary space-y-2 list-decimal list-inside">
                <li>Open a terminal in the repository directory</li>
                <li>Edit the conflicted files to resolve conflicts</li>
                <li>Stage the resolved files: <code className="bg-surface px-1.5 py-0.5 rounded text-xs">git add &lt;file&gt;</code></li>
                <li>Continue the rebase: <code className="bg-surface px-1.5 py-0.5 rounded text-xs">git rebase --continue</code></li>
              </ol>
            </div>

            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-700">
                Repository path: <code className="bg-yellow-100 px-1.5 py-0.5 rounded text-xs">{errorDetails.repoPath}</code>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="manual-fix-ack"
                checked={manualFixAcknowledged}
                onChange={(e) => setManualFixAcknowledged(e.target.checked)}
                className="w-4 h-4 rounded border-border text-kanvas-blue focus:ring-kanvas-blue"
              />
              <label htmlFor="manual-fix-ack" className="text-sm text-text-secondary">
                I have resolved the conflicts and completed the rebase
              </label>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleManualFixComplete}
                disabled={!manualFixAcknowledged || isProcessing}
                className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Verify & Complete
              </button>
              <button
                onClick={handleAbort}
                className="px-4 py-2.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors text-sm font-medium"
              >
                Abort Rebase
              </button>
            </div>
          </div>
        );

      case 'result':
        return (
          <div className="space-y-4">
            <div className={`p-4 rounded-lg ${
              resultSuccess ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
            }`}>
              <div className="flex items-start gap-3">
                {resultSuccess ? (
                  <svg className="w-6 h-6 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                <div>
                  <h4 className={`font-semibold ${resultSuccess ? 'text-green-700' : 'text-red-700'}`}>
                    {resultSuccess ? 'Success' : 'Failed'}
                  </h4>
                  <p className={`text-sm mt-1 ${resultSuccess ? 'text-green-600' : 'text-red-600'}`}>
                    {resultMessage}
                  </p>
                </div>
              </div>
            </div>

            {/* Advanced details on failure */}
            {!resultSuccess && (
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs text-text-secondary hover:bg-surface-secondary transition-colors"
                >
                  <span className="font-medium">Advanced Details</span>
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showAdvanced && (
                  <div className="border-t border-border bg-surface-secondary p-3 space-y-2 max-h-48 overflow-y-auto">
                    <div className="text-xs font-mono text-text-secondary space-y-1">
                      <p><span className="text-text-primary font-medium">Result:</span> {resultMessage}</p>
                      {errorDetails.rawError && (
                        <>
                          <p className="mt-2"><span className="text-text-primary font-medium">Git Output:</span></p>
                          <pre className="pl-2 text-red-400 whitespace-pre-wrap break-all bg-black/10 rounded p-2 mt-1">{errorDetails.rawError}</pre>
                        </>
                      )}
                      <p><span className="text-text-primary font-medium">Session:</span> {errorDetails.sessionId}</p>
                      <p><span className="text-text-primary font-medium">Repo:</span> {errorDetails.repoPath}</p>
                      <p><span className="text-text-primary font-medium">Branch:</span> {errorDetails.currentBranch} → {errorDetails.baseBranch}</p>
                      {errorDetails.conflictedFiles.length > 0 && (
                        <>
                          <p><span className="text-text-primary font-medium">Conflicted files:</span></p>
                          {errorDetails.conflictedFiles.map((file) => (
                            <p key={file} className="pl-4 text-red-500">{file}</p>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleClose}
              className="w-full px-4 py-2.5 bg-surface-secondary text-text-primary rounded-lg hover:bg-surface-tertiary transition-colors text-sm font-medium"
            >
              Close
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">
            {currentStep === 'result' ? (resultSuccess ? 'Resolution Complete' : 'Resolution Failed') :
             currentStep === 'manual' ? 'Manual Resolution' :
             currentStep === 'review_plan' ? 'Review AI Resolutions' :
             'Conflict Resolution'}
          </h2>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-surface-secondary transition-colors"
            title="Close"
          >
            <svg className="w-4 h-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {renderStepContent()}
        </div>

        {/* Footer with context info */}
        {currentStep !== 'result' && (
          <div className="px-4 pb-4 pt-0">
            <div className="text-xs text-text-secondary flex items-center gap-4">
              <span>Branch: <code className="bg-surface-secondary px-1 rounded">{errorDetails.currentBranch}</code></span>
              <span>Base: <code className="bg-surface-secondary px-1 rounded">{errorDetails.baseBranch}</code></span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
