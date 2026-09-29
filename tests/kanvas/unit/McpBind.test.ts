/**
 * KC-S2.2.2: the MCP server stays on loopback by default; a LAN bind is opt-in
 * and requires a bearer token from every caller that is not on loopback.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveMcpBind, isMcpRequestAuthorized, isLoopbackAddress } from '../../../shared/mcp-bind';

const settings = (values: Record<string, string>) => (key: string, dflt?: unknown) => values[key] ?? dflt;

describe('McpServerService bind config (KC-S2.2.2)', () => {
  it('defaults to 127.0.0.1 with no token', () => {
    expect(resolveMcpBind(settings({}), {})).toEqual({ host: '127.0.0.1', urlHost: '127.0.0.1', lan: false, token: null });
  });

  it('a setting enables a LAN bind with a token', () => {
    const bind = resolveMcpBind(settings({ 'mcp.server.bind_host': '0.0.0.0', 'mcp.server.token': 's3cret' }), {});
    expect(bind).toEqual({ host: '0.0.0.0', urlHost: '127.0.0.1', lan: true, token: 's3cret' });
  });

  it('the environment can set it for an unattended agent, settings win', () => {
    const env = { KIT_MCP_BIND_HOST: '192.168.1.20', KIT_MCP_TOKEN: 'envtoken' };
    expect(resolveMcpBind(settings({}), env)).toMatchObject({ host: '192.168.1.20', urlHost: '192.168.1.20', lan: true, token: 'envtoken' });
    expect(resolveMcpBind(settings({ 'mcp.server.token': 'settingtoken' }), env).token).toBe('settingtoken');
  });

  it('refuses a LAN bind without a token and stays on loopback', () => {
    const bind = resolveMcpBind(settings({ 'mcp.server.bind_host': '0.0.0.0' }), {});
    expect(bind.host).toBe('127.0.0.1');
    expect(bind.lan).toBe(false);
    expect(bind.warning).toMatch(/refused/);
  });

  it('recognises loopback addresses, including IPv4-mapped ones', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['192.168.1.5', '10.0.0.2', '::ffff:10.0.0.2', '', undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe('mcp auth (KC-S2.2.2)', () => {
  const lan = { lan: true, token: 's3cret' };

  it('loopback binds never ask for a token', () => {
    expect(isMcpRequestAuthorized({ lan: false, token: null }, '10.0.0.9', undefined)).toBe(true);
  });

  it('LAN callers need the bearer token', () => {
    expect(isMcpRequestAuthorized(lan, '10.0.0.9', undefined)).toBe(false);
    expect(isMcpRequestAuthorized(lan, '10.0.0.9', 'Bearer wrong')).toBe(false);
    expect(isMcpRequestAuthorized(lan, '10.0.0.9', 'Basic s3cret')).toBe(false);
    expect(isMcpRequestAuthorized(lan, '10.0.0.9', 'Bearer s3cret')).toBe(true);
    expect(isMcpRequestAuthorized(lan, '::ffff:192.168.1.7', 'bearer s3cret')).toBe(true);
  });

  it('local agents on a LAN bind keep working without a token', () => {
    expect(isMcpRequestAuthorized(lan, '127.0.0.1', undefined)).toBe(true);
    expect(isMcpRequestAuthorized(lan, '::1', undefined)).toBe(true);
  });
});
