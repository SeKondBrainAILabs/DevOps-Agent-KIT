/**
 * KIT Harness client types and pure helpers for the Kanvas Coding tab
 * (KC-S2.1.x). Shapes follow the harness's inbound MCP tools (harness_*) and
 * its run events route (GET /runs/<id>/events, Kora HAI FeatureBus v1 frames).
 */

/** Story states, as KIT Harness's lifecycle names them. */
export type HarnessStoryState =
  | 'queued'
  | 'preparing'
  | 'refining'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'test_writing'
  | 'coding'
  | 'qa_functional'
  | 'qa_visual'
  | 'reviewing'
  | 'pr_open'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface HarnessUsage {
  sessions: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
}

export interface HarnessRunSummary {
  run_id: string;
  status: string;
  created_at: string;
  /** Story counts by state. */
  stories: Record<string, number>;
  /** Repos the run's stories target: a repo name, owner/name, or an absolute checkout path. */
  repos?: string[];
}

export interface HarnessStorySummary {
  story_id: string;
  title: string;
  repo?: string;
  state: HarnessStoryState | string;
  rounds?: number;
  session_id?: string | null;
  worktree?: string | null;
  commits?: string[];
  pr_url?: string | null;
  questions?: string[];
  reason?: string;
  tokens?: HarnessUsage & { by_role?: Record<string, HarnessUsage> };
}

export interface HarnessRun extends Omit<HarnessRunSummary, 'stories'> {
  epic?: string | null;
  source?: string | null;
  error?: string;
  proposal?: unknown;
  questions?: string[];
  stories: HarnessStorySummary[];
  role_totals: Record<string, HarnessUsage>;
  totals: HarnessUsage;
}

export interface HarnessCriterionEvidence {
  id: string;
  text: string;
  verify?: string;
  tests?: string[];
  passed: boolean;
  /** Verify commands QA ran: stdout and stderr together, last part kept (output_tail). */
  checks?: Array<{ command: string; exit_code: number; output_tail?: string; neutral?: boolean }>;
  visual?: { ac?: string; pass?: boolean; confidence?: number; screenshot?: string; finding?: string; advisory?: boolean } | null;
}

export interface HarnessEvidence {
  story_id: string;
  run_id: string;
  rounds: number;
  acceptance_criteria: HarnessCriterionEvidence[];
  static_findings?: Array<{ severity?: string; file?: string; line?: number | null; message?: string }>;
  tokens?: HarnessUsage & { by_role?: Record<string, HarnessUsage> };
  usage?: HarnessUsageRecord[];
  files_touched?: string[];
  commits?: Array<{ hash: string; message: string; files: string[] }>;
  session_id?: string | null;
}

/** One engine session, as the harness journals it (role, alias and the model that served it). */
export interface HarnessUsageRecord {
  step?: string;
  role: string;
  model?: string;
  served_model?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  seconds?: number;
}

export interface HarnessStory extends HarnessStorySummary {
  story: { id: string; title: string; narrative?: string; acceptance_criteria?: Array<{ id: string; text: string; verify?: string; visual?: boolean }> };
  plan: Record<string, unknown> | null;
  evidence: HarnessEvidence | null;
}

/** A Kora HAI FeatureBus v1 frame: {schema_version, event, event_id, timestamp, data}. */
export interface HarnessFrame {
  schema_version: string;
  event: 'feature_bus' | 'terminal' | string;
  event_id: string;
  timestamp: string;
  data: {
    event_id?: string;
    event_type?: string;
    timestamp?: string;
    source_agent_id?: string;
    payload?: Record<string, any>;
    correlation_id?: string | null;
    run_id?: string;
    status?: string;
  };
}

export interface HarnessEventsPage {
  run_id: string;
  resumed_after: string | null;
  frames: HarnessFrame[];
  cursor: string | null;
}

export interface HarnessClusterStatus {
  /** Core AI Backend, the harness's model route since its ADR 0012. */
  core?: { ok: boolean; url?: string | null; detail?: unknown };
  /** The LiteLLM gateway, reported by harnesses from before ADR 0012. */
  litellm?: { ok: boolean; url?: string; detail?: unknown };
  devops_agent?: { ok: boolean; url?: string; mode?: string };
  /** Per-lane health, when the harness reports it: alias -> status. */
  lanes?: Record<string, { ok: boolean; model?: string | null; detail?: string }>;
}

export interface HarnessConnection {
  url: string | null;
  hasToken: boolean;
}

// ---------------------------------------------------------------------------
// Cloud escalation (KC-S1.11.6)
// ---------------------------------------------------------------------------

/**
 * When KIT Harness may move a story's builder sessions from local models to a
 * cloud open-weight model (Core AI Backend DAMA → Vercel AI Gateway):
 * after the stuck ladder's builder-large rung fails, or from the start for a
 * story the Planner sizes L or XL.
 */
export type EscalationTrigger = 'stuck_ladder' | 'size_l_xl';

export const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = ['stuck_ladder', 'size_l_xl'];

export interface CloudEscalationPolicy {
  enabled: boolean;
  triggers: EscalationTrigger[];
}

/** Off until someone turns it on: escalation spends money. */
/** Short labels for the timeline and the event stream. */
export const ESCALATION_LABELS: Record<string, string> = {
  stuck_ladder: 'stuck ladder',
  size_l_xl: 'size L/XL',
};

export const DEFAULT_CLOUD_ESCALATION: CloudEscalationPolicy = {
  enabled: false,
  triggers: ['stuck_ladder', 'size_l_xl'],
};

/** A stored or submitted policy, with anything unknown dropped. Never throws. */
export function normalizeCloudEscalation(raw: unknown): CloudEscalationPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLOUD_ESCALATION, triggers: [...DEFAULT_CLOUD_ESCALATION.triggers] };
  const r = raw as { enabled?: unknown; triggers?: unknown };
  const triggers = Array.isArray(r.triggers)
    ? ESCALATION_TRIGGERS.filter((t) => (r.triggers as unknown[]).includes(t))
    : [...DEFAULT_CLOUD_ESCALATION.triggers];
  return { enabled: r.enabled === true, triggers };
}

/** Error codes HarnessClientService returns, so the tab can show an offline state instead of failing. */
export const HARNESS_ERRORS = {
  NOT_CONFIGURED: 'HARNESS_NOT_CONFIGURED',
  OFFLINE: 'HARNESS_OFFLINE',
  UNAUTHORIZED: 'HARNESS_UNAUTHORIZED',
  PROTOCOL: 'HARNESS_PROTOCOL_ERROR',
  TOOL: 'HARNESS_TOOL_ERROR',
} as const;

// ---------------------------------------------------------------------------
// Board (KC-S2.1.3)
// ---------------------------------------------------------------------------

export interface BoardColumn {
  id: string;
  title: string;
  states: string[];
}

/** The board's columns, in order; every story state lands in exactly one. */
export const CODING_COLUMNS: BoardColumn[] = [
  { id: 'queued', title: 'Queued', states: ['queued', 'preparing'] },
  { id: 'refining', title: 'Refining/Planning', states: ['refining', 'planning'] },
  { id: 'approval', title: 'Awaiting approval', states: ['awaiting_plan_approval'] },
  { id: 'building', title: 'Building', states: ['test_writing', 'coding'] },
  { id: 'qa', title: 'QA', states: ['qa_functional', 'qa_visual'] },
  { id: 'review', title: 'Review', states: ['reviewing'] },
  { id: 'pr', title: 'PR open', states: ['pr_open', 'done'] },
  { id: 'blocked', title: 'Blocked', states: ['blocked'] },
  { id: 'failed', title: 'Failed', states: ['failed', 'cancelled'] },
];

export function columnForState(state: string): string {
  return CODING_COLUMNS.find((c) => c.states.includes(state))?.id ?? 'queued';
}

export interface BoardCard extends HarnessStorySummary {
  run_id: string;
}

/** Stories of every run, grouped by column id. */
export function boardColumns(runs: HarnessRun[]): Record<string, BoardCard[]> {
  const out: Record<string, BoardCard[]> = Object.fromEntries(CODING_COLUMNS.map((c) => [c.id, []]));
  for (const run of runs) {
    for (const story of run.stories) {
      out[columnForState(story.state)].push({ ...story, run_id: run.run_id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run stream (KC-S2.1.4)
// ---------------------------------------------------------------------------

/**
 * Append newly polled frames, dropping any already seen (a reconnect with an
 * unknown cursor replays everything), keeping arrival order.
 */
export function mergeFrames(existing: HarnessFrame[], incoming: HarnessFrame[]): HarnessFrame[] {
  const seen = new Set(existing.map((f) => f.event_id));
  const out = existing.slice();
  for (const frame of incoming) {
    if (!seen.has(frame.event_id)) {
      seen.add(frame.event_id);
      out.push(frame);
    }
  }
  return out;
}

/** The cursor to resume after: the last feature_bus event id seen. */
export function lastCursor(frames: HarnessFrame[]): string | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].event === 'feature_bus') return frames[i].event_id;
  }
  return null;
}

export const PHASE_ROLES: Record<string, string> = {
  REFINE: 'refiner',
  PLAN: 'planner',
  TEST_WRITE: 'test-writer',
  CODE: 'coder',
  QA_FUNC: 'qa-functional',
  QA_VISUAL: 'qa-visual',
  REVIEW: 'reviewer',
};

export interface TimelineStep {
  role: string;
  phase?: string;
  started?: string;
  ended?: string;
  /** Alias the step asked for and the model that actually served it. */
  model?: string;
  served_model?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  seconds?: number;
  status: 'running' | 'done';
  /** Set when the step ran on the cloud escalation route (KC-S1.11.6 AC4). */
  escalation?: { trigger: string; alias: string };
}

/**
 * One story's per-role timeline from the run's frames: phase start/end give
 * the steps, and `kit.story.session` events add the model that served each.
 */
export function storyTimeline(frames: HarnessFrame[], storyId: string): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const open = new Map<string, TimelineStep>();
  // The harness journals `escalated {story, trigger, alias}` before the first
  // escalated session; sessions that ask for that alias carry it.
  let escalation: { trigger: string; alias: string } | undefined;
  for (const frame of frames) {
    if (frame.event !== 'feature_bus') continue;
    const d = frame.data;
    const p = d.payload ?? {};
    if ((p.story_id ?? d.correlation_id) !== storyId) continue;
    if (d.event_type === 'kit.phase.start' && p.phase) {
      const step: TimelineStep = { role: PHASE_ROLES[p.phase] ?? String(p.phase).toLowerCase(), phase: p.phase, started: d.timestamp, status: 'running' };
      steps.push(step);
      open.set(p.phase, step);
    } else if (d.event_type === 'kit.phase.end' && p.phase) {
      const step = open.get(p.phase);
      if (step) {
        step.ended = d.timestamp;
        step.status = 'done';
        open.delete(p.phase);
      }
    } else if (d.event_type === 'kit.story.escalated') {
      escalation = { trigger: String(p.trigger ?? 'escalated'), alias: String(p.alias ?? '') };
    } else if (d.event_type === 'kit.story.session') {
      const role = String(p.role ?? '');
      const step = [...steps].reverse().find((s) => s.role === role) ?? (() => {
        const s: TimelineStep = { role, started: d.timestamp, status: 'done' };
        steps.push(s);
        return s;
      })();
      step.model = p.model ?? step.model;
      step.served_model = p.served_model ?? step.served_model;
      const model = String(p.model ?? '');
      if (escalation && model && model === escalation.alias) {
        step.escalation = escalation;
      } else if (model.endsWith('@escalate')) {
        step.escalation = { trigger: String(p.escalation_trigger ?? 'escalated'), alias: model };
      }
      step.tokens_in = (step.tokens_in ?? 0) + Number(p.tokens_in ?? 0);
      step.tokens_out = (step.tokens_out ?? 0) + Number(p.tokens_out ?? 0);
      step.seconds = (step.seconds ?? 0) + Number(p.seconds ?? 0);
    }
  }
  return steps;
}

/** A readable line for one frame in the live stream. */
export function describeFrame(frame: HarnessFrame): string {
  if (frame.event === 'terminal') return `run ${frame.data.run_id} finished: ${frame.data.status}`;
  const d = frame.data;
  const p = d.payload ?? {};
  const story = p.story_id ?? d.correlation_id;
  switch (d.event_type) {
    case 'kit.phase.start':
      return `${story}: ${PHASE_ROLES[p.phase] ?? p.phase} started`;
    case 'kit.phase.end':
      return `${story}: ${PHASE_ROLES[p.phase] ?? p.phase} finished`;
    case 'kit.story.session':
      return `${story}: ${p.role} on ${p.served_model || p.model} (${Number(p.tokens_in ?? 0) + Number(p.tokens_out ?? 0)} tokens)`;
    case 'kit.story.escalated':
      return `${story}: escalated to ${p.alias} (${ESCALATION_LABELS[p.trigger] ?? p.trigger})`;
    default: {
      const name = (d.event_type ?? 'event').replace(/^kit\.(story|run)\./, '');
      return story ? `${story}: ${name}` : name;
    }
  }
}

// ---------------------------------------------------------------------------
// Diff (KC-S2.1.4 AC3)
// ---------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  diff: string;
}

/** Split a unified multi-file diff into one chunk per file. */
export function splitUnifiedDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  const blocks = diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf('\n') === -1 ? undefined : block.indexOf('\n'));
    const m = header.match(/^diff --git a\/(.+) b\/(.+)$/);
    out.push({ path: m ? m[2] : header.replace('diff --git ', ''), diff: block });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token meter and lanes (KC-S2.1.7)
// ---------------------------------------------------------------------------

export const HARNESS_LANES: Array<{ id: string; alias: string }> = [
  { id: 'planner', alias: 'kit-planner' },
  { id: 'builder', alias: 'kit-builder' },
  { id: 'reviewer', alias: 'kit-reviewer' },
  { id: 'vision', alias: 'kit-vision' },
  { id: 'fast', alias: 'kit-fast' },
];

export type LaneHealth = 'ok' | 'down' | 'unknown';

/**
 * Health per lane. Uses the harness's per-lane report when it has one;
 * otherwise every lane shares the gateway's readiness (LiteLLM fronts them all).
 */
export function laneHealth(status: HarnessClusterStatus | null): Array<{ id: string; alias: string; health: LaneHealth; model?: string | null }> {
  return HARNESS_LANES.map((lane) => {
    const reported = status?.lanes?.[lane.alias] ?? status?.lanes?.[lane.id];
    if (reported) return { ...lane, health: reported.ok ? 'ok' : 'down', model: reported.model };
    const gateway = status?.core ?? status?.litellm;
    if (!gateway) return { ...lane, health: 'unknown' };
    return { ...lane, health: gateway.ok ? 'ok' : 'down' };
  });
}

export interface RoleTokens {
  role: string;
  tokens_in: number;
  tokens_out: number;
  total: number;
  cost: number;
  sessions: number;
}

/** Tokens per role for a run, largest first. */
export function roleTokens(roleTotals: Record<string, HarnessUsage> | undefined): RoleTokens[] {
  return Object.entries(roleTotals ?? {})
    .map(([role, u]) => ({
      role,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      total: u.tokens_in + u.tokens_out,
      cost: u.cost,
      sessions: u.sessions,
    }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// A session's Code tab: the runs for that session's repo, and the sessions they spawned
// ---------------------------------------------------------------------------

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Does a story's repo (name, owner/name or absolute path) name this checkout? */
export function repoMatches(repo: string | undefined, repoPath: string): boolean {
  if (!repo) return false;
  const target = trimSlash(repoPath);
  const wanted = trimSlash(repo);
  if (wanted.startsWith('/')) return wanted === target;
  return wanted.split('/').pop() === target.split('/').pop();
}

/** Runs with at least one story for this checkout. Uses the run's repos, else its stories' repos. */
export function runsForRepo(runs: HarnessRun[], repoPath: string): HarnessRun[] {
  return runs.filter((run) => {
    const repos = run.repos ?? run.stories.map((s) => s.repo).filter((r): r is string => !!r);
    return repos.some((repo) => repoMatches(repo, repoPath));
  });
}

export interface SpawnedSession {
  run_id: string;
  story_id: string;
  title: string;
  state: string;
  session_id: string;
  pr_url?: string | null;
}

/** The DevOps sessions the harness started for these runs' stories, one per story, newest run first. */
export function spawnedSessions(runs: HarnessRun[]): SpawnedSession[] {
  const out: SpawnedSession[] = [];
  for (const run of [...runs].reverse()) {
    for (const story of run.stories) {
      if (!story.session_id) continue;
      out.push({
        run_id: run.run_id,
        story_id: story.story_id,
        title: story.title,
        state: String(story.state),
        session_id: story.session_id,
        pr_url: story.pr_url,
      });
    }
  }
  return out;
}
