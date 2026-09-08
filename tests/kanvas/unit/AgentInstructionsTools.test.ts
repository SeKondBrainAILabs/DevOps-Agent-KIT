/**
 * The agent prompt must only name tools that exist — and must name the ones
 * that matter.
 *
 * `shared/agent-instructions.ts` is the text KIT copies to the coding agent. It
 * is the ONLY thing that tells an agent which MCP tools it has; an agent does
 * not go and read the registry. So the prompt drifting from the registry has
 * two distinct failure modes, and this suite pins both:
 *
 *   - Naming a tool that does not exist. The agent calls it, gets a protocol
 *     error, and has no way to tell whether it did the wrong thing or KIT is
 *     broken. Three such names shipped for a long time.
 *   - Omitting a tool that does exist. The capability is simply invisible; the
 *     agent works around it or does without.
 *
 * The registry test (McpToolRegistry.test.ts) keeps `MCP_TOOLS` honest about
 * what is REGISTERED. This keeps the prompt honest about what is DOCUMENTED.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MCP_TOOLS, MCP_SESSION_TOOLS } from '../../../shared/mcp-types';

const source = readFileSync(
  join(__dirname, '../../../shared/agent-instructions.ts'),
  'utf-8'
);

const mentioned = new Set(
  [...source.matchAll(/kit_[a-z_]+/g)].map((m) => m[0])
);

const REAL = new Set<string>([
  ...Object.values(MCP_TOOLS),
  ...Object.values(MCP_SESSION_TOOLS),
]);

describe('agent prompt tool references', () => {
  it('never names a tool that does not exist', () => {
    // `kit_get_session`, `kit_log_commit` and `kit_update_status` were named
    // here for a long time and were never registered. An agent following the
    // prompt got a protocol error.
    const phantom = [...mentioned].filter((name) => !REAL.has(name)).sort();
    expect(phantom).toEqual([]);
  });

  it('documents every session lifecycle tool', () => {
    // These are the epic's whole surface. An agent that cannot see them cannot
    // spawn a subagent or clean up after itself, which is the point of them.
    const undocumented = Object.values(MCP_SESSION_TOOLS)
      .filter((name) => !mentioned.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('documents the core git tools an agent needs to do its job', () => {
    const core = [
      MCP_TOOLS.COMMIT,
      MCP_TOOLS.COMMIT_ALL,
      MCP_TOOLS.LOCK_FILE,
      MCP_TOOLS.UNLOCK_FILE,
      MCP_TOOLS.REQUEST_REVIEW,
      MCP_TOOLS.MERGE,
      MCP_TOOLS.REBASE,
    ];
    expect(core.filter((name) => !mentioned.has(name))).toEqual([]);
  });
});
