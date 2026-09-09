/**
 * CreateAgentWizard Component
 * Conversational wizard for creating new agent instances
 */

import React, { useState } from 'react';
import { RepoSelector } from './RepoSelector';
import { AgentTypeSelector } from './AgentTypeSelector';
import { InstructionsModal } from './InstructionsModal';
import { KanvasLogo } from '../ui/KanvasLogo';
import type { AgentType, RepoValidation, AgentInstance, AgentInstanceConfig, RebaseFrequency, MultiRepoConfig, RepoEntry } from '../../../shared/types';
import { generateSecondaryBranchName } from '../../../shared/types';

interface CreateAgentWizardProps {
  onClose: () => void;
  /**
   * Optional repo path to pre-select (Day 2). When provided, the wizard
   * skips the repo-pick step and starts at 'setup'. Useful for the
   * "New session" button on RepoStatusCard.
   */
  initialRepoPath?: string | null;
  /**
   * Optional task description to pre-fill. Used by "Resolve with AI" in the
   * workspace view to pre-populate the task with a description of the issues.
   */
  initialTask?: string | null;
}

type WizardStep = 'repo' | 'setup' | 'agent' | 'multi-repo' | 'workflow' | 'prompt' | 'complete';

type FeatureOrgStructure = 'feature-folders' | 'flat' | 'migrate';

interface AgentSettings {
  taskDescription: string;
  branchName: string;
  baseBranch: string;
  rebaseFrequency: RebaseFrequency;
  autoCommit: boolean;
  systemPrompt: string;
  contextPreservation: string;
  // GitHub Action on merge (tag-push)
  mergeActionEnabled: boolean;
  mergeActionTagPrefix: string;
}

const DEFAULT_SYSTEM_PROMPT = `Follow existing code style and patterns
Write clean, maintainable code
Add tests for new functionality
Use clear, descriptive commit messages
Ask before making major architectural changes`;

const DEFAULT_CONTEXT_PRESERVATION = `SESSION_ID: [will be filled automatically]
WORKTREE: [will be filled automatically]
BRANCH: [will be filled automatically]
TASK: [describe the task]

Key things to remember after context compaction:
- Always re-read houserules.md after compaction
- Check .file-coordination/active-edits/ for file claims
- Write commits to .devops-commit-<session>.msg`;

export function CreateAgentWizard({ onClose, initialRepoPath, initialTask }: CreateAgentWizardProps): React.ReactElement {
  const [currentStep, setCurrentStep] = useState<WizardStep>(
    initialRepoPath ? 'setup' : 'repo'
  );
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this repo already has sessions — drives "using previous settings" UX
  const [hasPreviousSession, setHasPreviousSession] = useState(false);

  // Form state
  const [repoPath, setRepoPath] = useState<string | null>(initialRepoPath ?? null);
  const [repoValidation, setRepoValidation] = useState<RepoValidation | null>(null);

  const [agentType, setAgentType] = useState<AgentType | null>(null);
  const [settings, setSettings] = useState<AgentSettings>({
    taskDescription: initialTask ?? '',
    branchName: '',
    baseBranch: 'main',
    rebaseFrequency: 'daily',
    autoCommit: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    contextPreservation: DEFAULT_CONTEXT_PRESERVATION,
    mergeActionEnabled: false,
    mergeActionTagPrefix: '',
  });

  // Detected version-tag prefixes in the selected repo (for the GH Action picker).
  const [tagPrefixes, setTagPrefixes] = useState<Array<{ prefix: string; count: number; latest: string }>>([]);

  // Result
  const [createdInstance, setCreatedInstance] = useState<AgentInstance | null>(null);

  // Refine-with-AI state
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refinedPersona, setRefinedPersona] = useState<string | null>(null);

  const handleRefineTask = async () => {
    setRefineError(null);
    const raw = settings.taskDescription.trim();
    if (!raw) {
      setRefineError('Type a task first');
      return;
    }
    if (!window.api?.ai?.refineSessionTask) {
      setRefineError('Refine is not available in this build');
      return;
    }
    setRefining(true);
    try {
      const repoName = repoPath ? repoPath.split('/').filter(Boolean).pop() : undefined;
      const result = await window.api.ai.refineSessionTask({
        rawTask: raw,
        agentType: agentType || 'claude',
        repoName,
      });
      if (result.success && result.data) {
        setSettings(s => ({ ...s, taskDescription: result.data!.refinedTask }));
        setRefinedPersona(result.data.persona);
      } else {
        setRefineError(result.error?.message || 'Refine failed');
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const personaLabel = (p: string): string =>
    p === 'product_manager' ? 'Senior Product Manager'
      : p === 'senior_ai_engineer' ? 'Senior AI Engineer'
      : p === 'senior_engineer' ? 'Senior Engineer'
      : p;

  // First-run setup
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [featureOrgChoice, setFeatureOrgChoice] = useState<FeatureOrgStructure>('feature-folders');

  // Custom agent MCP opt-in
  const [customMcpEnabled, setCustomMcpEnabled] = useState(false);

  // Multi-repo settings
  const [multiRepoEnabled, setMultiRepoEnabled] = useState(false);
  const [detectedSubmodules, setDetectedSubmodules] = useState<Array<{ name: string; path: string; url: string }>>([]);
  const [selectedSecondaryRepos, setSelectedSecondaryRepos] = useState<Array<{ repoPath: string; repoName: string; isSubmodule: boolean }>>([]);
  const [commitScope, setCommitScope] = useState<'all' | 'per-repo'>('all');

  /**
   * Load defaults from the most recent session for this repo.
   * Returns true if a previous session was found and defaults applied.
   */
  const loadPreviousSessionDefaults = React.useCallback(async (path: string): Promise<boolean> => {
    try {
      const result = await window.api?.instance?.list?.();
      if (!result?.success || !result.data) return false;

      // Find the most recently-created session for this repo
      const repoSessions = result.data
        .filter(inst => inst.config?.repoPath === path)
        .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

      if (repoSessions.length === 0) return false;

      const last = repoSessions[0];
      const cfg = last.config;

      setHasPreviousSession(true);
      if (cfg.agentType) setAgentType(cfg.agentType as AgentType);
      if (cfg.multiRepo) {
        setMultiRepoEnabled(true);
        setCommitScope(cfg.multiRepo.commitScope || 'all');
        // Restore secondary repos list
        if (cfg.multiRepo.secondaryRepos?.length) {
          setSelectedSecondaryRepos(cfg.multiRepo.secondaryRepos.map(r => ({
            repoPath: r.repoPath,
            repoName: r.repoName,
            isSubmodule: r.isSubmodule,
          })));
        }
      }
      setSettings(s => ({
        ...s,
        rebaseFrequency: cfg.rebaseFrequency || s.rebaseFrequency,
        autoCommit: cfg.autoCommit !== undefined ? cfg.autoCommit : s.autoCommit,
        systemPrompt: cfg.systemPrompt || s.systemPrompt,
        contextPreservation: cfg.contextPreservation || s.contextPreservation,
        // Keep baseBranch from repo validation (current branch) unless we have a specific one
        baseBranch: s.baseBranch !== 'main' ? s.baseBranch : (cfg.baseBranch || s.baseBranch),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  // When opened with a prefill, kick off validation + load previous defaults.
  // Then advance past the 'setup' placeholder to the right step.
  React.useEffect(() => {
    if (!initialRepoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const [validationResult, hasPrev] = await Promise.all([
          window.api?.instance?.validateRepo?.(initialRepoPath),
          loadPreviousSessionDefaults(initialRepoPath),
        ]);
        if (cancelled) return;
        if (validationResult?.success && validationResult.data) {
          setRepoValidation(validationResult.data);
          // Default the base branch to the repo's current branch — but never to a
          // detached-HEAD/"HEAD" sentinel. Fall back to a primary that actually exists.
          setSettings((s) => ({ ...s, baseBranch: pickDefaultBaseBranch(validationResult.data!) }));
          // Detect existing version-tag prefixes (for the GitHub-Action-on-merge picker).
          // If the repo has a versioned-tag convention, default the toggle ON —
          // KIT was treating tag-push as opt-in and most users assumed the absence
          // of the tag UI at merge meant tags broke. A repo that already tags
          // releases obviously wants its workflow fired on merge.
          window.api?.git?.detectTagPrefixes?.(initialRepoPath).then((r) => {
            if (!cancelled && r?.success && r.data) {
              setTagPrefixes(r.data);
              if (r.data[0]) {
                setSettings((s) => ({
                  ...s,
                  mergeActionTagPrefix: s.mergeActionTagPrefix || r.data![0].prefix,
                  mergeActionEnabled: s.mergeActionEnabled || true,
                }));
              }
            }
          }).catch(() => {});
        }

        // Advance past the 'setup' placeholder to the correct first step
        if (hasPrev) {
          // Previous session found — skip first-run setup, go to agent type
          setNeedsSetup(false);
          setCurrentStep('agent');
        } else {
          // No previous session — check if first-run setup is needed
          try {
            const setupResult = await window.api?.contractRegistry?.needsFirstRunSetup(initialRepoPath);
            if (!cancelled) {
              if (setupResult?.success && setupResult.data) {
                setNeedsSetup(true);
                setCurrentStep('setup');
              } else {
                setNeedsSetup(false);
                setCurrentStep('agent');
              }
            }
          } catch {
            if (!cancelled) {
              setNeedsSetup(false);
              setCurrentStep('agent');
            }
          }
        }
      } catch {
        // ignore — wizard still usable, user can re-pick
        if (!cancelled) setCurrentStep('repo');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialRepoPath, loadPreviousSessionDefaults]);

  const handleRepoSelect = async (path: string, validation: RepoValidation) => {
    setRepoPath(path);
    setRepoValidation(validation);
    setError(null);
    setSettings(s => ({ ...s, baseBranch: pickDefaultBaseBranch(validation) }));
    window.api?.git?.detectTagPrefixes?.(path).then((r) => {
      if (r?.success && r.data) {
        setTagPrefixes(r.data);
        if (r.data[0]) setSettings((s) => ({ ...s, mergeActionTagPrefix: s.mergeActionTagPrefix || r.data![0].prefix }));
      }
    }).catch(() => {});

    // Load previous session defaults for this repo + detect submodules in parallel
    const [hasPrev] = await Promise.all([
      loadPreviousSessionDefaults(path),
      (async () => {
        try {
          const subResult = await window.api?.git?.detectSubmodules(path);
          if (subResult?.success && subResult.data?.length > 0) {
            setDetectedSubmodules(subResult.data);
          } else {
            setDetectedSubmodules([]);
          }
        } catch {
          setDetectedSubmodules([]);
        }
      })(),
    ]);

    // If a previous session exists for this repo, skip the one-time setup step —
    // it was already done. Jump straight to agent type selection.
    if (hasPrev) {
      setNeedsSetup(false);
      setTimeout(() => setCurrentStep('agent'), 300);
      return;
    }

    // Check if first-run setup is needed (new repo, never set up before)
    try {
      const result = await window.api?.contractRegistry?.needsFirstRunSetup(path);
      if (result?.success && result.data) {
        setNeedsSetup(true);
        setTimeout(() => setCurrentStep('setup'), 300);
      } else {
        setNeedsSetup(false);
        setTimeout(() => setCurrentStep('agent'), 300);
      }
    } catch {
      // If check fails, skip setup step
      setNeedsSetup(false);
      setTimeout(() => setCurrentStep('agent'), 300);
    }
  };

  const handleSetupComplete = async () => {
    if (!repoPath) return;

    try {
      // Save organization config
      await window.api?.contractRegistry?.setOrganizationConfig(repoPath, {
        enabled: featureOrgChoice === 'feature-folders',
        structure: featureOrgChoice === 'migrate' ? 'flat' : featureOrgChoice,
        setupCompleted: true,
        setupCompletedAt: new Date().toISOString(),
      });

      // Initialize contract registry
      await window.api?.contractRegistry?.initialize(repoPath);

      setCurrentStep('agent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setup');
    }
  };

  const handleSkipSetup = async () => {
    if (!repoPath) return;

    try {
      // Mark setup as completed but keep flat structure
      await window.api?.contractRegistry?.setOrganizationConfig(repoPath, {
        enabled: false,
        structure: 'flat',
        setupCompleted: true,
        setupCompletedAt: new Date().toISOString(),
      });

      setCurrentStep('agent');
    } catch {
      // Continue anyway
      setCurrentStep('agent');
    }
  };

  const handleAgentSelect = (type: AgentType) => {
    setAgentType(type);
    setError(null);
    // Generate unique branch name with date + short random suffix to avoid collisions
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const uniqueSuffix = Math.random().toString(36).substring(2, 6);
    setSettings(s => ({ ...s, branchName: `${type}-session-${timestamp}-${uniqueSuffix}` }));
    setTimeout(() => setCurrentStep('multi-repo'), 300);
  };

  const handleMultiRepoContinue = () => {
    setCurrentStep('workflow');
  };

  const toggleSubmoduleSelection = (sub: { name: string; path: string; url: string }) => {
    setSelectedSecondaryRepos(prev => {
      const exists = prev.find(r => r.repoPath === sub.path);
      if (exists) {
        return prev.filter(r => r.repoPath !== sub.path);
      }
      return [...prev, { repoPath: sub.path, repoName: sub.name, isSubmodule: true }];
    });
  };

  const handleCreate = async () => {
    if (!repoPath || !agentType) {
      setError('Please complete all steps');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Build multi-repo config if enabled and repos selected
      let multiRepo: MultiRepoConfig | undefined;
      if (multiRepoEnabled && selectedSecondaryRepos.length > 0) {
        const primaryRepoName = repoPath.split('/').pop() || repoPath;
        const primaryEntry: RepoEntry = {
          repoPath,
          repoName: primaryRepoName,
          branchName: settings.branchName,
          baseBranch: settings.baseBranch,
          worktreePath: '', // Set during instance creation
          role: 'primary',
          isSubmodule: false,
        };
        const secondaryEntries: RepoEntry[] = selectedSecondaryRepos.map(r => ({
          repoPath: r.repoPath,
          repoName: r.repoName,
          branchName: generateSecondaryBranchName(primaryRepoName),
          baseBranch: 'main',
          worktreePath: '', // Set during instance creation
          role: 'secondary' as const,
          isSubmodule: r.isSubmodule,
        }));
        multiRepo = {
          primaryRepo: primaryEntry,
          secondaryRepos: secondaryEntries,
          commitScope,
        };
      }

      const config: AgentInstanceConfig = {
        repoPath,
        agentType,
        taskDescription: settings.taskDescription || settings.branchName || `${agentType} session`,
        branchName: settings.branchName,
        baseBranch: settings.baseBranch,
        useWorktree: false,
        autoCommit: settings.autoCommit,
        commitInterval: 30000,
        rebaseFrequency: settings.rebaseFrequency,
        systemPrompt: settings.systemPrompt,
        contextPreservation: settings.contextPreservation,
        multiRepo,
        customMcpEnabled: agentType === 'custom' ? customMcpEnabled : undefined,
        mergeAction: settings.mergeActionEnabled && settings.mergeActionTagPrefix.trim()
          ? { enabled: true, type: 'tag-push' as const, tagPrefix: settings.mergeActionTagPrefix.trim(), versionBump: 'patch' as const }
          : undefined,
      };

      const result = await window.api?.instance?.create(config);

      if (result?.success && result.data) {
        setCreatedInstance(result.data);
        setCurrentStep('complete');
      } else {
        setError(result?.error?.message || 'Failed to create agent instance');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsCreating(false);
    }
  };

  // Show instructions modal if complete
  if (currentStep === 'complete' && createdInstance) {
    return (
      <InstructionsModal
        instance={createdInstance}
        onClose={onClose}
      />
    );
  }

  // Calculate step number (setup step is optional, multi-repo is always shown)
  const totalSteps = needsSetup ? 6 : 5;
  const stepNumber = {
    repo: 1,
    setup: 2,
    agent: needsSetup ? 3 : 2,
    'multi-repo': needsSetup ? 4 : 3,
    workflow: needsSetup ? 5 : 4,
    prompt: needsSetup ? 6 : 5,
    complete: needsSetup ? 7 : 6,
  }[currentStep];

  return (
    <>
      {/* Backdrop */}
      <div className="modal-backdrop" onClick={onClose} />

      {/* Modal */}
      <div className="modal w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[rgba(0,0,0,0.10)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KanvasLogo size="lg" />
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Set Up Agent Session</h2>
              <p className="text-sm text-text-secondary">Step {stepNumber} of {totalSteps}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-icon">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-6 py-2 bg-surface-secondary border-b border-[rgba(0,0,0,0.10)]">
          <div className="flex gap-2">
            {Array.from({ length: totalSteps }, (_, idx) => (
              <div
                key={idx}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  idx < stepNumber ? 'bg-black' : 'bg-[rgba(0,0,0,0.10)]'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 rounded-[14px] bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* Step 1: Repository */}
          {currentStep === 'repo' && (
            <div className="space-y-6">
              <ConversationBubble>
                <p className="text-lg font-medium">Which repository should the agent work on?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Select a Git repository for this coding session.
                </p>
              </ConversationBubble>

              <div className="mt-6">
                <RepoSelector
                  selectedPath={repoPath}
                  onSelect={handleRepoSelect}
                />
              </div>
            </div>
          )}

          {/* Step 2: First-Run Setup (only shows if needsSetup) */}
          {currentStep === 'setup' && (
            <div className="space-y-6">
              <CompletedStep>
                {repoValidation?.repoName || 'Repository'} selected
              </CompletedStep>

              <ConversationBubble>
                <p className="text-lg font-medium">Set up code organization for this repo?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Feature-based folders help keep code organized and make test coverage tracking easier.
                </p>
              </ConversationBubble>

              <div className="space-y-3 mt-4">
                {/* Option 1: Feature Folders (Recommended) */}
                <SetupOption
                  selected={featureOrgChoice === 'feature-folders'}
                  onClick={() => setFeatureOrgChoice('feature-folders')}
                  recommended
                  title="Enable Feature Folders"
                  description="New code will be organized into src/features/{name}/ with tests alongside code"
                  icon={
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  }
                />

                {/* Option 2: Keep Current */}
                <SetupOption
                  selected={featureOrgChoice === 'flat'}
                  onClick={() => setFeatureOrgChoice('flat')}
                  title="Keep Current Structure"
                  description="Agent will follow existing patterns in the codebase"
                  icon={
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                  }
                />

                {/* Option 3: Migrate (Coming Soon) */}
                <SetupOption
                  selected={featureOrgChoice === 'migrate'}
                  onClick={() => setFeatureOrgChoice('migrate')}
                  title="Migrate Existing Code"
                  description="AI will analyze and reorganize your codebase into feature folders"
                  comingSoon
                  icon={
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  }
                />
              </div>

              {/* House Rules Preview */}
              {featureOrgChoice === 'feature-folders' && (
                <div className="mt-4 p-4 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface-secondary">
                  <p className="text-sm font-medium text-text-primary mb-2">This will add to house rules:</p>
                  <div className="text-xs text-text-secondary font-mono space-y-1">
                    <p>• Features go in src/features/{'{name}'}/ folders</p>
                    <p>• Tests live with their feature code</p>
                    <p>• Each feature has index.ts for public exports</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Agent Type */}
          {currentStep === 'agent' && (
            <div className="space-y-6">
              <CompletedStep>
                {repoValidation?.repoName || 'Repository'} selected
              </CompletedStep>

              <ConversationBubble>
                <p className="text-lg font-medium">What type of AI agent will be working?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Choose the coding assistant you'll be using.
                </p>
              </ConversationBubble>

              <div className="mt-4">
                <AgentTypeSelector
                  selectedType={agentType}
                  onSelect={handleAgentSelect}
                  customMcpEnabled={customMcpEnabled}
                  onCustomMcpChange={setCustomMcpEnabled}
                />
              </div>
            </div>
          )}

          {/* Step: Multi-Repo Configuration */}
          {currentStep === 'multi-repo' && (
            <div className="space-y-6">
              <CompletedStep>
                {agentType?.charAt(0).toUpperCase()}{agentType?.slice(1)} agent for {repoValidation?.repoName}
              </CompletedStep>

              {hasPreviousSession && (
                <PreviousSettingsBanner />
              )}

              <ConversationBubble>
                <p className="text-lg font-medium">Working across multiple repositories?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Enable multi-repo mode if your work spans multiple repositories or submodules.
                </p>
              </ConversationBubble>

              <div className="space-y-4 mt-4">
                {/* Toggle */}
                <SettingCard
                  title="Multi-Repo Mode (Advanced)"
                  description="Manage multiple repositories in a single session"
                >
                  <div className="flex gap-3">
                    <OptionButton
                      selected={!multiRepoEnabled}
                      onClick={() => {
                        setMultiRepoEnabled(false);
                        setSelectedSecondaryRepos([]);
                      }}
                    >
                      Single repo
                    </OptionButton>
                    <OptionButton
                      selected={multiRepoEnabled}
                      onClick={() => setMultiRepoEnabled(true)}
                    >
                      Multi-repo
                    </OptionButton>
                  </div>
                </SettingCard>

                {multiRepoEnabled && (
                  <>
                    {/* Detected Submodules */}
                    {detectedSubmodules.length > 0 && (
                      <SettingCard
                        title="Detected Submodules"
                        description="Select submodules to include in this session"
                      >
                        <div className="space-y-2">
                          {detectedSubmodules.map(sub => {
                            const isSelected = selectedSecondaryRepos.some(r => r.repoPath === sub.path);
                            return (
                              <label
                                key={sub.path}
                                className={`flex items-center gap-3 p-3 rounded-[10px] border cursor-pointer transition-all ${
                                  isSelected ? 'border-black bg-[rgba(0,0,0,0.04)]' : 'border-[rgba(0,0,0,0.10)] hover:border-[rgba(0,0,0,0.25)]'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSubmoduleSelection(sub)}
                                  className="w-4 h-4 rounded border-[rgba(0,0,0,0.20)] text-black"
                                />
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-text-primary text-sm">{sub.name}</span>
                                  <span className="text-xs text-text-secondary ml-2">{sub.path}</span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </SettingCard>
                    )}

                    {detectedSubmodules.length === 0 && (
                      <div className="p-4 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface-secondary">
                        <p className="text-sm text-text-secondary">
                          No submodules detected in this repository.
                          You can add external repositories below.
                        </p>
                      </div>
                    )}

                    {/* Commit Scope */}
                    {selectedSecondaryRepos.length > 0 && (
                      <SettingCard
                        title="Commit Scope"
                        description="How should commits be handled across repositories?"
                      >
                        <div className="flex gap-3">
                          <OptionButton
                            selected={commitScope === 'all'}
                            onClick={() => setCommitScope('all')}
                          >
                            Commit all at once
                          </OptionButton>
                          <OptionButton
                            selected={commitScope === 'per-repo'}
                            onClick={() => setCommitScope('per-repo')}
                          >
                            Commit per-repo
                          </OptionButton>
                        </div>
                        <p className="text-xs text-text-secondary mt-2">
                          {commitScope === 'all'
                            ? 'All repos will be committed together with the same message.'
                            : 'Each repo will be committed independently.'}
                        </p>
                      </SettingCard>
                    )}

                    {/* Branch naming info */}
                    {selectedSecondaryRepos.length > 0 && (
                      <div className="p-4 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface-secondary">
                        <p className="text-sm text-text-secondary">
                          Secondary repos will use branch: <code className="text-kanvas-blue font-mono">
                            From_{repoValidation?.repoName || 'Repo'}_{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '')}
                          </code>
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Step: Git Workflow */}
          {currentStep === 'workflow' && (
            <div className="space-y-6">
              <CompletedStep>
                {agentType?.charAt(0).toUpperCase()}{agentType?.slice(1)} agent for {repoValidation?.repoName}
              </CompletedStep>

              {hasPreviousSession && (
                <PreviousSettingsBanner />
              )}

              <ConversationBubble>
                <p className="text-lg font-medium">How should the agent manage branches?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Configure the Git workflow for this session.
                </p>
              </ConversationBubble>

              <div className="space-y-4 mt-4">
                {/* Task Description */}
                <SettingCard
                  title="Task"
                  description="Describe what this agent should accomplish"
                >
                  <textarea
                    value={settings.taskDescription}
                    onChange={(e) => {
                      setSettings(s => ({ ...s, taskDescription: e.target.value }));
                      if (refinedPersona) setRefinedPersona(null);
                    }}
                    className="textarea h-32"
                    placeholder="e.g. Resolve uncommitted changes: commit staged files, stash modified work, clean up repo state"
                  />
                  <div className="flex items-center justify-between mt-2 gap-3">
                    <div className="flex items-center gap-2 text-xs">
                      {refinedPersona && (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full bg-[rgba(0,0,0,0.05)] text-text-secondary"
                          title="Persona used to refine the task"
                        >
                          {personaLabel(refinedPersona)}
                        </span>
                      )}
                      {refineError && <span className="text-red-500">{refineError}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={handleRefineTask}
                      disabled={refining || !settings.taskDescription.trim()}
                      className="text-xs px-3 py-1.5 rounded-full bg-black text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[rgba(0,0,0,0.85)] transition-colors"
                      title="Rewrite the task as a senior PM / engineer / AI engineer (auto-picked)"
                    >
                      {refining ? 'Refining…' : '✨ Refine with AI'}
                    </button>
                  </div>
                </SettingCard>

                {/* Branch Name */}
                <SettingCard
                  title="Working Branch"
                  description="The agent will commit changes to this branch"
                >
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={settings.branchName}
                      onChange={(e) => setSettings(s => ({ ...s, branchName: e.target.value }))}
                      className="input flex-1"
                      placeholder="feature/agent-work"
                    />
                    <BaseBranchPicker
                      branches={repoValidation?.branches || ['main']}
                      currentBranch={repoValidation?.currentBranch || 'main'}
                      value={settings.baseBranch}
                      onChange={(v) => setSettings(s => ({ ...s, baseBranch: v }))}
                    />
                  </div>
                </SettingCard>

                {/* Rebase Frequency */}
                <SettingCard
                  title="Rebase Frequency"
                  description="How often should the branch be rebased from the base branch?"
                >
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: 'never', label: 'Never' },
                      { value: 'on-demand', label: 'After every commit' },
                      { value: 'daily', label: 'Daily' },
                      { value: 'weekly', label: 'Weekly' },
                    ].map(option => (
                      <OptionButton
                        key={option.value}
                        selected={settings.rebaseFrequency === option.value}
                        onClick={() => setSettings(s => ({ ...s, rebaseFrequency: option.value as RebaseFrequency }))}
                      >
                        {option.label}
                      </OptionButton>
                    ))}
                  </div>
                </SettingCard>

                {/* Auto-commit */}
                <SettingCard
                  title="Auto-commit Changes"
                  description="Automatically commit changes as the agent works?"
                >
                  <div className="flex gap-3">
                    <OptionButton
                      selected={settings.autoCommit}
                      onClick={() => setSettings(s => ({ ...s, autoCommit: true }))}
                    >
                      Yes, auto-commit
                    </OptionButton>
                    <OptionButton
                      selected={!settings.autoCommit}
                      onClick={() => setSettings(s => ({ ...s, autoCommit: false }))}
                    >
                      Manual commits only
                    </OptionButton>
                  </div>
                </SettingCard>

                {/* GitHub Action on merge (tag-push) */}
                <SettingCard
                  title="GitHub Action on merge"
                  description="Fire a workflow when this session is merged, by pushing a version tag."
                >
                  <div className="flex gap-3">
                    <OptionButton
                      selected={!settings.mergeActionEnabled}
                      onClick={() => setSettings(s => ({ ...s, mergeActionEnabled: false }))}
                    >
                      Off
                    </OptionButton>
                    <OptionButton
                      selected={settings.mergeActionEnabled}
                      onClick={() => setSettings(s => ({ ...s, mergeActionEnabled: true }))}
                    >
                      Push a version tag
                    </OptionButton>
                  </div>
                  {settings.mergeActionEnabled && (
                    <div className="mt-3 space-y-2">
                      <label className="label">Tag prefix (the part before the version)</label>
                      {tagPrefixes.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {tagPrefixes.slice(0, 4).map(p => (
                            <button
                              key={p.prefix}
                              type="button"
                              onClick={() => setSettings(s => ({ ...s, mergeActionTagPrefix: p.prefix }))}
                              className={`text-xs px-2 py-1 rounded-full border ${settings.mergeActionTagPrefix === p.prefix ? 'bg-black text-white border-black' : 'border-[rgba(0,0,0,0.10)] text-text-secondary hover:bg-[#FAFAF7]'}`}
                              title={`${p.count} existing tags — latest ${p.latest}`}
                            >
                              {p.prefix}… <span className="opacity-60">(latest {p.latest.replace(p.prefix, '')})</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <input
                        type="text"
                        value={settings.mergeActionTagPrefix}
                        onChange={(e) => setSettings(s => ({ ...s, mergeActionTagPrefix: e.target.value }))}
                        className="input w-full font-mono"
                        placeholder="SDDMini-KH/v"
                      />
                      <p className="text-[11px] text-text-secondary">
                        On merge, KIT will create &amp; push the next patch tag (e.g. <code>{(settings.mergeActionTagPrefix || 'SDDMini-KH/v')}3.23.41</code>) — you can edit the version before it fires. Its push triggers the matching workflow.
                      </p>
                    </div>
                  )}
                </SettingCard>
              </div>
            </div>
          )}

          {/* Step 4: System Prompt & Context */}
          {currentStep === 'prompt' && (
            <div className="space-y-6">
              <CompletedStep>
                Branch: {settings.branchName} (rebase: {settings.rebaseFrequency})
              </CompletedStep>

              {hasPreviousSession && (
                <PreviousSettingsBanner />
              )}

              <ConversationBubble>
                <p className="text-lg font-medium">Set up the agent's instructions</p>
                <p className="text-sm text-text-secondary mt-1">
                  Define the system prompt and context preservation rules.
                </p>
              </ConversationBubble>

              <div className="space-y-4 mt-4">
                {/* System Prompt */}
                <SettingCard
                  title="System Prompt"
                  description="Instructions for the coding agent when starting the session"
                >
                  <textarea
                    value={settings.systemPrompt}
                    onChange={(e) => setSettings(s => ({ ...s, systemPrompt: e.target.value }))}
                    className="input w-full h-32 font-mono text-sm resize-y"
                    placeholder="Enter instructions for the agent..."
                  />
                </SettingCard>

                {/* Context Preservation */}
                <SettingCard
                  title="Context Preservation (Memory Block)"
                  description="Information to preserve when context is compacted"
                >
                  <textarea
                    value={settings.contextPreservation}
                    onChange={(e) => setSettings(s => ({ ...s, contextPreservation: e.target.value }))}
                    className="input w-full h-40 font-mono text-sm resize-y"
                    placeholder="SESSION_ID: abc123&#10;WORKTREE: /path/to/repo&#10;..."
                  />
                  <p className="text-xs text-text-secondary mt-2">
                    This will be included in the prompt to help the agent recover context after compaction.
                    House rules are stored in <code className="text-kanvas-blue">houserules.md</code>.
                  </p>
                </SettingCard>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[rgba(0,0,0,0.10)] flex items-center justify-between bg-surface">
          <div>
            {currentStep !== 'repo' && (
              <button
                type="button"
                onClick={() => {
                  const prevStep: Record<WizardStep, WizardStep> = {
                    repo: 'repo',
                    setup: 'repo',
                    agent: needsSetup ? 'setup' : 'repo',
                    'multi-repo': 'agent',
                    workflow: 'multi-repo',
                    prompt: 'workflow',
                    complete: 'prompt',
                  };
                  setCurrentStep(prevStep[currentStep]);
                }}
                className="btn-ghost"
                disabled={isCreating}
              >
                Back
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
              disabled={isCreating}
            >
              Cancel
            </button>

            {currentStep === 'setup' && (
              <>
                <button
                  type="button"
                  onClick={handleSkipSetup}
                  className="btn-ghost text-text-secondary"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  onClick={handleSetupComplete}
                  className="btn-primary"
                  disabled={featureOrgChoice === 'migrate'}
                >
                  {featureOrgChoice === 'migrate' ? 'Coming Soon' : 'Apply & Continue'}
                </button>
              </>
            )}

            {currentStep === 'multi-repo' && (
              <button
                type="button"
                onClick={handleMultiRepoContinue}
                className="btn-primary"
              >
                Next: Git Workflow
              </button>
            )}

            {currentStep === 'workflow' && (
              <button
                type="button"
                onClick={() => setCurrentStep('prompt')}
                className="btn-primary"
                disabled={!settings.branchName}
              >
                Next: Agent Instructions
              </button>
            )}

            {currentStep === 'prompt' && (
              <button
                type="button"
                onClick={handleCreate}
                className="btn-primary"
                disabled={isCreating}
              >
                {isCreating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                    Creating...
                  </>
                ) : (
                  'Create Session'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Banner shown when settings are pre-populated from a previous session
 */
function PreviousSettingsBanner(): React.ReactElement {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] bg-[rgba(0,0,0,0.04)] border border-[rgba(0,0,0,0.08)] text-sm text-text-secondary">
      <svg className="w-4 h-4 flex-shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <span>Settings from your last session on this repo are pre-filled — adjust anything below or just continue.</span>
    </div>
  );
}

/**
 * Conversation bubble
 */
function ConversationBubble({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="animate-fade-in">
      <div className="p-4 rounded-[22px] rounded-tl-md bg-surface-secondary text-text-primary">
        {children}
      </div>
    </div>
  );
}

/**
 * Completed step indicator
 */
function CompletedStep({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
      <span className="text-text-secondary">{children}</span>
    </div>
  );
}

/**
 * Setting card
 */
function SettingCard({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="p-4 rounded-[14px] border border-[rgba(0,0,0,0.10)] bg-surface">
      <h4 className="font-medium text-text-primary mb-1">{title}</h4>
      <p className="text-sm text-text-secondary mb-3">{description}</p>
      {children}
    </div>
  );
}

/**
 * Option button
 */
function OptionButton({
  selected,
  onClick,
  children
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        px-4 py-2 rounded-full text-sm font-medium transition-all
        ${selected
          ? 'bg-black text-white'
          : 'bg-surface-secondary text-text-primary hover:bg-surface-tertiary border border-[rgba(0,0,0,0.10)]'
        }
      `}
    >
      {children}
    </button>
  );
}

/**
 * Smart branch picker — shows a curated short list with an "Other…" escape hatch.
 */
const PRIMARY_BRANCHES = ['main', 'master', 'development', 'develop', 'dev'];

/** Branches that should never appear as a merge-target choice */
/**
 * Choose a sensible default base branch from a repo validation result.
 * Never returns a detached-HEAD/"HEAD" sentinel: prefers the current branch when
 * it's a real branch, otherwise the first primary that exists, otherwise 'main'.
 */
function pickDefaultBaseBranch(validation: { currentBranch?: string; branches?: string[] }): string {
  const current = validation.currentBranch;
  if (current && !isSessionOrRemoteBranch(current)) return current;
  const branches = validation.branches ?? [];
  const primary = PRIMARY_BRANCHES.find(b => branches.includes(b));
  if (primary) return primary;
  const firstReal = branches.find(b => !isSessionOrRemoteBranch(b));
  return firstReal ?? 'main';
}

function isSessionOrRemoteBranch(b: string): boolean {
  return (
    b.startsWith('origin/') ||
    b.startsWith('remotes/') ||
    // Detached-HEAD pseudo-entries ("(HEAD detached at <tag>)") and the bare
    // "HEAD" sentinel are never valid base branches to commit onto.
    b.startsWith('(') ||
    b.includes('HEAD detached') ||
    b === 'HEAD' ||
    /^codex-session-/.test(b) ||
    /^cursor-session-/.test(b) ||
    /^copilot-session-/.test(b) ||
    /^aider-session-/.test(b) ||
    /^warp-session-/.test(b) ||
    /^cline-session-/.test(b)
  );
}

function BaseBranchPicker({
  branches,
  currentBranch,
  value,
  onChange,
}: {
  branches: string[];
  currentBranch: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const [showAll, setShowAll] = React.useState(false);
  const [prevValue, setPrevValue] = React.useState(value);

  // Filter out remote-tracking refs and session branches — these are never valid merge targets
  const cleanBranches = React.useMemo(
    () => branches.filter(b => !isSessionOrRemoteBranch(b)),
    [branches]
  );

  // Build primary list: PRIMARY_BRANCHES that exist in branches, preserving order
  const primaryList = React.useMemo(() => {
    const filtered = PRIMARY_BRANCHES.filter(b => cleanBranches.includes(b));
    // Prepend currentBranch if not already in the list (and it's not a session branch)
    if (currentBranch && !filtered.includes(currentBranch) && !isSessionOrRemoteBranch(currentBranch)) {
      return [currentBranch, ...filtered];
    }
    return filtered;
  }, [cleanBranches, currentBranch]);

  // Self-heal a stale/invalid selected value (e.g. a detached-HEAD string persisted
  // by an older session config, or "HEAD") so the user always sees a real branch.
  React.useEffect(() => {
    if (!value || isSessionOrRemoteBranch(value)) {
      const fallback = primaryList[0] ?? cleanBranches[0];
      if (fallback && fallback !== value) onChange(fallback);
    }
  }, [value, primaryList, cleanBranches, onChange]);

  // If the branch list is small enough, just show all branches
  const useSimpleSelect = cleanBranches.length <= primaryList.length + 1;

  if (useSimpleSelect) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="select w-40"
      >
        {cleanBranches.map(branch => (
          <option key={branch} value={branch}>from {branch}</option>
        ))}
      </select>
    );
  }

  if (showAll) {
    // Phase 2: full list with a "← Back" option at the top
    return (
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '__back__') {
            setShowAll(false);
            onChange(prevValue);
          } else {
            onChange(e.target.value);
            setShowAll(false);
          }
        }}
        className="select w-40"
      >
        <option value="__back__">← Common branches</option>
        {cleanBranches.map(branch => (
          <option key={branch} value={branch}>from {branch}</option>
        ))}
      </select>
    );
  }

  // Phase 1: compact list — primaryList + selected custom branch + "Other…"
  const valueInPrimary = primaryList.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === '__other__') {
          setPrevValue(value);
          setShowAll(true);
        } else {
          onChange(e.target.value);
        }
      }}
      className="select w-40"
    >
      {!valueInPrimary && (
        <option key={value} value={value}>{value} (custom)</option>
      )}
      {primaryList.map(branch => (
        <option key={branch} value={branch}>from {branch}</option>
      ))}
      <option value="__other__">Other branch…</option>
    </select>
  );
}

/**
 * Setup option card for feature organization
 */
function SetupOption({
  selected,
  onClick,
  title,
  description,
  icon,
  recommended,
  comingSoon,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  icon: React.ReactNode;
  recommended?: boolean;
  comingSoon?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={comingSoon}
      className={`
        w-full p-4 rounded-[14px] border-2 text-left transition-all
        ${selected
          ? 'border-black bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          : 'border-[rgba(0,0,0,0.10)] hover:border-[rgba(0,0,0,0.25)] bg-surface'
        }
        ${comingSoon ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`
          w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0
          ${selected ? 'bg-black text-white' : 'bg-surface-secondary text-text-secondary'}
        `}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-medium ${selected ? 'text-text-primary' : 'text-text-primary'}`}>
              {title}
            </span>
            {recommended && (
              <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
                Recommended
              </span>
            )}
            {comingSoon && (
              <span className="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700 rounded-full">
                Coming Soon
              </span>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-0.5">{description}</p>
        </div>
        <div className={`
          w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0
          ${selected ? 'border-black bg-black' : 'border-[rgba(0,0,0,0.20)]'}
        `}>
          {selected && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      </div>
    </button>
  );
}
