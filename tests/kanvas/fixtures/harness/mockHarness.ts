/**
 * Fixtures captured from a real `kit-harness serve --engine fake --scm fake` run
 * (runs.json, story-*.json, events-done.json), and a window.api.harness mock
 * serving them. Tests override any method they need.
 */

import { jest } from '@jest/globals';
import type { HarnessRun, HarnessStory, HarnessEventsPage } from '../../../../shared/harness-types';

/* eslint-disable @typescript-eslint/no-var-requires */
export const RUNS: HarnessRun[] = require('./runs.json');
export const STORY_DONE: HarnessStory = require('./story-done.json');
export const STORY_GATED: HarnessStory = require('./story-gated.json');
export const EVENTS_DONE: HarnessEventsPage = require('./events-done.json');

export const DONE_RUN = RUNS[0];
export const GATED_RUN = RUNS[1];

const ok = <T,>(data: T) => ({ success: true, data });

export function makeHarnessApi(overrides: Record<string, unknown> = {}) {
  const fn = (impl: (...a: any[]) => any) => jest.fn(impl as any) as any;
  return {
    connection: fn(async () => ok({ url: 'http://mini:39200/mcp', hasToken: true })),
    setConnection: fn(async (url: string, token?: string) => ok({ url, hasToken: !!token })),
    listRuns: fn(async () => ok(RUNS.map((r) => ({ run_id: r.run_id, status: r.status, created_at: r.created_at, stories: {} })))),
    getRun: fn(async (runId: string) => ok(RUNS.find((r) => r.run_id === runId))),
    getStory: fn(async (_runId: string, storyId: string) =>
      ok(storyId === STORY_GATED.story_id ? STORY_GATED : STORY_DONE)),
    events: fn(async () => ok(EVENTS_DONE)),
    approve: fn(async () => ok({ approved: true })),
    answer: fn(async () => ok({ state: 'queued' })),
    pause: fn(async () => ok({ status: 'paused' })),
    resume: fn(async () => ok({ status: 'running' })),
    cancel: fn(async () => ok({ status: 'cancelled' })),
    clusterStatus: fn(async () => ok({ litellm: { ok: true }, devops_agent: { ok: true, url: 'http://127.0.0.1:39100/mcp' } })),
    storyDiff: fn(async () => ({ success: false, error: { code: 'HARNESS_WORKTREE_NOT_LOCAL', message: 'The worktree is not on this machine' } })),
    screenshot: fn(async () => ok('data:image/png;base64,iVBORw0KGgo=')),
    submitStories: fn(async () => ok({ run_id: 'r-new', stories: [] })),
    submitEpic: fn(async () => ok({ run_id: 'r-epic' })),
    ...overrides,
  };
}

export function installHarnessApi(overrides: Record<string, unknown> = {}) {
  const api = makeHarnessApi(overrides);
  (window as any).api = { ...(window as any).api, harness: api };
  return api;
}
