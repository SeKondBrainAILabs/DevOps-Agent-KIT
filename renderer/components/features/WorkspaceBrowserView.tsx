/**
 * WorkspaceBrowserView (Epic A / story A5 — MVP)
 *
 * Top-level view rendered when `mainView === 'workspaces'`. Shows the
 * configured workspaces, a switcher, and a grid of RepoStatusCards
 * for the active workspace's discovered repos.
 *
 * Three inline tabs:
 *   Repos     — discovered repos grid/table
 *   Workflow  — daily workflow queue
 *   Storage   — disk metrics / Docker usage
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DiscoveredRepo,
  Workspace,
  WorkspaceRepoChangeEvent,
  StorageMetricsOverview,
  WorktreeSafetyInfo,
} from '../../../shared/types';
import {
  DEFAULT_REPO_SORT_KEY,
  getRepoComparator,
  type RepoSortKey,
} from '../../../shared/repo-sort';
import type { RepoStatusBlock } from './RepoStatusCard';
import { AddWorkspaceDialog } from './AddWorkspaceDialog';
import { StaleBranchesDialog } from './StaleBranchesDialog';
import { useUIStore } from '../../store/uiStore';

function formatGiB(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  return `${gib.toFixed(2)} GiB`;
}

function basenameFromPath(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).pop() ?? repoPath;
}

function formatDaysOld(days: number | null): string {
  if (days === null) return 'age unknown';
  if (days <= 0) return '<1 day old';
  if (days === 1) return '1 day old';
  return `${days} days old`;
}

function formatAbandonedReason(
  reason: AbandonedWorktreeEntry['reason']
): string {
  return reason === 'missing-path' ? 'missing path' : 'stale + no active session';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const WORKFLOW_VIEW_STATE_KEY = 'kanvas.workspace.workflow-dashboard.v1';
const ONE_GIB = 1024 ** 3;
const WORKFLOW_QUEUE_LIMIT = 7;
const WORKFLOW_SNOOZE_HOURS = 24;

interface PersistedWorkflowViewState {
  dismissedItemIds: string[];
  snoozedUntilByItemId: Record<string, string>;
}
type AbandonedWorktreeEntry = StorageMetricsOverview['local']['abandonedWorktrees'][number];

type WorkflowQueueCategory = 'cleanup' | 'sync' | 'changes';
type WorkspaceRepoSortKey = RepoSortKey | 'priority';
type RepoPriorityLevel = 'critical' | 'attention' | 'healthy';
type WorkflowActionKind =
  | 'open-repo-detail'
  | 'open-terminal'
  | 'new-session'
  | 'copy-repo-cleanup-command'
  | 'copy-abandoned-worktree-command'
  | 'clean-abandoned-worktree'
  | 'clean-missing-worktree-refs';

interface WorkflowActionDefinition {
  kind: WorkflowActionKind;
  label: string;
  repoPath?: string;
  abandonedWorktree?: AbandonedWorktreeEntry;
}

interface WorkflowQueueItem {
  id: string;
  title: string;
  reason: string;
  impactLabel: string;
  score: number;
  category: WorkflowQueueCategory;
  primaryAction: WorkflowActionDefinition;
  secondaryActions?: WorkflowActionDefinition[];
}
interface RepoHealthSnapshot {
  healthScore: number;
  riskPoints: number;
  priority: RepoPriorityLevel;
}

function readWorkflowStateFromStorage(): PersistedWorkflowViewState {
  if (typeof window === 'undefined') {
    return { dismissedItemIds: [], snoozedUntilByItemId: {} };
  }

  try {
    const raw = window.localStorage.getItem(WORKFLOW_VIEW_STATE_KEY);
    if (!raw) return { dismissedItemIds: [], snoozedUntilByItemId: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedWorkflowViewState>;
    return {
      dismissedItemIds: Array.isArray(parsed.dismissedItemIds) ? parsed.dismissedItemIds : [],
      snoozedUntilByItemId:
        parsed.snoozedUntilByItemId && typeof parsed.snoozedUntilByItemId === 'object'
          ? parsed.snoozedUntilByItemId
          : {},
    };
  } catch {
    return { dismissedItemIds: [], snoozedUntilByItemId: {} };
  }
}

function workflowCategoryLabel(category: WorkflowQueueCategory): string {
  if (category === 'cleanup') return 'Cleanup';
  if (category === 'sync') return 'Sync';
  return 'Changes';
}

function getRepoPriorityLevel(riskPoints: number): RepoPriorityLevel {
  if (riskPoints >= 20) return 'critical';
  if (riskPoints >= 10) return 'attention';
  return 'healthy';
}

function formatRepoPriorityLabel(priority: RepoPriorityLevel): string {
  if (priority === 'critical') return 'Critical';
  if (priority === 'attention') return 'Attention';
  return 'Healthy';
}

function repoPriorityBadgeClasses(priority: RepoPriorityLevel): string {
  if (priority === 'critical') {
    return 'border-red-500/40 bg-red-500/10 text-red-500';
  }
  if (priority === 'attention') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  }
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500';
}

function calculateRepoStalePenalty(discoveredAt: string): number {
  const discoveredAtMs = Date.parse(discoveredAt);
  if (!Number.isFinite(discoveredAtMs)) return 0;
  const ageDays = (Date.now() - discoveredAtMs) / (1000 * 60 * 60 * 24);
  if (ageDays >= 30) return 4;
  if (ageDays >= 14) return 2;
  return 0;
}


// ---------------------------------------------------------------------------
// Worktree safety badge sub-component
// ---------------------------------------------------------------------------

interface WorktreeSafetyBadgesProps {
  worktreePath: string;
  safetyInfo: WorktreeSafetyInfo | undefined;
  loading: boolean;
}

function WorktreeSafetyBadges({ worktreePath: _worktreePath, safetyInfo, loading }: WorktreeSafetyBadgesProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <span style={{ fontSize: '0.68rem', color: 'rgba(0,0,0,0.45)' }}>
        Checking safety…
      </span>
    );
  }
  if (!safetyInfo) return <></>;

  const isSafe = !safetyInfo.hasUncommittedChanges && safetyInfo.unmergedCommitCount === 0;

  return (
    <div style={{ marginTop: '0.4rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
        {/* Uncommitted changes badge */}
        {safetyInfo.hasUncommittedChanges ? (
          <span style={{
            fontSize: '0.68rem', padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
            color: '#f87171',
          }}>
            {safetyInfo.uncommittedFiles.length} uncommitted file{safetyInfo.uncommittedFiles.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span style={{
            fontSize: '0.68rem', padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.4)',
            color: '#34d399',
          }}>
            Clean
          </span>
        )}

        {/* Merge safety badge */}
        {safetyInfo.unmergedCommitCount === 0 ? (
          <span style={{
            fontSize: '0.68rem', padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.4)',
            color: '#34d399',
          }}>
            Fully merged
          </span>
        ) : (
          <span style={{
            fontSize: '0.68rem', padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
            color: '#f87171',
          }}>
            {safetyInfo.unmergedCommitCount} unmerged commit{safetyInfo.unmergedCommitCount === 1 ? '' : 's'}
          </span>
        )}

        {!isSafe && <span style={{ fontSize: '0.68rem', color: 'rgba(0,0,0,0.45)' }}>
          merged into: {safetyInfo.mergedIntoBranches.length > 0 ? safetyInfo.mergedIntoBranches.join(', ') : 'none'}
        </span>}
      </div>

      {safetyInfo.hasUncommittedChanges && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="kb-btn"
          style={{ marginTop: '0.35rem', fontSize: '0.68rem' }}
        >
          {expanded ? 'Hide changes' : 'View changes'}
        </button>
      )}

      {expanded && safetyInfo.uncommittedFiles.length > 0 && (
        <div style={{
          marginTop: '0.4rem',
          borderRadius: '0.6rem',
          padding: '0.5rem 0.75rem',
          maxHeight: '10rem',
          overflowY: 'auto',
        }} className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)]">
          {safetyInfo.uncommittedFiles.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.68rem', padding: '0.1rem 0' }} className="text-black">
              <span style={{ fontFamily: 'monospace', minWidth: '2rem' }} className="text-[rgba(0,0,0,0.45)]">{f.status}</span>
              <span style={{ fontFamily: 'monospace' }}>{f.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip helper — renders at fixed position to escape overflow-hidden parents
// ---------------------------------------------------------------------------

function Tip({ label, children }: { label: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
      style={{ cursor: 'default' }}
    >
      {children}
      {pos && (
        <div
          style={{
            position: 'fixed',
            left: pos.x + 14,
            top: pos.y - 6,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.88)',
            color: '#fff',
            borderRadius: 10,
            padding: '8px 12px',
            fontSize: 12,
            lineHeight: '1.5',
            maxWidth: 280,
            pointerEvents: 'none',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            fontFamily: 'var(--f-body)',
            letterSpacing: '-0.005em',
            whiteSpace: 'pre-line',
          }}
        >
          {label}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Repo insights — plain-English explanations for a repo's status
// ---------------------------------------------------------------------------

interface RepoInsight {
  icon: string;
  text: string;
  severity: 'info' | 'warn' | 'ok';
}

function buildRepoInsights(opts: {
  repoName: string;
  branch: string;
  behind: number;
  ahead: number;
  staged: number;
  modified: number;
  untracked: number;
  stashCount: number;
  worktreeCount: number;
  riskPoints: number;
  healthScore: number;
}): RepoInsight[] {
  const { behind, ahead, staged, modified, untracked, stashCount, worktreeCount, riskPoints, healthScore } = opts;
  const insights: RepoInsight[] = [];

  // Sync insights
  if (behind > 0) {
    insights.push({
      icon: '⬇',
      text: `${behind} commit${behind !== 1 ? 's' : ''} from remote haven't been pulled yet — this branch is behind its remote counterpart. Run \`git pull\` to update.`,
      severity: behind > 10 ? 'warn' : 'info',
    });
  }
  if (ahead > 0) {
    insights.push({
      icon: '⬆',
      text: `${ahead} local commit${ahead !== 1 ? 's' : ''} haven't been pushed to remote yet.`,
      severity: ahead > 20 ? 'warn' : 'info',
    });
  }
  if (behind === 0 && ahead === 0) {
    insights.push({ icon: '✓', text: 'Branch is fully in sync with its remote.', severity: 'ok' });
  }

  // Changes insights
  if (staged > 0) {
    insights.push({
      icon: '📝',
      text: `${staged} file${staged !== 1 ? 's' : ''} ${staged !== 1 ? 'are' : 'is'} staged — these changes are queued and ready to commit.`,
      severity: 'warn',
    });
  }
  if (modified > 0) {
    insights.push({
      icon: '✏',
      text: `${modified} file${modified !== 1 ? 's' : ''} modified but not staged yet — changes exist locally but haven't been added to a commit.`,
      severity: 'info',
    });
  }
  if (untracked > 0) {
    insights.push({
      icon: '?',
      text: `${untracked} untracked file${untracked !== 1 ? 's' : ''} — new files not yet known to git. Add them with \`git add\` if they should be tracked.`,
      severity: 'info',
    });
  }
  if (staged === 0 && modified === 0 && untracked === 0) {
    insights.push({ icon: '✓', text: 'Working directory is clean — no uncommitted changes.', severity: 'ok' });
  }

  // Stash & worktree insights
  if (stashCount > 0) {
    insights.push({
      icon: '📦',
      text: `${stashCount} stash${stashCount !== 1 ? 'es' : ''} — work saved aside with \`git stash\`. Stashes can be lost if the repo is cleaned up.`,
      severity: stashCount > 3 ? 'warn' : 'info',
    });
  }
  if (worktreeCount > 1) {
    insights.push({
      icon: '🌿',
      text: `${worktreeCount} worktrees — this repo has ${worktreeCount} parallel checkout directories on different branches.`,
      severity: 'info',
    });
  }

  // Risk score explanation
  const riskBreakdown: string[] = [];
  if (behind > 0) riskBreakdown.push(`${behind} commits behind × 3 = ${behind * 3} pts`);
  if (staged > 0) riskBreakdown.push(`${staged} staged file${staged !== 1 ? 's' : ''} = ${staged} pts`);
  if (modified > 0) riskBreakdown.push(`${modified} modified file${modified !== 1 ? 's' : ''} = ${modified} pts`);
  if (untracked > 0) riskBreakdown.push(`${untracked} untracked file${untracked !== 1 ? 's' : ''} = ${untracked} pts`);

  insights.push({
    icon: '📊',
    text: `Risk score: ${riskPoints} pts → Health: ${healthScore}/100\n${riskBreakdown.length > 0 ? riskBreakdown.join(' · ') : 'No major risk factors detected'}.\nScores ≥ 20 = Critical, ≥ 10 = Attention, < 10 = Healthy.`,
    severity: riskPoints >= 20 ? 'warn' : riskPoints >= 10 ? 'info' : 'ok',
  });

  return insights;
}

// ---------------------------------------------------------------------------
// RepoInsightRow — one repo row with expandable plain-English insights
// ---------------------------------------------------------------------------

interface RepoInsightRowProps {
  repo: DiscoveredRepo;
  index: number;
  status: RepoStatusBlock | null;
  healthSnapshot: RepoHealthSnapshot;
  isLast: boolean;
  openRepoDetail: (path: string) => void;
  openCreateAgentWizardForRepo: (path: string) => void;
  openCreateAgentWizardWithTask: (path: string, task: string) => void;
  onOpenBranchCleanup: (repoPath: string) => void;
}

interface ResolveCommand {
  label: string;
  cmd: string;
}

interface RunResult {
  ok: boolean;
  output: string;
}

function parseResolveCommands(text: string): ResolveCommand[] {
  const results: ResolveCommand[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^COMMAND:\s*(.+)$/);
    if (match) {
      // Use the preceding non-empty line as a label, stripping markdown
      let label = '';
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim().replace(/^#+\s*/, '').replace(/^\d+\.\s*/, '').replace(/\*\*/g, '');
        if (prev) { label = prev; break; }
      }
      results.push({ label: label || match[1], cmd: match[1].trim() });
    }
  }
  return results;
}

function RepoInsightRow({
  repo, index, status, healthSnapshot, isLast,
  openRepoDetail, openCreateAgentWizardForRepo, openCreateAgentWizardWithTask, onOpenBranchCleanup,
}: RepoInsightRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveState, setResolveState] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
  const [resolveText, setResolveText] = useState('');
  const [runResults, setRunResults] = useState<Record<number, RunResult>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [runningIndex, setRunningIndex] = useState<number | null>(null);

  // Run all resolve commands in order. Stops on the first failure since later
  // commands typically depend on earlier ones (e.g. `git add` then `git commit`).
  const runAllCommands = useCallback(async (commands: ResolveCommand[]) => {
    setRunningAll(true);
    for (let i = 0; i < commands.length; i++) {
      if (runResults[i]?.ok) continue; // skip already-succeeded commands
      setRunningIndex(i);
      const r = await window.api.shell?.execGitSafe?.(repo.path, commands[i].cmd);
      const ok = r?.ok ?? false;
      setRunResults(prev => ({
        ...prev,
        [i]: { ok, output: r ? `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`.trim() : 'No response' },
      }));
      if (!ok) break; // halt the chain on first failure
    }
    setRunningIndex(null);
    setRunningAll(false);
  }, [repo.path, runResults]);

  const branch = status?.currentBranch || 'unknown';
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const staged = status?.stagedCount ?? 0;
  const modified = status?.modifiedCount ?? 0;
  const untracked = status?.untrackedCount ?? 0;
  const stashCount = status?.stashCount ?? 0;
  const worktreeCount = status?.worktreeCount ?? 0;
  const activeSessions = status?.activeSessionCount ?? 0;
  const worktreeModeLabel = status?.worktreeMode === 'in-place' ? 'In-place mode' : 'Worktree mode';
  const priorityLabel = formatRepoPriorityLabel(healthSnapshot.priority);
  const priorityBadgeClassName = repoPriorityBadgeClasses(healthSnapshot.priority);
  const healthHint = healthSnapshot.healthScore >= 80 ? 'Stable' : healthSnapshot.healthScore >= 60 ? 'Watch' : 'Needs focus';

  const insights = buildRepoInsights({
    repoName: repo.name, branch, behind, ahead, staged, modified, untracked,
    stashCount, worktreeCount, riskPoints: healthSnapshot.riskPoints, healthScore: healthSnapshot.healthScore,
  });

  const hasIssues = staged > 0 || modified > 0 || (ahead > 0 && behind > 0) || behind > 0;

  const rowBorder = isLast ? 'none' : '1px solid rgba(0,0,0,0.06)';

  const triggerResolve = useCallback(async () => {
    setResolveOpen(true);
    setExpanded(false);
    setRunResults({});
    if (resolveState === 'analyzing') return; // already in flight
    setResolveState('analyzing');
    setResolveText('');

    const issueLines: string[] = [];
    if (behind > 0) issueLines.push(`- ${behind} commit${behind !== 1 ? 's' : ''} behind remote (need to pull)`);
    if (ahead > 0) issueLines.push(`- ${ahead} commit${ahead !== 1 ? 's' : ''} ahead of remote (not yet pushed)`);
    if (staged > 0) issueLines.push(`- ${staged} staged file${staged !== 1 ? 's' : ''} waiting to be committed`);
    if (modified > 0) issueLines.push(`- ${modified} modified file${modified !== 1 ? 's' : ''} not yet staged`);
    if (untracked > 0) issueLines.push(`- ${untracked} untracked file${untracked !== 1 ? 's' : ''}`);
    if (stashCount > 0) issueLines.push(`- ${stashCount} stash${stashCount !== 1 ? 'es' : ''} saved aside`);

    const userMessage = `Repository: ${repo.name}\nBranch: ${branch}\n\nCurrent issues:\n${issueLines.join('\n')}`;
    const systemMessage = `You are a concise git assistant helping a developer resolve repository issues.
Explain what each issue means in 1-2 plain-English sentences, then give exact git commands to fix them.

Rules:
- Be concise and practical
- No --force, no reset --hard, no branch deletion
- If staged files exist: commit them with a sensible message
- If modified files exist: suggest staging + committing, or stashing
- If behind remote: git pull --rebase origin ${branch}
- If ahead of remote: git push origin ${branch}
- Each command must appear on its own line starting with COMMAND: (no markdown fences around it)

Format your response exactly like:
**What's happening:** [brief plain-English summary]

**Steps to resolve:**

1. [step description]
COMMAND: git <command here>

2. [next step if needed]
COMMAND: git <command here>`;

    try {
      const result = await window.api.ai?.chat([
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ]);
      if (result?.success) {
        setResolveText(result.data ?? '');
        setResolveState('done');
      } else {
        // result?.error is an IpcError object — extract the message string
        const errMsg = result?.error?.message ?? 'AI not available';
        // Surface a helpful hint when the API key isn't configured
        setResolveText(
          errMsg.includes('not configured') || errMsg.includes('API key')
            ? 'Groq API key not configured. Add it in Settings → AI to enable this feature.'
            : errMsg
        );
        setResolveState('error');
      }
    } catch (e) {
      setResolveText('Failed to reach AI service. Is it configured?');
      setResolveState('error');
    }
  }, [repo.name, branch, behind, ahead, staged, modified, untracked, stashCount, resolveState]);

  return (
    <div data-testid="repo-list-row" style={{ borderBottom: rowBorder }}>
      {/* Main data row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(220px,2fr) minmax(130px,0.9fr) minmax(90px,0.7fr) minmax(150px,0.9fr) minmax(220px,1fr) auto',
          gap: '0.5rem',
          padding: '0.65rem 0.75rem',
          alignItems: 'start',
          background: index % 2 === 0 ? 'rgba(0,0,0,0.02)' : 'transparent',
        }}
      >
        {/* Repository name + path + tags */}
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => openRepoDetail(repo.path)}
            className="truncate hover:underline text-black font-semibold text-[0.875rem]"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
            data-testid={`repo-row-open-${index}`}
          >
            {repo.name}
          </button>
          <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)] truncate">{repo.path}</p>
          <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            <span className="text-[0.68rem] px-[0.4rem] py-[0.1rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]">
              {`Branch ${branch}`}
            </span>
            <span className="text-[0.68rem] px-[0.4rem] py-[0.1rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]">
              {worktreeModeLabel}
            </span>
          </div>
        </div>

        {/* Priority / Risk */}
        <div className="text-[0.75rem] text-[rgba(0,0,0,0.45)]" data-testid="repo-row-priority">
          <Tip label={
            <span>
              <strong style={{ display: 'block', marginBottom: 4 }}>Priority &amp; Risk Score</strong>
              Risk is calculated from uncommitted work and sync gaps:{'\n'}
              • Each commit behind remote = 3 pts{'\n'}
              • Each staged / modified / untracked file = 1 pt{'\n'}
              • Abandoned worktrees = 2 pts each{'\n\n'}
              Critical ≥ 20 · Attention ≥ 10 · Healthy &lt; 10
            </span>
          }>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${priorityBadgeClassName}`} data-testid="repo-row-priority-badge">
              {priorityLabel}
            </span>
            <p style={{ fontSize: '0.68rem', marginTop: '0.2rem' }} data-testid="repo-row-risk">Risk {healthSnapshot.riskPoints} pts</p>
          </Tip>
        </div>

        {/* Health score */}
        <div className="text-[0.75rem] text-[rgba(0,0,0,0.45)]" data-testid="repo-row-health">
          <Tip label={
            <span>
              <strong style={{ display: 'block', marginBottom: 4 }}>Health Score (0 – 100)</strong>
              Starts at 100 and decreases with risk points.{'\n'}
              80 – 100 = Stable{'\n'}
              60 – 79  = Watch{'\n'}
              0  – 59  = Needs focus
            </span>
          }>
            <p className="text-[0.875rem] text-black font-bold" data-testid="repo-row-health-score">{healthSnapshot.healthScore}</p>
            <p style={{ fontSize: '0.68rem' }}>{healthHint}</p>
          </Tip>
        </div>

        {/* Sync (behind / ahead) + stashes + worktrees */}
        <div className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">
          <Tip label={
            <span>
              <strong style={{ display: 'block', marginBottom: 4 }}>Sync with Remote</strong>
              ↓ {behind} = commits on remote not yet pulled locally{'\n'}
              ↑ {ahead} = local commits not yet pushed to remote
            </span>
          }>
            <p className="text-[0.875rem] text-black font-semibold" data-testid="repo-row-sync">{`↓${behind} / ↑${ahead}`}</p>
          </Tip>
          <Tip label={
            <span>
              <strong style={{ display: 'block', marginBottom: 4 }}>Stashes &amp; Worktrees</strong>
              Stashes = work saved aside with `git stash`.{'\n'}
              Worktrees = parallel branch checkouts in separate directories.
            </span>
          }>
            <p style={{ fontSize: '0.68rem' }}>{`Stashes ${stashCount} • Worktrees ${worktreeCount}`}</p>
          </Tip>
        </div>

        {/* Local state */}
        <div className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">
          <Tip label={
            <span>
              <strong style={{ display: 'block', marginBottom: 4 }}>Local File Changes</strong>
              Staged = queued for the next commit{'\n'}
              Modified = changed but not staged yet{'\n'}
              Untracked = new files git doesn't know about{'\n\n'}
              Sessions = active agent sessions on this repo
            </span>
          }>
            <p style={{ fontSize: '0.68rem' }} data-testid="repo-row-changes">{`Staged ${staged} • Modified ${modified} • Untracked ${untracked}`}</p>
            <p style={{ fontSize: '0.68rem' }} data-testid="repo-row-sessions">{`Sessions ${activeSessions}`}</p>
          </Tip>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
          <button type="button" onClick={() => openRepoDetail(repo.path)} className="btn-primary-sm" data-testid={`repo-row-detail-${index}`}>Open</button>
          <button type="button" onClick={() => window.api.shell?.openVSCode?.(repo.path)} className="kb-btn-sm" data-testid={`repo-row-ide-${index}`}>IDE</button>
          <button type="button" onClick={() => window.api.shell?.openTerminal?.(repo.path)} className="kb-btn-sm" data-testid={`repo-row-terminal-${index}`}>Terminal</button>
          <button type="button" onClick={() => openCreateAgentWizardForRepo(repo.path)} className="kb-btn-sm" data-testid={`repo-row-session-${index}`}>New session</button>
          <button type="button" onClick={() => onOpenBranchCleanup(repo.path)} className="kb-btn-sm" data-testid={`repo-row-branches-${index}`} title="View and clean up stale branches">Branches</button>
          {hasIssues && (
            <button
              type="button"
              className={`btn-ai-resolve${resolveOpen ? ' ring-1 ring-[#8B78F5]' : ''}`}
              data-testid={`repo-row-ai-resolve-${index}`}
              title="Explain and resolve these issues with AI"
              onClick={triggerResolve}
            >
              {resolveState === 'analyzing' ? '⟳ Analyzing…' : '✦ Resolve'}
            </button>
          )}
          {/* Expand/collapse insights */}
          <button
            type="button"
            onClick={() => { setExpanded((v) => !v); setResolveOpen(false); }}
            className="kb-btn-sm"
            data-testid={`repo-row-expand-${index}`}
            title={expanded ? 'Hide insights' : 'Show plain-English explanation'}
            style={{ minWidth: 28, padding: '0 8px' }}
          >
            {expanded ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {/* Expandable insights panel */}
      {expanded && !resolveOpen && (
        <div
          style={{
            margin: '0 0.75rem 0.75rem',
            padding: '0.75rem 1rem',
            background: '#FAFAF7',
            borderRadius: 10,
            border: '1px solid rgba(0,0,0,0.08)',
          }}
          data-testid={`repo-row-insights-${index}`}
        >
          <p style={{ fontSize: 11, fontFamily: 'var(--f-mono)', textTransform: 'uppercase', letterSpacing: '0.10em', color: 'rgba(0,0,0,0.45)', marginBottom: '0.5rem' }}>
            {repo.name} — what this means
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {insights.map((insight, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: '0.6rem',
                  alignItems: 'flex-start',
                  fontSize: 12,
                  lineHeight: '1.5',
                  color: insight.severity === 'warn' ? '#b45309' : insight.severity === 'ok' ? '#059669' : 'rgba(0,0,0,0.75)',
                }}
              >
                <span style={{ flexShrink: 0, marginTop: 1 }}>{insight.icon}</span>
                <span>{insight.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Resolve panel */}
      {resolveOpen && (
        <div
          style={{
            margin: '0 0.75rem 0.75rem',
            padding: '0.85rem 1rem',
            background: 'rgba(139,120,245,0.04)',
            borderRadius: 10,
            border: '1px solid rgba(139,120,245,0.20)',
          }}
          data-testid={`repo-row-resolve-panel-${index}`}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
            <p style={{ fontSize: 11, fontFamily: 'var(--f-mono)', textTransform: 'uppercase', letterSpacing: '0.10em', color: '#8B78F5' }}>
              ✦ AI Resolution — {repo.name}
            </p>
            <button
              type="button"
              onClick={() => setResolveOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'rgba(0,0,0,0.35)', lineHeight: 1 }}
              title="Close"
            >×</button>
          </div>

          {resolveState === 'analyzing' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 13, color: 'rgba(0,0,0,0.55)' }}>
              <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 16 }}>⟳</span>
              Asking AI to analyse this repository…
            </div>
          )}

          {resolveState === 'error' && (
            <p style={{ fontSize: 13, color: '#b91c1c' }}>{resolveText}</p>
          )}

          {resolveState === 'done' && (() => {
            const commands = parseResolveCommands(resolveText);
            // Render explanation text without COMMAND: lines
            const explanationLines = resolveText.split('\n').filter(l => !l.match(/^COMMAND:/));
            const explanation = explanationLines.join('\n').trim();

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {/* Explanation */}
                <div style={{ fontSize: 13, lineHeight: '1.6', color: 'rgba(0,0,0,0.75)', whiteSpace: 'pre-wrap' }}>
                  {explanation}
                </div>

                {/* Commands */}
                {commands.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                      <p style={{ fontSize: 11, fontFamily: 'var(--f-mono)', textTransform: 'uppercase', letterSpacing: '0.10em', color: 'rgba(0,0,0,0.40)', margin: 0 }}>
                        Commands to run
                      </p>
                      {commands.length > 1 && (
                        <button
                          type="button"
                          disabled={runningAll || commands.every((_, i) => runResults[i]?.ok)}
                          onClick={() => void runAllCommands(commands)}
                          style={{
                            height: 24, padding: '0 12px', fontSize: 11, borderRadius: 999, border: 'none',
                            background: runningAll ? '#e5e7eb' : '#000',
                            color: runningAll ? '#6b7280' : '#fff',
                            cursor: runningAll ? 'default' : 'pointer', fontWeight: 600, flexShrink: 0,
                          }}
                          title="Run every command in order; stops if one fails"
                        >
                          {runningAll ? `Running ${(runningIndex ?? 0) + 1}/${commands.length}…` : '▶▶ Run all'}
                        </button>
                      )}
                    </div>
                    {commands.map((c, ci) => {
                      const res = runResults[ci];
                      return (
                        <div
                          key={ci}
                          style={{
                            background: '#fff',
                            border: `1px solid ${res ? (res.ok ? 'rgba(5,150,105,0.30)' : 'rgba(220,38,38,0.30)') : 'rgba(0,0,0,0.10)'}`,
                            borderRadius: 8,
                            padding: '0.5rem 0.75rem',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
                            <code style={{ fontSize: 12, fontFamily: 'var(--f-mono)', color: '#1e40af', flex: 1 }}>
                              {c.cmd}
                            </code>
                            <button
                              type="button"
                              disabled={!!res || resolveState === 'analyzing' || runningAll}
                              style={{
                                height: 24,
                                padding: '0 10px',
                                fontSize: 11,
                                borderRadius: 999,
                                border: 'none',
                                background: res ? (res.ok ? '#dcfce7' : '#fee2e2') : (runningIndex === ci ? '#e5e7eb' : '#000'),
                                color: res ? (res.ok ? '#059669' : '#b91c1c') : (runningIndex === ci ? '#6b7280' : '#fff'),
                                cursor: res || runningAll ? 'default' : 'pointer',
                                fontWeight: 600,
                                flexShrink: 0,
                              }}
                              onClick={async () => {
                                const r = await window.api.shell?.execGitSafe?.(repo.path, c.cmd);
                                setRunResults(prev => ({
                                  ...prev,
                                  [ci]: {
                                    ok: r?.ok ?? false,
                                    output: r ? `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`.trim() : 'No response',
                                  },
                                }));
                              }}
                            >
                              {res ? (res.ok ? '✓ Done' : '✗ Failed') : (runningIndex === ci ? 'Running…' : '▶ Run')}
                            </button>
                          </div>
                          {res?.output && (
                            <pre style={{ margin: '0.4rem 0 0', fontSize: 11, fontFamily: 'var(--f-mono)', color: res.ok ? '#059669' : '#b91c1c', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {res.output}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkspaceBrowserView(): React.ReactElement {
  const openCreateAgentWizardForRepo = useUIStore((s) => s.openCreateAgentWizardForRepo);
  const openCreateAgentWizardWithTask = useUIStore((s) => s.openCreateAgentWizardWithTask);
  const openRepoDetail = useUIStore((s) => s.openRepoDetail);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<WorkspaceRepoSortKey>(DEFAULT_REPO_SORT_KEY);
  const [storageMetrics, setStorageMetrics] = useState<StorageMetricsOverview | null>(null);
  const [storageMetricsLoading, setStorageMetricsLoading] = useState(false);
  const [storageMetricsError, setStorageMetricsError] = useState<string | null>(null);
  const [storageMetricsRefreshNonce, setStorageMetricsRefreshNonce] = useState(0);
  const [copiedCleanupRepoPath, setCopiedCleanupRepoPath] = useState<string | null>(null);
  const [copiedAbandonedWorktreeKey, setCopiedAbandonedWorktreeKey] = useState<string | null>(null);
  const [cleaningAbandonedWorktreeKey, setCleaningAbandonedWorktreeKey] = useState<string | null>(null);
  const [abandonedWorktreeErrors, setAbandonedWorktreeErrors] = useState<Record<string, string>>({});
  const [dismissedWorkflowItemIds, setDismissedWorkflowItemIds] = useState<string[]>([]);
  const [snoozedUntilByWorkflowItemId, setSnoozedUntilByWorkflowItemId] = useState<Record<string, string>>({});
  const [workflowActionInFlightItemId, setWorkflowActionInFlightItemId] = useState<string | null>(null);
  const [workflowActionErrorsByItemId, setWorkflowActionErrorsByItemId] = useState<Record<string, string>>({});
  const [workspaceMutationPendingId, setWorkspaceMutationPendingId] = useState<string | null>(null);
  const [workspaceManagerExpanded, setWorkspaceManagerExpanded] = useState(false);
  const [statusByPath, setStatusByPath] = useState<Record<string, RepoStatusBlock>>({});
  const [recentReposFallback, setRecentReposFallback] = useState<DiscoveredRepo[]>([]);
  // Tab state
  const [activeTab, setActiveTab] = useState<'repos' | 'workflow' | 'storage'>('repos');
  // Stale branches cleanup dialog
  const [staleBranchesRepoPath, setStaleBranchesRepoPath] = useState<string | null>(null);
  // Worktree safety info keyed by worktree path
  const [worktreeSafetyByPath, setWorktreeSafetyByPath] = useState<Map<string, WorktreeSafetyInfo>>(new Map());
  const [worktreeSafetyLoadingPaths, setWorktreeSafetyLoadingPaths] = useState<Set<string>>(new Set());
  // Confirmation state for unsafe "Clean now" actions (key = worktreeKey)
  const [confirmCleanWorktreeKey, setConfirmCleanWorktreeKey] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    const listRes = await window.api.workspace.list();
    const list = listRes.success && listRes.data ? listRes.data : [];
    if (listRes.success) setWorkspaces(list);

    const activeRes = await window.api.workspace.getActive();
    if (activeRes.success && activeRes.data) setActiveId(activeRes.data.id);
    else if (list.length) setActiveId(list[0].id);

    if (list.length === 0) {
      try {
        const recents = await window.api.instance?.getRecentRepos?.();
        if (recents?.success && Array.isArray(recents.data)) {
          const now = new Date().toISOString();
          setRecentReposFallback(
            recents.data.map((r: { path: string; name: string; lastUsed?: string }) => ({
              workspaceId: '__recent__',
              path: r.path,
              name: r.name,
              depth: 0,
              discoveredAt: r.lastUsed ?? now,
            }))
          );
        }
      } catch {
        // ignore — fallback just stays empty
      }
    } else {
      setRecentReposFallback([]);
    }
  }, []);

  const commonParent = useCallback((paths: string[]): string | null => {
    if (paths.length === 0) return null;
    const split = paths.map((p) => p.split('/'));
    const head = split[0];
    let i = 0;
    for (; i < head.length; i++) {
      const segment = head[i];
      if (!split.every((parts) => parts[i] === segment)) break;
    }
    if (i === 0) return '/';
    const joined = head.slice(0, i).join('/');
    return joined || '/';
  }, []);

  const scanActive = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.workspace.scan(id);
      if (res.success && res.data) {
        setRepos(res.data.repos);
      } else {
        setError(res.error?.message || 'Scan failed');
        setRepos([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!activeId) {
      setRepos([]);
      return;
    }
    void scanActive(activeId);
    void window.api.workspace.startWatching(activeId);
  }, [activeId, scanActive]);

  useEffect(() => {
    const unsubscribe = window.api.workspace.onRepoChange((event: WorkspaceRepoChangeEvent) => {
      if (event.workspaceId !== activeId) return;
      setRepos((prev) => {
        if (event.kind === 'repo-added') {
          if (prev.some((r) => r.path === event.repoPath)) return prev;
          const name = event.repoPath.split('/').filter(Boolean).pop() ?? event.repoPath;
          return [
            ...prev,
            {
              workspaceId: event.workspaceId,
              path: event.repoPath,
              name,
              depth: event.depth,
              discoveredAt: event.at,
            },
          ];
        }
        return prev.filter((r) => r.path !== event.repoPath);
      });
    });
    return unsubscribe;
  }, [activeId]);

  useEffect(() => {
    let cancelled = false;
    const target = workspaces.length === 0 ? recentReposFallback : repos;
    (async () => {
      const updates: Record<string, RepoStatusBlock> = {};
      for (const repo of target) {
        try {
          const [modeRes, countRes, statusRes] = await Promise.all([
            window.api.repoWorkspace.getWorktreeMode(repo.path),
            // Use the running-count (agent attached) for the repo card badge.
            // The lifecycle-broad getActiveSessionCount stays for the SSM
            // guard in NewSessionWizard — see shared/instance-status.ts.
            window.api.repoWorkspace.getRunningSessionCount(repo.path),
            window.api.git.getRepoStatus(repo.path),
          ]);
          const block: RepoStatusBlock = {
            worktreeMode: modeRes.success ? modeRes.data : undefined,
            activeSessionCount: countRes.success ? countRes.data : 0,
          };
          if (statusRes.success && statusRes.data) {
            const s = statusRes.data;
            block.currentBranch = s.currentBranch;
            block.ahead = s.ahead;
            block.behind = s.behind;
            block.unmergedCount = s.unmergedCount;
            block.modifiedCount = s.modifiedCount;
            block.stagedCount = s.stagedCount;
            block.untrackedCount = s.untrackedCount;
            block.stashCount = s.stashCount;
            block.worktreeCount = s.worktreeCount;
          }
          updates[repo.path] = block;
        } catch {
          // ignore
        }
      }
      if (!cancelled) setStatusByPath((prev) => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
  }, [repos, recentReposFallback, workspaces.length]);

  const showingFallback = workspaces.length === 0 && recentReposFallback.length > 0;
  const sourceRepos = showingFallback ? recentReposFallback : repos;

  useEffect(() => {
    const persistedState = readWorkflowStateFromStorage();
    setDismissedWorkflowItemIds(persistedState.dismissedItemIds);
    setSnoozedUntilByWorkflowItemId(persistedState.snoozedUntilByItemId);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const validEntries = Object.entries(snoozedUntilByWorkflowItemId).filter(([, untilIso]) => {
      const untilMs = Date.parse(untilIso);
      return Number.isFinite(untilMs) && untilMs > now;
    });
    if (validEntries.length === Object.keys(snoozedUntilByWorkflowItemId).length) return;
    setSnoozedUntilByWorkflowItemId(Object.fromEntries(validEntries));
  }, [snoozedUntilByWorkflowItemId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const payload: PersistedWorkflowViewState = {
      dismissedItemIds: dismissedWorkflowItemIds,
      snoozedUntilByItemId: snoozedUntilByWorkflowItemId,
    };
    try {
      window.localStorage.setItem(WORKFLOW_VIEW_STATE_KEY, JSON.stringify(payload));
    } catch {
      // Best-effort persistence only.
    }
  }, [dismissedWorkflowItemIds, snoozedUntilByWorkflowItemId]);

  useEffect(() => {
    let cancelled = false;
    const repoPaths = [...new Set(sourceRepos.map((repo) => repo.path))];

    if (repoPaths.length === 0) {
      setStorageMetrics(null);
      setStorageMetricsError(null);
      setStorageMetricsLoading(false);
      return () => { cancelled = true; };
    }

    const loadStorageMetrics = async (): Promise<void> => {
      setStorageMetricsLoading(true);
      setStorageMetricsError(null);
      try {
        const result = await window.api.cleanup.getStorageMetrics(repoPaths);
        if (cancelled) return;
        if (result.success && result.data) {
          setStorageMetrics(result.data);
        } else {
          setStorageMetrics(null);
          setStorageMetricsError(result.error?.message || 'Failed to load storage metrics');
        }
      } catch (error) {
        if (cancelled) return;
        setStorageMetrics(null);
        setStorageMetricsError(error instanceof Error ? error.message : 'Failed to load storage metrics');
      } finally {
        if (!cancelled) setStorageMetricsLoading(false);
      }
    };

    void loadStorageMetrics();
    return () => { cancelled = true; };
  }, [sourceRepos, storageMetricsRefreshNonce]);

  // Fetch worktree safety info for stale-no-session abandoned worktrees
  useEffect(() => {
    if (!storageMetrics) return;
    let cancelled = false;
    const staleEntries = storageMetrics.local.abandonedWorktrees.filter(
      (e) => e.reason === 'stale-no-session' && e.exists
    );

    for (const entry of staleEntries) {
      const wtp = entry.worktreePath;
      if (worktreeSafetyByPath.has(wtp) || worktreeSafetyLoadingPaths.has(wtp)) continue;

      setWorktreeSafetyLoadingPaths((prev) => new Set([...prev, wtp]));

      window.api.git.getWorktreeSafetyInfo(wtp).then((res) => {
        if (cancelled) return;
        setWorktreeSafetyLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(wtp);
          return next;
        });
        if (res.success && res.data) {
          setWorktreeSafetyByPath((prev) => {
            const next = new Map(prev);
            next.set(wtp, res.data!);
            return next;
          });
        }
      }).catch(() => {
        if (cancelled) return;
        setWorktreeSafetyLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(wtp);
          return next;
        });
      });
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageMetrics]);

  const fallbackParent = useMemo(
    () => (showingFallback ? commonParent(recentReposFallback.map((r) => r.path)) : null),
    [showingFallback, recentReposFallback, commonParent]
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeId) ?? workspaces[0] ?? null,
    [workspaces, activeId]
  );
  const handleSetActiveWorkspace = useCallback(async (nextWorkspaceId: string | null): Promise<void> => {
    setError(null);
    setActiveId(nextWorkspaceId);
    const result = await window.api.workspace.setActive(nextWorkspaceId);
    if (!result.success) {
      setError(result.error?.message || 'Failed to switch workspace');
    }
  }, []);

  const handleRemoveWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    setWorkspaceMutationPendingId(workspaceId);
    setError(null);
    try {
      const result = await window.api.workspace.remove(workspaceId);
      if (!result.success) {
        setError(result.error?.message || 'Failed to delete workspace');
        return;
      }
      await refreshWorkspaces();
    } finally {
      setWorkspaceMutationPendingId((current) => (current === workspaceId ? null : current));
    }
  }, [refreshWorkspaces]);

  const handlePinFallbackParent = useCallback(async () => {
    if (!fallbackParent) return;
    const result = await window.api.workspace.add({ path: fallbackParent });
    if (result.success && result.data) {
      void refreshWorkspaces();
    }
  }, [fallbackParent, refreshWorkspaces]);

  const cleanupTargetsByRepo = useMemo(() => {
    const targetsByRepo = new Map<string, Set<string>>();
    if (!storageMetrics) return targetsByRepo;

    const addTarget = (repoPath: string, targetPath: string): void => {
      const current = targetsByRepo.get(repoPath) ?? new Set<string>();
      current.add(targetPath);
      targetsByRepo.set(repoPath, current);
    };

    for (const entry of storageMetrics.local.nodeModulesByRepo) {
      for (const targetPath of entry.paths) addTarget(entry.repoPath, targetPath);
    }
    for (const entry of storageMetrics.local.pythonEnvsByRepo) {
      for (const targetPath of entry.paths) addTarget(entry.repoPath, targetPath);
    }
    for (const entry of storageMetrics.local.abandonedWorktrees) {
      if (!entry.exists) continue;
      addTarget(entry.repoPath, entry.worktreePath);
    }

    return targetsByRepo;
  }, [storageMetrics]);

  const topPriorityReclaimable = useMemo(
    () => storageMetrics?.local.reclaimableByRepo.slice(0, 3) ?? [],
    [storageMetrics]
  );

  const abandonedWorktreeCountByRepoPath = useMemo(() => {
    const countsByRepoPath = new Map<string, number>();
    if (!storageMetrics) return countsByRepoPath;
    for (const entry of storageMetrics.local.abandonedWorktrees) {
      countsByRepoPath.set(entry.repoPath, (countsByRepoPath.get(entry.repoPath) ?? 0) + 1);
    }
    return countsByRepoPath;
  }, [storageMetrics]);

  const healthByRepoPath = useMemo(() => {
    const snapshotsByRepoPath = new Map<string, RepoHealthSnapshot>();
    for (const repo of sourceRepos) {
      const status = statusByPath[repo.path];
      const behind = status?.behind ?? 0;
      const unmerged = status?.unmergedCount ?? 0;
      const modified = status?.modifiedCount ?? 0;
      const staged = status?.stagedCount ?? 0;
      const untracked = status?.untrackedCount ?? 0;
      const abandonedWorktreeCount = abandonedWorktreeCountByRepoPath.get(repo.path) ?? 0;
      const stalePenalty = calculateRepoStalePenalty(repo.discoveredAt);
      const riskPoints = (
        behind * 3
        + unmerged * 2
        + staged
        + modified
        + untracked
        + abandonedWorktreeCount * 2
        + stalePenalty
      );
      const healthScore = Math.max(0, 100 - Math.min(95, riskPoints * 3));
      snapshotsByRepoPath.set(repo.path, {
        healthScore,
        riskPoints,
        priority: getRepoPriorityLevel(riskPoints),
      });
    }
    return snapshotsByRepoPath;
  }, [sourceRepos, statusByPath, abandonedWorktreeCountByRepoPath]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? sourceRepos.filter(
          (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
        )
      : [...sourceRepos];
    if (sortKey === 'priority') {
      list.sort((a, b) => {
        const priorityA = healthByRepoPath.get(a.path);
        const priorityB = healthByRepoPath.get(b.path);
        const riskDelta = (priorityB?.riskPoints ?? 0) - (priorityA?.riskPoints ?? 0);
        if (riskDelta !== 0) return riskDelta;
        const healthDelta = (priorityA?.healthScore ?? 100) - (priorityB?.healthScore ?? 100);
        if (healthDelta !== 0) return healthDelta;
        return a.name.localeCompare(b.name);
      });
      return list;
    }
    const cmp = getRepoComparator(sortKey);
    list.sort((a, b) =>
      cmp(
        { name: a.name, workingTreeMtimeMs: Date.parse(a.discoveredAt), lastCommitMs: Date.parse(a.discoveredAt), sizeBytes: 0 },
        { name: b.name, workingTreeMtimeMs: Date.parse(b.discoveredAt), lastCommitMs: Date.parse(b.discoveredAt), sizeBytes: 0 }
      )
    );
    return list;
  }, [sourceRepos, filter, sortKey, healthByRepoPath]);

  const buildCleanupCommand = useCallback((repoPath: string): string | null => {
    const targets = [...(cleanupTargetsByRepo.get(repoPath) ?? [])];
    if (targets.length === 0) return null;
    const quotedTargets = targets.map(shellQuote).join(' ');
    return `du -sh ${quotedTargets}; rm -rf ${quotedTargets}`;
  }, [cleanupTargetsByRepo]);

  const handleCopyCleanupCommand = useCallback(async (repoPath: string): Promise<void> => {
    const command = buildCleanupCommand(repoPath);
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCleanupRepoPath(repoPath);
      window.setTimeout(() => {
        setCopiedCleanupRepoPath((current) => (current === repoPath ? null : current));
      }, 1600);
    } catch {
      setCopiedCleanupRepoPath(null);
    }
  }, [buildCleanupCommand]);

  const buildAbandonedWorktreeKey = useCallback((entry: AbandonedWorktreeEntry): string =>
    `${entry.repoPath}::${entry.worktreePath}::${entry.reason}`, []);

  const buildAbandonedWorktreeCleanupCommand = useCallback((entry: AbandonedWorktreeEntry): string => {
    const repoPath = shellQuote(entry.repoPath);
    if (entry.reason === 'missing-path') {
      return `git -C ${repoPath} worktree prune`;
    }
    const worktreePath = shellQuote(entry.worktreePath);
    return `git -C ${repoPath} worktree remove --force ${worktreePath} && git -C ${repoPath} worktree prune`;
  }, []);

  const handleCopyAbandonedWorktreeCommand = useCallback(async (entry: AbandonedWorktreeEntry): Promise<void> => {
    const command = buildAbandonedWorktreeCleanupCommand(entry);
    const worktreeKey = buildAbandonedWorktreeKey(entry);
    try {
      await navigator.clipboard.writeText(command);
      setCopiedAbandonedWorktreeKey(worktreeKey);
      window.setTimeout(() => {
        setCopiedAbandonedWorktreeKey((current) => (current === worktreeKey ? null : current));
      }, 1600);
    } catch {
      setCopiedAbandonedWorktreeKey(null);
    }
  }, [buildAbandonedWorktreeCleanupCommand, buildAbandonedWorktreeKey]);

  const runWorktreeCleanup = useCallback(async (entries: AbandonedWorktreeEntry[]): Promise<void> => {
    const entriesByRepoPath = new Map<string, AbandonedWorktreeEntry[]>();
    for (const entry of entries) {
      const current = entriesByRepoPath.get(entry.repoPath) ?? [];
      current.push(entry);
      entriesByRepoPath.set(entry.repoPath, current);
    }

    for (const [repoPath, repoEntries] of entriesByRepoPath.entries()) {
      const result = await window.api.cleanup.execute(
        {
          repoPath,
          worktreesToRemove: repoEntries.map((entry) => ({
            path: entry.worktreePath,
            branch: entry.branch,
          })),
          branchesToDelete: [],
          branchesToMerge: [],
        },
        {
          removeWorktrees: true,
          deleteMergedBranches: false,
          mergeCompletedBranches: false,
          deleteRemoteBranches: false,
        }
      );

      if (!result.success) {
        throw new Error(result.error?.message || `Failed to clean worktrees in ${repoPath}`);
      }
      if (!result.data?.success) {
        throw new Error(result.data?.errors?.[0] || `Failed to clean worktrees in ${repoPath}`);
      }
    }

    setStorageMetricsRefreshNonce((nonce) => nonce + 1);
  }, []);

  const handleCleanAbandonedWorktree = useCallback(async (
    entry: AbandonedWorktreeEntry
  ): Promise<{ success: boolean; error?: string }> => {
    const worktreeKey = buildAbandonedWorktreeKey(entry);
    setCleaningAbandonedWorktreeKey(worktreeKey);
    setAbandonedWorktreeErrors((current) => {
      if (!(worktreeKey in current)) return current;
      const next = { ...current };
      delete next[worktreeKey];
      return next;
    });

    try {
      await runWorktreeCleanup([entry]);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clean abandoned worktree';
      setAbandonedWorktreeErrors((current) => ({
        ...current,
        [worktreeKey]: message,
      }));
      return { success: false, error: message };
    } finally {
      setCleaningAbandonedWorktreeKey((current) => (current === worktreeKey ? null : current));
    }
  }, [buildAbandonedWorktreeKey, runWorktreeCleanup]);

  const handleCleanMissingPathWorktreeRefs = useCallback(async (): Promise<void> => {
    if (!storageMetrics) return;
    const missingPathEntries = storageMetrics.local.abandonedWorktrees.filter((entry) => entry.reason === 'missing-path');
    if (missingPathEntries.length === 0) return;
    await runWorktreeCleanup(missingPathEntries);
  }, [storageMetrics, runWorktreeCleanup]);

  const dismissedWorkflowItemIdSet = useMemo(
    () => new Set(dismissedWorkflowItemIds),
    [dismissedWorkflowItemIds]
  );

  const activeSnoozedUntilByWorkflowItemId = useMemo(() => {
    const now = Date.now();
    const entries = Object.entries(snoozedUntilByWorkflowItemId).filter(([, untilIso]) => {
      const untilMs = Date.parse(untilIso);
      return Number.isFinite(untilMs) && untilMs > now;
    });
    return Object.fromEntries(entries);
  }, [snoozedUntilByWorkflowItemId]);

  const workflowQueueItems = useMemo<WorkflowQueueItem[]>(() => {
    const items: WorkflowQueueItem[] = [];
    const repoNameByPath = new Map(sourceRepos.map((repo) => [repo.path, repo.name]));

    if (storageMetrics) {
      const missingPathEntries = storageMetrics.local.abandonedWorktrees.filter((entry) => entry.reason === 'missing-path');
      const missingPathRepoCount = new Set(missingPathEntries.map((entry) => entry.repoPath)).size;

      if (missingPathRepoCount > 0) {
        items.push({
          id: 'cleanup:missing-path-refs',
          title: `Prune missing worktree refs in ${missingPathRepoCount} repo${missingPathRepoCount === 1 ? '' : 's'}`,
          reason: `${missingPathEntries.length} stale worktree reference${missingPathEntries.length === 1 ? '' : 's'} point to directories that no longer exist.`,
          impactLabel: 'Safe cleanup',
          score: 250 + missingPathEntries.length * 10,
          category: 'cleanup',
          primaryAction: { kind: 'clean-missing-worktree-refs', label: 'Clean safe refs' },
          secondaryActions: [{ kind: 'open-terminal', label: 'Open terminal', repoPath: missingPathEntries[0]?.repoPath }],
        });
      }

      for (const entry of storageMetrics.local.abandonedWorktrees.filter((row) => row.reason === 'stale-no-session').slice(0, 3)) {
        const staleScore = 180
          + Math.min(40, Math.round((entry.bytes / ONE_GIB) * 7))
          + Math.min(30, entry.daysSinceLastTouched ?? 0);
        const repoName = basenameFromPath(entry.repoPath);
        items.push({
          id: `cleanup:abandoned:${buildAbandonedWorktreeKey(entry)}`,
          title: `Remove abandoned worktree ${entry.branch}`,
          reason: `${repoName} • ${entry.exists ? formatDaysOld(entry.daysSinceLastTouched) : 'missing path'} • ${formatGiB(entry.bytes)} reclaimable`,
          impactLabel: 'Medium impact',
          score: staleScore,
          category: 'cleanup',
          primaryAction: { kind: 'clean-abandoned-worktree', label: 'Clean now', abandonedWorktree: entry },
          secondaryActions: [{ kind: 'copy-abandoned-worktree-command', label: 'Copy cmd', abandonedWorktree: entry }],
        });
      }

      for (const entry of storageMetrics.local.reclaimableByRepo.filter((row) => row.totalReclaimableBytes >= ONE_GIB).slice(0, 3)) {
        const repoPath = entry.repoPath;
        const repoName = repoNameByPath.get(repoPath) ?? basenameFromPath(repoPath);
        items.push({
          id: `cleanup:reclaimable:${repoPath}`,
          title: `Reclaim ${formatGiB(entry.totalReclaimableBytes)} from ${repoName}`,
          reason: `node_modules ${formatGiB(entry.nodeModulesBytes)} • python envs ${formatGiB(entry.pythonEnvsBytes)} • abandoned worktrees ${entry.abandonedWorktreeCount}`,
          impactLabel: 'Disk pressure relief',
          score: 130 + Math.min(45, Math.round((entry.totalReclaimableBytes / ONE_GIB) * 6)),
          category: 'cleanup',
          primaryAction: { kind: 'copy-repo-cleanup-command', label: 'Copy cleanup cmd', repoPath },
          secondaryActions: [{ kind: 'open-terminal', label: 'Open terminal', repoPath }],
        });
      }
    }

    const behindRepos = sourceRepos
      .map((repo) => ({ repo, behind: statusByPath[repo.path]?.behind ?? 0 }))
      .filter((row) => row.behind > 0)
      .sort((a, b) => b.behind - a.behind)
      .slice(0, 4);
    for (const { repo, behind } of behindRepos) {
      items.push({
        id: `sync:behind:${repo.path}`,
        title: `${repo.name} is ${behind} commit${behind === 1 ? '' : 's'} behind`,
        reason: 'Staying in sync early lowers rebase and conflict risk later in the day.',
        impactLabel: 'Merge risk reduction',
        score: 170 + Math.min(40, behind * 3),
        category: 'sync',
        primaryAction: { kind: 'open-repo-detail', label: 'Open repo', repoPath: repo.path },
        secondaryActions: [{ kind: 'open-terminal', label: 'Open terminal', repoPath: repo.path }],
      });
    }

    const dirtyRepos = sourceRepos
      .map((repo) => ({
        repo,
        uncommitted:
          (statusByPath[repo.path]?.modifiedCount ?? 0) +
          (statusByPath[repo.path]?.stagedCount ?? 0) +
          (statusByPath[repo.path]?.untrackedCount ?? 0),
      }))
      .filter((row) => row.uncommitted > 0)
      .sort((a, b) => b.uncommitted - a.uncommitted)
      .slice(0, 4);
    for (const { repo, uncommitted } of dirtyRepos) {
      items.push({
        id: `changes:dirty:${repo.path}`,
        title: `Review ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} in ${repo.name}`,
        reason: 'Uncommitted local drift is easy to lose and hard to reason about later.',
        impactLabel: 'Context preservation',
        score: 140 + Math.min(30, uncommitted * 2),
        category: 'changes',
        primaryAction: { kind: 'open-repo-detail', label: 'Inspect changes', repoPath: repo.path },
        secondaryActions: [{ kind: 'new-session', label: 'New session', repoPath: repo.path }],
      });
    }

    return items
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 12);
  }, [sourceRepos, statusByPath, storageMetrics, buildAbandonedWorktreeKey]);

  const visibleWorkflowQueueItems = useMemo(
    () =>
      workflowQueueItems
        .filter((item) => {
          if (dismissedWorkflowItemIdSet.has(item.id)) return false;
          return !(item.id in activeSnoozedUntilByWorkflowItemId);
        })
        .slice(0, WORKFLOW_QUEUE_LIMIT),
    [workflowQueueItems, dismissedWorkflowItemIdSet, activeSnoozedUntilByWorkflowItemId]
  );

  const hiddenWorkflowItemCount = useMemo(
    () =>
      workflowQueueItems.filter((item) =>
        dismissedWorkflowItemIdSet.has(item.id) || item.id in activeSnoozedUntilByWorkflowItemId
      ).length,
    [workflowQueueItems, dismissedWorkflowItemIdSet, activeSnoozedUntilByWorkflowItemId]
  );

  const handleDismissWorkflowItem = useCallback((itemId: string): void => {
    setDismissedWorkflowItemIds((current) => (current.includes(itemId) ? current : [...current, itemId]));
    setWorkflowActionErrorsByItemId((current) => {
      if (!(itemId in current)) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }, []);

  const handleSnoozeWorkflowItem = useCallback((itemId: string): void => {
    const until = new Date(Date.now() + WORKFLOW_SNOOZE_HOURS * 60 * 60 * 1000).toISOString();
    setSnoozedUntilByWorkflowItemId((current) => ({ ...current, [itemId]: until }));
    setWorkflowActionErrorsByItemId((current) => {
      if (!(itemId in current)) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }, []);

  const handleResetWorkflowVisibility = useCallback((): void => {
    setDismissedWorkflowItemIds([]);
    setSnoozedUntilByWorkflowItemId({});
  }, []);

  const executeWorkflowAction = useCallback(async (
    itemId: string,
    action: WorkflowActionDefinition,
    force?: boolean
  ): Promise<void> => {
    // Safety gate: if this is a clean action for an abandoned worktree and not safe, require confirmation
    if (action.kind === 'clean-abandoned-worktree' && action.abandonedWorktree && !force) {
      const wtp = action.abandonedWorktree.worktreePath;
      const info = worktreeSafetyByPath.get(wtp);
      if (info && (info.hasUncommittedChanges || info.unmergedCommitCount > 0)) {
        setConfirmCleanWorktreeKey(buildAbandonedWorktreeKey(action.abandonedWorktree));
        return;
      }
    }

    setWorkflowActionInFlightItemId(itemId);
    setWorkflowActionErrorsByItemId((current) => {
      if (!(itemId in current)) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });

    try {
      if (action.kind === 'open-repo-detail') {
        if (!action.repoPath) throw new Error('No repository selected');
        openRepoDetail(action.repoPath);
      } else if (action.kind === 'open-terminal') {
        if (!action.repoPath) throw new Error('No repository selected');
        await window.api.shell?.openTerminal?.(action.repoPath);
      } else if (action.kind === 'new-session') {
        if (!action.repoPath) throw new Error('No repository selected');
        openCreateAgentWizardForRepo(action.repoPath);
      } else if (action.kind === 'copy-repo-cleanup-command') {
        if (!action.repoPath) throw new Error('No repository selected');
        await handleCopyCleanupCommand(action.repoPath);
      } else if (action.kind === 'copy-abandoned-worktree-command') {
        if (!action.abandonedWorktree) throw new Error('No abandoned worktree selected');
        await handleCopyAbandonedWorktreeCommand(action.abandonedWorktree);
      } else if (action.kind === 'clean-abandoned-worktree') {
        if (!action.abandonedWorktree) throw new Error('No abandoned worktree selected');
        const result = await handleCleanAbandonedWorktree(action.abandonedWorktree);
        if (!result.success) throw new Error(result.error || 'Failed to clean abandoned worktree');
        setDismissedWorkflowItemIds((current) => (current.includes(itemId) ? current : [...current, itemId]));
      } else if (action.kind === 'clean-missing-worktree-refs') {
        await handleCleanMissingPathWorktreeRefs();
        setDismissedWorkflowItemIds((current) => (current.includes(itemId) ? current : [...current, itemId]));
      }
    } catch (error) {
      setWorkflowActionErrorsByItemId((current) => ({
        ...current,
        [itemId]: error instanceof Error ? error.message : 'Workflow action failed',
      }));
    } finally {
      setWorkflowActionInFlightItemId((current) => (current === itemId ? null : current));
    }
  }, [
    openRepoDetail,
    openCreateAgentWizardForRepo,
    openCreateAgentWizardWithTask,
    handleCopyCleanupCommand,
    handleCopyAbandonedWorktreeCommand,
    handleCleanAbandonedWorktree,
    handleCleanMissingPathWorktreeRefs,
    worktreeSafetyByPath,
    buildAbandonedWorktreeKey,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 h-full min-h-0 flex flex-col bg-white" data-testid="workspace-browser">
      {/* Header */}
      <div className="bg-white border-b border-[rgba(0,0,0,0.10)]">
        <div className="p-4 pb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="uppercase tracking-widest text-[0.8rem] text-black font-semibold" style={{ fontSize: '1rem' }}>Workspaces</h1>
              <span className="inline-flex items-center px-[0.6rem] py-[0.15rem] text-[0.7rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]">
                {activeWorkspace ? activeWorkspace.name : 'No active workspace'}
              </span>
            </div>
            <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">
              {sourceRepos.length === 0
                ? 'Add a workspace to discover repositories and workflow actions.'
                : `${sourceRepos.length} repositories${filter.trim() ? ` • ${filtered.length} visible` : ''}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="px-[0.7rem] py-[0.35rem] border border-[rgba(0,0,0,0.10)] rounded-lg bg-white text-black text-[0.8rem]"
              value={activeId ?? ''}
              onChange={(e) => {
                const next = e.target.value || null;
                void handleSetActiveWorkspace(next);
              }}
              data-testid="workspace-switcher"
            >
              {workspaces.length === 0 && <option value="">— no workspaces —</option>}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="btn-primary"
              data-testid="add-workspace-button"
            >
              + Add local folder
            </button>
            <button
              type="button"
              onClick={() => activeId && void scanActive(activeId)}
              disabled={!activeId || loading}
              className="kb-btn"
              style={{ opacity: (!activeId || loading) ? 0.5 : 1 }}
              data-testid="rescan-button"
            >
              {loading ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
        </div>

        {/* Workspace manager panel */}
        {workspaces.length > 0 && (
          <div className="px-4 pb-3">
            <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px]" style={{ padding: '0.6rem 0.85rem' }} data-testid="workspace-manager-panel">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="uppercase tracking-widest text-black font-semibold" style={{ fontSize: '0.72rem' }}>Workspace folders</p>
                  <span className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">{workspaces.length} total</span>
                </div>
                <button
                  type="button"
                  onClick={() => setWorkspaceManagerExpanded((expanded) => !expanded)}
                  className="kb-btn"
                  data-testid="workspace-manager-toggle"
                >
                  {workspaceManagerExpanded ? 'Done' : 'Manage'}
                </button>
              </div>
              {!workspaceManagerExpanded && activeWorkspace && (
                <div
                  className="flex items-center justify-between gap-3 border border-[rgba(0,0,0,0.10)] rounded-[10px] bg-white"
                  style={{ marginTop: '0.5rem', padding: '0.4rem 0.6rem' }}
                  data-testid="workspace-manager-collapsed-summary"
                >
                  <div className="min-w-0">
                    <p className="text-[0.875rem] text-black font-semibold truncate">{activeWorkspace.name}</p>
                    <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)] truncate">{activeWorkspace.path}</p>
                  </div>
                  <span className="text-[0.68rem] px-[0.5rem] py-[0.15rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]">Active</span>
                </div>
              )}
              {workspaceManagerExpanded && (
                <>
                  <div className="mt-2 space-y-2" data-testid="workspace-manager-list">
                    {workspaces.map((workspace) => {
                      const isActiveWorkspace = workspace.id === activeId;
                      const isRemovingWorkspace = workspaceMutationPendingId === workspace.id;
                      return (
                        <div
                          key={workspace.id}
                          className="flex items-center justify-between gap-3 border border-[rgba(0,0,0,0.10)] rounded-[10px] bg-white"
                          style={{ padding: '0.4rem 0.6rem' }}
                          data-testid="workspace-manager-row"
                        >
                          <div className="min-w-0">
                            <p className="text-[0.875rem] text-black font-semibold truncate">{workspace.name}</p>
                            <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)] truncate">{workspace.path}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            {isActiveWorkspace ? (
                              <span className="text-[0.68rem] px-[0.5rem] py-[0.15rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]" data-testid={`workspace-manager-active-${workspace.id}`}>
                                Active
                              </span>
                            ) : (
                              <button type="button" onClick={() => void handleSetActiveWorkspace(workspace.id)} className="kb-btn" data-testid={`workspace-manager-switch-${workspace.id}`}>
                                Switch
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRemoveWorkspace(workspace.id)}
                              disabled={isRemovingWorkspace}
                              className="kb-btn"
                              style={{ borderColor: 'rgba(239,68,68,0.4)', color: '#dc2626', opacity: isRemovingWorkspace ? 0.5 : 1 }}
                              data-testid={`workspace-manager-remove-${workspace.id}`}
                            >
                              {isRemovingWorkspace ? 'Removing…' : 'Delete'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[rgba(0,0,0,0.45)]" style={{ marginTop: '0.5rem', fontSize: '0.68rem' }}>
                    Add any local folder (repo root or parent folder) via "+ Add local folder".
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex items-center gap-1.5 p-1 bg-[rgba(0,0,0,0.04)] rounded-full" style={{ margin: '0 1rem 0.75rem' }}>
          <button type="button" data-testid="workspace-tab-repos" className={activeTab === 'repos' ? 'bg-black text-white rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer' : 'text-[rgba(0,0,0,0.45)] rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[rgba(0,0,0,0.04)] cursor-pointer'} onClick={() => setActiveTab('repos')}>
            Repos
          </button>
          <button type="button" data-testid="workspace-tab-workflow" className={activeTab === 'workflow' ? 'bg-black text-white rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer' : 'text-[rgba(0,0,0,0.45)] rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[rgba(0,0,0,0.04)] cursor-pointer'} onClick={() => setActiveTab('workflow')}>
            Workflow
          </button>
          <button type="button" data-testid="workspace-tab-storage" className={activeTab === 'storage' ? 'bg-black text-white rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer' : 'text-[rgba(0,0,0,0.45)] rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[rgba(0,0,0,0.04)] cursor-pointer'} onClick={() => setActiveTab('storage')}>
            Storage
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {error && (
          <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '0.75rem', fontSize: '0.85rem' }} className="bg-red-50 border border-red-200 text-red-600">
            {error}
          </div>
        )}

        {/* ===== REPOS TAB ===== */}
        {activeTab === 'repos' && (
          <>
            {/* Filter / sort bar */}
            <div style={{ marginBottom: '1rem' }}>
              <div className="flex flex-wrap items-center gap-2 border border-[rgba(0,0,0,0.10)] rounded-[12px] bg-[#FAFAF7]" style={{ padding: '0.5rem 0.75rem' }}>
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter repos…"
                  className="border border-[rgba(0,0,0,0.10)] rounded-lg bg-white text-black text-[0.8rem]"
                  style={{ padding: '0.35rem 0.65rem', flex: '1', minWidth: '200px' }}
                  data-testid="repo-filter"
                />
                <label className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Sort:</label>
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as WorkspaceRepoSortKey)}
                  className="border border-[rgba(0,0,0,0.10)] rounded-lg bg-white text-black text-[0.8rem]"
                  style={{ padding: '0.35rem 0.65rem' }}
                  data-testid="sort-select"
                >
                  <option value="priority">Priority score</option>
                  <option value="last-touched">Last touched</option>
                  <option value="alphabetical">Alphabetical</option>
                  <option value="size">Size</option>
                </select>
              </div>
            </div>

            {workspaces.length === 0 && recentReposFallback.length === 0 && (
              <div className="flex flex-col items-center justify-center text-[rgba(0,0,0,0.45)]" style={{ height: '12rem' }} data-testid="empty-state-no-workspace">
                <p style={{ marginBottom: '0.75rem' }}>No workspaces yet.</p>
                <button type="button" onClick={() => setShowAdd(true)} className="btn-primary">
                  Add your first workspace
                </button>
              </div>
            )}

            {showingFallback && (
              <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4" style={{ marginBottom: '1rem' }} data-testid="recent-repos-banner">
                <p className="text-[0.875rem] text-black" style={{ marginBottom: '0.5rem' }}>
                  Showing {recentReposFallback.length} repos from your recent sessions.
                  Add a workspace to enable folder scanning + filesystem watching.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setShowAdd(true)} className="btn-primary">
                    + Add local folder
                  </button>
                  {fallbackParent && (
                    <button
                      type="button"
                      onClick={() => void handlePinFallbackParent()}
                      className="kb-btn"
                      data-testid="pin-parent-button"
                      title={`Create a workspace at ${fallbackParent}`}
                    >
                      Pin {fallbackParent} as workspace
                    </button>
                  )}
                </div>
              </div>
            )}

            {workspaces.length > 0 && filtered.length === 0 && !loading && (
              <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]" data-testid="empty-state-no-repos">
                {repos.length === 0 ? 'No git repositories found in this workspace.' : 'No repos match your filter.'}
              </p>
            )}

            {filtered.length > 0 && (
              <div className="border border-[rgba(0,0,0,0.10)] rounded-[14px] overflow-hidden bg-white" data-testid="repo-list">
                <div className="uppercase tracking-widest text-black font-semibold text-[0.8rem] border-b border-[rgba(0,0,0,0.10)]" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,2fr) minmax(130px,0.9fr) minmax(90px,0.7fr) minmax(150px,0.9fr) minmax(220px,1fr) auto', gap: '0.5rem', padding: '0.5rem 0.75rem' }}>
                  <span>Repository</span>
                  <span>Priority</span>
                  <span>Health</span>
                  <span>Sync</span>
                  <span>Local state</span>
                  <span>Actions</span>
                </div>
                <div>
                  {filtered.map((repo, index) => (
                    <RepoInsightRow
                      key={repo.path}
                      repo={repo}
                      index={index}
                      status={statusByPath[repo.path] ?? null}
                      healthSnapshot={healthByRepoPath.get(repo.path) ?? { healthScore: 100, riskPoints: 0, priority: 'healthy' as RepoPriorityLevel }}
                      isLast={index === filtered.length - 1}
                      openRepoDetail={openRepoDetail}
                      openCreateAgentWizardForRepo={openCreateAgentWizardForRepo}
                      openCreateAgentWizardWithTask={openCreateAgentWizardWithTask}
                      onOpenBranchCleanup={(path) => setStaleBranchesRepoPath(path)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ===== WORKFLOW TAB ===== */}
        {activeTab === 'workflow' && (
          <div data-testid="workflow-queue-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', gap: '0.5rem' }}>
              <div>
                <h2 className="uppercase tracking-widest text-black font-semibold text-[0.8rem]">Daily workflow queue</h2>
                <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Highest-leverage actions for this workspace right now.</p>
              </div>
              {hiddenWorkflowItemCount > 0 && (
                <button type="button" onClick={handleResetWorkflowVisibility} className="kb-btn" data-testid="workflow-queue-reset">
                  Show hidden ({hiddenWorkflowItemCount})
                </button>
              )}
            </div>

            {sourceRepos.length === 0 ? (
              <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4 text-center">
                <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Add a workspace to see workflow actions.</p>
              </div>
            ) : visibleWorkflowQueueItems.length === 0 ? (
              <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]" data-testid="workflow-queue-empty">
                Queue is clear. Hidden items can be restored with "Show hidden".
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {visibleWorkflowQueueItems.map((item, index) => {
                  const inFlight = workflowActionInFlightItemId === item.id;
                  const actionError = workflowActionErrorsByItemId[item.id];

                  // For abandoned worktree cleanup items, extract entry + safety info
                  const isAbandonedCleanup = item.primaryAction.kind === 'clean-abandoned-worktree';
                  const abandEntry = item.primaryAction.abandonedWorktree;
                  const wtp = abandEntry?.worktreePath;
                  const safetyInfo = wtp ? worktreeSafetyByPath.get(wtp) : undefined;
                  const safetyLoading = wtp ? worktreeSafetyLoadingPaths.has(wtp) : false;
                  const worktreeKey = abandEntry ? buildAbandonedWorktreeKey(abandEntry) : '';
                  const isSafe = safetyInfo && !safetyInfo.hasUncommittedChanges && safetyInfo.unmergedCommitCount === 0;
                  const confirmingThisItem = confirmCleanWorktreeKey === worktreeKey;

                  return (
                    <div
                      key={item.id}
                      className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4"
                      data-testid={`workflow-queue-item-${index}`}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                          <div className="min-w-0">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                              <span className="text-[0.68rem] px-[0.45rem] py-[0.1rem] rounded-full border border-[rgba(0,0,0,0.10)] text-[rgba(0,0,0,0.45)]">
                                {workflowCategoryLabel(item.category)}
                              </span>
                              <span className="text-[0.68rem] text-[rgba(0,0,0,0.45)]">{item.impactLabel}</span>
                            </div>
                            <p className="text-[0.875rem] text-black font-semibold">{item.title}</p>
                            <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">{item.reason}</p>

                            {/* Safety badges for abandoned worktree items */}
                            {isAbandonedCleanup && wtp && (
                              <WorktreeSafetyBadges
                                worktreePath={wtp}
                                safetyInfo={safetyInfo}
                                loading={safetyLoading}
                              />
                            )}
                          </div>

                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                            {/* Primary action button — changes colour based on safety */}
                            {confirmingThisItem ? (
                              <>
                                <span className="text-[0.7rem] text-amber-600 self-center">Unsafe — confirm?</span>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    setConfirmCleanWorktreeKey(null);
                                    await executeWorkflowAction(item.id, item.primaryAction, true);
                                  }}
                                  disabled={inFlight}
                                  className="kb-btn"
                                  style={{ borderColor: 'rgba(217,119,6,0.4)', color: '#d97706', opacity: inFlight ? 0.5 : 1 }}
                                  data-testid={`workflow-queue-primary-${index}`}
                                >
                                  {inFlight ? 'Running…' : 'Confirm clean'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmCleanWorktreeKey(null)}
                                  className="kb-btn"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void executeWorkflowAction(item.id, item.primaryAction)}
                                disabled={inFlight}
                                className={isAbandonedCleanup && safetyInfo && !isSafe ? 'kb-btn' : 'btn-primary'}
                                style={isAbandonedCleanup && safetyInfo && !isSafe ? { borderColor: 'rgba(217,119,6,0.4)', color: '#d97706', opacity: inFlight ? 0.5 : 1 } : { opacity: inFlight ? 0.5 : 1 }}
                                data-testid={`workflow-queue-primary-${index}`}
                              >
                                {inFlight ? 'Running…' : item.primaryAction.label}
                              </button>
                            )}
                            {(item.secondaryActions ?? []).slice(0, 2).map((secondaryAction, secondaryIndex) => (
                              <button
                                key={`${item.id}-secondary-${secondaryAction.kind}-${secondaryIndex}`}
                                type="button"
                                onClick={() => void executeWorkflowAction(item.id, secondaryAction)}
                                disabled={inFlight}
                                className="kb-btn"
                                style={{ opacity: inFlight ? 0.5 : 1 }}
                                data-testid={`workflow-queue-secondary-${index}-${secondaryIndex}`}
                              >
                                {secondaryAction.label}
                              </button>
                            ))}
                            <button type="button" onClick={() => handleSnoozeWorkflowItem(item.id)} disabled={inFlight} className="kb-btn" style={{ opacity: inFlight ? 0.5 : 1 }} data-testid={`workflow-queue-snooze-${index}`}>
                              Snooze
                            </button>
                            <button type="button" onClick={() => handleDismissWorkflowItem(item.id)} disabled={inFlight} className="kb-btn" style={{ opacity: inFlight ? 0.5 : 1 }} data-testid={`workflow-queue-dismiss-${index}`}>
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </div>
                      {actionError && (
                        <p style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: '#f87171' }} data-testid={`workflow-queue-error-${index}`}>
                          {actionError}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ===== STORAGE TAB ===== */}
        {activeTab === 'storage' && (
          <div data-testid="storage-metrics-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 className="uppercase tracking-widest text-black font-semibold text-[0.8rem]">Disk &amp; Docker usage</h2>
              <button type="button" onClick={() => setStorageMetricsRefreshNonce((n) => n + 1)} disabled={storageMetricsLoading} className="kb-btn" style={{ opacity: storageMetricsLoading ? 0.5 : 1 }} data-testid="refresh-storage-metrics">
                {storageMetricsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {storageMetricsLoading && (
              <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Analyzing Docker and local storage usage…</p>
            )}

            {!storageMetricsLoading && storageMetricsError && (
              <p style={{ color: '#f87171', fontSize: '0.8rem' }} data-testid="storage-metrics-error">{storageMetricsError}</p>
            )}

            {!storageMetricsLoading && storageMetrics && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {/* Docker + Local side-by-side */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4">
                    <p className="uppercase tracking-widest text-black font-semibold text-[0.8rem]" style={{ marginBottom: '0.5rem' }}>Docker</p>
                    {storageMetrics.docker.available ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <p className="text-[0.875rem] text-black" data-testid="docker-images-metric">{`${formatGiB(storageMetrics.docker.images.sizeBytes)} images (${storageMetrics.docker.images.reclaimablePercent ?? 0}% of total)`}</p>
                        <p className="text-[0.875rem] text-black" data-testid="docker-volumes-metric">{`${formatGiB(storageMetrics.docker.localVolumes.sizeBytes)} local volumes (${storageMetrics.docker.localVolumes.reclaimablePercent ?? 0}% unused)`}</p>
                        <p className="text-[0.875rem] text-black" data-testid="docker-build-cache-metric">{`${formatGiB(storageMetrics.docker.buildCache.sizeBytes)} build cache`}</p>
                      </div>
                    ) : (
                      <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Docker metrics unavailable{storageMetrics.docker.error ? `: ${storageMetrics.docker.error}` : ''}</p>
                    )}
                  </div>

                  <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4">
                    <p className="uppercase tracking-widest text-black font-semibold text-[0.8rem]" style={{ marginBottom: '0.5rem' }}>Local storage</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <p className="text-[0.875rem] text-black" data-testid="local-node-modules-metric">{`${formatGiB(storageMetrics.local.nodeModulesTotalBytes)} node_modules (${storageMetrics.local.nodeModulesByRepo.length} repos)`}</p>
                      <p className="text-[0.875rem] text-black" data-testid="local-python-metric">{`${formatGiB(storageMetrics.local.pythonEnvsTotalBytes)} python envs (${storageMetrics.local.pythonEnvsByRepo.length} repos)`}</p>
                    </div>
                    {(storageMetrics.local.nodeModulesByRepo.length > 0 || storageMetrics.local.pythonEnvsByRepo.length > 0) && (
                      <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                        {storageMetrics.local.nodeModulesByRepo.slice(0, 3).map((entry) => (
                          <p key={`node-${entry.repoPath}`} className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">{`node_modules: ${basenameFromPath(entry.repoPath)} — ${formatGiB(entry.bytes)}`}</p>
                        ))}
                        {storageMetrics.local.pythonEnvsByRepo.slice(0, 3).map((entry) => (
                          <p key={`py-${entry.repoPath}`} className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">{`python envs: ${basenameFromPath(entry.repoPath)} — ${formatGiB(entry.bytes)}`}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Top priority actions */}
                {topPriorityReclaimable.length > 0 && (
                  <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4" data-testid="top-priority-actions-section">
                    <p className="uppercase tracking-widest text-black font-semibold text-[0.8rem]" style={{ marginBottom: '0.5rem' }}>Top priority actions</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {topPriorityReclaimable.map((entry, index) => {
                        const cleanupCommand = buildCleanupCommand(entry.repoPath);
                        return (
                          <div key={`top-action-${entry.repoPath}`} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }} data-testid={`top-priority-action-row-${index}`}>
                            <p className="text-[0.875rem] text-black">{`${index + 1}. ${basenameFromPath(entry.repoPath)} — reclaim ${formatGiB(entry.totalReclaimableBytes)}`}</p>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <button type="button" onClick={() => void handleCopyCleanupCommand(entry.repoPath)} disabled={!cleanupCommand} className="kb-btn" style={{ opacity: !cleanupCommand ? 0.5 : 1 }} data-testid={`top-priority-action-copy-${index}`}>
                                {copiedCleanupRepoPath === entry.repoPath ? 'Copied' : 'Copy cleanup cmd'}
                              </button>
                              <button type="button" onClick={() => window.api.shell?.openTerminal?.(entry.repoPath)} className="kb-btn" data-testid={`top-priority-action-terminal-${index}`}>
                                Open terminal
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Reclaimable ranking */}
                {storageMetrics.local.reclaimableByRepo.length > 0 && (
                  <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4" data-testid="reclaimable-ranking-section">
                    <p className="uppercase tracking-widest text-black font-semibold text-[0.8rem]" style={{ marginBottom: '0.5rem' }}>Reclaimable space ranking</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      {storageMetrics.local.reclaimableByRepo.slice(0, 5).map((entry, index) => (
                        <p key={`reclaim-${entry.repoPath}`} className="text-[0.875rem] text-black" data-testid={`reclaimable-ranking-row-${index}`}>
                          {`${index + 1}. ${basenameFromPath(entry.repoPath)} — ${formatGiB(entry.totalReclaimableBytes)} reclaimable`}
                          {` (node_modules ${formatGiB(entry.nodeModulesBytes)}, python ${formatGiB(entry.pythonEnvsBytes)}, abandoned worktrees ${entry.abandonedWorktreeCount})`}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Abandoned worktrees */}
                <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4" data-testid="abandoned-worktrees-section">
                  <p className="uppercase tracking-widest text-black font-semibold text-[0.8rem]" style={{ marginBottom: '0.5rem' }}>Abandoned worktrees</p>
                  {storageMetrics.local.abandonedWorktrees.length === 0 ? (
                    <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">No abandoned worktrees detected.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      {storageMetrics.local.abandonedWorktrees.slice(0, 5).map((entry, index) => {
                        const worktreeKey = buildAbandonedWorktreeKey(entry);
                        const cleanupError = abandonedWorktreeErrors[worktreeKey];
                        const cleaningInProgress = cleaningAbandonedWorktreeKey === worktreeKey;

                        return (
                          <div
                            key={`abandoned-${entry.worktreePath}-${index}`}
                            className="border border-[rgba(0,0,0,0.10)] rounded-[10px] bg-white"
                            style={{ padding: '0.6rem 0.75rem' }}
                            data-testid={`abandoned-worktree-row-${index}`}
                          >
                            <p className="text-[0.875rem] text-black">
                              {`${basenameFromPath(entry.repoPath)}:${entry.branch} — ${formatAbandonedReason(entry.reason)} • ${entry.exists ? formatDaysOld(entry.daysSinceLastTouched) : 'missing path'} • ${formatGiB(entry.bytes)}`}
                            </p>

                            {/* Safety badges in storage panel */}
                            {entry.reason === 'stale-no-session' && entry.exists && (
                              <WorktreeSafetyBadges
                                worktreePath={entry.worktreePath}
                                safetyInfo={worktreeSafetyByPath.get(entry.worktreePath)}
                                loading={worktreeSafetyLoadingPaths.has(entry.worktreePath)}
                              />
                            )}

                            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                onClick={() => void handleCleanAbandonedWorktree(entry)}
                                disabled={cleaningInProgress}
                                className="btn-primary"
                                style={{ opacity: cleaningInProgress ? 0.5 : 1 }}
                                data-testid={`abandoned-worktree-clean-${index}`}
                              >
                                {cleaningInProgress ? 'Cleaning…' : 'Clean now'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleCopyAbandonedWorktreeCommand(entry)}
                                disabled={cleaningInProgress}
                                className="kb-btn"
                                style={{ opacity: cleaningInProgress ? 0.5 : 1 }}
                                data-testid={`abandoned-worktree-copy-${index}`}
                              >
                                {copiedAbandonedWorktreeKey === worktreeKey ? 'Copied' : 'Copy cmd'}
                              </button>
                            </div>
                            {cleanupError && (
                              <p style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: '#f87171' }} data-testid={`abandoned-worktree-error-${index}`}>
                                {cleanupError}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {!storageMetricsLoading && !storageMetrics && sourceRepos.length === 0 && (
              <div className="bg-[#FAFAF7] border border-[rgba(0,0,0,0.10)] rounded-[14px] p-4 text-center">
                <p className="text-[0.75rem] text-[rgba(0,0,0,0.45)]">Add a workspace to see storage metrics.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <AddWorkspaceDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => { void refreshWorkspaces(); }}
      />

      {/* Stale branches cleanup dialog */}
      {staleBranchesRepoPath && (
        <StaleBranchesDialog
          repoPath={staleBranchesRepoPath}
          onClose={() => setStaleBranchesRepoPath(null)}
        />
      )}
    </div>
  );
}
