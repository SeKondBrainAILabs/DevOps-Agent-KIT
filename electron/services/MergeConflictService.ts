/**
 * Merge Conflict Service
 * AI-powered merge conflict resolution using LLM
 */

import { BaseService } from './BaseService';
import type { IpcResult } from '../../shared/types';
import type { AIService } from './AIService';
import type { DebugLogService } from './DebugLogService';
import { promises as fs } from 'fs';
import path from 'path';

// Dynamic import helper for execa (ESM-only module)
// Handles various bundling scenarios with fallback patterns
type ExecaFn = (cmd: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string }>;
let _execa: ExecaFn | null = null;

async function getExeca(): Promise<ExecaFn> {
  if (!_execa) {
    const mod = await import('execa');
    // Try different export patterns based on how the bundler resolves the module
    if (typeof mod.execa === 'function') {
      _execa = mod.execa as unknown as ExecaFn;
    } else if (typeof mod.default === 'function') {
      _execa = mod.default as unknown as ExecaFn;
    } else if (typeof (mod.default as Record<string, unknown>)?.execa === 'function') {
      _execa = (mod.default as Record<string, unknown>).execa as unknown as ExecaFn;
    } else {
      throw new Error(`Unable to resolve execa function from module: ${JSON.stringify(Object.keys(mod))}`);
    }
  }
  return _execa;
}

export interface ConflictedFile {
  path: string;
  content: string;
  language: string;
}

export interface ConflictAnalysis {
  currentBranchIntent: string;
  incomingBranchIntent: string;
  conflictType: 'compatible' | 'semantic' | 'structural';
  recommendedStrategy: 'merge_both' | 'prefer_current' | 'prefer_incoming' | 'manual';
  explanation: string;
  complexity: 'simple' | 'moderate' | 'complex';
}

export interface ResolutionResult {
  file: string;
  resolved: boolean;
  content?: string;
  error?: string;
  analysis?: ConflictAnalysis;
}

/**
 * Preview of a proposed conflict resolution
 * User must approve before it's applied
 */
export interface ConflictResolutionPreview {
  file: string;
  language: string;
  originalContent: string;       // The file with conflict markers
  proposedContent: string;       // AI's proposed resolution
  analysis?: ConflictAnalysis;   // AI's analysis of the conflict
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  userModifiedContent?: string;  // If user edits the proposed resolution
}

/**
 * Result of generating previews for all conflicts
 */
export interface ConflictPreviewResult {
  repoPath: string;
  currentBranch: string;
  targetBranch: string;
  previews: ConflictResolutionPreview[];
  totalConflicts: number;
  resolvedByAI: number;
  failedToResolve: number;
}

/**
 * Result of applying approved resolutions
 */
export interface ApplyResolutionsResult {
  success: boolean;
  message: string;
  applied: string[];
  failed: string[];
  skipped: string[];
}

export interface RebaseWithResolutionResult {
  success: boolean;
  message: string;
  conflictsResolved: number;
  conflictsFailed: number;
  resolutions: ResolutionResult[];
}

export class MergeConflictService extends BaseService {
  private aiService: AIService;
  private debugLog: DebugLogService | null = null;

  constructor(aiService: AIService) {
    super();
    this.aiService = aiService;
  }

  setDebugLog(debugLog: DebugLogService): void {
    this.debugLog = debugLog;
  }

  /**
   * Execute a git command
   */
  private async git(args: string[], cwd: string): Promise<string> {
    const execa = await getExeca();
    const { stdout } = await execa('git', args, { cwd });
    return stdout.trim();
  }

  /**
   * Get list of files with conflicts
   */
  async getConflictedFiles(repoPath: string): Promise<IpcResult<string[]>> {
    return this.wrap(async () => {
      const output = await this.git(['diff', '--name-only', '--diff-filter=U'], repoPath);
      return output.split('\n').filter(Boolean);
    }, 'GET_CONFLICTED_FILES_FAILED');
  }

  /**
   * Read a conflicted file's content
   */
  async readConflictedFile(repoPath: string, filePath: string): Promise<IpcResult<ConflictedFile>> {
    return this.wrap(async () => {
      const fullPath = path.join(repoPath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');

      // Detect language from extension
      const ext = path.extname(filePath).toLowerCase();
      const languageMap: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.json': 'json',
        '.md': 'markdown',
        '.css': 'css',
        '.scss': 'scss',
        '.html': 'html',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.py': 'python',
        '.go': 'go',
        '.rs': 'rust',
        '.java': 'java',
        '.sql': 'sql',
      };

      return {
        path: filePath,
        content,
        language: languageMap[ext] || 'text',
      };
    }, 'READ_CONFLICTED_FILE_FAILED');
  }

  /**
   * Check if content has conflict markers
   */
  hasConflictMarkers(content: string): boolean {
    return content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>');
  }

  /**
   * Get recent commit messages for a branch (for conflict context)
   */
  private async getBranchCommits(repoPath: string, branch: string, limit = 10): Promise<string> {
    try {
      const output = await this.git(
        ['log', branch, `--format=%h %s`, `-${limit}`],
        repoPath
      );
      return output || '(no commits found)';
    } catch {
      return '(could not retrieve commits)';
    }
  }

  /**
   * Phase 1: Analyze a conflict with commit context to build a resolution plan
   */
  async analyzeConflict(
    repoPath: string,
    filePath: string,
    currentBranch?: string,
    incomingBranch?: string
  ): Promise<IpcResult<ConflictAnalysis & { resolutionPlan?: string }>> {
    return this.wrap(async () => {
      const fileResult = await this.readConflictedFile(repoPath, filePath);
      if (!fileResult.success || !fileResult.data) {
        throw new Error(`Failed to read file: ${filePath}`);
      }

      // Get commit context from both branches
      const currentCommits = currentBranch
        ? await this.getBranchCommits(repoPath, currentBranch)
        : '(unknown branch)';
      const incomingCommits = incomingBranch
        ? await this.getBranchCommits(repoPath, `origin/${incomingBranch}`)
        : '(unknown branch)';

      const promptKey = currentBranch ? 'analyze_with_context' : 'analyze_conflict';

      const result = await this.aiService.sendWithMode({
        modeId: 'merge_conflict_resolver',
        promptKey,
        variables: {
          file_path: filePath,
          language: fileResult.data.language,
          current_branch: currentBranch || 'current',
          incoming_branch: incomingBranch || 'incoming',
          current_commits: currentCommits,
          incoming_commits: incomingCommits,
          conflicted_content: fileResult.data.content,
        },
        userMessage: 'Analyze this conflict and return ONLY valid JSON.',
      });

      if (!result.success || !result.data) {
        throw new Error('AI analysis failed');
      }

      // Parse JSON from response
      const jsonMatch = result.data.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse AI response as JSON');
      }

      return JSON.parse(jsonMatch[0]) as ConflictAnalysis & { resolutionPlan?: string };
    }, 'ANALYZE_CONFLICT_FAILED');
  }

  /**
   * Phase 2: Resolve a single file's conflicts using AI
   * Uses analysis from Phase 1 and commit context for informed resolution
   */
  async resolveFileConflict(
    repoPath: string,
    filePath: string,
    currentBranch: string,
    incomingBranch: string,
    analysis?: ConflictAnalysis & { resolutionPlan?: string }
  ): Promise<IpcResult<ResolutionResult>> {
    return this.wrap(async () => {
      this.debugLog?.info('MergeConflict', `Resolving conflict in file`, {
        filePath, repoPath, currentBranch, incomingBranch,
        hasAnalysis: !!analysis,
        strategy: analysis?.recommendedStrategy,
      });
      console.log(`[MergeConflict] Resolving conflict in: ${filePath} (strategy: ${analysis?.recommendedStrategy || 'none'})`);

      const fileResult = await this.readConflictedFile(repoPath, filePath);
      if (!fileResult.success || !fileResult.data) {
        return {
          file: filePath,
          resolved: false,
          error: `Failed to read file: ${filePath}`,
        };
      }

      const { content, language } = fileResult.data;

      // Check if file actually has conflicts
      if (!this.hasConflictMarkers(content)) {
        console.log(`[MergeConflict] No conflict markers in ${filePath}, skipping`);
        return {
          file: filePath,
          resolved: true,
          content,
        };
      }

      // Get commit context for both branches
      const currentCommits = await this.getBranchCommits(repoPath, currentBranch);
      const incomingCommits = await this.getBranchCommits(repoPath, `origin/${incomingBranch}`);

      let result;

      if (analysis?.resolutionPlan) {
        // Phase 2: Use the analysis plan from Phase 1
        console.log(`[MergeConflict] Using Phase 2 resolve_with_plan for ${filePath}`);
        result = await this.aiService.sendWithMode({
          modeId: 'merge_conflict_resolver',
          promptKey: 'resolve_with_plan',
          variables: {
            file_path: filePath,
            language,
            current_branch: currentBranch,
            incoming_branch: incomingBranch,
            analysis_current_intent: analysis.currentBranchIntent,
            analysis_incoming_intent: analysis.incomingBranchIntent,
            analysis_conflict_type: analysis.conflictType,
            analysis_strategy: analysis.recommendedStrategy,
            analysis_plan: analysis.resolutionPlan,
            current_commits: currentCommits,
            incoming_commits: incomingCommits,
            conflicted_content: content,
          },
          userMessage: 'Follow the resolution plan. Output ONLY the final merged code — no explanations, no markdown fences.',
        });
      } else {
        // Fallback: single-shot resolve without analysis
        console.log(`[MergeConflict] Fallback to single-shot resolve for ${filePath}`);
        result = await this.aiService.sendWithMode({
          modeId: 'merge_conflict_resolver',
          promptKey: 'resolve_conflict',
          variables: {
            file_path: filePath,
            language,
            current_branch: currentBranch,
            incoming_branch: incomingBranch,
            conflicted_content: content,
          },
          userMessage: 'Resolve this conflict and output ONLY the final merged code. No explanations.',
        });
      }

      if (!result.success || !result.data) {
        return {
          file: filePath,
          resolved: false,
          error: 'AI resolution failed',
        };
      }

      let resolvedContent = result.data;

      // Extract code from markdown code blocks if present
      const codeBlockMatch = resolvedContent.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        resolvedContent = codeBlockMatch[1];
      }

      // Verify no conflict markers remain
      if (this.hasConflictMarkers(resolvedContent)) {
        this.debugLog?.warn('MergeConflict', `AI output still has conflict markers, retrying with stronger instruction`, { filePath });
        console.warn(`[MergeConflict] AI output still has conflict markers, retrying...`);

        // Retry with stronger instruction
        const retryResult = await this.aiService.sendWithMode({
          modeId: 'merge_conflict_resolver',
          promptKey: 'resolve_with_plan',
          variables: {
            file_path: filePath,
            language,
            current_branch: currentBranch,
            incoming_branch: incomingBranch,
            analysis_current_intent: analysis?.currentBranchIntent || 'unknown',
            analysis_incoming_intent: analysis?.incomingBranchIntent || 'unknown',
            analysis_conflict_type: analysis?.conflictType || 'unknown',
            analysis_strategy: analysis?.recommendedStrategy || 'merge_both',
            analysis_plan: analysis?.resolutionPlan || 'Merge both sides, preserving all functionality',
            current_commits: currentCommits,
            incoming_commits: incomingCommits,
            conflicted_content: content,
          },
          userMessage: 'CRITICAL: You MUST remove ALL conflict markers (<<<<<<, ======, >>>>>>) and produce clean, merged code. Output ONLY the resolved code — no markdown, no explanation.',
        });

        if (retryResult.success && retryResult.data) {
          resolvedContent = retryResult.data;
          const retryCodeBlock = resolvedContent.match(/```(?:\w+)?\n([\s\S]*?)```/);
          if (retryCodeBlock) {
            resolvedContent = retryCodeBlock[1];
          }
        }

        // If still has markers, fail
        if (this.hasConflictMarkers(resolvedContent)) {
          return {
            file: filePath,
            resolved: false,
            error: 'AI could not fully resolve conflict markers after retry',
          };
        }
      }

      return {
        file: filePath,
        resolved: true,
        content: resolvedContent.trim(),
        analysis,
      };
    }, 'RESOLVE_FILE_CONFLICT_FAILED');
  }

  /**
   * Apply a resolved file's content (internal use)
   */
  async applyResolution(repoPath: string, filePath: string, content: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      const fullPath = path.join(repoPath, filePath);
      await fs.writeFile(fullPath, content, 'utf-8');
      await this.git(['add', filePath], repoPath);
      console.log(`[MergeConflict] Applied resolution and staged: ${filePath}`);
    }, 'APPLY_RESOLUTION_FAILED');
  }

  // ==========================================================================
  // INTERACTIVE WORKFLOW - Preview & Approval
  // ==========================================================================

  /**
   * Start rebase and generate previews for all conflicts
   * Does NOT apply any changes - returns previews for user approval
   */
  async generateResolutionPreviews(
    repoPath: string,
    targetBranch: string
  ): Promise<IpcResult<ConflictPreviewResult>> {
    return this.wrap(async () => {
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);
      this.debugLog?.info('MergeConflict', `Generating resolution previews`, { repoPath, currentBranch, targetBranch });
      console.log(`[MergeConflict] Generating previews for rebase of ${currentBranch} onto ${targetBranch}`);

      // Fetch latest
      try {
        await this.git(['fetch', 'origin', targetBranch], repoPath);
      } catch {
        throw new Error(`Failed to fetch ${targetBranch}`);
      }

      // Start rebase (may fail with conflicts)
      try {
        await this.git(['rebase', `origin/${targetBranch}`], repoPath);
        // If no error, rebase succeeded without conflicts
        return {
          repoPath,
          currentBranch,
          targetBranch,
          previews: [],
          totalConflicts: 0,
          resolvedByAI: 0,
          failedToResolve: 0,
        };
      } catch {
        // Expected - rebase has conflicts, continue to generate previews
        console.log(`[MergeConflict] Rebase has conflicts, generating AI previews`);
      }

      // Get conflicted files
      const conflictedResult = await this.getConflictedFiles(repoPath);
      if (!conflictedResult.success || !conflictedResult.data) {
        throw new Error('Failed to get conflicted files');
      }

      const conflictedFiles = conflictedResult.data;
      const previews: ConflictResolutionPreview[] = [];
      let resolvedByAI = 0;
      let failedToResolve = 0;

      // Generate preview for each conflicted file
      for (const file of conflictedFiles) {
        const fileResult = await this.readConflictedFile(repoPath, file);
        if (!fileResult.success || !fileResult.data) {
          previews.push({
            file,
            language: 'text',
            originalContent: '',
            proposedContent: '',
            status: 'pending',
            analysis: undefined,
          });
          failedToResolve++;
          continue;
        }

        const { content, language } = fileResult.data;

        // Phase 1: Analyze the conflict with commit context
        let analysis: (ConflictAnalysis & { resolutionPlan?: string }) | undefined;
        try {
          const analysisResult = await this.analyzeConflict(repoPath, file, currentBranch, targetBranch);
          if (analysisResult.success && analysisResult.data) {
            analysis = analysisResult.data;
            this.debugLog?.info('MergeConflict', `Phase 1 analysis complete for ${file}`, {
              conflictType: analysis.conflictType,
              strategy: analysis.recommendedStrategy,
              hasPlan: !!analysis.resolutionPlan,
            });
          }
        } catch {
          // Analysis is optional, continue without it
        }

        // Phase 2: Generate AI resolution using the analysis plan
        const resolution = await this.resolveFileConflict(
          repoPath,
          file,
          currentBranch,
          targetBranch,
          analysis
        );

        if (resolution.success && resolution.data?.resolved && resolution.data.content) {
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: resolution.data.content,
            analysis,
            status: 'pending',
          });
          resolvedByAI++;
        } else {
          // AI couldn't resolve - still show preview with original for manual resolution
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content, // Keep original with markers for manual editing
            analysis,
            status: 'pending',
          });
          failedToResolve++;
        }
      }

      this.debugLog?.info('MergeConflict', `Resolution preview generation complete`, {
        repoPath,
        currentBranch,
        targetBranch,
        totalConflicts: conflictedFiles.length,
        resolvedByAI,
        failedToResolve,
        conflictedFiles,
      });
      if (failedToResolve > 0) {
        this.debugLog?.warn('MergeConflict', `AI failed to resolve ${failedToResolve} of ${conflictedFiles.length} conflicts`, {
          repoPath, failedToResolve, totalConflicts: conflictedFiles.length,
        });
      }

      return {
        repoPath,
        currentBranch,
        targetBranch,
        previews,
        totalConflicts: conflictedFiles.length,
        resolvedByAI,
        failedToResolve,
      };
    }, 'GENERATE_PREVIEWS_FAILED');
  }

  /**
   * Apply user-approved resolutions and continue rebase
   * Only processes previews with status 'approved'
   */
  async applyApprovedResolutions(
    repoPath: string,
    approvedPreviews: ConflictResolutionPreview[]
  ): Promise<IpcResult<ApplyResolutionsResult>> {
    return this.wrap(async () => {
      const applied: string[] = [];
      const failed: string[] = [];
      const skipped: string[] = [];

      for (const preview of approvedPreviews) {
        if (preview.status === 'rejected') {
          skipped.push(preview.file);
          continue;
        }

        if (preview.status !== 'approved' && preview.status !== 'modified') {
          skipped.push(preview.file);
          continue;
        }

        // Use user-modified content if provided, otherwise use AI proposed content
        const contentToApply = preview.userModifiedContent || preview.proposedContent;

        // Verify no conflict markers in content to apply
        if (this.hasConflictMarkers(contentToApply)) {
          this.debugLog?.error('MergeConflict', `Cannot apply resolution — content still has conflict markers`, { filePath: preview.file, repoPath });
        console.error(`[MergeConflict] Cannot apply ${preview.file} - still has conflict markers`);
          failed.push(preview.file);
          continue;
        }

        const result = await this.applyResolution(repoPath, preview.file, contentToApply);
        if (result.success) {
          applied.push(preview.file);
        } else {
          failed.push(preview.file);
        }
      }

      // If all approved files applied successfully, try to continue rebase
      if (failed.length === 0 && applied.length > 0) {
        try {
          await this.git(['rebase', '--continue'], repoPath);
        } catch {
          // May have more conflicts - that's okay, user will see them
        }
      }

      const allApplied = failed.length === 0;
      const resultMsg = allApplied
        ? `Applied ${applied.length} resolution(s)`
        : `Applied ${applied.length}, failed ${failed.length}`;

      if (allApplied) {
        this.debugLog?.info('MergeConflict', `All approved resolutions applied successfully`, {
          repoPath, applied, skipped,
        });
      } else {
        this.debugLog?.error('MergeConflict', `Some resolutions failed to apply`, {
          repoPath, applied, failed, skipped,
        });
      }

      return {
        success: allApplied,
        message: resultMsg,
        applied,
        failed,
        skipped,
      };
    }, 'APPLY_APPROVED_RESOLUTIONS_FAILED');
  }

  /**
   * Abort the current rebase operation
   */
  async abortRebase(repoPath: string): Promise<IpcResult<void>> {
    return this.wrap(async () => {
      await this.git(['rebase', '--abort'], repoPath);
      console.log(`[MergeConflict] Rebase aborted`);
    }, 'ABORT_REBASE_FAILED');
  }

  /**
   * Check if a rebase is currently in progress
   */
  async isRebaseInProgress(repoPath: string): Promise<IpcResult<boolean>> {
    return this.wrap(async () => {
      try {
        const gitDir = await this.git(['rev-parse', '--git-dir'], repoPath);
        const rebaseMergePath = path.join(repoPath, gitDir, 'rebase-merge');
        const rebaseApplyPath = path.join(repoPath, gitDir, 'rebase-apply');

        const mergeExists = await fs.access(rebaseMergePath).then(() => true).catch(() => false);
        const applyExists = await fs.access(rebaseApplyPath).then(() => true).catch(() => false);

        return mergeExists || applyExists;
      } catch {
        return false;
      }
    }, 'CHECK_REBASE_FAILED');
  }

  // ==========================================================================
  // AUTOMATIC WORKFLOW (kept for backwards compatibility, but use with caution)
  // ==========================================================================

  /**
   * Perform rebase with automatic AI conflict resolution
   * WARNING: This auto-applies resolutions. Prefer generateResolutionPreviews + applyApprovedResolutions
   */
  async rebaseWithResolution(
    repoPath: string,
    targetBranch: string,
    maxRetries = 3
  ): Promise<IpcResult<RebaseWithResolutionResult>> {
    return this.wrap(async () => {
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);
      console.log(`[MergeConflict] Starting rebase of ${currentBranch} onto ${targetBranch}`);

      const resolutions: ResolutionResult[] = [];
      let conflictsResolved = 0;
      let conflictsFailed = 0;
      let retries = 0;

      // Start the rebase
      try {
        await this.git(['fetch', 'origin', targetBranch], repoPath);
      } catch (fetchError) {
        return {
          success: false,
          message: `Failed to fetch ${targetBranch}`,
          conflictsResolved: 0,
          conflictsFailed: 0,
          resolutions: [],
        };
      }

      // Start rebase (may fail with conflicts)
      try {
        await this.git(['rebase', `origin/${targetBranch}`], repoPath);
        // If no error, rebase succeeded without conflicts
        return {
          success: true,
          message: 'Rebase completed without conflicts',
          conflictsResolved: 0,
          conflictsFailed: 0,
          resolutions: [],
        };
      } catch {
        // Expected - rebase has conflicts, continue to resolve
        console.log(`[MergeConflict] Rebase has conflicts, attempting AI resolution`);
      }

      // Resolution loop - handle each conflict
      while (retries < maxRetries) {
        // Get conflicted files
        const conflictedResult = await this.getConflictedFiles(repoPath);
        if (!conflictedResult.success || !conflictedResult.data) {
          break;
        }

        const conflictedFiles = conflictedResult.data;
        if (conflictedFiles.length === 0) {
          // No more conflicts, continue rebase
          try {
            await this.git(['rebase', '--continue'], repoPath);
            // Check if rebase is complete or has more conflicts
            continue;
          } catch {
            // May still have conflicts or rebase is complete
            break;
          }
        }

        console.log(`[MergeConflict] Found ${conflictedFiles.length} conflicted files`);

        // Resolve each conflicted file (two-phase: analyze then resolve)
        let allResolved = true;
        for (const file of conflictedFiles) {
          // Phase 1: Analyze with commit context
          let analysis: (ConflictAnalysis & { resolutionPlan?: string }) | undefined;
          try {
            const analysisResult = await this.analyzeConflict(repoPath, file, currentBranch, targetBranch);
            if (analysisResult.success && analysisResult.data) {
              analysis = analysisResult.data;
            }
          } catch {
            // Analysis is optional, continue without it
          }

          // Phase 2: Resolve using the analysis plan
          const resolution = await this.resolveFileConflict(
            repoPath,
            file,
            currentBranch,
            targetBranch,
            analysis
          );

          if (resolution.success && resolution.data) {
            resolutions.push(resolution.data);

            if (resolution.data.resolved && resolution.data.content) {
              // Apply the resolution
              const applyResult = await this.applyResolution(
                repoPath,
                file,
                resolution.data.content
              );

              if (applyResult.success) {
                conflictsResolved++;
              } else {
                conflictsFailed++;
                allResolved = false;
              }
            } else {
              conflictsFailed++;
              allResolved = false;
            }
          } else {
            conflictsFailed++;
            allResolved = false;
            resolutions.push({
              file,
              resolved: false,
              error: 'Resolution failed',
            });
          }
        }

        if (!allResolved) {
          // Some conflicts couldn't be resolved, abort
          this.debugLog?.error('MergeConflict', `Could not resolve all conflicts, aborting rebase`, {
          repoPath, targetBranch, conflictsResolved, conflictsFailed,
          resolutions: resolutions.map(r => ({ file: r.file, resolved: r.resolved, error: r.error })),
        });
        console.warn(`[MergeConflict] Could not resolve all conflicts, aborting rebase`);
          try {
            await this.git(['rebase', '--abort'], repoPath);
          } catch {
            // Ignore abort errors
          }
          return {
            success: false,
            message: `Failed to resolve ${conflictsFailed} conflict(s). Rebase aborted.`,
            conflictsResolved,
            conflictsFailed,
            resolutions,
          };
        }

        // Try to continue the rebase
        try {
          await this.git(['rebase', '--continue'], repoPath);
          // If successful, may have more conflicts or be complete
        } catch {
          // More conflicts or rebase complete
        }

        retries++;
      }

      // Check if rebase is complete
      try {
        // If we can get status without rebase in progress, it's complete
        await this.git(['status'], repoPath);

        // Verify no rebase in progress
        const gitDir = await this.git(['rev-parse', '--git-dir'], repoPath);
        const rebaseInProgress = await fs.access(path.join(repoPath, gitDir, 'rebase-merge'))
          .then(() => true)
          .catch(() => false);

        if (rebaseInProgress) {
          // Still in rebase, abort
          await this.git(['rebase', '--abort'], repoPath);
          return {
            success: false,
            message: 'Rebase could not complete after max retries',
            conflictsResolved,
            conflictsFailed,
            resolutions,
          };
        }

        return {
          success: true,
          message: `Rebase completed. Resolved ${conflictsResolved} conflict(s).`,
          conflictsResolved,
          conflictsFailed,
          resolutions,
        };
      } catch {
        return {
          success: false,
          message: 'Rebase status check failed',
          conflictsResolved,
          conflictsFailed,
          resolutions,
        };
      }
    }, 'REBASE_WITH_RESOLUTION_FAILED');
  }
}
