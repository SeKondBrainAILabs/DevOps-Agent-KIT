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
import { existsSync, realpathSync } from 'fs';
import { join, basename, relative } from 'path';
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

  // Tools that change state — their calls are logged to the session activity feed
  const STATE_CHANGING_TOOLS = new Set([
    'kit_commit', 'kit_commit_all', 'kit_lock_file', 'kit_unlock_file', 'kit_request_review',
    'kit_workspace_add', 'kit_workspace_scan', 'kit_project_group_add',
    'kit_set_repo_worktree_mode',
  ]);

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
      const sessionId = (args as any).session_id || 'unknown';

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
        deps.activityService?.log(sessionId, 'git', `MCP › ${toolName}`, { source: 'mcp', toolName });
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
      push: z.boolean().optional().default(false).describe('Push to remote after commit'),
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

        // 4. Optional push — capture failure reason so agent knows exactly what went wrong
        let pushed = false;
        let pushError: string | undefined;
        if (push) {
          try {
            const pushResult = await deps.gitService.push(session_id, repo);
            pushed = pushResult.success === true;
            if (!pushed) {
              pushError = pushResult.error?.message || 'Push returned failure';
            }
          } catch (err) {
            pushError = err instanceof Error ? err.message : 'Push threw an error';
          }
          if (!pushed && pushError) {
            deps.activityService?.log(session_id, 'warning',
              `Push failed after commit [${shortHash}]: ${pushError}`,
              { commitHash: hash, pushError, repo, source: 'mcp' }
            );
          }
        }

        // 5. Emit commit event so renderer CommitsTab updates in real-time
        deps.emitCommitCompleted?.(session_id, hash, commitMessage, filesChanged);

        // 6. On-demand post-commit rebase (fire-and-forget). Wired from
        // services/index.ts to WatcherService.attemptPostCommitRebase — same
        // logic the .commit-msg-file path fires. Before v2.6.92 this was
        // silently skipped for MCP commits so agent-driven sessions never got
        // the "on-demand" rebase they were configured for.
        deps.postCommitRebase?.(session_id, repo).catch(() => { /* non-fatal */ });

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
      push: z.boolean().optional().default(false).describe('Push to remote after each commit'),
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

          // Optional push — capture failure reason
          let pushed = false;
          let pushError: string | undefined;
          if (push) {
            try {
              const pushResult = await deps.gitService.push(session_id, repoName);
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
          }

          // On-demand post-commit rebase (fire-and-forget) — see kit_commit.
          deps.postCommitRebase?.(session_id, repo.repoName).catch(() => { /* non-fatal */ });

          // Post-commit contract check
          triggerContractCheck(session_id, repo.worktreePath, hash).catch(() => {});

          const repoResult: Record<string, unknown> = { repoName: repo.repoName, commitHash: hash, filesChanged, pushed };
          if (pushError) repoResult.pushError = pushError;
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

      // Try to get richer info from agentInstanceService
      let extraInfo: Record<string, unknown> = {};
      if (deps.agentInstanceService) {
        const instances = deps.agentInstanceService.listInstances();
        if (instances.success && instances.data) {
          const match = instances.data.find((i: any) => i.sessionId === session_id);
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
        // Check for conflicts first
        const conflictResult = await deps.lockService.checkConflicts(worktree, files, session_id);
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
        await deps.lockService.declareFiles(session_id, files, 'edit');

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
        if (files && files.length > 0) {
          // Release specific files by force-releasing each
          const worktree = binder.getWorktreePathForRepo(session_id, repo)!;
          for (const file of files) {
            await deps.lockService.forceReleaseLock(worktree, file);
          }
        } else {
          // Release all locks for this session
          await deps.lockService.releaseFiles(session_id);
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
    'Signal that work is ready for review. Logs activity and emits event to KIT dashboard.',
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ logged: true, summary, sessionId: session_id }),
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
      const instances = deps.agentInstanceService?.listInstances();
      const inst = instances?.success && instances.data ? instances.data.find((i: any) => i.sessionId === session_id) : undefined;
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

      const instances = deps.agentInstanceService?.listInstances();
      const inst = instances?.success && instances.data ? instances.data.find((i: any) => i.sessionId === session_id) : undefined;
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
