/**
 * Syntax checks for a single file, shared by the kit_commit sanity gate
 * (mcp/tools.ts preCommitSanityCheck) and the AI merge-conflict resolver
 * (MergeConflictService), so a resolution is held to the same bar as a commit.
 *
 *   .py               python3 -c "import ast; ast.parse(...)"
 *   .js / .mjs / .cjs node --check
 *   .json             JSON.parse
 *   .ts / .tsx / .jsx structuralSanityCheck — NOT a real parser (no TypeScript
 *                     parser ships with the app); catches truncation, unbalanced
 *                     brackets and leftover conflict markers.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Whether the structural check below should run on a file. It is a JavaScript-shaped scanner:
 * it does not know Python's triple-quoted strings, `#` comments or JS regex literals, so on a
 * file a real parser has already accepted it only adds false refusals (2026-10-13: every
 * Python file opening with a multi-line docstring was refused as "unterminated double-quoted
 * string near line 1"). It runs where there is no real parser — TS, TSX, JSX.
 */
export function structuralCheckApplies(ext: string, parsedByRealParser: boolean): boolean {
  if (parsedByRealParser) return false;
  return ['ts', 'tsx', 'jsx'].includes(ext.toLowerCase());
}

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
export function structuralSanityCheck(content: string): string | null {
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

/** The real-parser command for a file extension, or null when there is none (TS/TSX/JSX, others). */
export function parserCommandFor(ext: string, absPath: string): { bin: string; args: string[] } | null {
  const e = ext.toLowerCase();
  if (e === 'py') {
    return { bin: 'python3', args: ['-c', `import ast,sys\nast.parse(open(sys.argv[1]).read())`, absPath] };
  }
  if (e === 'js' || e === 'mjs' || e === 'cjs') {
    return { bin: 'node', args: ['--check', absPath] };
  }
  return null;
}

/** Extensions checkContentParses has an opinion on. Anything else returns null unchecked. */
const CONTENT_CHECKABLE = new Set(['py', 'js', 'mjs', 'cjs', 'json', 'ts', 'tsx', 'jsx']);

/**
 * Whether `content`, as the file at `relPath`, still parses. Returns null when
 * it does (or the type is not checked), else a short reason. The content is
 * checked from a temporary copy, so nothing in the repository is touched.
 */
export async function checkContentParses(relPath: string, content: string): Promise<string | null> {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  if (!CONTENT_CHECKABLE.has(ext)) return null;

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return `JSON does not parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (ext === 'py' || ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'kit-parse-check-'));
    const abs = path.join(dir, `check.${ext}`);
    try {
      await fs.writeFile(abs, content, 'utf-8');
      const cmd = parserCommandFor(ext, abs)!;
      try {
        await execFileAsync(cmd.bin, cmd.args, { timeout: 10_000 });
        return null;
      } catch (err) {
        const e = err as { code?: unknown; stderr?: unknown; message?: string };
        // The parser itself is missing: say so rather than blame the file.
        if (e.code === 'ENOENT') {
          console.warn(`[file-parse-check] ${cmd.bin} not found — ${relPath} not parse-checked`);
          return null;
        }
        const detail = String(e.stderr || e.message || '').trim().split('\n').slice(-3).join(' | ');
        return `${ext === 'py' ? 'Python' : 'JavaScript'} does not parse: ${detail}`;
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const problem = structuralSanityCheck(content);
  return problem ? `structural check failed: ${problem}` : null;
}
