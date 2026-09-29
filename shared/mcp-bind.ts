/**
 * Where the DevOps Agent's MCP server listens, and whether callers need a token
 * (KC-S2.2.2).
 *
 * The default stays 127.0.0.1: only agents on this machine can reach the server,
 * and none of them needs a token. A LAN bind (for a harness or a runner on another
 * machine) is opt-in through the `mcp.server.bind_host` setting or the
 * `KIT_MCP_BIND_HOST` environment variable, and it requires a bearer token
 * (`mcp.server.token` / `KIT_MCP_TOKEN`). Without a token a LAN bind is refused
 * and the server stays on loopback: exposing unauthenticated kit_* tools to the
 * network would let anyone on it commit, merge and delete branches.
 *
 * On a LAN bind the token is checked for every caller that is not itself on
 * loopback, so agents on this machine keep working with their existing config.
 */

import { timingSafeEqual } from 'crypto';

export const MCP_BIND_SETTING_KEYS = {
  host: 'mcp.server.bind_host',
  token: 'mcp.server.token',
} as const;

export const MCP_BIND_ENV = { host: 'KIT_MCP_BIND_HOST', token: 'KIT_MCP_TOKEN' } as const;

export const LOOPBACK_HOST = '127.0.0.1';

export interface McpBindConfig {
  /** Address passed to listen(). */
  host: string;
  /** Host local agents should use in their MCP URL. */
  urlHost: string;
  /** True when the server listens beyond loopback. */
  lan: boolean;
  /** Bearer token LAN callers must present; null on a loopback bind. */
  token: string | null;
  /** Set when a requested LAN bind was refused (no token). */
  warning?: string;
}

type SettingReader = (key: string, defaultValue?: unknown) => unknown;

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  return a === 'localhost' || a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMcpBind(
  getSetting: SettingReader | undefined,
  env: Record<string, string | undefined> = {},
): McpBindConfig {
  const host = text(getSetting?.(MCP_BIND_SETTING_KEYS.host, '')) || text(env[MCP_BIND_ENV.host]) || LOOPBACK_HOST;
  const token = text(getSetting?.(MCP_BIND_SETTING_KEYS.token, '')) || text(env[MCP_BIND_ENV.token]);
  if (isLoopbackAddress(host)) {
    return { host, urlHost: host === 'localhost' ? LOOPBACK_HOST : host, lan: false, token: null };
  }
  if (!token) {
    return {
      host: LOOPBACK_HOST,
      urlHost: LOOPBACK_HOST,
      lan: false,
      token: null,
      warning: `LAN bind to ${host} refused: set ${MCP_BIND_SETTING_KEYS.token} (or ${MCP_BIND_ENV.token}) first`,
    };
  }
  const wildcard = host === '0.0.0.0' || host === '::';
  return { host, urlHost: wildcard ? LOOPBACK_HOST : host, lan: true, token };
}

/**
 * Whether a request may proceed. Loopback binds and loopback callers always
 * may; anyone else on a LAN bind must send `Authorization: Bearer <token>`.
 */
export function isMcpRequestAuthorized(
  config: Pick<McpBindConfig, 'lan' | 'token'>,
  remoteAddress: string | undefined | null,
  authorization: string | string[] | undefined,
): boolean {
  if (!config.lan || !config.token) return true;
  if (isLoopbackAddress(remoteAddress)) return true;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(config.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
