/**
 * OnboardingModal Component
 * First-time setup experience for DevOps Agent (Kanvas)
 * Walks new users through core concepts: sessions, auto-commit, rebase, merge
 */

import React, { useState, useCallback } from 'react';

interface OnboardingModalProps {
  onClose: () => void;
}

interface OnboardingStep {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: Array<{ icon: string; title: string; desc: string }>;
}

const STEPS: OnboardingStep[] = [
  {
    title: 'Welcome to Kanvas',
    subtitle:
      'Your command center for AI-powered development. Kanvas orchestrates coding agents, manages sessions, and keeps your repositories healthy.',
    icon: (
      <svg className="w-16 h-16 text-kanvas-blue" fill="none" viewBox="0 0 64 64" stroke="currentColor" strokeWidth={1.5}>
        <rect x="8" y="8" width="48" height="48" rx="12" />
        <path d="M24 20v24M40 20v24M16 32h32" />
      </svg>
    ),
    items: [
      { icon: '🎯', title: 'Monitor agents', desc: 'Track Claude, Cursor, Copilot, and other coding agents in one place' },
      { icon: '🌿', title: 'Isolated branches', desc: 'Every session gets its own Git worktree — no conflicts between agents' },
      { icon: '⚡', title: 'Auto-commit', desc: 'File changes are committed automatically so nothing gets lost' },
      { icon: '🔄', title: 'Stay synced', desc: 'Auto-rebase keeps your branches up to date with the team' },
    ],
  },
  {
    title: 'Sessions & Worktrees',
    subtitle:
      'Each coding task runs in its own session. Kanvas creates an isolated Git worktree so agents can work without stepping on each other.',
    icon: (
      <svg className="w-16 h-16 text-kanvas-purple" fill="none" viewBox="0 0 64 64" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="32" cy="16" r="8" />
        <circle cx="16" cy="48" r="8" />
        <circle cx="48" cy="48" r="8" />
        <path d="M32 24v8M24 40l-4 4M40 40l4 4" />
      </svg>
    ),
    items: [
      { icon: '📂', title: 'Create a session', desc: 'Pick a repo, name your branch, and choose an agent type' },
      { icon: '🔀', title: 'Git worktree', desc: 'Each session works in local_deploy/<branch> — fully isolated from main' },
      { icon: '👁️', title: 'File watcher', desc: 'Kanvas watches for changes and auto-commits with smart messages' },
      { icon: '📋', title: 'Contracts', desc: 'API, schema, and feature contracts are auto-generated from your code' },
    ],
  },
  {
    title: 'Rebase, Merge & Ship',
    subtitle:
      'When your feature is ready, Kanvas handles rebasing onto the latest base branch and merging — with conflict detection built in.',
    icon: (
      <svg className="w-16 h-16 text-kanvas-magenta" fill="none" viewBox="0 0 64 64" stroke="currentColor" strokeWidth={1.5}>
        <path d="M16 48V16M48 48V32" />
        <circle cx="16" cy="12" r="4" />
        <circle cx="16" cy="52" r="4" />
        <circle cx="48" cy="52" r="4" />
        <circle cx="48" cy="28" r="4" />
        <path d="M20 48c8 0 12-4 16-8s8-8 12-8" />
      </svg>
    ),
    items: [
      { icon: '🔄', title: 'Auto-rebase', desc: 'Daily or on-demand rebase keeps your branch current — conflicts flagged early' },
      { icon: '🔀', title: 'Merge workflow', desc: 'Preview changes, resolve conflicts, then merge back to main or development' },
      { icon: '🛡️', title: 'Protected files', desc: 'Lock files and package.json get deterministic resolution — no surprises' },
      { icon: '📊', title: 'Commit history', desc: 'Browse all commits across sessions in the universal commits view' },
    ],
  },
  {
    title: 'Ready to Go',
    subtitle:
      'Create your first session to get started. You can always revisit this guide from Settings.',
    icon: (
      <svg className="w-16 h-16 text-green-500" fill="none" viewBox="0 0 64 64" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="32" cy="32" r="24" />
        <path d="M22 32l7 7 13-13" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    items: [
      { icon: '1️⃣', title: 'Create Instance', desc: 'Click "Create Instance" in the sidebar to set up your first agent session' },
      { icon: '2️⃣', title: 'Select a repo', desc: 'Point Kanvas at any Git repository on your machine' },
      { icon: '3️⃣', title: 'Start coding', desc: 'Open the worktree in your agent (Claude, Cursor, etc.) and start building' },
      { icon: '4️⃣', title: 'Monitor & merge', desc: 'Watch progress in Kanvas, then merge when ready' },
    ],
  },
];

export function OnboardingModal({ onClose }: OnboardingModalProps): React.ReactElement {
  const [step, setStep] = useState(0);
  const isLastStep = step === STEPS.length - 1;
  const current = STEPS[step];

  const handleComplete = useCallback(async () => {
    try {
      await window.api?.config?.set?.('onboardingCompleted', true);
    } catch {
      // Non-critical — don't block close
    }
    onClose();
  }, [onClose]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      handleComplete();
    } else {
      setStep((s) => s + 1);
    }
  }, [isLastStep, handleComplete]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-slide-up">
      <div className="bg-surface border border-border rounded-2xl shadow-kanvas w-[640px] max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 text-center">
          <div className="flex justify-center mb-4">{current.icon}</div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">{current.title}</h2>
          <p className="text-sm text-text-secondary leading-relaxed max-w-md mx-auto">
            {current.subtitle}
          </p>
        </div>

        {/* Content */}
        <div className="px-8 py-4 flex-1 overflow-auto">
          <div className="grid grid-cols-1 gap-3">
            {current.items.map((item, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-surface-secondary/50 border border-border/50 hover:border-kanvas-blue/30 transition-colors"
              >
                <span className="text-xl flex-shrink-0 mt-0.5">{item.icon}</span>
                <div>
                  <p className="font-medium text-text-primary text-sm">{item.title}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-border flex items-center justify-between">
          {/* Step dots */}
          <div className="flex gap-2">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`w-2 h-2 rounded-full transition-all ${
                  i === step
                    ? 'bg-kanvas-blue w-6'
                    : i < step
                    ? 'bg-kanvas-blue/40'
                    : 'bg-text-secondary/30'
                }`}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex gap-3">
            {step === 0 ? (
              <button
                onClick={handleComplete}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                Skip
              </button>
            ) : (
              <button
                onClick={handleBack}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="btn-primary px-6 py-2 text-sm font-medium rounded-lg"
            >
              {isLastStep ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
