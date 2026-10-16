/**
 * The pre-commit sanity gate's structural check is a JavaScript-shaped scanner. It refused every
 * Python file that opens with a multi-line docstring ("unterminated double-quoted string near
 * line 1"), and Python files with an apostrophe in a comment, although Python's own parser
 * accepted them (KIT Harness run 20261013T051955-efc168, 2026-10-13).
 */
import { describe, it, expect } from '@jest/globals';
import { structuralCheckApplies, structuralSanityCheck } from '../../../electron/services/mcp/tools';

const PYTHON = `"""Engine smoke run: one headless Coder session makes a three-file change
on a toy repository, and the result is recorded.
"""

# don't count retries twice
def run(x):
    return {"a": [x]}
`;

describe('sanity gate structural check', () => {
  it('would misread valid Python, which is why it must not run on it', () => {
    expect(structuralSanityCheck(PYTHON)).not.toBeNull();
  });

  it('does not run on Python or JavaScript a real parser accepted', () => {
    expect(structuralCheckApplies('py', true)).toBe(false);
    expect(structuralCheckApplies('js', true)).toBe(false);
    expect(structuralCheckApplies('mjs', true)).toBe(false);
  });

  it('still runs on TypeScript, TSX and JSX, which have no parser here', () => {
    expect(structuralCheckApplies('ts', false)).toBe(true);
    expect(structuralCheckApplies('TSX', false)).toBe(true);
    expect(structuralCheckApplies('jsx', false)).toBe(true);
  });

  it('reads an apostrophe in JSX text as text, not as a string', () => {
    const tsx = `export function Help() {
  return (
    <span>
      allow_foreign. It still can't discard uncommitted or unpushed work
      unless it forces that explicitly.
    </span>
  );
}
`;
    expect(structuralSanityCheck(tsx)).toBeNull();
  });

  it('still catches a quote that really opens a string and never closes', () => {
    expect(structuralSanityCheck("const a = 'never closed;\nconst b = 1;\n")).toMatch(/unterminated single-quoted/);
    expect(structuralSanityCheck('const a = f("x", 2;\n')).toMatch(/unbalanced/);
  });

  it('still catches a truncated TypeScript file', () => {
    expect(structuralSanityCheck('export function f() {\n  const s = "unterminated\n')).toMatch(/unterminated/);
    expect(structuralSanityCheck('export function f() {\n  return [1, 2];\n}\n')).toBeNull();
  });
});
