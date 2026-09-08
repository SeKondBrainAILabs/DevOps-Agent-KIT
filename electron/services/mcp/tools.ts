/**
 * MCP Tool Handlers
 *
 * Registers tools via mcpServer.tool() with Zod input schemas:
 *
 * Session ops (existing):
 * - kit_commit
 * - kit_commit_all (multi-repo: commit across all repos)
 * - kit_get_session_info
 * - kit_log_activity
 * - kit_lock_file
 * - kit_unlock_file
 * - kit_get_commit_history
 * - kit_request_review
 *
 * Workspace + repo state (v2.5 additions):
 * - kit_workspace_list / kit_workspace_add / kit_workspace_scan
 * - kit_project_group_list / kit_project_group_add
 * - kit_get_repo_status (branch / ahead-behind / uncommitted / stash / worktree)
 * - kit_list_branches (with C7 hygiene metadata)
 * - kit_list_worktrees
 * - kit_get_repo_worktree_mode / kit_set_repo_worktree_mode (C5 Single-Session Mode)
 * - kit_get_active_session_count (R1 fix)
 * - kit_check_autocommit_guard (KIT rebase-race incident fix — agents check before
 *   triggering any commit-like operation to avoid orphaning real work)
 */

import { z } from 'zod';
import {
  MCP_STATE_CHANGING_TOOLS,
  MCP_TOOL_LOG_TYPE,
  MCP_OBSERVER_FORBIDDEN_TOOLS,
  actorSessionIdFor,
} from '../../../shared/mcp-types';
import { existsSync, realpathSync } from 'fs';
import { join, basename, relative, resolve as resolvePath } from 'path';
import {
  generateSessionBranchName,
  pickDefaultBaseBranch,
} from '../../../shared/branch-naming';
import { isKitWorktreePath, resolveRepoRootFromWorktree } from '../../../shared/worktree-path';
import { deriveObserverConfig } from '../../../shared/observer-session';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSessionBinder } from './session-binder';
import type { McpServiceDeps, McpCallLogEntry } from '../McpServerService';
import { evaluateAutoCommitGuardForWorktree } from '../GitRewriteGuardIO';

// Dynamic execa (ESM-only) for the worktree-divergence guards. Mirrors the
// resolution fallbacks used in AgentInstanceService for bundler compatibility.
let _execa: ((cmd: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string }>) | null = null;
async function gitInWorktree(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  if (!_execa) {
    const mod: any = await import('execa');
    _execa = typeof mod.execa === 'function' ? mod.execa
      : typeof mod.default === 'function' ? mod.default
      : mod.default?.execa;
    if (typeof _execa !== 'function') throw new Error('execa unavailable');
  }
  return _execa('git', args, { cwd, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** Shape of a worktree-divergence correction returned to the agent. */
type Divergence = {
  error: 'WRONG_WORKTREE' | 'DETACHED_HEAD' | 'WRONG_BRANCH';
  instruction: string;
  [k: string]: unknown;
};

/** Verdict from preCommitSanityCheck. block=true → return error to agent. */
type SanityGateResult = {
  block: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  /** Set when we snapshotted the worktree before refusing — so the agent's
   *  work isn't lost while they fix the issue. */
  snapshotRef?: string;
  retryGuidance?: string;
};

/** Files we know how to syntax-check quickly. Anything else is skipped. */
const PARSE_CHECKABLE = /\.(py|js|mjs|cjs|jsx|ts|tsx)$/i;
/** Single-file shrink threshold that requires force=true. */
const SHRINK_PCT_THRESHOLD = 0.5;
/** Below this line count the shrink check is skipped — tiny files routinely
 *  shrink during refactors and would create false positives. */
const SHRINK_MIN_LINES = 300;

/**
 * Cheap structural sanity check for TS/TSX/JSX (and anything else parser-check
 * can't handle). Not a real parser — catches the truncation/conflict-marker
 * class of breakage that KIT itself introduced (f7f05bb, Kanvas auto-merge
 * mangles) at ~1ms per file. Returns null when the file looks structurally
 * sound; a short error string when it's obviously broken.
 *
 * Checks:
 *   - No leftover conflict markers (<<<<<<< / ======= / >>>>>>> at line start)
 *   - Balanced brackets and parens, respecting strings and comments
 *   - No unterminated single-quoted / double-quoted / template string at EOF
 *
 * Deliberately conservative — we'd rather miss a subtle bug than false-positive
 * on legitimate code. Balanced-braces on a small file can be wrong (macros,
 * dedented strings) so keep this to modest false-positive risk.
 */
function structuralSanityCheck(content: string): string | null {
  // 1. Leftover merge-conflict markers
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('<<<<<<<') || l.startsWith('=======') && lines[i].length === 7 || l.startsWith('>>>>>>>')) {
      // Skip the '=======' one — it collides too often with divider comments.
      // Only fire on <<<<<<< / >>>>>>> which are unambiguous.
      if (l.startsWith('<<<<<<<') || l.startsWith('>>>>>>>')) {
        return `unresolved conflict marker at line ${i + 1}: ${l.slice(0, 40)}`;
      }
    }
  }

  // 2. Bracket balance + string-terminator tracking. Single-pass character
  //    machine that respects //, /* */, ' ', " ", and template literals.
  let depthBrace = 0, depthParen = 0, depthBracket = 0;
  let inLine = false; // //-comment
  let inBlock = false; // /* */
  let inSingle = false, inDouble = false, inTemplate = false;
  let templateExprDepth = 0; // ${...} inside template

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const n = content[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inSingle) { if (c === '\\') { i++; continue; } if (c === "'") inSingle = false; if (c === '\n') return `unterminated single-quoted string near line ${content.slice(0, i).split('\n').length}`; continue; }
    if (inDouble) { if (c === '\\') { i++; continue; } if (c === '"') inDouble = false; if (c === '\n') return `unterminated double-quoted string near line ${content.slice(0, i).split('\n').length}`; continue; }
    if (inTemplate) {
      if (c === '\\') { i++; continue; }
      if (c === '`' && templateExprDepth === 0) { inTemplate = false; continue; }
      if (c === '$' && n === '{') { templateExprDepth++; i++; continue; }
      if (c === '}' && templateExprDepth > 0) { templateExprDepth--; continue; }
      // Inside ${...} we still fall through so brackets in the expression
      // are balanced — but only when templateExprDepth > 0 does '}' pop the
      // expression rather than the outer stack. Skip the outer bracket
      // machine for characters inside the template body.
      continue;
    }
    // Not inside any quote / comment
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '{') depthBrace++;
    else if (c === '}') { depthBrace--; if (depthBrace < 0) return `unmatched '}' near line ${content.slice(0, i).split('\n').length}`; }
    else if (c === '(') depthParen++;
    else if (c === ')') { depthParen--; if (depthParen < 0) return `unmatched ')' near line ${content.slice(0, i).split('\n').length}`; }
    else if (c === '[') depthBracket++;
    else if (c === ']') { depthBracket--; if (depthBracket < 0) return `unmatched ']' near line ${content.slice(0, i).split('\n').length}`; }
  }

  if (inSingle) return 'unterminated single-quoted string at EOF';
  if (inDouble) return 'unterminated double-quoted string at EOF';
  if (inTemplate) return 'unterminated template literal at EOF';
  if (inBlock) return 'unterminated /* */ comment at EOF';
  if (depthBrace !== 0) return `unbalanced braces (${depthBrace > 0 ? '+' : ''}${depthBrace}) at EOF — file may be truncated`;
  if (depthParen !== 0) return `unbalanced parens (${depthParen > 0 ? '+' : ''}${depthParen}) at EOF — file may be truncated`;
  if (depthBracket !== 0) return `unbalanced brackets (${depthBracket > 0 ? '+' : ''}${depthBracket}) at EOF — file may be truncated`;
  return null;
}

/** Interface for the McpServerService to log calls */
interface McpCallLogger {
  addCallLogEntry(entry: McpCallLogEntry): void;
}

/**
 * Register all MCP tools on the server instance.
 *
 * NOTE: We cast `server` to `any` below to avoid extremely expensive
 * generic type inference when combining McpServer.tool() + Zod schemas.
 * TypeScript's type checker hangs (OOM) without this escape hatch.
 */
export function registerTools(
  server: McpServer,
  binder: McpSessionBinder,
  deps: McpServiceDeps,
  callLogger?: McpCallLogger
): void {
  // Cast to any to avoid TS compiler OOM from complex zod+MCP generic inference
  const srv: any = server;

  // ---------------------------------------------------------------------------
  // Session → AgentInstance resolution (predecessor-aware).
  //
  // After a KIT restart a session is re-created with a fresh id and the old id
  // is recorded on the new instance's `predecessorSessionIds`. Agents keep
  // calling with the id they were launched with — i.e. the OLD, now-predecessor
  // id. The MCP binder registers predecessors as aliases (v2.7.4), so tools that
  // resolve via the binder (kit_commit, kit_get_session_info's worktree/repos)
  // work with a predecessor id. But three call sites looked the instance up by
  // EXACT `sessionId` match — kit_get_session_info's extraInfo, kit_merge, and
  // kit_rebase — so for a predecessor id they silently found nothing:
  // kit_get_session_info dropped branchName/baseBranch, and kit_merge/kit_rebase
  // failed with "Could not resolve source branch or repo path" for a session
  // every other tool resolved fine. One helper so the git tools resolve a
  // session exactly like the worktree tools and can't drift again.
  const resolveInstance = (session_id: string): any => {
    const listed = deps.agentInstanceService?.listInstances();
    if (!listed?.success || !listed.data) return undefined;
    return listed.data.find((i: any) =>
      i.sessionId === session_id ||
      (Array.isArray(i.predecessorSessionIds) && i.predecessorSessionIds.includes(session_id))
    );
  };

  // Tools that change state — their calls are logged to the session activity
  // feed. Owned by shared/mcp-types.ts so the set cannot drift from the
  // registry the way MCP_TOOLS itself did (it listed 8 of 22 live tools).
  const STATE_CHANGING_TOOLS = MCP_STATE_CHANGING_TOOLS;

  // ===========================================================================
  // Pre-commit sanity gate
  //
  // Why this exists: KIT pushed a 1120-line truncation of ai_chat_service.py
  // straight to Kemory main in June 2026 because nothing along the path
  // — agent, watcher, kit_commit, merge — noticed the file went 1497 → 378.
  // Pre-commit hooks would have caught it, but worktree gitdirs don't
  // inherit the project's `.pre-commit-config.yaml` so they never ran.
  // This gate is the KIT-side defense in depth: a syntax parse on every
  // changed file + a diff-size sanity check that forces the agent to
  // confirm any 50%+ shrink on a non-trivial file. Snapshots the work
  // before refusing so retries can't lose data.
  // ===========================================================================
  async function preCommitSanityCheck(
    worktreePath: string,
    sessionId: string,
    force: boolean
  ): Promise<SanityGateResult> {
    // 1. Inventory the changed files via porcelain. `XY <path>` where the
    //    second char is the worktree-vs-index status; `??` = untracked.
    let porcelain = '';
    try {
      const r = await gitInWorktree(['status', '--porcelain', '-z'], worktreePath);
      porcelain = r.stdout;
    } catch {
      // If we can't read status, don't block — let gitService.commit surface
      // the real error rather than mask it with a sanity-gate failure.
      return { block: false };
    }

    // Porcelain -z separator: every record ends in NUL. Rename records carry
    // an extra NUL-separated old-path; we keep only the new path.
    const records = porcelain.split('\0').filter(Boolean);
    const changedPaths: { path: string; deleted: boolean; untracked: boolean }[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.length < 3) continue;
      const xy = rec.slice(0, 2);
      const rest = rec.slice(3);
      const isRename = xy[0] === 'R' || xy[0] === 'C';
      const path = isRename ? rest : rest; // -z renames put old path in next record; we skip the old
      if (isRename) i++; // consume the old-path record
      const deleted = xy.includes('D');
      const untracked = xy === '??';
      changedPaths.push({ path, deleted, untracked });
    }

    // 2. Parser gate — never bypassable. A failing parse means the file on
    //    disk is broken; force=true can't pretend otherwise.
    const parseFailures: Array<{ file: string; error: string }> = [];
    for (const { path: rel, deleted } of changedPaths) {
      if (deleted) continue;
      if (!PARSE_CHECKABLE.test(rel)) continue;
      const abs = join(worktreePath, rel);
      if (!existsSync(abs)) continue;
      const ext = rel.toLowerCase().split('.').pop() || '';
      let cmd: { bin: string; args: string[] } | null = null;
      if (ext === 'py') {
        cmd = { bin: 'python3', args: ['-c', `import ast,sys\nast.parse(open(sys.argv[1]).read())`, abs] };
      } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
        cmd = { bin: 'node', args: ['--check', abs] };
      }
      // TS/TSX/JSX have no cheap parser here (tsc is too heavy, node --check
      // rejects TS syntax). Fall through to the structural check below.
      if (cmd) {
        try {
          if (!_execa) {
            const mod: any = await import('execa');
            _execa = typeof mod.execa === 'function' ? mod.execa
              : typeof mod.default === 'function' ? mod.default
              : mod.default?.execa;
          }
          await _execa!(cmd.bin, cmd.args, { cwd: worktreePath, timeout: 5_000 });
        } catch (err: any) {
          const stderr = (err?.stderr || err?.message || '').toString();
          parseFailures.push({ file: rel, error: stderr.split('\n').slice(0, 4).join('\n') });
          continue;
        }
      }

      // Structural sanity check — runs for TS/TSX/JSX (where we have no
      // parser) AND as a second pass on JS/Py files (parsers can occasionally
      // accept legitimately-truncated files). ~1ms/file, no subprocess.
      try {
        const fs = await import('fs/promises');
        const content = await fs.readFile(abs, 'utf8');
        const problem = structuralSanityCheck(content);
        if (problem) parseFailures.push({ file: rel, error: `structural: ${problem}` });
      } catch { /* best-effort */ }
    }

    if (parseFailures.length > 0) {
      // Snapshot before refusing so the agent's work survives until they fix it.
      let snapshotRef: string | undefined;
      try {
        const snap = await deps.gitService?.createSnapshot(worktreePath, sessionId);
        if (snap?.success && snap.data) snapshotRef = snap.data.refName;
      } catch { /* best-effort */ }
      return {
        block: true,
        reason: `Parse error in ${parseFailures.length} file(s) — commit refused. Re-read the file(s), fix the syntax, then retry. force=true does NOT bypass parser errors.`,
        details: { parseFailures },
        snapshotRef,
        retryGuidance: 'Open each flagged file, locate the syntax error, fix it, then call kit_commit again (no force needed once the parse passes).',
      };
    }

    // 3. Diff-size gate — bypassable with force=true.
    if (!force) {
      const shrinkFlags: Array<{ file: string; beforeLines: number; afterLines: number; shrinkPct: number }> = [];
      for (const { path: rel, deleted, untracked } of changedPaths) {
        if (deleted || untracked) continue; // shrink is only meaningful for modifications
        const abs = join(worktreePath, rel);
        if (!existsSync(abs)) continue;
        let beforeLines = 0;
        let afterLines = 0;
        try {
          const before = await gitInWorktree(['show', `HEAD:${rel}`], worktreePath);
          beforeLines = before.stdout.split('\n').length;
        } catch {
          continue; // new file or untracked at HEAD — no shrink possible
        }
        try {
          const after = await gitInWorktree(['cat-file', '-p', `:0:${rel}`], worktreePath).catch(async () => {
            // not staged yet — read working tree
            const fs = await import('fs/promises');
            return { stdout: await fs.readFile(abs, 'utf8'), stderr: '' };
          });
          afterLines = after.stdout.split('\n').length;
        } catch {
          continue;
        }
        if (beforeLines < SHRINK_MIN_LINES) continue;
        const shrink = (beforeLines - afterLines) / beforeLines;
        if (shrink >= SHRINK_PCT_THRESHOLD) {
          shrinkFlags.push({
            file: rel,
            beforeLines,
            afterLines,
            shrinkPct: Math.round(shrink * 100),
          });
        }
      }

      if (shrinkFlags.length > 0) {
        let snapshotRef: string | undefined;
        try {
          const snap = await deps.gitService?.createSnapshot(worktreePath, sessionId);
          if (snap?.success && snap.data) snapshotRef = snap.data.refName;
        } catch { /* best-effort */ }
        const summary = shrinkFlags.map(f => `${f.file} (${f.beforeLines}→${f.afterLines} lines, -${f.shrinkPct}%)`).join('; ');
        return {
          block: true,
          reason: `Suspicious shrink in ${shrinkFlags.length} file(s): ${summary}. Re-read the file(s) to confirm the change is intentional, then retry with force=true if it is.`,
          details: { shrinkFlags },
          snapshotRef,
          retryGuidance: 'If the shrink is wrong (accidental truncation), discard the on-disk file and reapply your changes. If intentional, call kit_commit again with force=true.',
        };
      }
    }

    return { block: false };
  }

  // ===========================================================================
  // Worktree-divergence guards
  //
  // Coding agents are chaotic: they cd into sibling clones, switch branches, or
  // detach HEAD. Because the commit tools always operate in the session's
  // REGISTERED worktree (not wherever the agent happens to be), divergence
  // silently produces empty/wrong-branch/orphaned commits. These guards make
  // that impossible: mutating tools require the agent's cwd and we verify both
  // the directory and the branch, returning a correction the agent reads.
  // ===========================================================================

  /** The branch the session's worktree SHOULD be on, from the instance record. */
  function expectedBranchFor(sessionId: string): string | undefined {
    try {
      const listed = deps.agentInstanceService?.listInstances?.();
      if (!listed?.success || !listed.data) return undefined;
      const inst = listed.data.find((i: any) => i.sessionId === sessionId || i.id === sessionId);
      return inst?.config?.branchName;
    } catch { return undefined; }
  }

  /**
   * Current branch of a worktree, TRI-STATE (see GitService.getCurrentBranch):
   *   branch name → on that branch; 'HEAD' → detached; null → could not determine.
   * We must distinguish "detached" from "unknown" so a failed check never produces
   * a false detached warning/block.
   */
  async function currentBranchOf(worktreePath: string): Promise<string | null> {
    // Prefer the injected git service (mockable in tests); fall back to direct git.
    const dep = deps.gitService?.getCurrentBranchName;
    if (typeof dep === 'function') {
      try { return await dep(worktreePath); } catch { return null; }
    }
    try {
      const { stdout } = await gitInWorktree(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      return stdout.trim() || null;
    } catch { return null; }
  }

  function realpathSafe(p: string): string {
    try { return realpathSync(p); } catch { return p.replace(/\/+$/, ''); }
  }

  /**
   * Layers 1+2: verify the agent is physically in the session worktree (cwd) and
   * that the worktree is on the expected branch. Returns a correction or null.
   */
  async function checkDivergence(
    sessionId: string,
    repo: string | undefined,
    cwd: string,
    opts: { requireBranch?: boolean } = {},
  ): Promise<Divergence | null> {
    const { requireBranch = true } = opts;
    const expectedWorktree = binder.getWorktreePathForRepo(sessionId, repo);
    if (!expectedWorktree) return null; // unknown session/repo handled by the caller

    // Layer 1 — the agent's working directory must BE the worktree.
    if (realpathSafe(cwd) !== realpathSafe(expectedWorktree)) {
      return {
        error: 'WRONG_WORKTREE',
        expected_worktree: expectedWorktree,
        your_cwd: cwd,
        instruction: `You are not in this session's worktree. Any changes under "${cwd}" are NOT part of this session and will NOT be committed. Run:  cd "${expectedWorktree}"  then retry. Work ONLY inside that directory.`,
      };
    }

    if (!requireBranch) return null;

    // Layer 2 — the worktree must be on the session branch, not detached/switched.
    // Tri-state: null = couldn't determine → FAIL OPEN (never block/scare on an
    // inconclusive check); 'HEAD' = genuinely detached; else = the branch name.
    const actualBranch = await currentBranchOf(expectedWorktree);
    const expectedBranch = expectedBranchFor(sessionId);
    if (actualBranch === null) {
      return null; // can't tell — allow; the cwd check already confirmed the directory
    }
    if (actualBranch === 'HEAD') {
      return {
        error: 'DETACHED_HEAD',
        expected_branch: expectedBranch ?? null,
        instruction: `The worktree is in a DETACHED HEAD state — commits made now attach to no branch and can be lost. Run:  git checkout ${expectedBranch ?? '<session-branch>'}  before continuing.`,
      };
    }
    // Only enforce the branch name for the primary repo; secondary repos in a
    // multi-repo session may legitimately be on a differently-named branch.
    if (!repo && expectedBranch && actualBranch !== expectedBranch) {
      return {
        error: 'WRONG_BRANCH',
        expected_branch: expectedBranch,
        your_branch: actualBranch,
        instruction: `The worktree is on "${actualBranch}" but this session is "${expectedBranch}". Run:  git checkout ${expectedBranch}  before continuing so your work lands on the right branch.`,
      };
    }
    return null;
  }

  /** Build the rejection tool-response for a divergence and log it. */
  function divergenceResponse(sessionId: string, toolName: string, divergence: Divergence) {
    deps.activityService?.log(sessionId, 'warning', `MCP rejected ${toolName} — ${divergence.error}`, { source: 'mcp', toolName, ...divergence });
    deps.debugLog?.warn('McpTool', `Rejected ${toolName} — ${divergence.error}`, { sessionId, ...divergence });
    return { content: [{ type: 'text', text: JSON.stringify(divergence, null, 2) }], isError: true };
  }

  // Layer 3: proactive drift directive, throttled, appended to EVERY response so
  // the agent is nudged to correct even on read-only calls (before it tries to commit).
  const driftCache = new Map<string, { at: number; directive: string | null }>();
  const DRIFT_TTL_MS = 8000;
  async function driftDirectiveFor(sessionId: string): Promise<string | null> {
    if (!sessionId || sessionId === 'unknown') return null;
    const cached = driftCache.get(sessionId);
    if (cached && Date.now() - cached.at < DRIFT_TTL_MS) return cached.directive;
    let directive: string | null = null;
    try {
      const worktree = binder.getWorktreePathForRepo(sessionId);
      if (worktree && existsSync(worktree)) {
        const actual = await currentBranchOf(worktree);
        const expected = expectedBranchFor(sessionId);
        // Tri-state: null = couldn't determine → stay SILENT (no false alarms).
        // Only warn on a definitive detached HEAD or a definite branch mismatch.
        if (actual === 'HEAD') {
          directive = `⚠️ KIT: this session's worktree is in a DETACHED HEAD state. Run: git checkout ${expected ?? '<session-branch>'} before committing, or your work may be lost.`;
        } else if (actual !== null && expected && actual !== expected) {
          directive = `⚠️ KIT: this session's worktree is on "${actual}" but should be on "${expected}". Run: git checkout ${expected} before committing.`;
        }
      }
    } catch { /* best-effort */ }
    driftCache.set(sessionId, { at: Date.now(), directive });
    return directive;
  }

  /** Wrap a tool handler to log timing, success/failure, and surface errors to the activity feed */
  function withCallLog<T extends Record<string, any>>(
    toolName: string,
    handler: (args: T) => Promise<any>
  ): (args: T) => Promise<any> {
    return async (args: T) => {
      const start = Date.now();
      // The CALLER, which is not always `session_id`: on the close tools
      // `session_id` is the TARGET and `caller_session_id` is the actor. Using
      // the target here would flip the closed session's status to 'idle', file
      // the activity entry in its feed rather than the caller's, and drift-check
      // a worktree that may have just been removed.
      const sessionId = actorSessionIdFor(toolName, args as Record<string, unknown>);

      // Read-only enforcement for observer sessions.
      //
      // Central rather than per-tool, for the same reason STATE_CHANGING_TOOLS
      // is: a per-tool check is one `srv.tool(` block away from being forgotten
      // by the next contributor, and the failure mode of forgetting is an
      // observer committing into somebody else's worktree.
      if (
        sessionId !== 'unknown' &&
        MCP_OBSERVER_FORBIDDEN_TOOLS.has(toolName) &&
        (binder as any).isObserver?.(sessionId)
      ) {
        const bound = binder.getSession(sessionId);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({
            error: 'OBSERVER_SESSION_READ_ONLY',
            tool: toolName,
            isolation: 'observer',
            observed_path: bound?.worktreePath,
            owner_session_id: (bound as any)?.ownerSessionId ?? null,
            instruction:
              'This is an OBSERVER session. It shares another session\'s working ' +
              'directory and owns no branch, so all write operations are refused — ' +
              'a commit here would land in someone else\'s worktree. Read tools ' +
              '(kit_get_repo_status, kit_get_commit_history, kit_list_branches, ' +
              'kit_get_session_info, kit_list_sessions) work normally. To make ' +
              'changes, ask the orchestrator for a session with isolation=\'worktree\'. ' +
              'To report findings, use kit_log_activity.',
          }) }],
        };
      }

      // First MCP call from an agent flips the instance status from 'waiting'
      // (the post-create / post-restart default) to 'idle' so the
      // "Waiting for agent to connect…" banner clears. Idempotent — only
      // bumps when current status is exactly 'waiting'.
      if (sessionId !== 'unknown' && deps.agentInstanceService?.listInstances) {
        try {
          const listed = deps.agentInstanceService.listInstances();
          if (listed?.success && Array.isArray(listed.data)) {
            for (const inst of listed.data) {
              if (inst?.sessionId === sessionId && inst.status === 'waiting' && inst.id) {
                deps.agentInstanceService.updateInstanceStatus?.(inst.id, 'idle');
                break;
              }
            }
          }
        } catch {
          // Diagnostics-only flip — never block a tool call on it.
        }
      }

      // Log state-changing tool calls to the activity feed so they're visible in KIT
      if (STATE_CHANGING_TOOLS.has(toolName) && sessionId !== 'unknown') {
        // Not everything state-changing is a git operation — starting or
        // closing a session is not a commit, and filing it under 'git' makes
        // the feed read as though the repo had been touched.
        const logType = MCP_TOOL_LOG_TYPE[toolName] ?? 'git';
        deps.activityService?.log(sessionId, logType, `MCP › ${toolName}`, { source: 'mcp', toolName });
      }

      try {
        const result = await handler(args);
        callLogger?.addCallLogEntry({
          timestamp: new Date().toISOString(),
          toolName,
          sessionId,
          success: true,
          durationMs: Date.now() - start,
        });
        // Layer 3: append a proactive drift warning so the agent is nudged to
        // correct even on read-only calls. Skip when the call was itself a
        // divergence rejection (it already carries the correction).
        try {
          if (result && !result.isError && Array.isArray(result.content)) {
            const directive = await driftDirectiveFor(sessionId);
            if (directive) result.content.push({ type: 'text', text: directive });
          }
        } catch { /* non-fatal */ }
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        callLogger?.addCallLogEntry({
          timestamp: new Date().toISOString(),
          toolName,
          sessionId,
          success: false,
          durationMs: Date.now() - start,
          error: errorMsg,
        });
        deps.debugLog?.error('McpTool', `Tool call failed: ${toolName}`, { sessionId, error: errorMsg });
        // Always surface exceptions to the activity feed regardless of tool type
        if (sessionId !== 'unknown') {
          deps.activityService?.log(sessionId, 'error', `MCP error › ${toolName}: ${errorMsg}`, {
            source: 'mcp',
            toolName,
          });
        }
        throw err;
      }
    };
  }

  /** Post-commit: detect contract changes and regenerate affected contracts */
  async function triggerContractCheck(sessionId: string, worktreePath: string, commitHash: string, repoPath?: string): Promise<void> {
    if (!deps.contractDetectionService || !deps.contractGenerationService || !deps.databaseService) return;

    const metaFile = join(worktreePath, '.devops-kit', '.contract-generation-meta.json');
    if (!existsSync(metaFile)) return;

    try {
      const analysisResult = await deps.contractDetectionService.analyzeCommit(worktreePath, commitHash);
      if (!analysisResult.success || !analysisResult.data?.hasContractChanges) return;

      const { changes, breakingChanges } = analysisResult.data;
      const changedFiles: string[] = changes.map((c: { file: string }) => c.file);

      const effectiveRepoPath = repoPath || worktreePath;
      const cachedFeatures: any[] = deps.databaseService.getSetting(`discovered_features:${effectiveRepoPath}`, []) || [];
      if (!cachedFeatures.length) return;

      const affectedFeatures = cachedFeatures.filter((feature: any) => {
        const relativeFeatPath = relative(effectiveRepoPath, feature.basePath);
        return changedFiles.some((f: string) => f.startsWith(relativeFeatPath + '/'));
      });

      if (affectedFeatures.length === 0) return;

      const updatedFeatures: string[] = [];
      for (const feature of affectedFeatures) {
        try {
          const result = await deps.contractGenerationService!.generateFeatureContract(worktreePath, feature);
          if (result.success) updatedFeatures.push(feature.name);
        } catch { /* non-fatal */ }
      }

      if (updatedFeatures.length > 0 && deps.activityService) {
        const displayFiles = changedFiles.map((f: string) => basename(f));
        const filesSummary = displayFiles.length > 5
          ? `${displayFiles.slice(0, 5).join(', ')} +${displayFiles.length - 5} more`
          : displayFiles.join(', ');
        deps.activityService.log(sessionId, 'info',
          `Contracts updated for ${updatedFeatures.length} feature(s): ${updatedFeatures.join(', ')} (${changedFiles.length} files: ${filesSummary})`,
          { type: 'contract-auto-update', commitHash, updatedFeatures, filesChanged: changedFiles, breakingChanges: breakingChanges.length }
        );
      }
    } catch (err) {
      console.error('[MCP] Post-commit contract check error:', err);
    }
  }

  // --------------------------------------------------------------------------
  // kit_commit — Stage + commit + record + push (optional repo for multi-repo)
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_commit',
    'Stage all changes, commit with a message, record in KIT, and optionally push. This replaces writing .devops-commit files. In multi-repo mode, specify repo to target a specific repository.',
    {
      session_id: z.string().describe('The KIT session ID'),
      message: z.string().describe('Commit message (conventional commits format preferred)'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED. The commit is rejected if this is not the session worktree, so your work is never silently committed to the wrong place.'),
      push: z.boolean().optional().default(true).describe('Push to remote after commit. Defaults to TRUE — commits ship to origin so CI runs and other collaborators can see them. Pass push=false ONLY when you explicitly want a local-only commit (rare — mostly for WIP work you plan to squash before pushing).'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
      force: z.boolean().optional().default(false).describe('Bypass the pre-commit sanity gate (diff-size warning + parser check). Set to true ONLY after re-reading any flagged file and confirming the change is intentional. Parser errors block even with force=true — they always mean the on-disk file is broken.'),
    },
    withCallLog('kit_commit', async ({ session_id, message, cwd, push, repo, force }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      // Guard: refuse if the agent is in the wrong directory or on the wrong branch.
      const divergence = await checkDivergence(session_id, repo, cwd);
      if (divergence) return divergenceResponse(session_id, 'kit_commit', divergence);

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      // Pre-commit sanity gate — catches the f7f05bb-class truncation that
      // pushed a 378-line broken ai_chat_service.py straight to Kemory main
      // because nothing in the path noticed the file went from 1497 → 378.
      const gate = await preCommitSanityCheck(worktree, session_id, !!force);
      if (gate.block) {
        deps.activityService?.log(session_id, 'warning', `Commit blocked by sanity gate: ${gate.reason}`, { source: 'mcp', toolName: 'kit_commit' });
        return { content: [{ type: 'text', text: JSON.stringify({
          error: 'Commit refused by sanity gate',
          reason: gate.reason,
          details: gate.details,
          snapshot: gate.snapshotRef,
          retry: gate.retryGuidance,
        }) }] };
      }

      try {
        // For secondary repos, prefix message with "Upgrade From {RootRepo}"
        // so child repo history clearly traces back to the root repo session
        const primaryRepo = binder.getPrimaryRepoNameIfSecondary(session_id, repo);
        const commitMessage = primaryRepo
          ? `[Upgrade From ${primaryRepo}] ${message}`
          : message;

        // 1. Stage + commit via gitService (pass repoName for multi-repo)
        const commitResult = await deps.gitService.commit(session_id, commitMessage, repo);
        if (!commitResult.success) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: commitResult.error?.message || 'Commit failed' }) }] };
        }

        const commitData = commitResult.data;
        const hash = commitData?.hash || commitData?.commitHash || '';
        const shortHash = commitData?.shortHash || hash.substring(0, 7);
        const filesChanged = commitData?.filesChanged || 0;

        // 2. Record in database
        if (deps.databaseService) {
          try {
            deps.databaseService.recordCommit(hash, session_id, commitMessage, new Date().toISOString(), { filesChanged, repoName: repo });
            deps.databaseService.recordSessionEvent(session_id, 'commit', { hash, message: commitMessage, filesChanged, repo });
          } catch {
            // Non-fatal: database recording
          }
        }

        // 3. Link activity — update the "MCP › kit_commit" entry with commit details
        if (deps.activityService) {
          deps.activityService.log(session_id, 'git', `Committed [${shortHash}]: ${message}`, {
            commitHash: hash,
            shortHash,
            filesChanged,
            repo,
            source: 'mcp',
          });
        }

        // 4. Post-commit rebase (v2.7.5) — runs BEFORE push so the commit
        //    lands on top of the latest base. Awaited (not fire-and-forget)
        //    so failures are visible to the agent and can block the push.
        //    If the rebase fails, the branch is left at pre-rebase state
        //    and push is skipped so we don't publish a stale-base commit.
        let rebaseInfo: {
          ok: boolean;
          rewrote: boolean;
          commitsIntegrated: number;
          baseBranch?: string;
          message: string;
          conflictFiles?: string[];
        } | undefined;
        try {
          rebaseInfo = await deps.postCommitRebase?.(session_id, repo);
        } catch (err) {
          rebaseInfo = { ok: false, rewrote: false, commitsIntegrated: 0, message: err instanceof Error ? err.message : 'Rebase threw' };
        }

        // 5. Push — only when rebase either succeeded or wasn't needed.
        //    Force-with-lease if the rebase rewrote history (replayed local
        //    commits on top of new base ⇒ non-fast-forward push otherwise).
        let pushed = false;
        let pushError: string | undefined;
        const rebaseFailed = rebaseInfo && !rebaseInfo.ok;
        if (push && !rebaseFailed) {
          try {
            const pushResult = await deps.gitService.push(
              session_id,
              repo,
              rebaseInfo?.rewrote ? { forceWithLease: true } : undefined,
            );
            pushed = pushResult.success === true;
            if (!pushed) pushError = pushResult.error?.message || 'Push returned failure';
          } catch (err) {
            pushError = err instanceof Error ? err.message : 'Push threw an error';
          }
          if (!pushed && pushError) {
            deps.activityService?.log(session_id, 'warning',
              `Push failed after commit [${shortHash}]: ${pushError}`,
              { commitHash: hash, pushError, repo, source: 'mcp' }
            );
          }
        } else if (push && rebaseFailed) {
          pushError = 'Push skipped — post-commit rebase failed. Fix conflicts then run kit_rebase.';
        }

        // 6. Emit commit event so renderer CommitsTab updates in real-time.
        deps.emitCommitCompleted?.(session_id, hash, commitMessage, filesChanged);

        // 7. Post-commit contract check (fire-and-forget)
        triggerContractCheck(session_id, worktree, hash).catch(() => {});

        const result: Record<string, unknown> = {
          commitHash: hash,
          shortHash,
          message,
          filesChanged,
          pushed,
          repo: repo || undefined,
        };
        // Always tell the agent why push failed — it needs this to decide next steps
        if (pushError) result.pushError = pushError;
        // v2.7.5 — surface rebase outcome so the agent knows whether the
        // commit is on top of the latest base and can retry via kit_rebase
        // when a conflict blocked us.
        if (rebaseInfo) {
          result.rebase = {
            ok: rebaseInfo.ok,
            rewrote: rebaseInfo.rewrote,
            commitsIntegrated: rebaseInfo.commitsIntegrated,
            baseBranch: rebaseInfo.baseBranch,
            message: rebaseInfo.message,
            conflictFiles: rebaseInfo.conflictFiles,
          };
        }

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Commit failed';
        deps.activityService?.log(session_id, 'error', `Commit failed: ${errorMsg}`, { source: 'mcp' });
        return { content: [{ type: 'text', text: JSON.stringify({ error: errorMsg }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_commit_all — Commit across all repos in multi-repo session
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_commit_all',
    'Commit changes across all repositories in a multi-repo session. Each repo with changes gets a commit with the same message.',
    {
      session_id: z.string().describe('The KIT session ID'),
      message: z.string().describe('Commit message (conventional commits format preferred)'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED — must be the session\'s primary worktree, or the call is rejected.'),
      push: z.boolean().optional().default(true).describe('Push each per-repo commit to its remote. Defaults to TRUE — every repo\'s commit ships to origin so CI runs. Pass push=false only when you want a local-only multi-repo commit (rare).'),
      force: z.boolean().optional().default(false).describe('Bypass the pre-commit sanity gate (diff-size warning) for ALL repos in this multi-repo commit. Parser errors still block even with force=true.'),
    },
    withCallLog('kit_commit_all', async ({ session_id, message, cwd, push, force }) => {
      const repos = binder.getReposForSession(session_id);
      if (repos.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      // Guard: agent must be in the session's primary worktree, on the right branch.
      const divergence = await checkDivergence(session_id, undefined, cwd);
      if (divergence) return divergenceResponse(session_id, 'kit_commit_all', divergence);

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      // Sanity gate per repo. If ANY repo blocks, refuse the whole multi-repo
      // commit — a partial commit across a multi-repo session leaves the
      // ecosystem in a worse state than one with no commits at all.
      const blockedRepos: Array<{ repoName: string; reason: string; details: unknown; snapshot?: string }> = [];
      for (const r of repos) {
        const wt = binder.getWorktreePathForRepo(session_id, r.repoName);
        if (!wt) continue;
        const gate = await preCommitSanityCheck(wt, session_id, !!force);
        if (gate.block) {
          blockedRepos.push({ repoName: r.repoName, reason: gate.reason || 'sanity gate', details: gate.details, snapshot: gate.snapshotRef });
        }
      }
      if (blockedRepos.length > 0) {
        deps.activityService?.log(session_id, 'warning', `kit_commit_all blocked by sanity gate (${blockedRepos.length} repo(s))`, { source: 'mcp', toolName: 'kit_commit_all' });
        return { content: [{ type: 'text', text: JSON.stringify({
          error: 'Commit refused by sanity gate in one or more repos — no repos committed.',
          blockedRepos,
        }) }] };
      }

      const results: Array<{ repoName: string; commitHash?: string; filesChanged?: number; pushed?: boolean; error?: string }> = [];

      for (const repo of repos) {
        try {
          const repoName = repo.repoName === 'primary' ? undefined : repo.repoName;

          // For secondary repos, prefix message with "Upgrade From {RootRepo}"
          const primaryRepo = binder.getPrimaryRepoNameIfSecondary(session_id, repoName);
          const commitMessage = primaryRepo
            ? `[Upgrade From ${primaryRepo}] ${message}`
            : message;

          const commitResult = await deps.gitService.commit(session_id, commitMessage, repoName);

          if (!commitResult.success) {
            results.push({ repoName: repo.repoName, error: commitResult.error?.message || 'Commit failed' });
            continue;
          }

          const hash = commitResult.data?.hash || '';
          const filesChanged = commitResult.data?.filesChanged || 0;

          // Record in database
          if (deps.databaseService) {
            try {
              deps.databaseService.recordCommit(hash, session_id, commitMessage, new Date().toISOString(), { filesChanged, repoName: repo.repoName });
            } catch { /* non-fatal */ }
          }

          // Activity log
          if (deps.activityService) {
            deps.activityService.log(session_id, 'git', `Committed (${repo.repoName}): ${message}`, {
              commitHash: hash,
              repo: repo.repoName,
              source: 'mcp',
            });
          }

          // v2.7.5 — Post-commit rebase awaited BEFORE push (same rationale
          // as kit_commit). Failure blocks the push so no stale-base commit
          // ships to origin.
          let rebaseInfo: { ok: boolean; rewrote: boolean; commitsIntegrated: number; baseBranch?: string; message: string; conflictFiles?: string[]; } | undefined;
          try {
            rebaseInfo = await deps.postCommitRebase?.(session_id, repo.repoName);
          } catch (err) {
            rebaseInfo = { ok: false, rewrote: false, commitsIntegrated: 0, message: err instanceof Error ? err.message : 'Rebase threw' };
          }

          // Push (only after rebase succeeded or was not needed).
          let pushed = false;
          let pushError: string | undefined;
          const rebaseFailed = rebaseInfo && !rebaseInfo.ok;
          if (push && !rebaseFailed) {
            try {
              const pushResult = await deps.gitService.push(
                session_id,
                repoName,
                rebaseInfo?.rewrote ? { forceWithLease: true } : undefined,
              );
              pushed = pushResult.success === true;
              if (!pushed) pushError = pushResult.error?.message || 'Push returned failure';
            } catch (err) {
              pushError = err instanceof Error ? err.message : 'Push threw an error';
            }
            if (!pushed && pushError) {
              deps.activityService?.log(session_id, 'warning',
                `Push failed (${repo.repoName}): ${pushError}`,
                { commitHash: hash, pushError, repo: repo.repoName, source: 'mcp' }
              );
            }
          } else if (push && rebaseFailed) {
            pushError = 'Push skipped — post-commit rebase failed. Fix conflicts then run kit_rebase.';
          }

          // Post-commit contract check
          triggerContractCheck(session_id, repo.worktreePath, hash).catch(() => {});

          const repoResult: Record<string, unknown> = { repoName: repo.repoName, commitHash: hash, filesChanged, pushed };
          if (pushError) repoResult.pushError = pushError;
          if (rebaseInfo) repoResult.rebase = { ok: rebaseInfo.ok, rewrote: rebaseInfo.rewrote, commitsIntegrated: rebaseInfo.commitsIntegrated, baseBranch: rebaseInfo.baseBranch, message: rebaseInfo.message, conflictFiles: rebaseInfo.conflictFiles };
          results.push(repoResult as any);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Failed';
          deps.activityService?.log(session_id, 'error', `Commit failed (${repo.repoName}): ${errMsg}`, { source: 'mcp' });
          results.push({ repoName: repo.repoName, error: errMsg });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ commits: results }) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_get_session_info — Session config and metadata
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_get_session_info',
    'Get session configuration, metadata, and working directory for a KIT session. In multi-repo mode, returns all repos.',
    {
      session_id: z.string().describe('The KIT session ID'),
    },
    withCallLog('kit_get_session_info', async ({ session_id }) => {
      const session = binder.getSession(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      // Try to get richer info from agentInstanceService (predecessor-aware, so
      // branchName/baseBranch still resolve when called with a post-restart
      // predecessor id — the same id kit_merge/kit_rebase must resolve).
      let extraInfo: Record<string, unknown> = {};
      if (deps.agentInstanceService) {
        {
          const match = resolveInstance(session_id);
          if (match) {
            extraInfo = {
              agentType: match.config?.agentType,
              branchName: match.config?.branchName,
              baseBranch: match.config?.baseBranch,
              task: match.config?.taskDescription,
              repoPath: match.config?.repoPath,
              createdAt: match.createdAt,
            };
          }
        }
      }

      // Include repos list for multi-repo sessions
      const repos = binder.getReposForSession(session_id);
      const reposInfo = repos.length > 1 ? repos : undefined;

      const result = {
        sessionId: session_id,
        worktreePath: session.worktreePath,
        registeredAt: session.registeredAt,
        repos: reposInfo,
        ...extraInfo,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_log_activity — Log to KIT dashboard timeline
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_log_activity',
    'Log an activity entry to the KIT dashboard timeline. Use for progress updates, warnings, or error reports.',
    {
      session_id: z.string().describe('The KIT session ID'),
      type: z.enum(['info', 'warning', 'error', 'git']).describe('Log level/type'),
      message: z.string().describe('Activity message'),
      details: z.record(z.unknown()).optional().describe('Optional structured details'),
    },
    withCallLog('kit_log_activity', async ({ session_id, type, message, details }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (!deps.activityService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Activity service not available' }) }] };
      }

      deps.activityService.log(session_id, type, message, { ...details, source: 'mcp' });
      return { content: [{ type: 'text', text: JSON.stringify({ logged: true, type, message }) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_lock_file — Declare file edit intent (optional repo for multi-repo)
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_lock_file',
    'Declare intent to edit files. Returns conflicts if another session holds locks on the same files.',
    {
      session_id: z.string().describe('The KIT session ID'),
      files: z.array(z.string()).describe('File paths to lock (relative to worktree)'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED — must be the session worktree.'),
      reason: z.string().optional().describe('Reason for the lock'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_lock_file', async ({ session_id, files, cwd, reason, repo }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      // Guard (directory only — locking files from the wrong dir is the failure to catch).
      const divergence = await checkDivergence(session_id, repo, cwd, { requireBranch: false });
      if (divergence) return divergenceResponse(session_id, 'kit_lock_file', divergence);

      if (!deps.lockService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Lock service not available' }) }] };
      }

      try {
        // Locks are keyed by SOURCE REPO ROOT, not by worktree.
        //
        // This call used to pass `worktree`, while the watcher's auto-locks
        // pass the repo root — so the two wrote to different locks.json files
        // and never saw each other. Cross-session locking was a no-op as a
        // result: kit_lock_file always reported "no conflicts" regardless of
        // who actually held the file.
        const lockRoot = resolveRepoRootFromWorktree(worktree)?.root ?? worktree;

        // Check for conflicts first
        const conflictResult = await deps.lockService.checkConflicts(lockRoot, files, session_id);
        const conflicts = conflictResult.success && conflictResult.data?.length > 0
          ? conflictResult.data
          : [];

        if (conflicts.length > 0) {
          const conflictSummary = conflicts.map((c: any) =>
            `${c.file || c.filePath} (held by ${c.heldBy || c.agentType || 'unknown session'})`
          ).join(', ');
          deps.activityService?.log(session_id, 'warning',
            `File lock conflict: ${conflictSummary}`,
            { files, conflicts, source: 'mcp' }
          );
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                locked: false,
                files,
                conflicts: conflicts.map((c: any) => ({
                  file: c.file || c.filePath,
                  heldBy: c.heldBy || c.agentType || 'unknown',
                  sessionId: c.sessionId || 'unknown',
                })),
              }),
            }],
          };
        }

        // Declare locks
        await deps.lockService.declareFiles(lockRoot, session_id, files, 'edit');

        if (deps.activityService) {
          deps.activityService.log(session_id, 'info', `Locked files: ${files.join(', ')}`, {
            files,
            reason,
            repo,
            source: 'mcp',
          });
        }

        return { content: [{ type: 'text', text: JSON.stringify({ locked: true, files, conflicts: [] }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : 'Lock failed' }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_unlock_file — Release file locks
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_unlock_file',
    'Release file locks for this session. If no files specified, releases all locks.',
    {
      session_id: z.string().describe('The KIT session ID'),
      files: z.array(z.string()).optional().describe('Specific files to unlock. Omit to release all.'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_unlock_file', async ({ session_id, files, repo }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      if (!deps.lockService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Lock service not available' }) }] };
      }

      try {
        // Same repo-root normalisation as kit_lock_file — forceReleaseLock and
        // releaseFiles both key by repo, so a worktree path would target a
        // store nothing writes to.
        const worktree = binder.getWorktreePathForRepo(session_id, repo)!;
        const lockRoot = resolveRepoRootFromWorktree(worktree)?.root ?? worktree;

        if (files && files.length > 0) {
          for (const file of files) {
            await deps.lockService.forceReleaseLock(lockRoot, file);
          }
        } else {
          await deps.lockService.releaseFiles(lockRoot, session_id);
        }

        const unlockedLabel = files ? files.join(', ') : 'all files';
        deps.activityService?.log(session_id, 'git', `Unlocked: ${unlockedLabel}`, { files, source: 'mcp' });
        return { content: [{ type: 'text', text: JSON.stringify({ unlocked: true, files: files || 'all' }) }] };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unlock failed';
        deps.activityService?.log(session_id, 'error', `Unlock failed: ${errMsg}`, { source: 'mcp' });
        return { content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_get_commit_history — Recent commits for session branch
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_get_commit_history',
    'Get recent commit history for the session branch. In multi-repo mode, specify repo to get history for a specific repository.',
    {
      session_id: z.string().describe('The KIT session ID'),
      limit: z.number().optional().default(10).describe('Max number of commits to return'),
      repo: z.string().optional().describe('Target repo name (multi-repo mode). Omit for primary repo.'),
    },
    withCallLog('kit_get_commit_history', async ({ session_id, limit, repo }) => {
      const worktree = binder.getWorktreePathForRepo(session_id, repo);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or repo', session_id, repo }) }] };
      }

      if (!deps.gitService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Git service not available' }) }] };
      }

      try {
        const result = await deps.gitService.getCommitHistory(worktree, undefined, limit);
        if (!result.success) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: result.error?.message || 'Failed to get history' }) }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify({ commits: result.data || [], repo: repo || undefined }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : 'History fetch failed' }) }] };
      }
    })
  );

  // --------------------------------------------------------------------------
  // kit_request_review — Signal work ready for review
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_request_review',
    'Signal that work is ready for review, and open a pull request for it. ' +
    'Creates the PR if there is not one, updates it if there is — calling this ' +
    'repeatedly never opens a second PR. The PR body lists what is actually on ' +
    'the branch. Safe to call on a repo with no GitHub remote: the review is ' +
    'still recorded, you just get no PR link back.',
    {
      session_id: z.string().describe('The KIT session ID'),
      summary: z.string().describe('Summary of work completed and what to review'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED — must be the session worktree, on the session branch.'),
    },
    withCallLog('kit_request_review', async ({ session_id, summary, cwd }) => {
      if (!binder.getSession(session_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }

      // Guard: reviewing implies the work is on the session branch in the worktree.
      const divergence = await checkDivergence(session_id, undefined, cwd);
      if (divergence) return divergenceResponse(session_id, 'kit_request_review', divergence);

      if (deps.activityService) {
        deps.activityService.log(session_id, 'info', `Review requested: ${summary}`, {
          reviewRequested: true,
          summary,
          source: 'mcp',
        });
      }

      // KIT-PR-P4 — open or update the pull request.
      //
      // This must NEVER fail the call. The review signal is the primary effect
      // and works offline; the PR is enrichment. An agent on a local-only repo
      // must not see an error for doing exactly the right thing, so every
      // non-GitHub outcome comes back as ok:true with a status explaining why
      // there is no link.
      let pr: Record<string, unknown> | null = null;
      try {
        const instances = deps.agentInstanceService?.listInstances?.();
        const inst = instances?.success && instances.data
          ? instances.data.find(
              (i: any) =>
                i.sessionId === session_id ||
                (Array.isArray(i.predecessorSessionIds) &&
                  i.predecessorSessionIds.includes(session_id))
            )
          : undefined;

        if (!deps.githubService) {
          pr = { status: 'unavailable', message: 'GitHub integration is not configured.' };
        } else if (!inst) {
          pr = { status: 'unavailable', message: 'No KIT instance found for this session.' };
        } else {
          const result = await deps.githubService.ensurePullRequest({
            sessionId: inst.sessionId ?? session_id,
            branchName: inst.config?.branchName ?? '',
            baseBranch: inst.config?.baseBranch ?? 'development',
            taskDescription: inst.config?.taskDescription ?? summary,
            worktreePath: inst.worktreePath || inst.config?.repoPath || cwd,
          });
          pr = {
            status: result.status,
            url: result.url ?? null,
            number: result.number ?? null,
            reason: result.reason ?? null,
            message: result.message ?? null,
          };
        }
      } catch (err) {
        // Even an unexpected throw must not lose the review.
        pr = {
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (deps.activityService && pr?.url) {
        deps.activityService.log(session_id, 'info', `Pull request ready: ${pr.url}`, {
          reviewRequested: true,
          prUrl: pr.url,
          source: 'mcp',
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            review_logged: true,
            session_id,
            summary,
            pr,
          }),
        }],
      };
    })
  );

  // --------------------------------------------------------------------------
  // kit_merge — Execute a merge via the same code path as the UI merge modal.
  // Enforces the S9N-6394 CI gate for protected targets (main/master/
  // production/release). Agents must not pass force=true unless the user has
  // explicitly authorized bypassing the gate — see the MERGE POLICY block in
  // the session prompt.
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_merge',
    'Merge the session branch into a target branch (default: baseBranch). ' +
    'For protected targets (main/master/production/release) the S9N-6394 CI ' +
    'gate refuses the merge if `gh pr checks` reports non-green, if pending, ' +
    'if the source contains WIP/[Kanvas] auto-checkpoint commits, or if gh is ' +
    'not installed. Pass force=true ONLY when the user has explicitly ' +
    'authorized bypassing the gate (never on your own initiative).',
    {
      session_id: z.string().describe('The KIT session ID'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED — must be the session worktree, on the session branch.'),
      target_branch: z.string().optional().describe('Target branch to merge into. Defaults to the session\'s baseBranch.'),
      force: z.boolean().optional().default(false).describe('Bypass the S9N-6394 CI gate. ONLY set when the user has explicitly authorized skipping the CI verification. Never set on your own initiative — the gate exists because auto-sync merged a mid-write file into Core_Kora_ChromeExt/main on 2026-07-22.'),
    },
    withCallLog('kit_merge', async ({ session_id, cwd, target_branch, force }) => {
      if (!deps.mergeService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Merge service not available' }) }] };
      }
      const worktree = binder.getWorktreePathForRepo(session_id);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session or worktree not registered', session_id }) }] };
      }
      const divergence = await checkDivergence(session_id, undefined, cwd);
      if (divergence) return divergenceResponse(session_id, 'kit_merge', divergence);

      // Resolve source branch + target from the instance config.
      // Predecessor-aware (see resolveInstance) — a post-restart session id is a
      // predecessor, and an exact-match find would miss it here even though the
      // binder resolved the worktree above.
      const inst = resolveInstance(session_id);
      const sourceBranch = inst?.config?.branchName;
      const resolvedTarget = target_branch || inst?.config?.baseBranch || 'main';
      const repoPath = inst?.config?.repoPath;
      if (!sourceBranch || !repoPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not resolve source branch or repo path', session_id }) }] };
      }

      deps.activityService?.log(session_id, 'git', `MCP kit_merge: ${sourceBranch} → ${resolvedTarget}${force ? ' (CI gate override)' : ''}`, { source: 'mcp', toolName: 'kit_merge' });

      const result = await deps.mergeService.executeMerge(repoPath, sourceBranch, resolvedTarget, {
        worktreePath: worktree,
        skipCiGate: !!force,
      });

      if (!result.success || !result.data) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: result.error?.message || 'Merge failed',
          success: false,
        }) }] };
      }
      const md = result.data;
      return { content: [{ type: 'text', text: JSON.stringify({
        success: md.success,
        message: md.message,
        mergeCommitHash: md.mergeCommitHash,
        filesChanged: md.filesChanged,
        conflictingFiles: md.conflictingFiles,
        gateReason: md.gateReason,
        gateDetails: md.gateDetails,
        source: sourceBranch,
        target: resolvedTarget,
      }) }] };
    })
  );

  // --------------------------------------------------------------------------
  // kit_rebase — On-demand rebase onto baseBranch via the same AI-conflict-
  // resolution code path the post-commit rebase uses. No CI gate here — rebase
  // moves the session branch onto latest baseBranch, doesn't touch protected
  // targets.
  // --------------------------------------------------------------------------
  srv.tool(
    'kit_rebase',
    'Rebase the session branch onto the latest baseBranch. Fetches origin, ' +
    'then rebases; conflicts get resolved by the AI conflict resolver. Use ' +
    'when you want the session branch up to date with base before continuing ' +
    'work OR before opening a PR (so CI runs against the latest base).',
    {
      session_id: z.string().describe('The KIT session ID'),
      cwd: z.string().describe('Your current shell working directory (run `pwd`). REQUIRED — must be the session worktree, on the session branch.'),
      base_branch: z.string().optional().describe('Base branch to rebase onto. Defaults to the session\'s baseBranch.'),
    },
    withCallLog('kit_rebase', async ({ session_id, cwd, base_branch }) => {
      if (!deps.rebaseWatcherService) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Rebase service not available' }) }] };
      }
      const worktree = binder.getWorktreePathForRepo(session_id);
      if (!worktree) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown session', session_id }) }] };
      }
      const divergence = await checkDivergence(session_id, undefined, cwd);
      if (divergence) return divergenceResponse(session_id, 'kit_rebase', divergence);

      const inst = resolveInstance(session_id);
      const resolvedBase = base_branch || inst?.config?.baseBranch || 'main';
      const repoPath = inst?.config?.repoPath;
      if (!repoPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not resolve repo path', session_id }) }] };
      }

      deps.activityService?.log(session_id, 'git', `MCP kit_rebase: onto ${resolvedBase}`, { source: 'mcp', toolName: 'kit_rebase' });

      try {
        const result = await deps.rebaseWatcherService.performRebaseForPath(session_id, repoPath, resolvedBase);
        return { content: [{ type: 'text', text: JSON.stringify({
          success: !!result.success,
          message: result.message || '',
          incomingCommits: result.incomingCommits,
          commitsAdded: result.commitsAdded,
          baseBranch: resolvedBase,
        }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: err instanceof Error ? err.message : 'Rebase failed',
          success: false,
        }) }] };
      }
    })
  );

  // ==========================================================================
  // Session lifecycle (MCP session-lifecycle epic).
  //
  // These go through SessionOrchestrator — the same funnel IPC.INSTANCE_CREATE
  // uses — so an agent-created session is identical to one the user made in
  // the UI, watcher and all. Reimplementing the compose step here is exactly
  // how the two would drift.
  // ==========================================================================

  /**
   * Normalise a caller-supplied repo path.
   *
   * `getActiveSessionsForRepo` compares repo paths by EXACT STRING, so a
   * trailing slash or a symlinked path silently creates a second bucket — and
   * with it a way past both the per-repo cap and Single-Session Mode. Agents
   * format paths inconsistently, so this is a realistic bypass rather than a
   * theoretical one.
   */
  function normaliseRepoPath(input: string): string {
    const resolved = resolvePath(input);
    try {
      return realpathSync(resolved);
    } catch {
      // Path does not exist yet — validation downstream will reject it.
      return resolved;
    }
  }

  srv.tool(
    'kit_start_session',
    'Create a new KIT session (its own git branch + worktree, auto-commit watcher, and MCP binding) and return everything a subagent needs to start working in it. Use this to fan out work; close them again with kit_close_session or kit_close_sessions.',
    {
      repo_path: z.string().describe('Absolute path to the git repository root the new session works in.'),
      task: z.string().min(1).describe('What this session is for, in one sentence. Shown in the KIT UI and embedded in the agent prompt.'),
      session_id: z.string().optional().describe('YOUR own KIT session id. The new session is recorded as its child so you can later close everything you spawned in one kit_close_sessions call.'),
      agent_type: z.enum(['claude', 'cursor', 'codex', 'copilot', 'aider', 'cline', 'warp', 'custom']).optional().describe('Which coding agent will run in this session. Defaults to claude.'),
      isolation: z.enum(['worktree', 'observer']).optional().describe("\"worktree\" (default) gives the session its own branch and worktree directory with full read/write. \"observer\" gives it NO worktree: it borrows another session's directory (or a repo checkout) and every write tool — kit_commit, kit_merge, kit_rebase, kit_lock_file — is refused. Use observer for reviewers and analysts that must not mutate the tree; it costs no disk and no watcher."),
      observe_session_id: z.string().optional().describe("With isolation=\"observer\": the session whose worktree to borrow. Omit to observe repo_path directly."),
      branch_name: z.string().optional().describe('Branch to create. Omit and KIT derives one in the same shape the UI uses.'),
      base_branch: z.string().optional().describe('Branch to cut from and merge back into. Omit and KIT uses the repo current branch, falling back to main/master/development.'),
      auto_commit: z.boolean().optional().describe('Run the KIT file watcher and auto-commit the worktree. Default true.'),
      rebase_frequency: z.enum(['never', 'daily', 'weekly', 'on-demand']).optional().describe('How often KIT rebases this session on its base branch. Default never.'),
      system_prompt: z.string().optional().describe('Extra instructions injected into the generated agent prompt — the subagent role.'),
      include_prompt: z.boolean().optional().describe('Return the full generated agent prompt. Default true; set false to save tokens.'),
      dry_run: z.boolean().optional().describe('Resolve and return the plan (branch, base, worktree path) WITHOUT creating anything.'),
    },
    withCallLog('kit_start_session', async (args: any) => {
      const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error_code: code, message, ...extra }) }],
      });

      if (!deps.sessionOrchestrator?.startSession) return notAvailable('sessionOrchestrator');

      const repoPath = normaliseRepoPath(args.repo_path);

      if (!existsSync(repoPath)) {
        return fail('INVALID_REPO', `No such directory: ${repoPath}`, { retryable: false });
      }

      // An orchestrator running inside its own KIT worktree will naturally pass
      // its cwd here. That would nest a KIT-DevOps-<branch>/ directory inside
      // the parent's worktree, which the parent's watcher would then
      // auto-commit into the parent's branch.
      if (isKitWorktreePath(repoPath)) {
        return fail(
          'NESTED_WORKTREE_REFUSED',
          `${repoPath} is itself a KIT session worktree. Pass the SOURCE repository path instead — creating a session inside another session's worktree would nest worktrees and the parent's watcher would commit them.`,
          { retryable: false, instruction: 'Use kit_get_session_info to find the source repo path for your session.' }
        );
      }

      const agentType = args.agent_type ?? 'claude';
      const isolation = args.isolation ?? 'worktree';

      // ── Observer branch ───────────────────────────────────────────────
      // No worktree, no branch, no watcher, no agent environment. It borrows a
      // directory and every write tool refuses for it.
      if (isolation === 'observer') {
        let observedPath = repoPath;
        let ownerIsObserver = false;

        if (args.observe_session_id) {
          const owner = deps.sessionOrchestrator!
            .listSessions()
            .find((i: any) => i.sessionId === args.observe_session_id);
          if (!owner) {
            return fail('NOT_FOUND', `No session ${args.observe_session_id} to observe.`);
          }
          ownerIsObserver = owner.config?.isolation === 'observer';
          observedPath = owner.worktreePath ?? owner.config?.repoPath ?? repoPath;
        }

        const derived = deriveObserverConfig({
          observedPath,
          ownerSessionId: args.observe_session_id,
          ownerIsObserver,
        });
        if (!derived.ok) {
          return fail(derived.error!.code, derived.error!.message, {
            instruction: derived.error!.instruction,
          });
        }

        const observerConfig: any = {
          ...derived.config,
          agentType,
          taskDescription: args.task,
          baseBranch: 'main',
          useWorktree: false,
          // An observer must never auto-commit: the tree it watches is not its
          // own, and the watcher is skipped for it entirely.
          autoCommit: false,
          commitInterval: 30,
          rebaseFrequency: 'never',
          systemPrompt: args.system_prompt ?? '',
          contextPreservation: '',
          createdBy: 'mcp',
          parentSessionId: args.session_id,
        };

        if (args.dry_run) {
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: true, dry_run: true,
            plan: {
              isolation: 'observer',
              observed_path: derived.config!.observedPath,
              repo_path: derived.config!.repoPath,
              observer_of: args.observe_session_id ?? null,
            },
          }) }] };
        }

        const obs = await deps.sessionOrchestrator!.startSession(observerConfig);
        if (!obs?.success || !obs.data) {
          const e = obs?.error ?? { code: 'INTERNAL', message: 'Observer creation failed' };
          return fail(e.code, e.message, { details: (e as any).details, instruction: (e as any).instruction });
        }

        // Registered as an observer so the read-only guard is O(1) per tool
        // call, and so a destructive close of the owner can find it.
        (binder as any).registerObserverSession?.(
          obs.data.sessionId,
          derived.config!.observedPath,
          { ownerSessionId: args.observe_session_id }
        );

        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          session_id: obs.data.sessionId,
          instance_id: obs.data.id,
          isolation: 'observer',
          created_by: 'mcp',
          parent_session_id: args.session_id ?? null,
          observer_of: args.observe_session_id ?? null,
          observed_path: derived.config!.observedPath,
          repo_path: derived.config!.repoPath,
          worktree_path: null,
          created_at: obs.data.createdAt,
          watcher_started: false,
          mcp: { url: deps.mcpUrl?.() ?? null, tool_prefix: 'kit_' },
          launch: {
            cwd: derived.config!.observedPath,
            must_pass_session_id: obs.data.sessionId,
          },
          read_only: true,
          instruction:
            'This session is READ-ONLY. It borrows a directory it does not own, so ' +
            'kit_commit, kit_merge, kit_rebase and kit_lock_file will be refused. ' +
            'Do not edit files here. Report findings with kit_log_activity.',
        }) }] };
      }

      const branchName = args.branch_name ?? generateSessionBranchName(agentType);

      // Derive the base branch from the repo rather than hard-defaulting to
      // 'main'. The wizard shows the user its choice; an agent just gets it,
      // so guessing wrong silently cuts sessions off the wrong base in every
      // repo that lives on 'development'.
      let baseBranch = args.base_branch;
      if (!baseBranch) {
        let branches: string[] = [];
        let currentBranch: string | undefined;
        try {
          const listed = await deps.gitService?.listBranchesForRepo?.(repoPath);
          const data: any = listed?.data ?? listed;
          branches = data?.branches ?? data?.local ?? [];
          currentBranch = data?.currentBranch ?? data?.current;
        } catch {
          // Fall through to the heuristic default.
        }
        baseBranch = pickDefaultBaseBranch({ currentBranch, branches });
      }
      baseBranch = String(baseBranch).replace(/^origin\//, '');

      const config: any = {
        repoPath,
        agentType,
        taskDescription: args.task,
        branchName,
        baseBranch,
        useWorktree: true,
        autoCommit: args.auto_commit ?? true,
        commitInterval: 30,
        rebaseFrequency: args.rebase_frequency ?? 'never',
        systemPrompt: args.system_prompt ?? '',
        contextPreservation: '',
        createdBy: 'mcp',
        parentSessionId: args.session_id,
      };

      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: true, dry_run: true,
            plan: { repo_path: repoPath, branch: branchName, base_branch: baseBranch, agent_type: agentType, task: args.task, parent_session_id: args.session_id ?? null },
          }) }],
        };
      }

      const result = await deps.sessionOrchestrator.startSession(config);

      if (!result?.success || !result.data) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Session creation failed' };
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false, error_code: err.code, message: err.message,
            retryable: err.code === 'SESSION_LIMIT_REACHED',
            details: (err as any).details, instruction: (err as any).instruction,
          }) }],
        };
      }

      const inst = result.data;
      const mcpUrl = deps.mcpUrl?.() ?? null;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          session_id: inst.sessionId,
          instance_id: inst.id,
          status: inst.status,
          created_by: 'mcp',
          parent_session_id: args.session_id ?? null,
          repo_path: repoPath,
          worktree_path: inst.worktreePath ?? repoPath,
          branch: branchName,
          base_branch: baseBranch,
          agent_type: agentType,
          task: args.task,
          created_at: inst.createdAt,
          worktree_status: inst.worktreeStatus ?? null,
          watcher_started: true,
          mcp: { url: mcpUrl, config_path: inst.worktreePath ? join(inst.worktreePath, '.mcp.json') : null, tool_prefix: 'kit_' },
          launch: {
            cwd: inst.worktreePath ?? repoPath,
            must_pass_session_id: inst.sessionId,
            suggested_command: `cd "${inst.worktreePath ?? repoPath}" && ${agentType}`,
          },
          ...((args.include_prompt ?? true) ? { prompt: inst.prompt } : {}),
          // Non-fatal problems provisioning the worktree. These were previously
          // swallowed to console.warn where no headless caller could see them.
          warnings: inst.worktreeWarnings ?? [],
        }) }],
      };
    })
  );

  srv.tool(
    'kit_close_session',
    'Close a KIT session. SAFE by default: stops the watcher, unbinds MCP, marks the session closed, and KEEPS the worktree and branch. Deleting the worktree or branches requires explicit flags and is refused when there is uncommitted or unpushed work unless forced.',
    {
      session_id: z.string().describe('The session to close. This is the TARGET — pass your own id as caller_session_id.'),
      caller_session_id: z.string().optional().describe('YOUR session id. Used for the ownership check: you may always close yourself or a session you spawned.'),
      reason: z.string().optional().describe('Why it is being closed. Recorded on the session and shown in KIT.'),
      delete_worktree: z.boolean().optional().describe('DESTRUCTIVE. Also remove the worktree directory. Refused if it has uncommitted changes unless force_dirty is set.'),
      delete_local_branch: z.boolean().optional().describe('DESTRUCTIVE. Also delete the local branch. Refused if it has unpushed commits unless force_unpushed is set.'),
      delete_remote_branch: z.boolean().optional().describe('DESTRUCTIVE. Also delete the branch on origin. Only when the work is merged or abandoned.'),
      force_dirty: z.boolean().optional().describe('DISCARDS UNCOMMITTED WORK. Only set after the user explicitly authorised it.'),
      force_unpushed: z.boolean().optional().describe('DISCARDS COMMITS THAT EXIST NOWHERE ELSE. Only set after the user explicitly authorised it.'),
      allow_foreign: z.boolean().optional().describe("Permit closing another agent's session. Never permits closing a session a human created in the KIT UI."),
    },
    withCallLog('kit_close_session', async (args: any) => {
      if (!deps.sessionOrchestrator?.closeSession) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.closeSession(args.session_id, {
        reason: args.reason,
        deleteWorktree: args.delete_worktree,
        deleteLocalBranch: args.delete_local_branch,
        deleteRemoteBranch: args.delete_remote_branch,
        forceDirty: args.force_dirty,
        forceUnpushed: args.force_unpushed,
        allowForeign: args.allow_foreign,
        callerSessionId: args.caller_session_id,
      });

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Close failed' };
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false, error_code: err.code, message: err.message,
            retryable: false, details: err.details,
            instruction: err.instruction,
            retry_with: err.details?.retry_with,
          }) }],
        };
      }

      const d = result.data;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          session_id: d.sessionId,
          already_closed: d.alreadyClosed,
          previous_status: d.previousStatus ?? null,
          actions: {
            watcher_stopped: d.actions.watchersStopped,
            rebase_watcher_stopped: d.actions.rebaseWatcherStopped,
            mcp_unregistered: d.actions.mcpUnregistered,
            aliases_unregistered: d.actions.aliasesUnregistered,
            status_set: d.actions.statusSet ?? null,
            worktree_deleted: d.actions.worktreeDeleted,
            local_branch_deleted: d.actions.localBranchDeleted,
            remote_branch_deleted: d.actions.remoteBranchDeleted,
          },
          preserved: d.preserved ?? null,
          warnings: d.actions.errors ?? [],
        }) }],
      };
    })
  );

  // ── M5: control tools ──────────────────────────────────────────────────
  srv.tool(
    'kit_restart_session',
    'Restart a KIT session: stop it, re-create its worktree from the current base, and bring the watcher back up. The session keeps working under its ORIGINAL id as well as a new one, so a subagent already launched with the old id keeps working. Use when a session is wedged; use kit_close_session when the work is finished.',
    {
      target_session_id: z.string().describe('The session to restart. This is the TARGET — pass your own id as caller_session_id.'),
      caller_session_id: z.string().optional().describe('YOUR session id.'),
      commit_changes: z.boolean().optional().describe('Commit any uncommitted work before restarting. Default true — setting this false risks losing it.'),
    },
    withCallLog('kit_restart_session', async (args: any) => {
      if (!deps.sessionOrchestrator?.restartSession) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.restartSession(
        args.target_session_id,
        undefined,
        args.commit_changes !== false
      );

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Restart failed' };
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error_code: err.code, message: err.message, retryable: false,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        session_id: result.data?.sessionId,
        previous_session_id: args.target_session_id,
        instance_id: result.data?.id,
        worktree_path: result.data?.worktreePath ?? null,
        branch: result.data?.config?.branchName,
        note: 'The previous session id still resolves for MCP calls, so a subagent launched with it keeps working.',
      }) }] };
    })
  );

  srv.tool(
    'kit_adopt_session',
    'Bring an EXISTING branch or worktree under KIT management without creating anything. Use when work already exists — a branch a human made, or one from a session KIT has lost track of. The adopted session is recorded as human-owned: you can manage it, but you can never destructively close it.',
    {
      repo_path: z.string().describe('Absolute path to the repository.'),
      branch_name: z.string().describe('The existing branch to adopt.'),
      base_branch: z.string().optional().describe('What this branch merges back into. Defaults to development.'),
      worktree_path: z.string().optional().describe('Where the branch is checked out, if not the repo root. Adopted as-is; no worktree is created.'),
      agent_type: z.string().optional().describe('Agent working in it. Defaults to claude.'),
      task: z.string().optional().describe('What this session is for.'),
      caller_session_id: z.string().optional().describe('YOUR session id, recorded as the parent.'),
      if_exists: z.enum(['refuse', 'take_over']).optional().describe('What to do when a live session already owns the branch. Default refuse. take_over works only on agent-created sessions — never on a human\'s.'),
    },
    withCallLog('kit_adopt_session', async (args: any) => {
      if (!deps.sessionOrchestrator?.adoptSession) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.adoptSession({
        repoPath: args.repo_path,
        branchName: args.branch_name,
        baseBranch: args.base_branch,
        worktreePath: args.worktree_path,
        agentType: args.agent_type,
        task: args.task,
        callerSessionId: args.caller_session_id,
        ifExists: args.if_exists,
      });

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Adopt failed' };
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error_code: err.code, message: err.message, retryable: false,
          instruction: err.instruction,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        session_id: result.data?.sessionId,
        instance_id: result.data?.id,
        worktree_path: result.data?.worktreePath ?? null,
        branch: result.data?.config?.branchName,
        created_by: 'adopted',
        note: 'Recorded as adopted, not agent-created. You may close it safely, but never destructively — the branch belongs to a human.',
      }) }] };
    })
  );

  srv.tool(
    'kit_update_session',
    "Change a live session's settings. Turning auto_commit on or off starts or stops its file watcher, and rebase_frequency starts or stops its rebase watcher, so these take effect immediately. The branch name cannot be changed — close the session and start a new one instead.",
    {
      target_session_id: z.string().describe('The session to update. This is the TARGET — pass your own id as caller_session_id.'),
      caller_session_id: z.string().optional().describe('YOUR session id.'),
      task: z.string().optional().describe('New task description.'),
      base_branch: z.string().optional().describe('New base branch to merge back into.'),
      auto_commit: z.boolean().optional().describe('Start or stop the auto-commit file watcher.'),
      rebase_frequency: z.enum(['never', 'daily', 'weekly', 'on-demand']).optional().describe('Start, stop or re-schedule the rebase watcher.'),
      system_prompt: z.string().optional().describe('New system prompt.'),
      ttl_minutes: z.number().optional().describe('New lifetime from creation, in minutes. Also resets the expiry deadline.'),
    },
    withCallLog('kit_update_session', async (args: any) => {
      if (!deps.sessionOrchestrator?.updateSession) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.updateSession(args.target_session_id, {
        taskDescription: args.task,
        baseBranch: args.base_branch,
        autoCommit: args.auto_commit,
        rebaseFrequency: args.rebase_frequency,
        systemPrompt: args.system_prompt,
        ttlMinutes: args.ttl_minutes,
      });

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Update failed' };
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error_code: err.code, message: err.message, retryable: false,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, session_id: result.data?.sessionId, updated: result.data?.updated ?? [],
      }) }] };
    })
  );

  srv.tool(
    'kit_extend_session',
    'Push a session\'s expiry deadline out so the reaper does not clean it up while it is still working. Capped at one extension of up to 4 hours per window — if you need longer than that, the session should probably be finished and a new one started.',
    {
      target_session_id: z.string().describe('The session to extend. This is the TARGET — pass your own id as caller_session_id.'),
      caller_session_id: z.string().optional().describe('YOUR session id.'),
      minutes: z.number().describe('How much longer it needs, in minutes. Maximum 240.'),
    },
    withCallLog('kit_extend_session', async (args: any) => {
      if (!deps.sessionOrchestrator?.extendSession) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.extendSession(args.target_session_id, {
        minutes: args.minutes,
      });

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Extend failed' };
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error_code: err.code, message: err.message,
          retryable: err.code === 'EXTENSION_LIMIT_REACHED',
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        session_id: result.data?.sessionId,
        expires_at: result.data?.expiresAt,
        extensions_used: result.data?.extensionsUsed,
      }) }] };
    })
  );

  srv.tool(
    'kit_close_sessions',
    'Close many KIT sessions at once — typically everything you spawned. Same SAFE default and same per-session refusals as kit_close_session; failures are reported per session and never abort the batch. Requires a scope: session_ids, parent_session_id or repo_path.',
    {
      session_ids: z.array(z.string()).optional().describe('Explicit list of sessions to close.'),
      parent_session_id: z.string().optional().describe('Close the children of this session. Pass your own id here AND as caller_session_id to clean up everything you spawned — the selector finds them, caller_session_id is what authorises closing them. Restart-predecessor ids are matched too.'),
      include_descendants: z.boolean().optional().describe('With parent_session_id, also close grandchildren. Default true.'),
      repo_path: z.string().optional().describe('Only sessions in this repository.'),
      created_by: z.enum(['mcp', 'ui', 'adopted', 'any']).optional().describe('Only sessions created this way. Defaults to "mcp" so a bulk close can never sweep up sessions a human created.'),
      status: z.array(z.string()).optional().describe('Only sessions currently in one of these statuses, e.g. ["waiting"] to reap agents that never connected.'),
      older_than_minutes: z.number().optional().describe('Only sessions created more than N minutes ago.'),
      exclude_session_ids: z.array(z.string()).optional().describe('Never close these. Your own id is always excluded.'),
      limit: z.number().optional().describe('Cap on how many to close in one call. Default 50; extras are reported as skipped and has_more is set.'),
      dry_run: z.boolean().optional().describe('Return exactly which sessions WOULD be closed without closing anything. Do this first with a broad selector.'),
      caller_session_id: z.string().optional().describe('YOUR session id, for ownership checks and self-exclusion.'),
      reason: z.string().optional().describe('Recorded on every closed session.'),
      delete_worktree: z.boolean().optional().describe('DESTRUCTIVE, applied per session.'),
      delete_local_branch: z.boolean().optional().describe('DESTRUCTIVE, applied per session.'),
      delete_remote_branch: z.boolean().optional().describe('DESTRUCTIVE, applied per session.'),
      force_dirty: z.boolean().optional().describe('DISCARDS UNCOMMITTED WORK in every matched session.'),
      force_unpushed: z.boolean().optional().describe('DISCARDS UNPUSHED COMMITS in every matched session.'),
      allow_foreign: z.boolean().optional().describe("Permit closing other agents' sessions. Never permits closing a human's."),
    },
    withCallLog('kit_close_sessions', async (args: any) => {
      if (!deps.sessionOrchestrator?.closeSessions) return notAvailable('sessionOrchestrator');

      const result = await deps.sessionOrchestrator.closeSessions(
        {
          sessionIds: args.session_ids,
          parentSessionId: args.parent_session_id,
          includeDescendants: args.include_descendants,
          repoPath: args.repo_path,
          createdBy: args.created_by,
          status: args.status,
          olderThanMinutes: args.older_than_minutes,
          excludeSessionIds: args.exclude_session_ids,
          limit: args.limit,
          dryRun: args.dry_run,
        },
        {
          reason: args.reason,
          deleteWorktree: args.delete_worktree,
          deleteLocalBranch: args.delete_local_branch,
          deleteRemoteBranch: args.delete_remote_branch,
          forceDirty: args.force_dirty,
          forceUnpushed: args.force_unpushed,
          allowForeign: args.allow_foreign,
          callerSessionId: args.caller_session_id,
        }
      );

      if (!result?.success) {
        const err = result?.error ?? { code: 'INTERNAL', message: 'Bulk close failed' };
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error_code: err.code, message: err.message }) }] };
      }

      const d = result.data;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          dry_run: d.dryRun,
          matched: d.matched,
          has_more: d.hasMore,
          closed_count: d.closed.length,
          closed: d.closed.map((c: any) => ({ session_id: c.sessionId, branch: c.branch, worktree_deleted: c.worktreeDeleted })),
          skipped: d.skipped.map((x: any) => ({ session_id: x.sessionId, reason_code: x.reasonCode })),
          failed: d.failed.map((f: any) => ({ session_id: f.sessionId, error_code: f.errorCode, message: f.message })),
        }) }],
      };
    })
  );

  srv.tool(
    'kit_list_sessions',
    'List KIT sessions with lineage, origin and runtime state. Use it to find what you spawned, or to re-adopt after a restart.',
    {
      repo_path: z.string().optional().describe('Only sessions in this repository.'),
      parent_session_id: z.string().optional().describe('Only children of this session (restart-predecessor ids are matched too).'),
      include_descendants: z.boolean().optional().describe('With parent_session_id, include the whole subtree. Default false.'),
      created_by: z.enum(['mcp', 'ui', 'adopted', 'any']).optional().describe('Filter by who created the session. Default any.'),
      status: z.array(z.string()).optional().describe('Only these statuses.'),
      include_closed: z.boolean().optional().describe('Include closed/completed/failed sessions. Default false.'),
      limit: z.number().optional().describe('Maximum sessions returned. Default 100.'),
    },
    withCallLog('kit_list_sessions', async (args: any) => {
      if (!deps.sessionOrchestrator?.listSessions) return notAvailable('sessionOrchestrator');

      const createdBy = args.created_by ?? 'any';
      const includeClosed = args.include_closed ?? false;
      const limit = args.limit ?? 100;

      const subtree = args.parent_session_id
        ? new Set(
            args.include_descendants
              ? deps.sessionOrchestrator.descendantSessionIds(args.parent_session_id)
              : (deps.sessionOrchestrator as any).directChildSessionIds?.(args.parent_session_id) ?? []
          )
        : undefined;

      const all = deps.sessionOrchestrator.listSessions().filter((inst: any) => {
        if (!inst.sessionId) return false;
        if (subtree && !subtree.has(inst.sessionId)) return false;
        if (args.repo_path && inst.config?.repoPath !== args.repo_path) return false;
        const origin = inst.config?.createdBy ?? 'ui';
        if (createdBy !== 'any' && origin !== createdBy) return false;
        if (args.status && !args.status.includes(inst.status)) return false;
        if (!includeClosed && ['closed', 'completed', 'failed'].includes(inst.status)) return false;
        return true;
      });

      const sessions = all.slice(0, limit).map((inst: any) => ({
        session_id: inst.sessionId,
        instance_id: inst.id,
        status: inst.status,
        created_by: inst.config?.createdBy ?? 'ui',
        parent_session_id: inst.config?.parentSessionId ?? null,
        predecessor_session_ids: inst.predecessorSessionIds ?? [],
        agent_type: inst.config?.agentType,
        repo_path: inst.config?.repoPath,
        worktree_path: inst.worktreePath ?? null,
        worktree_status: inst.worktreeStatus ?? null,
        branch: inst.config?.branchName,
        base_branch: inst.config?.baseBranch,
        task: inst.config?.taskDescription,
        created_at: inst.createdAt,
        closed_at: inst.closedAt ?? null,
        close_reason: inst.closeReason ?? null,
        // The reaper's deadline. Without it an agent cannot tell whether it is
        // about to be cleaned up, so it cannot know to call kit_extend_session.
        expires_at: inst.expiresAt ?? null,
        pinned: Boolean(inst.pinned),
        // Together these expose the leak class this epic closed: a binder entry
        // with no watcher, or a watcher with no binder entry.
        mcp_registered: Boolean(binder.getSession?.(inst.sessionId)),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true, count: sessions.length, truncated: all.length > limit, sessions,
        }) }],
      };
    })
  );

  srv.tool(
    'kit_get_session_status',
    'Full state of one KIT session: config, lineage, git state and runtime health.',
    {
      session_id: z.string().describe('KIT session id. Restart-predecessor ids resolve too.'),
      include_git: z.boolean().optional().describe('Include local git state for the worktree. Default true. Local only — no network.'),
      include_remote: z.boolean().optional().describe('ALSO contact the remote to compute unpushed commits and whether the branch exists on origin. SLOW: two 15-second fetches plus an untimed ls-remote. Default false. Only worth it before a destructive close.'),
      include_children: z.boolean().optional().describe('Include the sessions spawned from this one. Default true.'),
    },
    withCallLog('kit_get_session_status', async (args: any) => {
      if (!deps.sessionOrchestrator?.listSessions) return notAvailable('sessionOrchestrator');

      const aliases = deps.sessionOrchestrator.expandSessionAliases(args.session_id);
      const inst = deps.sessionOrchestrator
        .listSessions()
        .find((i: any) => aliases.includes(i.sessionId));

      if (!inst) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error_code: 'NOT_FOUND',
          message: `No session ${args.session_id}. It may have been deleted; kit_list_sessions(include_closed=true) shows closed ones.`,
        }) }] };
      }

      const worktree = inst.worktreePath ?? inst.config?.repoPath;
      const out: any = {
        ok: true,
        session_id: inst.sessionId,
        instance_id: inst.id,
        status: inst.status,
        created_by: inst.config?.createdBy ?? 'ui',
        agent_type: inst.config?.agentType,
        task: inst.config?.taskDescription,
        repo_path: inst.config?.repoPath,
        worktree_path: inst.worktreePath ?? null,
        worktree_status: inst.worktreeStatus ?? null,
        branch: inst.config?.branchName,
        base_branch: inst.config?.baseBranch,
        created_at: inst.createdAt,
        closed_at: inst.closedAt ?? null,
        close_reason: inst.closeReason ?? null,
        // The reaper's deadline. Without it an agent cannot tell whether it is
        // about to be cleaned up, so it cannot know to call kit_extend_session.
        expires_at: inst.expiresAt ?? null,
        pinned: Boolean(inst.pinned),
        lineage: {
          parent: inst.config?.parentSessionId ?? null,
          predecessors: inst.predecessorSessionIds ?? [],
          aliases,
        },
        runtime: {
          mcp_registered: Boolean(binder.getSession?.(inst.sessionId)),
          stale_rebase: inst.staleRebase ?? null,
        },
        warnings: inst.worktreeWarnings ?? [],
      };

      if (args.include_children ?? true) {
        const childIds = (deps.sessionOrchestrator as any).directChildSessionIds?.(inst.sessionId) ?? [];
        out.lineage.children = deps.sessionOrchestrator
          .listSessions()
          .filter((i: any) => childIds.includes(i.sessionId))
          .map((i: any) => ({ session_id: i.sessionId, status: i.status, branch: i.config?.branchName }));
      }

      if ((args.include_git ?? true) && worktree && deps.gitService?.getRepoStatus) {
        try {
          const st: any = await deps.gitService.getRepoStatus(worktree);
          const data = st?.data ?? st;
          out.git = {
            current_branch: data?.branch ?? null,
            on_expected_branch: data?.branch ? data.branch === inst.config?.branchName : null,
            uncommitted: data?.uncommitted ?? null,
          };
        } catch (err) {
          out.git = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      // Off by default and gated explicitly, because this is the expensive part:
      // two 15-second fetches plus an untimed ls-remote. An orchestrator polling
      // twenty children would otherwise stall for minutes.
      if (args.include_remote && deps.sessionOrchestrator) {
        try {
          const safety: any = await (deps.agentInstanceService as any)?.getDeleteSafetyInfo?.(inst.sessionId);
          const info = safety?.data ?? {};
          out.remote = {
            unpushed_commits: info.unpushedCommitCount ?? null,
            has_remote_branch: info.hasRemoteBranch ?? null,
            uncommitted_changes: info.hasUncommittedChanges ?? null,
          };
        } catch (err) {
          out.remote = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    })
  );

  // ==========================================================================
  // v2.5 additions (merged in at v2.7.0 from origin/main track) —
  // Workspace / repo state / auto-commit guard. Read-heavy tools that let
  // agents interrogate branch / worktree / session state before deciding to
  // spawn work or run commits. All are safe defaults: when a service isn't
  // wired, the tool returns a clear "not-available" response rather than
  // throwing.
  // ==========================================================================

  const notAvailable = (service: string) => ({
    content: [{ type: 'text', text: JSON.stringify({ error: `${service} not available` }) }],
  });

  // -- Workspace ops -------------------------------------------------------

  srv.tool(
    'kit_workspace_list',
    'List all configured workspaces (root folders that Kanvas scans for repos).',
    {},
    withCallLog('kit_workspace_list', async () => {
      if (!deps.workspaceService?.list) return notAvailable('workspaceService');
      const result = deps.workspaceService.list();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  srv.tool(
    'kit_workspace_add',
    'Add a workspace folder. Kanvas will scan it for repos and start watching for new / removed repos.',
    {
      path: z.string().describe('Absolute filesystem path to a folder containing git repos'),
      name: z.string().optional().describe('Display name; defaults to folder basename'),
      scan_depth: z.number().int().min(0).max(10).optional().describe('How many dir levels deep to scan (default 2)'),
      ignore_globs: z.array(z.string()).optional().describe('Folder basenames to skip (default: node_modules, .git, .worktrees, dist, build)'),
    },
    withCallLog('kit_workspace_add', async ({ path, name, scan_depth, ignore_globs }) => {
      if (!deps.workspaceService?.add) return notAvailable('workspaceService');
      const result = deps.workspaceService.add({ path, name, scanDepth: scan_depth, ignoreGlobs: ignore_globs });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  srv.tool(
    'kit_workspace_scan',
    'Scan a workspace for git repos. Returns the DiscoveredRepo[] list.',
    { workspace_id: z.string().describe('Workspace id from kit_workspace_list') },
    withCallLog('kit_workspace_scan', async ({ workspace_id }) => {
      if (!deps.workspaceService?.scan) return notAvailable('workspaceService');
      const result = await deps.workspaceService.scan(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -- Project group ops ---------------------------------------------------

  srv.tool(
    'kit_project_group_list',
    'List cross-repo project groups (e.g. "Core Stack" = Kora + Backend + Kanvas + AI_Backend).',
    {},
    withCallLog('kit_project_group_list', async () => {
      if (!deps.projectGroupService?.list) return notAvailable('projectGroupService');
      const result = deps.projectGroupService.list();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  srv.tool(
    'kit_project_group_add',
    'Create a persistent cross-repo project group.',
    {
      name: z.string().describe('Group name (case-insensitive unique)'),
      repo_paths: z.array(z.string()).min(1).describe('Member repo paths (absolute)'),
      color: z.string().optional().describe('Optional UI accent color (hex)'),
    },
    withCallLog('kit_project_group_add', async ({ name, repo_paths, color }) => {
      if (!deps.projectGroupService?.add) return notAvailable('projectGroupService');
      const result = deps.projectGroupService.add({ name, repoPaths: repo_paths, color });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -- Git repo state (repo-path keyed, no sessionId required) ------------

  srv.tool(
    'kit_get_repo_status',
    'Compact git snapshot for any repo path: branch, upstream, ahead/behind, uncommitted (M/S/U), stash count, worktree count, last commit. Safe to call frequently — 4 parallel fault-tolerant git invocations.',
    { repo_path: z.string().describe('Absolute repo path') },
    withCallLog('kit_get_repo_status', async ({ repo_path }) => {
      if (!deps.gitService?.getRepoStatus) return notAvailable('gitService.getRepoStatus');
      const result = await deps.gitService.getRepoStatus(repo_path);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  srv.tool(
    'kit_list_branches',
    'List branches with C7 hygiene metadata (merged / stale / gone-on-remote / has-worktree / is-current). Sorted newest-commit-first.',
    { repo_path: z.string().describe('Absolute repo path') },
    withCallLog('kit_list_branches', async ({ repo_path }) => {
      if (!deps.gitService?.listBranchesForRepo) return notAvailable('gitService.listBranchesForRepo');
      const result = await deps.gitService.listBranchesForRepo(repo_path);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  srv.tool(
    'kit_list_worktrees',
    'List git worktrees for a repo (each with path, branch, head sha).',
    { repo_path: z.string().describe('Absolute repo path') },
    withCallLog('kit_list_worktrees', async ({ repo_path }) => {
      if (!deps.gitService?.listWorktrees) return notAvailable('gitService.listWorktrees');
      const result = await deps.gitService.listWorktrees(repo_path);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -- Single-Session Mode + active session count (C5 + R1) ---------------

  srv.tool(
    'kit_get_repo_worktree_mode',
    'Get the per-repo worktree mode (in-place | worktree). When "in-place", the system blocks creating a 2nd active session (Single-Session Mode / C5).',
    { repo_path: z.string().describe('Absolute repo path') },
    withCallLog('kit_get_repo_worktree_mode', async ({ repo_path }) => {
      if (!deps.configService?.getRepoWorktreeMode) return notAvailable('configService');
      const mode = deps.configService.getRepoWorktreeMode(repo_path);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: mode }) }] };
    })
  );

  srv.tool(
    'kit_set_repo_worktree_mode',
    'Set the per-repo worktree mode. Use "in-place" to enable Single-Session Mode (blocks multiple concurrent sessions on this repo).',
    {
      repo_path: z.string().describe('Absolute repo path'),
      mode: z.enum(['in-place', 'worktree']).describe('worktree = default; in-place = Single-Session Mode'),
      // Present ONLY so the central observer guard in withCallLog can identify
      // the caller. Without it this tool resolves to 'unknown' and a throwaway
      // read-only inspector could flip a repo-wide policy for everybody.
      session_id: z.string().optional().describe('YOUR session id. Observer sessions may not change repo policy.'),
    },
    withCallLog('kit_set_repo_worktree_mode', async ({ repo_path, mode }) => {
      if (!deps.configService?.setRepoWorktreeMode) return notAvailable('configService');
      deps.configService.setRepoWorktreeMode(repo_path, mode);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, mode, repoPath: repo_path }) }] };
    })
  );

  srv.tool(
    'kit_get_active_session_count',
    'Get the count of ACTIVE agent sessions for a repo (excludes completed / closed / failed). Powers the "should I spawn another session" decision + Single-Session Mode guard.',
    { repo_path: z.string().describe('Absolute repo path') },
    withCallLog('kit_get_active_session_count', async ({ repo_path }) => {
      if (!deps.agentInstanceService?.getActiveSessionCountForRepo) {
        return notAvailable('agentInstanceService.getActiveSessionCountForRepo');
      }
      const result = deps.agentInstanceService.getActiveSessionCountForRepo(repo_path);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -- Auto-commit safety guard (KIT rebase-race fix) ---------------------

  srv.tool(
    'kit_check_autocommit_guard',
    'Check whether auto-commit is currently SAFE on a worktree. Returns allowed=true only when NO rebase/merge/cherry-pick/bisect is in progress, HEAD is not detached, and no history-rewrite lockfile is held. Agents SHOULD call this before triggering any commit path to avoid the KIT rebase-race that silently orphaned ~15 real commits in the July 22 incident.',
    { worktree_path: z.string().describe('Absolute worktree path (usually your session cwd)') },
    withCallLog('kit_check_autocommit_guard', async ({ worktree_path }) => {
      const guard = evaluateAutoCommitGuardForWorktree(worktree_path);
      return { content: [{ type: 'text', text: JSON.stringify(guard) }] };
    })
  );
}
