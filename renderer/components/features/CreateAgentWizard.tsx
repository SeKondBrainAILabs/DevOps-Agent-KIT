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
}

type WizardStep = 'repo' | 'setup' | 'agent' | 'multi-repo' | 'workflow' | 'prompt' | 'complete';

type FeatureOrgStructure = 'feature-folders' | 'flat' | 'migrate';

interface AgentSettings {
  branchName: string;
  baseBranch: string;
  rebaseFrequency: RebaseFrequency;
  autoCommit: boolean;
  systemPrompt: string;
  contextPreservation: string;
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

export function CreateAgentWizard({ onClose }: CreateAgentWizardProps): React.ReactElement {
  const [currentStep, setCurrentStep] = useState<WizardStep>('repo');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoValidation, setRepoValidation] = useState<RepoValidation | null>(null);
  const [agentType, setAgentType] = useState<AgentType | null>(null);
  const [settings, setSettings] = useState<AgentSettings>({
    branchName: '',
    baseBranch: 'main',
    rebaseFrequency: 'daily',
    autoCommit: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    contextPreservation: DEFAULT_CONTEXT_PRESERVATION,
  });

  // Result
  const [createdInstance, setCreatedInstance] = useState<AgentInstance | null>(null);

  // First-run setup
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [featureOrgChoice, setFeatureOrgChoice] = useState<FeatureOrgStructure>('feature-folders');

  // Multi-repo settings
  const [multiRepoEnabled, setMultiRepoEnabled] = useState(false);
  const [detectedSubmodules, setDetectedSubmodules] = useState<Array<{ name: string; path: string; url: string }>>([]);
  const [selectedSecondaryRepos, setSelectedSecondaryRepos] = useState<Array<{ repoPath: string; repoName: string; isSubmodule: boolean }>>([]);
  const [commitScope, setCommitScope] = useState<'all' | 'per-repo'>('all');

  const handleRepoSelect = async (path: string, validation: RepoValidation) => {
    setRepoPath(path);
    setRepoValidation(validation);
    setError(null);
    if (validation.currentBranch) {
      setSettings(s => ({ ...s, baseBranch: validation.currentBranch || 'main' }));
    }

    // Detect submodules for multi-repo support
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

    // Check if first-run setup is needed
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
        taskDescription: settings.branchName || `${agentType} session`,
        branchName: settings.branchName,
        baseBranch: settings.baseBranch,
        useWorktree: false,
        autoCommit: settings.autoCommit,
        commitInterval: 30000,
        rebaseFrequency: settings.rebaseFrequency,
        systemPrompt: settings.systemPrompt,
        contextPreservation: settings.contextPreservation,
        multiRepo,
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
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
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
        <div className="px-6 py-2 bg-surface-secondary border-b border-border">
          <div className="flex gap-2">
            {Array.from({ length: totalSteps }, (_, idx) => (
              <div
                key={idx}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  idx < stepNumber ? 'bg-kanvas-blue' : 'bg-border'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
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
                <div className="mt-4 p-4 rounded-xl border border-border bg-surface-secondary">
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
                                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                  isSelected ? 'border-kanvas-blue bg-kanvas-blue/5' : 'border-border hover:border-text-secondary'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSubmoduleSelection(sub)}
                                  className="w-4 h-4 rounded border-border text-kanvas-blue"
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
                      <div className="p-4 rounded-xl border border-border bg-surface-secondary">
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
                      <div className="p-4 rounded-xl border border-border bg-surface-secondary">
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

              <ConversationBubble>
                <p className="text-lg font-medium">How should the agent manage branches?</p>
                <p className="text-sm text-text-secondary mt-1">
                  Configure the Git workflow for this session.
                </p>
              </ConversationBubble>

              <div className="space-y-4 mt-4">
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
                    <select
                      value={settings.baseBranch}
                      onChange={(e) => setSettings(s => ({ ...s, baseBranch: e.target.value }))}
                      className="select w-40"
                    >
                      {(repoValidation?.branches || ['main']).map(branch => (
                        <option key={branch} value={branch}>from {branch}</option>
                      ))}
                    </select>
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
                      { value: 'on-demand', label: 'On-demand' },
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
              </div>
            </div>
          )}

          {/* Step 4: System Prompt & Context */}
          {currentStep === 'prompt' && (
            <div className="space-y-6">
              <CompletedStep>
                Branch: {settings.branchName} (rebase: {settings.rebaseFrequency})
              </CompletedStep>

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
        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-surface">
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
 * Conversation bubble
 */
function ConversationBubble({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="animate-fade-in">
      <div className="p-4 rounded-2xl rounded-tl-md bg-surface-secondary text-text-primary">
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
    <div className="p-4 rounded-xl border border-border bg-surface">
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
        px-4 py-2 rounded-lg text-sm font-medium transition-all
        ${selected
          ? 'bg-kanvas-blue text-white'
          : 'bg-surface-secondary text-text-primary hover:bg-surface-tertiary border border-border'
        }
      `}
    >
      {children}
    </button>
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
        w-full p-4 rounded-xl border-2 text-left transition-all
        ${selected
          ? 'border-kanvas-blue bg-kanvas-blue/5'
          : 'border-border hover:border-text-secondary bg-surface'
        }
        ${comingSoon ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`
          w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
          ${selected ? 'bg-kanvas-blue text-white' : 'bg-surface-secondary text-text-secondary'}
        `}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-medium ${selected ? 'text-kanvas-blue' : 'text-text-primary'}`}>
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
          ${selected ? 'border-kanvas-blue bg-kanvas-blue' : 'border-border'}
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
