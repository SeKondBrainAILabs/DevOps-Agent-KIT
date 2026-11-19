/**
 * The commit gate parses TS/TSX/JSX that a sandboxed coding engine wrote. TypeScript's parser ran
 * in the DevOps Agent's own process, synchronously and without a time or memory bound, while the
 * Python and JavaScript parsers run as subprocesses killed after 5 s.
 *
 * TypeScript's speculative arrow-function parse is exponential on `async (` repeated: 24
 * repetitions (168 bytes) take ~10 s, 40 would take days. A file like that froze the app's main
 * process (UI, MCP server, every session) inside kit_commit. A ~40 MB file of trivial statements
 * builds an AST past the V8 heap limit and kills the process.
 *
 * The parse now runs in a child process (the app's own runtime as node, the app's own
 * TypeScript) with a wall-clock timeout and a heap cap; a parse that does not finish refuses the
 * file.
 */

import { describe, it, expect } from '@jest/globals';
import {
  checkTypeScriptLikeFile,
  TS_PARSE_TIMEOUT_MS,
} from '../../../electron/services/file-parse-check';

const noHead = async () => null;

describe('the commit gate bounds the TypeScript parse', () => {
  it('refuses a tiny file the parser would spend minutes on, within the timeout', async () => {
    // ~40 s in-process before the fix; doubling with each extra repetition.
    const content = 'async ('.repeat(26);
    const started = Date.now();
    const failure = await checkTypeScriptLikeFile({ rel: 'src/slow.ts', content, readHead: noHead });
    const elapsed = Date.now() - started;
    expect(failure).toEqual({ file: 'src/slow.ts', error: expect.stringMatching(/^TypeScript parser failed: timed out after \d+ s/) });
    expect(elapsed).toBeLessThan(TS_PARSE_TIMEOUT_MS + 3_000);
  }, 120_000);

  it('refuses a file whose syntax tree exceeds the heap cap, instead of crashing the process', async () => {
    const content = 'a;\n'.repeat(20_000_000); // 60 MB, ~5 GB of AST
    const failure = await checkTypeScriptLikeFile({ rel: 'src/huge.ts', content, readHead: noHead });
    expect(failure).toEqual({ file: 'src/huge.ts', error: expect.stringMatching(/^TypeScript parser failed: /) });
  }, 120_000);

  it('still reports ordinary syntax errors with line and column', async () => {
    const failure = await checkTypeScriptLikeFile({ rel: 'src/f.ts', content: 'let ok = 1;\nlet x = ;\n', readHead: noHead });
    expect(failure).toEqual({ file: 'src/f.ts', line: 2, error: 'TypeScript syntax error: line 2, column 9: Expression expected.' });
  });
});
