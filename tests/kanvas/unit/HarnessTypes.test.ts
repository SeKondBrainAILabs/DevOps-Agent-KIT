/**
 * KC-S2.1.3 / KC-S2.1.4 / KC-S2.1.7: the Coding tab's pure logic (board columns, event
 * stream merging, per-role timeline, diff splitting, lanes and tokens), checked against
 * fixtures captured from a real KIT Harness run.
 */

import { describe, it, expect } from '@jest/globals';
import {
  CODING_COLUMNS,
  boardColumns,
  columnForState,
  describeFrame,
  laneHealth,
  lastCursor,
  mergeFrames,
  roleTokens,
  splitUnifiedDiff,
  storyTimeline,
} from '../../../shared/harness-types';
import { RUNS, EVENTS_DONE, DONE_RUN, GATED_RUN } from '../fixtures/harness/mockHarness';

const STATES = [
  'queued', 'preparing', 'refining', 'planning', 'awaiting_plan_approval', 'test_writing', 'coding',
  'qa_functional', 'qa_visual', 'reviewing', 'pr_open', 'done', 'blocked', 'failed', 'cancelled',
];

describe('Coding board columns (KC-S2.1.3 AC1)', () => {
  it('has the nine columns, in order', () => {
    expect(CODING_COLUMNS.map((c) => c.title)).toEqual([
      'Queued', 'Refining/Planning', 'Awaiting approval', 'Building', 'QA', 'Review', 'PR open', 'Blocked', 'Failed',
    ]);
  });

  it('puts every harness story state in exactly one column', () => {
    for (const state of STATES) {
      expect(CODING_COLUMNS.filter((c) => c.states.includes(state))).toHaveLength(1);
    }
    expect(columnForState('awaiting_plan_approval')).toBe('approval');
    expect(columnForState('qa_visual')).toBe('qa');
    expect(columnForState('done')).toBe('pr');
  });

  it('groups a real run by column, keeping the run id on each card', () => {
    const cols = boardColumns(RUNS);
    expect(cols.pr.map((c) => c.story_id)).toEqual(['KC-S9.9.1', 'KC-S9.9.2']);
    expect(cols.approval.map((c) => [c.run_id, c.story_id])).toEqual([[GATED_RUN.run_id, 'KC-S9.9.3']]);
    expect(cols.pr[0].run_id).toBe(DONE_RUN.run_id);
  });
});

describe('run event stream (KC-S2.1.4 AC1)', () => {
  const frames = EVENTS_DONE.frames;

  it('appends new frames in order and drops ones already seen on a replay', () => {
    const first = mergeFrames([], frames.slice(0, 10));
    const replayed = mergeFrames(first, frames); // unknown cursor: the harness replays everything
    expect(replayed.map((f) => f.event_id)).toEqual(frames.map((f) => f.event_id));
    expect(mergeFrames(replayed, frames)).toHaveLength(frames.length);
  });

  it('resumes after the last feature_bus event, not the terminal frame', () => {
    expect(frames[frames.length - 1].event).toBe('terminal');
    expect(lastCursor(frames)).toBe(EVENTS_DONE.cursor);
    expect(lastCursor([])).toBeNull();
  });

  it('builds a per-role timeline with the model that served each step', () => {
    const steps = storyTimeline(frames, 'KC-S9.9.1');
    expect(steps.map((s) => s.role)).toEqual(['refiner', 'planner', 'test-writer', 'coder', 'qa-functional', 'reviewer']);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
    expect(steps[0]).toMatchObject({ model: 'kit-planner', served_model: 'kit-planner' });
    expect(steps[3]).toMatchObject({ model: 'kit-builder' });
    expect(storyTimeline(frames, 'KC-S9.9.2').length).toBe(6);
    expect(steps[4].model).toBeUndefined(); // functional QA is deterministic: no model
  });

  it('describes frames in words', () => {
    const lines = frames.map(describeFrame);
    expect(lines).toContain('KC-S9.9.1: refiner started');
    expect(lines.some((l) => l.startsWith('KC-S9.9.1: coder on kit-builder'))).toBe(true);
    expect(lines[lines.length - 1]).toBe(`run ${DONE_RUN.run_id} finished: done`);
  });
});

describe('diff and meters', () => {
  it('splits a unified diff into one chunk per file (KC-S2.1.4 AC3)', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts',
    ].join('\n');
    const files = splitUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'new.ts']);
    expect(files[0].diff).toContain('+y');
    expect(splitUnifiedDiff('')).toEqual([]);
  });

  it('reports lane health per alias, or the gateway health for all lanes (KC-S2.1.7 AC1)', () => {
    expect(laneHealth(null).every((l) => l.health === 'unknown')).toBe(true);
    expect(laneHealth({ litellm: { ok: true } }).map((l) => l.health)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const reported = laneHealth({
      litellm: { ok: true },
      lanes: { 'kit-fast': { ok: false, detail: 'kit-fast not configured in LiteLLM' }, 'kit-builder': { ok: true, model: 'kit-builder' } },
    });
    expect(Object.fromEntries(reported.map((l) => [l.id, l.health]))).toEqual({
      planner: 'ok', builder: 'ok', reviewer: 'ok', vision: 'ok', fast: 'down',
    });
  });

  it('orders tokens per role, largest first (KC-S2.1.7 AC2)', () => {
    const rows = roleTokens({
      coder: { sessions: 2, tokens_in: 9000, tokens_out: 1000, cost: 0 },
      refiner: { sessions: 1, tokens_in: 800, tokens_out: 200, cost: 0.01 },
    });
    expect(rows.map((r) => [r.role, r.total])).toEqual([['coder', 10000], ['refiner', 1000]]);
    expect(roleTokens(DONE_RUN.role_totals).map((r) => r.role)).toEqual(
      expect.arrayContaining(['refiner', 'planner', 'test-writer', 'coder', 'reviewer'])
    );
  });
});

describe('cloud escalation policy (KC-S1.11.6)', () => {
  const { normalizeCloudEscalation, describeFrame } = require('../../../shared/harness-types');

  it('defaults to off and drops unknown triggers', () => {
    expect(normalizeCloudEscalation(undefined)).toEqual({ enabled: false, triggers: ['stuck_ladder', 'size_l_xl'] });
    expect(normalizeCloudEscalation({ enabled: 'yes', triggers: ['size_l_xl', 'always'] })).toEqual({
      enabled: false,
      triggers: ['size_l_xl'],
    });
    expect(normalizeCloudEscalation({ enabled: true, triggers: [] })).toEqual({ enabled: true, triggers: [] });
  });

  it('describes an escalation in the live stream', () => {
    const frame = {
      event: 'feature_bus',
      data: {
        event_type: 'kit.story.escalated',
        payload: { story_id: 'KC-S1', trigger: 'size_l_xl', alias: 'kit-builder@escalate' },
      },
    };
    expect(describeFrame(frame)).toBe('KC-S1: escalated to kit-builder@escalate (size L/XL)');
  });
});

