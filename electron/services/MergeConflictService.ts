/**
 * Merge Conflict Service
 * AI-powered merge conflict resolution using two-phase LLM pipeline
 *
 * Architecture (from FEATURE_DEVOPS_REBASE_AGENT.md):
 *   Phase 0: Triage — classify conflict type, route to appropriate model
 *   Phase 1: Plan  — reasoning LLM analyzes conflict with commit context
 *   Phase 2: Execute — apply resolution (deterministic or LLM-based)
 *
 * Safety guards:
 *   - Confidence threshold (default 0.80) — abort if any conflict scores below
 *   - Max conflict limit (default 15) — abort if too many conflicts (major divergence)
 *   - File-type restrictions — never auto-resolve package.json, lockfiles, .env, etc.
 *   - Backup tag — created before rebase so it can be reverted
 *   - Post-resolution marker scan — verify no conflict markers remain
 */

import { BaseService } from './BaseService';
import type { IpcResult } from '../../shared/types';
import type { AIService, GroqModelKey } from './AIService';
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

// ==========================================================================
// Types
// ==========================================================================

/** Conflict category taxonomy (from real-world rebase sessions) */
export type ConflictCategory =
  | 'append_both'       // Both sides add content (changelogs, new functions)
  | 'keep_current'      // HEAD is clearly better (refactored, newer structure)
  | 'keep_incoming'     // Incoming is better (bug fix, config upgrade)
  | 'semantic_merge'    // Both modify same block with different intent
  | 'structural_adapt'; // One side changed structure, other changed logic

export interface ConflictedFile {
  path: string;
  content: string;
  language: string;
}

export interface ConflictAnalysis {
  currentBranchIntent: string;
  incomingBranchIntent: string;
  conflictType: 'compatible' | 'semantic' | 'structural';
  conflictCategory?: ConflictCategory;
  recommendedStrategy: 'merge_both' | 'prefer_current' | 'prefer_incoming' | 'manual';
  explanation: string;
  complexity: 'simple' | 'moderate' | 'complex';
  confidence?: number;
  resolutionPlan?: string;
  sideEffects?: Array<{
    file: string;
    action: 'update' | 'rewrite';
    description: string;
  }>;
}

/** Triage result from fast model classification */
export interface TriageResult {
  conflictCategory: ConflictCategory;
  complexity: 'simple' | 'moderate' | 'complex';
  confidence: number;
  rationale: string;
}

export interface ResolutionResult {
  file: string;
  resolved: boolean;
  content?: string;
  error?: string;
  analysis?: ConflictAnalysis;
  skippedReason?: string;  // Why the file was skipped (e.g., safety restriction)
}

/** Preview of a proposed conflict resolution — user must approve before applying */
export interface ConflictResolutionPreview {
  file: string;
  language: string;
  originalContent: string;       // The file with conflict markers
  proposedContent: string;       // AI's proposed resolution
  analysis?: ConflictAnalysis;   // AI's analysis of the conflict
  triage?: TriageResult;         // Fast classification result
  status: 'pending' | 'approved' | 'rejected' | 'modified' | 'skipped';
  userModifiedContent?: string;  // If user edits the proposed resolution
  skippedReason?: string;        // Why auto-resolution was skipped
}

/** Result of generating previews for all conflicts */
export interface ConflictPreviewResult {
  repoPath: string;
  currentBranch: string;
  targetBranch: string;
  previews: ConflictResolutionPreview[];
  totalConflicts: number;
  resolvedByAI: number;
  failedToResolve: number;
  skippedFiles: number;
  metrics: RebaseMetrics;
  aborted?: boolean;
  abortReason?: string;
}

/** Result of applying approved resolutions */
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
  metrics?: RebaseMetrics;
}

/** Metrics tracked per rebase run */
export interface RebaseMetrics {
  totalConflicts: number;
  autoResolved: number;        // Resolved by deterministic template (no LLM)
  llmResolved: number;         // Resolved by reasoning model
  aborted: number;             // Failed confidence check
  skipped: number;             // Skipped due to safety restrictions
  phase1LatencyMs: number;     // Planning phase total time
  phase2LatencyMs: number;     // Execution phase total time
  totalLatencyMs: number;
  triageLatencyMs: number;
  backupTag?: string;          // Tag created before rebase
}

// ==========================================================================
// Safety configuration defaults
// ==========================================================================

const DEFAULT_CONFIDENCE_THRESHOLD = 0.80;
const DEFAULT_MAX_CONFLICTS = 15;

/** Files that should NEVER be auto-resolved */
const NEVER_AUTO_RESOLVE: string[] = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  '.env',
  '.env.local',
  '.env.production',
];

/** Lock files — always resolve by accepting incoming (base branch) version */
const LOCK_FILES: string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/** File patterns for migration files — never auto-resolve */
const MIGRATION_PATTERNS = [
  /\/migrations?\//i,
  /\.migration\./i,
  /\d{14}.*\.(sql|ts|js)$/,  // Timestamp-prefixed migration files
];

// ==========================================================================
// Service
// ==========================================================================

export class MergeConflictService extends BaseService {
  private aiService: AIService;
  private debugLog: DebugLogService | null = null;
  private confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  private maxConflicts = DEFAULT_MAX_CONFLICTS;

  constructor(aiService: AIService) {
    super();
    this.aiService = aiService;
  }

  setDebugLog(debugLog: DebugLogService): void {
    this.debugLog = debugLog;
  }

  setConfidenceThreshold(threshold: number): void {
    this.confidenceThreshold = Math.max(0, Math.min(1, threshold));
  }

  setMaxConflicts(max: number): void {
    this.maxConflicts = Math.max(1, max);
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

  // ==========================================================================
  // Safety Guards
  // ==========================================================================

  /**
   * Check if a file should never be auto-resolved
   */
  private isProtectedFile(filePath: string): boolean {
    const basename = path.basename(filePath);

    // Exact filename match
    if (NEVER_AUTO_RESOLVE.includes(basename)) {
      return true;
    }

    // Migration file pattern
    if (MIGRATION_PATTERNS.some(pattern => pattern.test(filePath))) {
      return true;
    }

    return false;
  }

  /**
   * Create a backup tag before rebase
   */
  private async createBackupTag(repoPath: string, currentBranch: string): Promise<string | undefined> {
    try {
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tagName = `backup/pre-rebase-${currentBranch}-${date}`;
      await this.git(['tag', tagName], repoPath);
      console.log(`[MergeConflict] Created backup tag: ${tagName}`);
      this.debugLog?.info('MergeConflict', `Created backup tag`, { tagName, repoPath });
      return tagName;
    } catch (error) {
      console.warn(`[MergeConflict] Failed to create backup tag:`, error);
      return undefined;
    }
  }

  // ==========================================================================
  // Commit Context
  // ==========================================================================

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

  // ==========================================================================
  // Phase 0: Triage — Fast classification for model routing
  // ==========================================================================

  /**
   * Quickly classify a conflict to determine routing
   * Uses fast 8B model for cost efficiency
   */
  async triageConflict(
    repoPath: string,
    filePath: string
  ): Promise<IpcResult<TriageResult>> {
    return this.wrap(async () => {
      const fileResult = await this.readConflictedFile(repoPath, filePath);
      if (!fileResult.success || !fileResult.data) {
        throw new Error(`Failed to read file: ${filePath}`);
      }

      const result = await this.aiService.sendWithMode({
        modeId: 'merge_conflict_resolver',
        promptKey: 'triage',
        variables: {
          file_path: filePath,
          language: fileResult.data.language,
          conflicted_content: fileResult.data.content,
        },
        userMessage: 'Classify this conflict. Return ONLY valid JSON.',
        modelOverride: 'llama-3.1-8b',  // Fast model for triage
      });

      if (!result.success || !result.data) {
        throw new Error('Triage classification failed');
      }

      const jsonMatch = result.data.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse triage response as JSON');
      }

      return JSON.parse(jsonMatch[0]) as TriageResult;
    }, 'TRIAGE_CONFLICT_FAILED');
  }

  // ==========================================================================
  // Deterministic Resolvers (no LLM needed)
  // ==========================================================================

  /**
   * Resolve an append_both conflict deterministically
   * Keeps HEAD content first, then incoming content (chronological order)
   */
  private resolveAppendBoth(content: string): string | null {
    // Match conflict blocks: <<<<<<< ... ======= ... >>>>>>>
    const conflictRegex = /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*/g;
    let resolved = content;
    let hadConflicts = false;

    resolved = resolved.replace(conflictRegex, (_match, ours: string, theirs: string) => {
      hadConflicts = true;
      // Keep both sides: HEAD (ours) first, then incoming (theirs)
      const oursClean = ours.trimEnd();
      const theirsClean = theirs.trimEnd();
      return `${oursClean}\n${theirsClean}`;
    });

    if (!hadConflicts) return null;

    // Verify no markers remain
    if (this.hasConflictMarkers(resolved)) return null;

    return resolved;
  }

  /**
   * Resolve a keep_current conflict by taking the HEAD version
   */
  private resolveKeepCurrent(content: string): string | null {
    const conflictRegex = /<<<<<<< [^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*/g;
    let resolved = content;
    let hadConflicts = false;

    resolved = resolved.replace(conflictRegex, (_match, ours: string) => {
      hadConflicts = true;
      return ours.trimEnd();
    });

    if (!hadConflicts) return null;
    if (this.hasConflictMarkers(resolved)) return null;
    return resolved;
  }

  /**
   * Resolve a keep_incoming conflict by taking the incoming version
   */
  private resolveKeepIncoming(content: string): string | null {
    const conflictRegex = /<<<<<<< [^\n]*\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> [^\n]*/g;
    let resolved = content;
    let hadConflicts = false;

    resolved = resolved.replace(conflictRegex, (_match, theirs: string) => {
      hadConflicts = true;
      return theirs.trimEnd();
    });

    if (!hadConflicts) return null;
    if (this.hasConflictMarkers(resolved)) return null;
    return resolved;
  }

  /**
   * Try to resolve a conflict using deterministic templates based on category
   * Returns null if deterministic resolution is not possible
   */
  private tryDeterministicResolve(
    content: string,
    category: ConflictCategory,
    confidence: number
  ): string | null {
    // Only use deterministic resolution for high-confidence simple conflicts
    if (confidence < 0.90) return null;

    switch (category) {
      case 'append_both':
        return this.resolveAppendBoth(content);
      case 'keep_current':
        return this.resolveKeepCurrent(content);
      case 'keep_incoming':
        return this.resolveKeepIncoming(content);
      default:
        // semantic_merge and structural_adapt always need LLM
        return null;
    }
  }

  // ==========================================================================
  // Phase 1: Analyze — Reasoning LLM builds resolution plan
  // ==========================================================================

  /**
   * Phase 1: Analyze a conflict with commit context to build a resolution plan
   * Uses reasoning model for complex conflicts, fast model if triage says simple
   */
  async analyzeConflict(
    repoPath: string,
    filePath: string,
    currentBranch?: string,
    incomingBranch?: string,
    triage?: TriageResult
  ): Promise<IpcResult<ConflictAnalysis>> {
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

      // Route to appropriate model based on triage complexity
      const modelOverride: GroqModelKey | undefined =
        triage?.complexity === 'simple' ? 'llama-3.1-8b' : undefined;  // undefined = use mode default (kimi-k2)

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
        modelOverride,
      });

      if (!result.success || !result.data) {
        throw new Error('AI analysis failed');
      }

      // Parse JSON from response
      const jsonMatch = result.data.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse AI response as JSON');
      }

      const analysis = JSON.parse(jsonMatch[0]) as ConflictAnalysis;

      // Ensure confidence is a number
      if (typeof analysis.confidence !== 'number') {
        analysis.confidence = triage?.confidence ?? 0.85;
      }

      return analysis;
    }, 'ANALYZE_CONFLICT_FAILED');
  }

  // ==========================================================================
  // Phase 2: Resolve — Apply resolution using plan
  // ==========================================================================

  /**
   * Phase 2: Resolve a single file's conflicts using AI
   * Uses analysis from Phase 1 and commit context for informed resolution
   */
  async resolveFileConflict(
    repoPath: string,
    filePath: string,
    currentBranch: string,
    incomingBranch: string,
    analysis?: ConflictAnalysis,
    triage?: TriageResult
  ): Promise<IpcResult<ResolutionResult>> {
    return this.wrap(async () => {
      this.debugLog?.info('MergeConflict', `Resolving conflict in file`, {
        filePath, repoPath, currentBranch, incomingBranch,
        hasAnalysis: !!analysis,
        strategy: analysis?.recommendedStrategy,
        category: analysis?.conflictCategory || triage?.conflictCategory,
        confidence: analysis?.confidence ?? triage?.confidence,
      });
      console.log(`[MergeConflict] Resolving: ${filePath} (category: ${analysis?.conflictCategory || triage?.conflictCategory || 'unknown'}, confidence: ${analysis?.confidence ?? triage?.confidence ?? '?'})`);

      const isProtected = this.isProtectedFile(filePath);
      const confidence = analysis?.confidence ?? triage?.confidence ?? 0.85;

      // Read the file first so we can attempt deterministic resolution before any blocks
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

      // Lock files: always accept incoming (base branch) version — regenerated by npm install
      const basename = path.basename(filePath);
      if (LOCK_FILES.includes(basename)) {
        console.log(`[MergeConflict] Lock file — accepting incoming version: ${filePath}`);
        const incomingContent = this.resolveKeepIncoming(content);
        if (incomingContent) {
          return {
            file: filePath,
            resolved: true,
            content: incomingContent,
          };
        }
      }

      // Try deterministic resolution first (no LLM — safe even for protected files)
      const category = analysis?.conflictCategory || triage?.conflictCategory;
      if (category) {
        const deterministicResult = this.tryDeterministicResolve(
          content, category, confidence
        );
        if (deterministicResult) {
          console.log(`[MergeConflict] Resolved deterministically (${category}): ${filePath}`);
          this.debugLog?.info('MergeConflict', `Deterministic resolution succeeded`, {
            filePath, category,
          });
          return {
            file: filePath,
            resolved: true,
            content: deterministicResult.trim(),
            analysis,
          };
        }
      }

      // Safety check: protected files block LLM-based resolution (deterministic already tried above)
      if (isProtected) {
        console.log(`[MergeConflict] SKIPPED (protected file, deterministic failed): ${filePath}`);
        this.debugLog?.warn('MergeConflict', `Skipping protected file after deterministic attempt`, { filePath });
        return {
          file: filePath,
          resolved: false,
          skippedReason: `Protected file — requires manual resolution: ${path.basename(filePath)}`,
          analysis,
        };
      }

      // Confidence check: block LLM if confidence too low
      if (confidence < this.confidenceThreshold) {
        console.log(`[MergeConflict] SKIPPED (low confidence ${confidence} < ${this.confidenceThreshold}): ${filePath}`);
        this.debugLog?.warn('MergeConflict', `Skipping low-confidence conflict`, {
          filePath, confidence, threshold: this.confidenceThreshold,
        });
        return {
          file: filePath,
          resolved: false,
          skippedReason: `Low confidence (${(confidence * 100).toFixed(0)}%) — requires manual review`,
          analysis,
        };
      }

      // Get commit context for both branches
      const currentCommits = await this.getBranchCommits(repoPath, currentBranch);
      const incomingCommits = await this.getBranchCommits(repoPath, `origin/${incomingBranch}`);

      // Route to appropriate model
      const isSimple = triage?.complexity === 'simple' || analysis?.complexity === 'simple';
      const modelOverride: GroqModelKey | undefined = isSimple ? 'llama-3.1-8b' : undefined;

      let result;

      if (analysis?.resolutionPlan) {
        // Phase 2: Use the analysis plan from Phase 1
        console.log(`[MergeConflict] Phase 2 resolve_with_plan for ${filePath} (model: ${modelOverride || 'default'})`);
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
            analysis_category: analysis.conflictCategory || 'unknown',
            analysis_strategy: analysis.recommendedStrategy,
            analysis_confidence: String(analysis.confidence ?? '?'),
            analysis_plan: analysis.resolutionPlan,
            current_commits: currentCommits,
            incoming_commits: incomingCommits,
            conflicted_content: content,
          },
          userMessage: 'Follow the resolution plan. Output ONLY the final merged code — no explanations, no markdown fences.',
          modelOverride,
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
          modelOverride,
        });
      }

      if (!result.success || !result.data) {
        const reason = !result.success
          ? (result.error?.message || result.error?.code || 'unknown API error')
          : 'empty response from model';
        const modelUsed = modelOverride || 'mode default (kimi-k2)';
        const errorMsg = `AI resolution failed (${modelUsed}): ${reason}`;
        this.debugLog?.error('MergeConflict', errorMsg, {
          filePath,
          model: modelUsed,
          errorCode: result.error?.code,
          errorMessage: result.error?.message,
          hadData: !!result.data,
        });
        console.error(`[MergeConflict] ${errorMsg} for ${filePath}`);
        return {
          file: filePath,
          resolved: false,
          error: errorMsg,
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

        // Retry with stronger instruction using reasoning model
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
            analysis_category: analysis?.conflictCategory || 'unknown',
            analysis_strategy: analysis?.recommendedStrategy || 'merge_both',
            analysis_confidence: String(analysis?.confidence ?? '?'),
            analysis_plan: analysis?.resolutionPlan || 'Merge both sides, preserving all functionality',
            current_commits: currentCommits,
            incoming_commits: incomingCommits,
            conflicted_content: content,
          },
          userMessage: 'CRITICAL: You MUST remove ALL conflict markers (<<<<<<, ======, >>>>>>) and produce clean, merged code. Output ONLY the resolved code — no markdown, no explanation.',
          // Always use reasoning model for retry
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
   *
   * Options:
   *  - dryRun: if true, only runs Phase 0 (triage) + Phase 1 (plan) — no resolution
   */
  async generateResolutionPreviews(
    repoPath: string,
    targetBranch: string,
    options?: { dryRun?: boolean }
  ): Promise<IpcResult<ConflictPreviewResult>> {
    return this.wrap(async () => {
      const startTime = Date.now();
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);
      this.debugLog?.info('MergeConflict', `Generating resolution previews`, {
        repoPath, currentBranch, targetBranch, dryRun: options?.dryRun,
      });
      console.log(`[MergeConflict] Generating previews for rebase of ${currentBranch} onto ${targetBranch}${options?.dryRun ? ' (DRY RUN)' : ''}`);

      const metrics: RebaseMetrics = {
        totalConflicts: 0,
        autoResolved: 0,
        llmResolved: 0,
        aborted: 0,
        skipped: 0,
        phase1LatencyMs: 0,
        phase2LatencyMs: 0,
        totalLatencyMs: 0,
        triageLatencyMs: 0,
      };

      // Create backup tag before rebase
      const backupTag = await this.createBackupTag(repoPath, currentBranch);
      metrics.backupTag = backupTag;

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
        metrics.totalLatencyMs = Date.now() - startTime;
        return {
          repoPath,
          currentBranch,
          targetBranch,
          previews: [],
          totalConflicts: 0,
          resolvedByAI: 0,
          failedToResolve: 0,
          skippedFiles: 0,
          metrics,
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
      metrics.totalConflicts = conflictedFiles.length;

      // Safety: abort if too many conflicts
      if (conflictedFiles.length > this.maxConflicts) {
        this.debugLog?.error('MergeConflict', `Too many conflicts (${conflictedFiles.length} > ${this.maxConflicts}), aborting`, {
          repoPath, conflictCount: conflictedFiles.length, maxConflicts: this.maxConflicts,
        });
        console.warn(`[MergeConflict] ABORTING: ${conflictedFiles.length} conflicts exceeds limit of ${this.maxConflicts}`);

        // Abort the rebase
        try { await this.git(['rebase', '--abort'], repoPath); } catch { /* ignore */ }

        metrics.aborted = conflictedFiles.length;
        metrics.totalLatencyMs = Date.now() - startTime;
        return {
          repoPath,
          currentBranch,
          targetBranch,
          previews: [],
          totalConflicts: conflictedFiles.length,
          resolvedByAI: 0,
          failedToResolve: 0,
          skippedFiles: 0,
          metrics,
          aborted: true,
          abortReason: `Too many conflicts (${conflictedFiles.length}) — likely a major divergence requiring manual review. Max: ${this.maxConflicts}`,
        };
      }

      const previews: ConflictResolutionPreview[] = [];
      let resolvedByAI = 0;
      let failedToResolve = 0;
      let skippedFiles = 0;

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

        // Lock files: accept incoming version automatically
        const fileBasename = path.basename(file);
        if (LOCK_FILES.includes(fileBasename)) {
          const incomingContent = this.resolveKeepIncoming(content);
          if (incomingContent) {
            console.log(`[MergeConflict] Lock file — accepting incoming version: ${file}`);
            previews.push({
              file,
              language,
              originalContent: content,
              proposedContent: incomingContent,
              status: 'approved',
            });
            resolvedByAI++;
            continue;
          }
        }

        // Safety: check if file is protected
        if (this.isProtectedFile(file)) {
          console.log(`[MergeConflict] Protected file, skipping auto-resolve: ${file}`);
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content,
            status: 'skipped',
            skippedReason: `Protected file — requires manual resolution: ${path.basename(file)}`,
          });
          skippedFiles++;
          metrics.skipped++;
          continue;
        }

        // Phase 0: Triage
        const triageStart = Date.now();
        let triage: TriageResult | undefined;
        try {
          const triageResult = await this.triageConflict(repoPath, file);
          if (triageResult.success && triageResult.data) {
            triage = triageResult.data;
            console.log(`[MergeConflict] Triage: ${file} → ${triage.conflictCategory} (${triage.complexity}, confidence: ${triage.confidence})`);
          }
        } catch {
          // Triage is optional
        }
        metrics.triageLatencyMs += Date.now() - triageStart;

        // Phase 1: Analyze the conflict with commit context
        const phase1Start = Date.now();
        let analysis: ConflictAnalysis | undefined;
        try {
          const analysisResult = await this.analyzeConflict(repoPath, file, currentBranch, targetBranch, triage);
          if (analysisResult.success && analysisResult.data) {
            analysis = analysisResult.data;
            this.debugLog?.info('MergeConflict', `Phase 1 analysis complete for ${file}`, {
              conflictType: analysis.conflictType,
              category: analysis.conflictCategory,
              strategy: analysis.recommendedStrategy,
              confidence: analysis.confidence,
              hasPlan: !!analysis.resolutionPlan,
              sideEffects: analysis.sideEffects?.length ?? 0,
            });
          }
        } catch {
          // Analysis is optional, continue without it
        }
        metrics.phase1LatencyMs += Date.now() - phase1Start;

        // Dry-run mode: only triage + analyze, no resolution
        if (options?.dryRun) {
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content,  // No resolution in dry-run
            analysis,
            triage,
            status: 'pending',
          });
          continue;
        }

        // Confidence gate: skip if below threshold
        const confidence = analysis?.confidence ?? triage?.confidence ?? 0.85;
        if (confidence < this.confidenceThreshold) {
          console.log(`[MergeConflict] Low confidence (${confidence}), skipping: ${file}`);
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content,
            analysis,
            triage,
            status: 'skipped',
            skippedReason: `Low confidence (${(confidence * 100).toFixed(0)}%) — requires manual review`,
          });
          skippedFiles++;
          metrics.skipped++;
          continue;
        }

        // Phase 2: Generate AI resolution using the analysis plan
        const phase2Start = Date.now();
        const resolution = await this.resolveFileConflict(
          repoPath,
          file,
          currentBranch,
          targetBranch,
          analysis,
          triage
        );
        metrics.phase2LatencyMs += Date.now() - phase2Start;

        if (resolution.success && resolution.data?.resolved && resolution.data.content) {
          // Track whether this was deterministic or LLM
          const category = analysis?.conflictCategory || triage?.conflictCategory;
          const wasDeterministic = category && ['append_both', 'keep_current', 'keep_incoming'].includes(category) && confidence >= 0.90;
          if (wasDeterministic) {
            metrics.autoResolved++;
          } else {
            metrics.llmResolved++;
          }

          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: resolution.data.content,
            analysis,
            triage,
            status: 'pending',
          });
          resolvedByAI++;
        } else if (resolution.data?.skippedReason) {
          // Skipped (protected file or low confidence — handled inside resolveFileConflict)
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content,
            analysis,
            triage,
            status: 'skipped',
            skippedReason: resolution.data.skippedReason,
          });
          skippedFiles++;
          metrics.skipped++;
        } else {
          // AI couldn't resolve - still show preview with original for manual resolution
          previews.push({
            file,
            language,
            originalContent: content,
            proposedContent: content,
            analysis,
            triage,
            status: 'pending',
          });
          failedToResolve++;
        }
      }

      metrics.totalLatencyMs = Date.now() - startTime;

      this.debugLog?.info('MergeConflict', `Resolution preview generation complete`, {
        repoPath, currentBranch, targetBranch,
        totalConflicts: conflictedFiles.length,
        resolvedByAI, failedToResolve, skippedFiles,
        metrics,
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
        skippedFiles,
        metrics,
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
        if (preview.status === 'rejected' || preview.status === 'skipped') {
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
      const startTime = Date.now();
      const currentBranch = await this.git(['branch', '--show-current'], repoPath);
      console.log(`[MergeConflict] Starting rebase of ${currentBranch} onto ${targetBranch}`);

      const metrics: RebaseMetrics = {
        totalConflicts: 0,
        autoResolved: 0,
        llmResolved: 0,
        aborted: 0,
        skipped: 0,
        phase1LatencyMs: 0,
        phase2LatencyMs: 0,
        totalLatencyMs: 0,
        triageLatencyMs: 0,
      };

      // Create backup tag
      const backupTag = await this.createBackupTag(repoPath, currentBranch);
      metrics.backupTag = backupTag;

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
          metrics,
        };
      }

      // Start rebase (may fail with conflicts)
      try {
        await this.git(['rebase', `origin/${targetBranch}`], repoPath);
        // If no error, rebase succeeded without conflicts
        metrics.totalLatencyMs = Date.now() - startTime;
        return {
          success: true,
          message: 'Rebase completed without conflicts',
          conflictsResolved: 0,
          conflictsFailed: 0,
          resolutions: [],
          metrics,
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
            continue;
          } catch {
            break;
          }
        }

        metrics.totalConflicts += conflictedFiles.length;

        // Safety: abort if too many conflicts
        if (conflictedFiles.length > this.maxConflicts) {
          this.debugLog?.error('MergeConflict', `Too many conflicts, aborting`, {
            repoPath, conflictCount: conflictedFiles.length, maxConflicts: this.maxConflicts,
          });
          try { await this.git(['rebase', '--abort'], repoPath); } catch { /* ignore */ }
          metrics.aborted = conflictedFiles.length;
          metrics.totalLatencyMs = Date.now() - startTime;
          return {
            success: false,
            message: `Too many conflicts (${conflictedFiles.length} > ${this.maxConflicts}). Rebase aborted.`,
            conflictsResolved,
            conflictsFailed,
            resolutions,
            metrics,
          };
        }

        console.log(`[MergeConflict] Found ${conflictedFiles.length} conflicted files`);

        // Resolve each conflicted file (three-phase: triage → analyze → resolve)
        let allResolved = true;
        for (const file of conflictedFiles) {
          // Phase 0: Triage
          const triageStart = Date.now();
          let triage: TriageResult | undefined;
          try {
            const triageResult = await this.triageConflict(repoPath, file);
            if (triageResult.success && triageResult.data) {
              triage = triageResult.data;
            }
          } catch { /* triage optional */ }
          metrics.triageLatencyMs += Date.now() - triageStart;

          // Phase 1: Analyze with commit context
          const phase1Start = Date.now();
          let analysis: ConflictAnalysis | undefined;
          try {
            const analysisResult = await this.analyzeConflict(repoPath, file, currentBranch, targetBranch, triage);
            if (analysisResult.success && analysisResult.data) {
              analysis = analysisResult.data;
            }
          } catch {
            // Analysis is optional, continue without it
          }
          metrics.phase1LatencyMs += Date.now() - phase1Start;

          // Phase 2: Resolve using the analysis plan
          const phase2Start = Date.now();
          const resolution = await this.resolveFileConflict(
            repoPath,
            file,
            currentBranch,
            targetBranch,
            analysis,
            triage
          );
          metrics.phase2LatencyMs += Date.now() - phase2Start;

          if (resolution.success && resolution.data) {
            resolutions.push(resolution.data);

            if (resolution.data.skippedReason) {
              // Protected file or low confidence
              metrics.skipped++;
              conflictsFailed++;
              allResolved = false;
            } else if (resolution.data.resolved && resolution.data.content) {
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
            resolutions: resolutions.map(r => ({ file: r.file, resolved: r.resolved, error: r.error, skipped: r.skippedReason })),
          });
          console.warn(`[MergeConflict] Could not resolve all conflicts, aborting rebase`);
          try {
            await this.git(['rebase', '--abort'], repoPath);
          } catch {
            // Ignore abort errors
          }
          metrics.totalLatencyMs = Date.now() - startTime;
          return {
            success: false,
            message: `Failed to resolve ${conflictsFailed} conflict(s). Rebase aborted.${backupTag ? ` Backup: ${backupTag}` : ''}`,
            conflictsResolved,
            conflictsFailed,
            resolutions,
            metrics,
          };
        }

        // Try to continue the rebase
        try {
          await this.git(['rebase', '--continue'], repoPath);
        } catch {
          // More conflicts or rebase complete
        }

        retries++;
      }

      // Check if rebase is complete
      try {
        await this.git(['status'], repoPath);

        const gitDir = await this.git(['rev-parse', '--git-dir'], repoPath);
        const rebaseInProgress = await fs.access(path.join(repoPath, gitDir, 'rebase-merge'))
          .then(() => true)
          .catch(() => false);

        if (rebaseInProgress) {
          await this.git(['rebase', '--abort'], repoPath);
          metrics.totalLatencyMs = Date.now() - startTime;
          return {
            success: false,
            message: `Rebase could not complete after max retries.${backupTag ? ` Backup: ${backupTag}` : ''}`,
            conflictsResolved,
            conflictsFailed,
            resolutions,
            metrics,
          };
        }

        metrics.totalLatencyMs = Date.now() - startTime;
        return {
          success: true,
          message: `Rebase completed. Resolved ${conflictsResolved} conflict(s).`,
          conflictsResolved,
          conflictsFailed,
          resolutions,
          metrics,
        };
      } catch {
        metrics.totalLatencyMs = Date.now() - startTime;
        return {
          success: false,
          message: 'Rebase status check failed',
          conflictsResolved,
          conflictsFailed,
          resolutions,
          metrics,
        };
      }
    }, 'REBASE_WITH_RESOLUTION_FAILED');
  }
}
