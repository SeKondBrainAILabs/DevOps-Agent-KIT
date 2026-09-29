/**
 * HarnessClientService (KC-S2.1.2)
 *
 * Kanvas's client for KIT Harness: its inbound MCP server (harness_* tools,
 * streamable HTTP at <url>, usually http://<mac-mini>:39200/mcp) and its run
 * events route (GET <base>/runs/<id>/events). URL and bearer token come from
 * Settings, so Kanvas can run on any machine that can reach the harness.
 *
 * Every call returns an IpcResult; a harness that is down, misconfigured or
 * refusing the token comes back as an error code (HARNESS_ERRORS), never a
 * throw, so the Coding tab can show an offline state.
 */

import { BaseService } from './BaseService';
import type { IpcResult } from '../../shared/types';
import {
  HARNESS_ERRORS,
  type HarnessClusterStatus,
  type HarnessConnection,
  type HarnessEventsPage,
  type HarnessRun,
  type HarnessRunSummary,
  type HarnessStory,
} from '../../shared/harness-types';

export interface HarnessSettings {
  url: string | null;
  token: string | null;
}

type FetchLike = (input: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 10_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class HarnessClientService extends BaseService {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;
  private appVersion = '0.0.0';

  constructor(
    private readonly getSettings: () => HarnessSettings,
    private readonly fetchImpl: FetchLike = (globalThis as any).fetch,
  ) {
    super();
  }

  setAppVersion(version: string): void {
    this.appVersion = version;
  }

  /** Forget the MCP session, e.g. after the URL or token changed in Settings. */
  reset(): void {
    this.sessionId = null;
    this.initialized = false;
  }

  connection(): HarnessConnection {
    const { url, token } = this.getSettings();
    return { url: url || null, hasToken: !!token };
  }

  // ---------------------------------------------------------------- tools

  listRuns(): Promise<IpcResult<HarnessRunSummary[]>> {
    return this.tool('harness_list_runs', {}, (r) => r.runs ?? []);
  }

  getRun(runId: string): Promise<IpcResult<HarnessRun>> {
    return this.tool('harness_get_run', { run_id: runId }, stripOk);
  }

  getStory(runId: string, storyId: string): Promise<IpcResult<HarnessStory>> {
    return this.tool('harness_get_story', { run_id: runId, story_id: storyId }, stripOk);
  }

  submitStories(
    stories: unknown[],
    options: { repo?: string; auto_approve?: boolean; models?: Record<string, string> } = {},
  ): Promise<IpcResult<{ run_id: string; stories: string[] }>> {
    return this.tool('harness_submit_stories', { stories, ...options }, stripOk);
  }

  submitEpic(
    source: string,
    repo: string,
    options: { auto_approve?: boolean; kind?: string; id_prefix?: string } = {},
  ): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_submit_epic', { source, repo, ...options }, stripOk);
  }

  approve(runId: string, storyId: string | null, approved: boolean, comment = ''): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_approve', { run_id: runId, story_id: storyId ?? '', approved, comment }, stripOk);
  }

  answer(runId: string, storyId: string, text: string): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_answer', { run_id: runId, story_id: storyId, text }, stripOk);
  }

  pause(runId: string): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_pause', { run_id: runId }, stripOk);
  }

  resume(runId: string): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_resume', { run_id: runId }, stripOk);
  }

  cancel(runId: string): Promise<IpcResult<Record<string, unknown>>> {
    return this.tool('harness_cancel', { run_id: runId }, stripOk);
  }

  clusterStatus(): Promise<IpcResult<HarnessClusterStatus>> {
    return this.tool('harness_cluster_status', {}, stripOk);
  }

  /** A run's events after a cursor, as FeatureBus frames (the harness replays all on an unknown cursor). */
  async events(runId: string, afterEventId?: string | null): Promise<IpcResult<HarnessEventsPage>> {
    try {
      const { url, token } = this.requireSettings();
      const base = url.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
      const query = afterEventId ? `?after_event_id=${encodeURIComponent(afterEventId)}` : '';
      const resp = await this.send(`${base}/runs/${encodeURIComponent(runId)}/events${query}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const text = await resp.text();
      if (!resp.ok) throw httpError(resp.status, text);
      return this.success(JSON.parse(text) as HarnessEventsPage);
    } catch (err) {
      return this.fail(err);
    }
  }

  /**
   * A visual-QA screenshot as a data URL (KC-S2.1.6). Evidence records the path on the
   * harness host; the harness serves the file by name from the story's screenshots/.
   */
  async screenshot(runId: string, storyId: string, path: string): Promise<IpcResult<string>> {
    try {
      const { url, token } = this.requireSettings();
      const name = path.split(/[\\/]/).pop() ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new HarnessError(HARNESS_ERRORS.PROTOCOL, `Not a screenshot name: ${path}`);
      }
      const base = url.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
      const resp = await this.send(
        `${base}/runs/${encodeURIComponent(runId)}/stories/${encodeURIComponent(storyId)}/screenshots/${encodeURIComponent(name)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) throw httpError(resp.status, await resp.text());
      if (!resp.arrayBuffer) throw new HarnessError(HARNESS_ERRORS.PROTOCOL, 'Binary responses are not supported');
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > MAX_SCREENSHOT_BYTES) {
        throw new HarnessError(HARNESS_ERRORS.PROTOCOL, `Screenshot ${name} is larger than 8 MB`);
      }
      const type = resp.headers.get('content-type') || 'image/png';
      return this.success(`data:${type};base64,${bytes.toString('base64')}`);
    } catch (err) {
      return this.fail(err);
    }
  }

  // ---------------------------------------------------------------- MCP

  private async tool<T>(name: string, args: Record<string, unknown>, pick: (r: any) => T): Promise<IpcResult<T>> {
    try {
      const result = await this.callTool(name, args);
      if (result && result.ok === false) {
        throw new HarnessError(HARNESS_ERRORS.TOOL, String(result.error ?? `${name} failed`));
      }
      return this.success(pick(result));
    } catch (err) {
      return this.fail(err);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await this.ensureSession();
    let response: any;
    try {
      response = await this.rpc('tools/call', { name, arguments: args });
    } catch (err) {
      // An expired or unknown MCP session: start a new one and retry once.
      if (err instanceof HarnessError && err.code === 'SESSION_EXPIRED') {
        this.reset();
        await this.ensureSession();
        response = await this.rpc('tools/call', { name, arguments: args });
      } else {
        throw err;
      }
    }
    if (response.isError) {
      const text = response.content?.[0]?.text ?? `${name} failed`;
      throw new HarnessError(HARNESS_ERRORS.TOOL, text);
    }
    if (response.structuredContent && typeof response.structuredContent === 'object') {
      const sc = response.structuredContent;
      // Tools returning a dict are wrapped as {result: {...}} by some servers.
      return sc.result && Object.keys(sc).length === 1 ? sc.result : sc;
    }
    const text = response.content?.find((c: any) => c.type === 'text')?.text;
    if (typeof text !== 'string') throw new HarnessError(HARNESS_ERRORS.PROTOCOL, `${name} returned no content`);
    try {
      return JSON.parse(text);
    } catch {
      throw new HarnessError(HARNESS_ERRORS.PROTOCOL, `${name} returned non-JSON content`);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'kanvas', version: this.appVersion },
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  private headers(token: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.initialized) h['mcp-protocol-version'] = PROTOCOL_VERSION;
    return h;
  }

  private async notify(method: string): Promise<void> {
    const { url, token } = this.requireSettings();
    const resp = await this.send(url, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
    if (!resp.ok && resp.status !== 202) throw httpError(resp.status, await resp.text());
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const { url, token } = this.requireSettings();
    const id = this.nextId++;
    const resp = await this.send(url, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await resp.text();
    if (resp.status === 404 && this.sessionId && method !== 'initialize') {
      throw new HarnessError('SESSION_EXPIRED', 'MCP session expired');
    }
    if (!resp.ok) throw httpError(resp.status, text);
    const message = parseRpcBody(text, resp.headers.get('content-type') ?? '', id);
    if (message.error) {
      throw new HarnessError(HARNESS_ERRORS.PROTOCOL, message.error.message ?? `${method} failed`);
    }
    return message.result;
  }

  private async send(url: string, init: any) {
    if (typeof this.fetchImpl !== 'function') {
      throw new HarnessError(HARNESS_ERRORS.OFFLINE, 'No fetch available in this process');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HarnessError(HARNESS_ERRORS.OFFLINE, `KIT Harness unreachable at ${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private requireSettings(): { url: string; token: string } {
    const { url, token } = this.getSettings();
    if (!url || !token) {
      throw new HarnessError(HARNESS_ERRORS.NOT_CONFIGURED, 'Set the KIT Harness URL and token in Settings');
    }
    return { url, token };
  }

  private fail<T>(err: unknown): IpcResult<T> {
    if (err instanceof HarnessError) return this.error(err.code, err.message);
    return this.error(HARNESS_ERRORS.PROTOCOL, err instanceof Error ? err.message : String(err));
  }
}

function stripOk(result: any): any {
  if (result && typeof result === 'object') {
    const { ok: _ok, ...rest } = result;
    return rest;
  }
  return result;
}

function httpError(status: number, body: string): HarnessError {
  if (status === 401 || status === 403) {
    return new HarnessError(HARNESS_ERRORS.UNAUTHORIZED, 'KIT Harness refused the token (check Settings)');
  }
  return new HarnessError(HARNESS_ERRORS.PROTOCOL, `KIT Harness returned HTTP ${status}: ${body.slice(0, 200)}`);
}

/** A JSON-RPC response from a JSON body or an SSE stream of `data:` lines. */
export function parseRpcBody(text: string, contentType: string, id: number): any {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && msg.id === id) return msg;
      } catch {
        // not JSON: keep scanning
      }
    }
    throw new HarnessError(HARNESS_ERRORS.PROTOCOL, 'No JSON-RPC response in the event stream');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HarnessError(HARNESS_ERRORS.PROTOCOL, 'KIT Harness returned a non-JSON response');
  }
}
