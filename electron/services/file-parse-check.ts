/**
 * Syntax checks for a single file, shared by the kit_commit sanity gate
 * (mcp/tools.ts preCommitSanityCheck) and the AI merge-conflict resolver
 * (MergeConflictService).
 *
 * Real parsers (parserCommandFor / checkContentParses):
 *   .py               python3 -I -c "import ast; ast.parse(...)", run from the
 *                     system temp directory, never the worktree (see parserCommandFor)
 *   .js / .mjs / .cjs node --check
 *   .json             JSON.parse (checkContentParses only)
 *
 * TS/TSX/JSX in the commit gate (checkTypeScriptLikeFile): parsed, syntax
 * only, with the app's own TypeScript compiler (a runtime dependency, shipped
 * in the packaged app). No type check. Never one from the repository being
 * committed: a sandboxed coding engine can write that worktree's node_modules,
 * and loading it would run its code in this process on the host.
 *
 * structuralSanityCheck is NOT a parser: it mis-reads regex literals, JSX text
 * apostrophes and multi-line JSX attributes. The commit gate uses it only when
 * no TypeScript can be loaded, and then refuses a file only when the scanner
 * passes on the HEAD version, so a pre-existing false positive never blocks a
 * commit. checkContentParses does not use it.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Whether the structural check below should run on a file. It is a JavaScript-shaped scanner:
 * it does not know Python's triple-quoted strings, `#` comments or JS regex literals, so on a
 * file a real parser has already accepted it only adds false refusals (2026-10-13: every
 * Python file opening with a multi-line docstring was refused as "unterminated double-quoted
 * string near line 1"). It applies where there is no parser command — TS, TSX, JSX — and there
 * the gate parses with TypeScript first (checkTypeScriptLikeFile), keeping the scanner as the
 * fallback when no TypeScript can be loaded.
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

type TypeScriptModule = typeof import('typescript');

/** The app's TypeScript compiler once resolved (null: none usable). */
let appTypeScript: TypeScriptModule | null | undefined;

/** This module's directory as the bundler or runtime gave it (electron-vite sets it from import.meta.dirname). */
const MODULE_DIRNAME: unknown = typeof __dirname === 'string' ? __dirname : undefined;

/** The directory appModuleDir reports; resetAppTypeScriptForTests can replace it. */
let moduleDirname: unknown = MODULE_DIRNAME;

/**
 * Where the app's own modules resolve from (dist/electron in the packaged app,
 * electron/services in a checkout). Null when it cannot be determined: never
 * the process's working directory, which can be a worktree whose node_modules
 * the coding engine writes. Null makes TypeScript unavailable (scanner fallback).
 */
export function appModuleDir(): string | null {
  return typeof moduleDirname === 'string' && path.isAbsolute(moduleDirname) ? moduleDirname : null;
}

/**
 * Test only: forget the loaded TypeScript, and optionally set the directory
 * appModuleDir reports (`moduleDirname`, which may be undefined to simulate a
 * runtime that gives none). Without options it restores the real directory.
 */
export function resetAppTypeScriptForTests(opts?: { moduleDirname?: unknown }): void {
  appTypeScript = undefined;
  moduleDirname = opts && 'moduleDirname' in opts ? opts.moduleDirname : MODULE_DIRNAME;
}

/** A compiler whose syntax-only parse reports diagnostics the way this gate reads them. */
function usableTypeScript(ts: any): ts is TypeScriptModule {
  if (!ts || typeof ts.createSourceFile !== 'function' || !ts.ScriptKind || !ts.ScriptTarget) return false;
  try {
    const probe: any = ts.createSourceFile('probe.ts', 'let x = ;', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    return Array.isArray(probe.parseDiagnostics) && probe.parseDiagnostics.length > 0;
  } catch {
    return false;
  }
}

/**
 * The TypeScript compiler the commit gate parses with: the app's own, resolved
 * from the app's module directory only. Never from a worktree or repository
 * being committed (their node_modules are writable by the sandboxed coding
 * engines). Null when it cannot be loaded or cannot be used.
 */
export function loadAppTypeScript(): TypeScriptModule | null {
  if (appTypeScript !== undefined) return appTypeScript;
  const dir = appModuleDir();
  if (dir === null) {
    appTypeScript = null;
    return null;
  }
  let mod: TypeScriptModule | null = null;
  try {
    const candidate = createRequire(path.join(dir, 'noop.js'))('typescript');
    if (usableTypeScript(candidate)) mod = candidate;
  } catch {
    mod = null;
  }
  appTypeScript = mod;
  return mod;
}

/** A syntax error TypeScript's parser reported: 1-based line and column. */
export interface TypeScriptSyntaxError {
  line: number;
  column: number;
  message: string;
}

/**
 * Syntax errors in `content` as the file `fileName`, from TypeScript's parser
 * alone (parseDiagnostics; no binding, no type check). Throws what the parser
 * throws: its recursive descent overflows the stack on ~1000 nested parens or
 * array literals (RangeError: Maximum call stack size exceeded).
 */
export function typeScriptSyntaxErrors(ts: TypeScriptModule, fileName: string, content: string): TypeScriptSyntaxError[] {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const kind = ext === 'tsx' ? ts.ScriptKind.TSX
    : ext === 'jsx' ? ts.ScriptKind.JSX
    : ext === 'js' || ext === 'mjs' || ext === 'cjs' ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  // tsc reads files through sys.readFile, which drops a leading BOM; do the same so '\uFEFF#!' parses.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const diags: import('typescript').Diagnostic[] = (sf as any).parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    return { line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') };
  });
}

/** A file the commit gate refuses to commit. */
export interface GateParseFailure {
  file: string;
  error: string;
  /** First line at fault, when the parser reported one. */
  line?: number;
}

/**
 * The commit gate's check for a TS/TSX/JSX file. Parses with TypeScript
 * (syntax only) and refuses on a real syntax error, and on a parse that throws
 * (an unparsed file is never let through). When no TypeScript
 * can be loaded it falls back to structuralSanityCheck, and refuses only when
 * the scanner fails on `content` but passes on the HEAD version (`readHead`
 * returns null for a file new at HEAD, which is then refused as before).
 */
export async function checkTypeScriptLikeFile(opts: {
  rel: string;
  content: string;
  readHead: () => Promise<string | null>;
  loadTypeScript?: () => TypeScriptModule | null;
}): Promise<GateParseFailure | null> {
  const { rel, content } = opts;
  const ts = (opts.loadTypeScript ?? loadAppTypeScript)();
  if (ts) {
    let errors: TypeScriptSyntaxError[];
    try {
      errors = typeScriptSyntaxErrors(ts, rel, content);
    } catch (err) {
      return { file: rel, error: `TypeScript parser failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (errors.length === 0) return null;
    const shown = errors.slice(0, 3).map((e) => `line ${e.line}, column ${e.column}: ${e.message}`);
    const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
    return { file: rel, line: errors[0].line, error: `TypeScript syntax error: ${shown.join('; ')}${more}` };
  }

  const problem = structuralSanityCheck(content);
  if (!problem) return null;
  let head: string | null = null;
  try {
    head = await opts.readHead();
  } catch {
    head = null;
  }
  if (head !== null && structuralSanityCheck(head) !== null) {
    console.warn(`[file-parse-check] ${rel}: structural check fails on HEAD too (${problem}); not refusing — no TypeScript to parse it`);
    return null;
  }
  return { file: rel, error: `structural: ${problem}` };
}

/** A parser invocation: the binary, its arguments, extra environment, and the directory to run it in. */
export interface ParserCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** Working directory; when absent the caller chooses. */
  cwd?: string;
}

/**
 * The real-parser command for a file extension, or null when there is none
 * (TS/TSX/JSX, others). JavaScript is checked with the running runtime
 * (process.execPath): a packaged Electron app has no `node` on PATH, and
 * ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as node (plain
 * node ignores it).
 *
 * Python runs isolated (-I: no current directory or script directory on
 * sys.path, no PYTHON* variables, no user site-packages) from the system temp
 * directory, with the file as an argument: run from the worktree, `import ast`
 * would load an ast.py the coding engine planted there, which runs on the host
 * and decides the verdict. The file is read as bytes so ast.parse honours its
 * encoding declaration (-I ignores PYTHONUTF8).
 */
export function parserCommandFor(ext: string, absPath: string): ParserCommand | null {
  const e = ext.toLowerCase();
  if (e === 'py') {
    return {
      bin: 'python3',
      args: ['-I', '-c', `import ast,sys\nast.parse(open(sys.argv[1], 'rb').read())`, path.resolve(absPath)],
      cwd: tmpdir(),
    };
  }
  if (e === 'js' || e === 'mjs' || e === 'cjs') {
    return { bin: process.execPath, args: ['--check', absPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return null;
}

/** Extensions checkContentParses has a real parser for. Anything else is not checked. */
const CONTENT_CHECKABLE = new Set(['py', 'js', 'mjs', 'cjs', 'json']);

/** Whether checkContentParses has a real parser for the file at `relPath`. */
export function hasContentParser(relPath: string): boolean {
  return CONTENT_CHECKABLE.has(path.extname(relPath).slice(1).toLowerCase());
}

/**
 * The outcome of a parse check: `problem` is null when the content parses;
 * `skipped` says why no check ran (no parser for the type, parser missing).
 */
export interface ParseCheck {
  problem: string | null;
  skipped?: string;
}

/**
 * Whether `content`, as the file at `relPath`, parses with a real parser. The
 * content is checked from a temporary copy, so nothing in the repository is
 * touched. A check that could not run is reported in `skipped`, never as a
 * problem.
 */
export async function checkContentParses(relPath: string, content: string): Promise<ParseCheck> {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  if (!CONTENT_CHECKABLE.has(ext)) return { problem: null, skipped: `no parser for .${ext || '(none)'} files` };

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return { problem: null };
    } catch (err) {
      return { problem: `JSON does not parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'kit-parse-check-'));
  const abs = path.join(dir, `check.${ext}`);
  try {
    await fs.writeFile(abs, content, 'utf-8');
    const cmd = parserCommandFor(ext, abs)!;
    try {
      await execFileAsync(cmd.bin, cmd.args, { cwd: cmd.cwd, timeout: 10_000, env: { ...process.env, ...cmd.env } });
      return { problem: null };
    } catch (err) {
      const e = err as { code?: unknown; stderr?: unknown; message?: string };
      // The parser itself is missing: report the skipped check rather than blame the file.
      if (e.code === 'ENOENT') {
        const skipped = `${relPath} not parse-checked: ${cmd.bin} not found`;
        console.warn(`[file-parse-check] ${skipped}`);
        return { problem: null, skipped };
      }
      const detail = String(e.stderr || e.message || '').trim().split('\n').slice(-3).join(' | ');
      return { problem: `${ext === 'py' ? 'Python' : 'JavaScript'} does not parse: ${detail}` };
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
