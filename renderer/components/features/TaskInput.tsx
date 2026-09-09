/**
 * TaskInput Component
 * Task description with auto-generated branch name
 */

import React, { useState, useEffect } from 'react';

interface TaskInputProps {
  taskDescription: string;
  branchName: string;
  baseBranch: string;
  branches: string[];
  onTaskChange: (task: string) => void;
  onBranchChange: (branch: string) => void;
  onBaseBranchChange: (branch: string) => void;
}

/**
 * Generate a branch name from task description
 */
function generateBranchName(task: string): string {
  if (!task.trim()) return '';

  // Convert to lowercase, replace spaces and special chars with hyphens
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);

  return `feature/${slug}`;
}

export function TaskInput({
  taskDescription,
  branchName,
  baseBranch,
  branches,
  onTaskChange,
  onBranchChange,
  onBaseBranchChange,
}: TaskInputProps): React.ReactElement {
  const [autoGenerate, setAutoGenerate] = useState(true);

  // Auto-generate branch name when task changes
  useEffect(() => {
    if (autoGenerate && taskDescription) {
      const generated = generateBranchName(taskDescription);
      onBranchChange(generated);
    }
  }, [taskDescription, autoGenerate, onBranchChange]);

  const handleBranchChange = (value: string) => {
    setAutoGenerate(false);
    onBranchChange(value);
  };

  const handleRegenerate = () => {
    setAutoGenerate(true);
    const generated = generateBranchName(taskDescription);
    onBranchChange(generated);
  };

  // Filter out remote branches for base branch selection
  const localBranches = branches.filter(b => !b.startsWith('origin/') && !b.startsWith('remotes/'));

  return (
    <div className="space-y-4">
      {/* Task description */}
      <div>
        <label className="label">Task Description</label>
        <textarea
          value={taskDescription}
          onChange={(e) => onTaskChange(e.target.value)}
          placeholder="What should the agent work on? e.g., Add dark mode toggle to settings page"
          className="textarea h-24"
        />
        <p className="helper-text">
          Describe the task or feature you want the agent to implement.
        </p>
      </div>

      {/* Branch name */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="label mb-0">Branch Name</label>
          {!autoGenerate && (
            <button
              type="button"
              onClick={handleRegenerate}
              className="text-xs text-kanvas-blue hover:text-kanvas-blue-dark transition-colors"
            >
              Auto-generate
            </button>
          )}
        </div>
        <div className="relative">
          <input
            type="text"
            value={branchName}
            onChange={(e) => handleBranchChange(e.target.value)}
            placeholder="feature/my-feature"
            className="input pr-24"
          />
          {autoGenerate && branchName && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary bg-surface-tertiary px-2 py-1 rounded">
              Auto
            </span>
          )}
        </div>
        <p className="helper-text">
          A new branch will be created for this agent session.
        </p>
      </div>

      {/* Base branch */}
      <div>
        <label className="label">Base Branch</label>
        <select
          value={baseBranch}
          onChange={(e) => onBaseBranchChange(e.target.value)}
          className="select"
        >
          {localBranches.length === 0 ? (
            <option value="main">main</option>
          ) : (
            localBranches.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))
          )}
        </select>
        <p className="helper-text">
          The new branch will be created from this base branch.
        </p>
      </div>

      {/* Advanced options toggle */}
      <AdvancedOptions />
    </div>
  );
}

/**
 * Advanced Options collapsible section
 */
function AdvancedOptions(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [autoCommit, setAutoCommit] = useState(true);
  const [commitInterval, setCommitInterval] = useState(30);

  return (
    <div className="border border-[rgba(0,0,0,0.10)] rounded-[14px] overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between bg-surface-secondary hover:bg-surface-tertiary transition-colors"
      >
        <span className="text-sm font-medium text-text-primary">Advanced Options</span>
        <svg
          className={`w-5 h-5 text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="px-4 py-4 space-y-4 border-t border-[rgba(0,0,0,0.10)] bg-white">
          {/* Worktree option */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-border text-kanvas-blue focus:ring-kanvas-blue"
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Use isolated worktree</span>
              <p className="text-xs text-text-secondary mt-0.5">
                Create a separate working directory for this session (recommended for parallel work)
              </p>
            </div>
          </label>

          {/* Auto-commit option */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCommit}
              onChange={(e) => setAutoCommit(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-border text-kanvas-blue focus:ring-kanvas-blue"
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Auto-commit changes</span>
              <p className="text-xs text-text-secondary mt-0.5">
                Automatically commit file changes after a period of inactivity
              </p>
            </div>
          </label>

          {/* Commit interval */}
          {autoCommit && (
            <div className="ml-7">
              <label className="text-sm text-text-secondary">Commit interval (seconds)</label>
              <input
                type="number"
                value={commitInterval}
                onChange={(e) => setCommitInterval(parseInt(e.target.value) || 30)}
                min={10}
                max={300}
                className="input mt-1 w-32"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
