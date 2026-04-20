/**
 * Conflict Store
 * State management for rebase/merge conflict resolution
 */

import { create } from 'zustand';

export interface RebaseErrorDetails {
  sessionId: string;
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  conflictedFiles: string[];
  errorMessage: string;
  rawError?: string;
}

/**
 * Mirrors ConflictResolutionPreview from electron/services/MergeConflictService.ts,
 * with an added `approved` flag the UI uses to gate which files get applied.
 */
export interface ConflictPreview {
  file: string;
  language: string;
  originalContent: string;       // File with conflict markers
  proposedContent: string;       // AI's proposed resolution
  status: 'pending' | 'approved' | 'rejected' | 'modified' | 'skipped';
  userModifiedContent?: string;
  skippedReason?: string;
  analysis?: unknown;
  triage?: unknown;
  approved: boolean;
}

export type ConflictResolutionStep =
  | 'error'           // Initial error state
  | 'choose_path'     // User chooses auto-fix or manual
  | 'generating'      // LLM generating previews
  | 'review_plan'     // User reviews AI resolution plan
  | 'applying'        // Applying approved resolutions
  | 'manual'          // User fixing manually
  | 'result';         // Final result (success/failure)

interface ConflictState {
  // Dialog visibility
  isDialogOpen: boolean;

  // Error details from rebase/merge
  errorDetails: RebaseErrorDetails | null;

  // Resolution workflow
  currentStep: ConflictResolutionStep;
  previews: ConflictPreview[];
  backupBranch: string | null;
  isProcessing: boolean;
  resultMessage: string | null;
  resultSuccess: boolean | null;

  // Actions
  showDialog: (errorDetails: RebaseErrorDetails) => void;
  hideDialog: () => void;
  setStep: (step: ConflictResolutionStep) => void;
  setPreviews: (previews: ConflictPreview[]) => void;
  setPreviewApproval: (filePath: string, approved: boolean) => void;
  setBackupBranch: (branch: string | null) => void;
  setIsProcessing: (processing: boolean) => void;
  setResult: (success: boolean, message: string) => void;
  reset: () => void;
}

const initialState = {
  isDialogOpen: false,
  errorDetails: null,
  currentStep: 'error' as ConflictResolutionStep,
  previews: [],
  backupBranch: null,
  isProcessing: false,
  resultMessage: null,
  resultSuccess: null,
};

export const useConflictStore = create<ConflictState>((set) => ({
  ...initialState,

  showDialog: (errorDetails) =>
    set({
      isDialogOpen: true,
      errorDetails,
      currentStep: 'error',
      previews: [],
      backupBranch: null,
      isProcessing: false,
      resultMessage: null,
      resultSuccess: null,
    }),

  hideDialog: () =>
    set({
      isDialogOpen: false,
    }),

  setStep: (step) => set({ currentStep: step }),

  setPreviews: (previews) => set({ previews }),

  setPreviewApproval: (filePath, approved) =>
    set((state) => ({
      previews: state.previews.map((p) =>
        p.file === filePath ? { ...p, approved } : p
      ),
    })),

  setBackupBranch: (branch) => set({ backupBranch: branch }),

  setIsProcessing: (processing) => set({ isProcessing: processing }),

  setResult: (success, message) =>
    set({
      resultSuccess: success,
      resultMessage: message,
      currentStep: 'result',
      isProcessing: false,
    }),

  reset: () => set(initialState),
}));
