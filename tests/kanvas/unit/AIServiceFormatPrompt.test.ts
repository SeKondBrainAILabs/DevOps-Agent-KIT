/**
 * Unit Tests for AIService.formatPrompt
 *
 * Mode prompts now carry user text and git output (task descriptions, file
 * names, stash messages). Substitution must be a single literal pass: a value
 * that happens to contain `{branch}` or `$&` must come through unchanged.
 */

import { describe, it, expect } from '@jest/globals';
import { AIService } from '../../../electron/services/AIService';

const ai = new AIService({} as never);

describe('AIService.formatPrompt', () => {
  it('substitutes known placeholders and leaves unknown ones', () => {
    expect(ai.formatPrompt('{a} and {b}', { a: '1' })).toBe('1 and {b}');
  });

  it('does not expand placeholders inside a substituted value', () => {
    expect(ai.formatPrompt('Task: {user_message} on {branch}', { user_message: 'fix {branch} naming', branch: 'main' }))
      .toBe('Task: fix {branch} naming on main');
  });

  it('inserts replacement-pattern characters literally', () => {
    expect(ai.formatPrompt('msg: {m}', { m: 'costs $& and $1' })).toBe('msg: costs $& and $1');
  });

  it('leaves JSON braces in the template alone', () => {
    expect(ai.formatPrompt('{ "persona": "..." } {x}', { x: 'y' })).toBe('{ "persona": "..." } y');
  });
});
