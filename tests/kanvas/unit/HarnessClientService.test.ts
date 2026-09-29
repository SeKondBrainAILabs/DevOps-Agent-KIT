/**
 * KC-S2.1.2: HarnessClientService talks to KIT Harness's inbound MCP server
 * (streamable HTTP, bearer token) and its run events route, and turns every
 * failure into an error code the Coding tab can show, never a crash.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('electron', () => ({ BrowserWindow: class {} }));

import { HarnessClientService, parseRpcBody } from '../../../electron/services/HarnessClientService';
import { HARNESS_ERRORS } from '../../../shared/harness-types';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** A fake harness: an MCP endpoint at /mcp (JSON or SSE replies) and GET /runs/<id>/events. */
function fakeHarness(opts: {
  tools?: Record<string, (args: any) => any>;
  sse?: boolean;
  token?: string;
  expireOnce?: boolean;
} = {}) {
  const calls: Call[] = [];
  let sessionCounter = 0;
  let expired = !opts.expireOnce;
  const tools = opts.tools ?? {};
  const token = opts.token ?? 'tok';
  const reply = (status: number, body: string, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  });
  const fetchImpl = async (url: string, init: any = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers, body });
    if (headers.authorization !== `Bearer ${token}`) return reply(401, '{"error":"unauthorized"}');
    const events = url.match(/\/runs\/([^/?]+)\/events(\?after_event_id=(.+))?$/);
    if (events) {
      return reply(200, JSON.stringify({ run_id: events[1], resumed_after: events[3] ?? null, frames: [], cursor: events[3] ?? null }));
    }
    if (body.method === 'initialize') {
      sessionCounter += 1;
      const msg = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'kit-harness' } } };
      return reply(200, JSON.stringify(msg), { 'mcp-session-id': `s${sessionCounter}`, 'content-type': 'application/json' });
    }
    if (body.method === 'notifications/initialized') return reply(202, '');
    if (!expired) {
      expired = true;
      return reply(404, '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"}}');
    }
    const fn = tools[body.params.name];
    const result = fn
      ? { content: [{ type: 'text', text: JSON.stringify(fn(body.params.arguments)) }], isError: false }
      : { content: [{ type: 'text', text: `Unknown tool ${body.params.name}` }], isError: true };
    const msg = { jsonrpc: '2.0', id: body.id, result };
    if (opts.sse) {
      return reply(200, `event: message\ndata: ${JSON.stringify(msg)}\n\n`, { 'content-type': 'text/event-stream' });
    }
    return reply(200, JSON.stringify(msg), { 'content-type': 'application/json' });
  };
  return { calls, fetchImpl };
}

const settings = (url: string | null = 'http://mini:39200/mcp', token: string | null = 'tok') => () => ({ url, token });

describe('HarnessClientService (KC-S2.1.2)', () => {
  let harness: ReturnType<typeof fakeHarness>;

  beforeEach(() => {
    harness = fakeHarness({
      tools: {
        harness_list_runs: () => ({ ok: true, runs: [{ run_id: 'r1', status: 'running', created_at: 't', stories: { coding: 1 } }] }),
        harness_get_run: (a) => ({ ok: true, run_id: a.run_id, status: 'running', stories: [], role_totals: {}, totals: {} }),
        harness_approve: (a) => ({ ok: true, approved: a.approved, story_id: a.story_id }),
        harness_answer: () => ({ ok: false, error: 'story KC-1 is not blocked' }),
      },
    });
  });

  it('initializes an MCP session once, then calls tools with the bearer token and session id', async () => {
    const svc = new HarnessClientService(settings(), harness.fetchImpl as any);
    const runs = await svc.listRuns();
    expect(runs).toEqual({ success: true, data: [{ run_id: 'r1', status: 'running', created_at: 't', stories: { coding: 1 } }] });
    await svc.getRun('r1');
    const methods = harness.calls.map((c) => c.body?.method);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    const toolCall = harness.calls[2];
    expect(toolCall.url).toBe('http://mini:39200/mcp');
    expect(toolCall.headers.authorization).toBe('Bearer tok');
    expect(toolCall.headers['mcp-session-id']).toBe('s1');
    expect(toolCall.body.params).toEqual({ name: 'harness_list_runs', arguments: {} });
  });

  it('exposes list/get/submit/approve/answer/pause/resume/cancel as harness_* tool calls', async () => {
    const seen: Array<[string, any]> = [];
    const all = fakeHarness({
      tools: Object.fromEntries(
        ['harness_list_runs', 'harness_get_run', 'harness_get_story', 'harness_submit_stories', 'harness_submit_epic',
          'harness_approve', 'harness_answer', 'harness_pause', 'harness_resume', 'harness_cancel', 'harness_cluster_status']
          .map((n) => [n, (a: any) => { seen.push([n, a]); return { ok: true, runs: [] }; }])
      ),
    });
    const svc = new HarnessClientService(settings(), all.fetchImpl as any);
    await svc.listRuns();
    await svc.getRun('r1');
    await svc.getStory('r1', 'KC-1');
    await svc.submitStories([{ id: 'KC-1' }], { repo: 'o/r' });
    await svc.submitEpic('# Epic', 'o/r', { auto_approve: false });
    await svc.approve('r1', 'KC-1', false, 'too big');
    await svc.answer('r1', 'KC-1', 'use postgres');
    await svc.pause('r1');
    await svc.resume('r1');
    await svc.cancel('r1');
    await svc.clusterStatus();
    expect(seen).toEqual([
      ['harness_list_runs', {}],
      ['harness_get_run', { run_id: 'r1' }],
      ['harness_get_story', { run_id: 'r1', story_id: 'KC-1' }],
      ['harness_submit_stories', { stories: [{ id: 'KC-1' }], repo: 'o/r' }],
      ['harness_submit_epic', { source: '# Epic', repo: 'o/r', auto_approve: false }],
      ['harness_approve', { run_id: 'r1', story_id: 'KC-1', approved: false, comment: 'too big' }],
      ['harness_answer', { run_id: 'r1', story_id: 'KC-1', text: 'use postgres' }],
      ['harness_pause', { run_id: 'r1' }],
      ['harness_resume', { run_id: 'r1' }],
      ['harness_cancel', { run_id: 'r1' }],
      ['harness_cluster_status', {}],
    ]);
  });

  it('approves a whole proposed run when no story is given', async () => {
    const svc = new HarnessClientService(settings(), harness.fetchImpl as any);
    const result = await svc.approve('r1', null, true);
    expect(result).toEqual({ success: true, data: { approved: true, story_id: '' } });
  });

  it('reads replies sent as an SSE stream', async () => {
    const sse = fakeHarness({ sse: true, tools: { harness_list_runs: () => ({ ok: true, runs: [] }) } });
    const svc = new HarnessClientService(settings(), sse.fetchImpl as any);
    expect(await svc.listRuns()).toEqual({ success: true, data: [] });
    expect(parseRpcBody('data: {"id": 2, "result": 1}\n\ndata: {"id": 3, "result": 2}\n', 'text/event-stream', 3)).toEqual({ id: 3, result: 2 });
  });

  it('starts a new MCP session when the old one has expired', async () => {
    const expiring = fakeHarness({ expireOnce: true, tools: { harness_list_runs: () => ({ ok: true, runs: [] }) } });
    const svc = new HarnessClientService(settings(), expiring.fetchImpl as any);
    expect((await svc.listRuns()).success).toBe(true);
    const inits = expiring.calls.filter((c) => c.body?.method === 'initialize');
    expect(inits).toHaveLength(2);
  });

  it('reports a tool error ({ok: false}) as HARNESS_TOOL_ERROR', async () => {
    const svc = new HarnessClientService(settings(), harness.fetchImpl as any);
    const result = await svc.answer('r1', 'KC-1', 'x');
    expect(result).toEqual({ success: false, error: { code: HARNESS_ERRORS.TOOL, message: 'story KC-1 is not blocked', details: undefined } });
  });

  it('is offline, not crashing, when the harness is unreachable', async () => {
    const down = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:39200'); };
    const svc = new HarnessClientService(settings(), down as any);
    const result = await svc.listRuns();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(HARNESS_ERRORS.OFFLINE);
    expect(result.error?.message).toMatch(/unreachable at http:\/\/mini:39200\/mcp/);
    expect((await svc.events('r1')).error?.code).toBe(HARNESS_ERRORS.OFFLINE);
  });

  it('says when the token is wrong or nothing is configured', async () => {
    const wrong = new HarnessClientService(settings('http://mini:39200/mcp', 'nope'), harness.fetchImpl as any);
    expect((await wrong.listRuns()).error?.code).toBe(HARNESS_ERRORS.UNAUTHORIZED);
    const empty = new HarnessClientService(settings(null, null), harness.fetchImpl as any);
    expect((await empty.listRuns()).error?.code).toBe(HARNESS_ERRORS.NOT_CONFIGURED);
    expect(empty.connection()).toEqual({ url: null, hasToken: false });
  });

  it('polls run events from the same host, passing the cursor', async () => {
    const svc = new HarnessClientService(settings(), harness.fetchImpl as any);
    const first = await svc.events('r1');
    const next = await svc.events('r1', 'ev-9');
    expect(first).toEqual({ success: true, data: { run_id: 'r1', resumed_after: null, frames: [], cursor: null } });
    expect(next.data?.resumed_after).toBe('ev-9');
    expect(harness.calls.map((c) => c.url)).toEqual([
      'http://mini:39200/runs/r1/events',
      'http://mini:39200/runs/r1/events?after_event_id=ev-9',
    ]);
  });
});
