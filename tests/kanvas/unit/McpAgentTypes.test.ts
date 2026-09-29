/**
 * KC-S2.2.1: kit_start_session accepts the engines KIT Harness drives, `opencode`
 * and `pi`, alongside the existing agent types.
 *
 * The zod stub here RECORDS every z.enum() list, so the test sees the exact
 * values the kit_start_session schema was built from.
 */

import { jest, describe, it, expect } from '@jest/globals';

const enums: unknown[][] = [];
function zodChain(): any {
  const target: any = () => zodChain();
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'enum') return (values: unknown[]) => { enums.push([...values]); return zodChain(); };
      return (..._a: any[]) => zodChain();
    },
    apply: () => zodChain(),
  });
}
jest.mock('zod', () => ({ z: zodChain() }));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({}));
jest.mock('../../../electron/services/McpServerService', () => ({}));

import { AGENT_TYPES } from '../../../shared/types';
import { SESSION_BRANCH_AGENTS } from '../../../shared/branch-naming';
import { getAgentInstructions, getAgentTypeDescription, getAgentLaunchMethod } from '../../../shared/agent-instructions';

const { registerTools } = require('../../../electron/services/mcp/tools');
const { McpSessionBinder } = require('../../../electron/services/mcp/session-binder');

const schemas = new Map<string, any>();
registerTools(
  { tool: (name: string, _d: string, schema: any) => schemas.set(name, schema), resource: () => undefined } as any,
  new McpSessionBinder(),
  {} as any,
);

describe('mcp tools agent types (KC-S2.2.1)', () => {
  it('kit_start_session is registered and its agent_type enum includes opencode and pi', () => {
    expect(schemas.has('kit_start_session')).toBe(true);
    const agentTypeEnum = enums.find(values => values.includes('claude') && values.includes('custom'));
    expect(agentTypeEnum).toBeDefined();
    expect(agentTypeEnum).toEqual(expect.arrayContaining(['opencode', 'pi']));
    expect(agentTypeEnum).toEqual([...AGENT_TYPES]);
  });

  it('opencode and pi session branches are recognised as KIT session branches', () => {
    expect(SESSION_BRANCH_AGENTS).toEqual(expect.arrayContaining(['opencode', 'pi']));
  });

  it('instructions, descriptions and launch methods exist for both', () => {
    const vars = {
      repoPath: '/repo', repoName: 'repo', branchName: 'opencode-session-20260929-ab12', sessionId: 'sess_1234abcd',
      taskDescription: 'Add a greeting', systemPrompt: '', contextPreservation: '', rebaseFrequency: 'never',
      mcpUrl: 'http://127.0.0.1:39100/mcp',
    };
    const opencode = getAgentInstructions('opencode', vars as any);
    expect(opencode).toContain('"type": "remote"');
    expect(opencode).toContain('http://127.0.0.1:39100/mcp');
    expect(opencode).toContain('sess_1234abcd');
    const pi = getAgentInstructions('pi', vars as any);
    expect(pi).toContain('no MCP client');
    expect(pi).toContain('sess_1234abcd');
    expect(pi).not.toContain('"mcp"');
    expect(getAgentTypeDescription('opencode')).toMatch(/OpenCode/);
    expect(getAgentTypeDescription('pi')).toMatch(/Pi/);
    expect(getAgentLaunchMethod('opencode')).toBe('cli');
    expect(getAgentLaunchMethod('pi')).toBe('cli');
  });
});
