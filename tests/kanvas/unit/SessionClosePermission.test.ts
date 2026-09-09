/**
 * Unit Tests for shared/session-close-permission.ts (story KIT-MCP-M2)
 *
 * The guard that stops an agent tearing down a human's work. Tested
 * exhaustively over the matrix rather than by example, because the failure
 * mode is silent and destructive.
 */

import { describe, it, expect } from '@jest/globals';
import {
  evaluateClosePermission,
  NOT_PERMITTED_CODE,
  type SessionOrigin,
} from '../../../shared/session-close-permission';

const ask = (over: Partial<Parameters<typeof evaluateClosePermission>[0]> = {}) =>
  evaluateClosePermission({
    target: { sessionId: 'sess_target', createdBy: 'mcp' },
    callerSessionId: 'sess_caller',
    callerDescendantIds: [],
    ...over,
  });

describe('a caller may always close itself', () => {
  it.each([['ui'], ['mcp'], ['adopted']] as [SessionOrigin][])(
    'even when its own origin is %s',
    (origin) => {
      const r = evaluateClosePermission({
        target: { sessionId: 'sess_me', createdBy: origin },
        callerSessionId: 'sess_me',
      });
      expect(r.allowed).toBe(true);
    }
  );

  it('including destructively — it owns its own work', () => {
    expect(
      evaluateClosePermission({
        target: { sessionId: 'sess_me', createdBy: 'mcp' },
        callerSessionId: 'sess_me',
        destructive: true,
      }).allowed
    ).toBe(true);
  });
});

describe('a caller may close what it spawned', () => {
  it('allows a direct descendant', () => {
    expect(
      ask({ callerDescendantIds: ['sess_target'] }).allowed
    ).toBe(true);
  });

  it('allows a descendant reached only via an alias', () => {
    // The list is alias-expanded, so a child created before the parent
    // restarted — and therefore holding the parent's OLD id — still resolves.
    // Without this, kit_close_sessions(parent_session_id=self) stops working
    // after any KIT restart.
    expect(
      ask({ target: { sessionId: 'sess_old_child', createdBy: 'mcp' }, callerDescendantIds: ['sess_old_child'] })
        .allowed
    ).toBe(true);
  });

  it('allows destroying a descendant', () => {
    expect(
      ask({ callerDescendantIds: ['sess_target'], destructive: true }).allowed
    ).toBe(true);
  });
});

describe('UI-created sessions are never closable by an agent', () => {
  it('refuses a safe close', () => {
    const r = ask({ target: { sessionId: 'sess_target', createdBy: 'ui' } });
    expect(r.allowed).toBe(false);
    expect(r.error?.code).toBe(NOT_PERMITTED_CODE);
  });

  it('refuses even with allow_foreign', () => {
    // allow_foreign is about other AGENTS' sessions, never a human's.
    expect(
      ask({ target: { sessionId: 'sess_target', createdBy: 'ui' }, allowForeign: true })
        .allowed
    ).toBe(false);
  });

  it('tells the agent to ask the user', () => {
    const r = ask({ target: { sessionId: 'sess_target', createdBy: 'ui' } });
    expect(r.error?.instruction).toMatch(/ask the user/i);
  });

  it('treats an ABSENT createdBy as ui — the upgrade fail-safe', () => {
    // Records written before createdBy existed are humans' sessions. An
    // upgrade must not hand agents the power to close them.
    const r = ask({ target: { sessionId: 'sess_legacy' } });
    expect(r.allowed).toBe(false);
    expect(r.error?.message).toMatch(/predates session origin tracking/i);
  });

  it('refuses a legacy session even with allow_foreign', () => {
    expect(
      ask({ target: { sessionId: 'sess_legacy' }, allowForeign: true }).allowed
    ).toBe(false);
  });
});

describe("another agent's session", () => {
  it('is refused by default', () => {
    const r = ask();
    expect(r.allowed).toBe(false);
    expect(r.error?.instruction).toMatch(/allow_foreign/);
  });

  it('is allowed with allow_foreign', () => {
    expect(ask({ allowForeign: true }).allowed).toBe(true);
  });

  it('may be destroyed with allow_foreign', () => {
    expect(ask({ allowForeign: true, destructive: true }).allowed).toBe(true);
  });
});

describe('adopted sessions — manageable, never demolishable', () => {
  const adopted = { sessionId: 'sess_adopted', createdBy: 'adopted' as SessionOrigin };

  it('allows a safe close', () => {
    expect(ask({ target: adopted }).allowed).toBe(true);
  });

  it('REFUSES a destructive close', () => {
    // An adopted session is bound to a branch a human already had. Letting the
    // adopter destroy it would make kit_adopt_session a way around the whole
    // rule — adopt, then delete.
    const r = ask({ target: adopted, destructive: true });
    expect(r.allowed).toBe(false);
    expect(r.error?.message).toMatch(/belong to a human/i);
  });

  it('refuses destruction even with allow_foreign', () => {
    expect(ask({ target: adopted, destructive: true, allowForeign: true }).allowed).toBe(
      false
    );
  });

  it('tells the agent how to proceed safely', () => {
    const r = ask({ target: adopted, destructive: true });
    expect(r.error?.instruction).toMatch(/delete_worktree/);
  });

  it('but the adopter may still destroy it if it is its own descendant', () => {
    // Ownership beats origin: if the caller spawned it, it is the caller's.
    expect(
      ask({ target: adopted, callerDescendantIds: ['sess_adopted'], destructive: true })
        .allowed
    ).toBe(true);
  });
});

describe('unidentified callers', () => {
  it('is told to identify itself, NOT to use allow_foreign', () => {
    // Found by running the real app. kit_close_sessions(parent_session_id=self)
    // — the call the tool description recommends — refused every matched child
    // and advised allow_foreign. Following that advice would mean asserting
    // "I am closing someone else's sessions" in order to close your own.
    const r = evaluateClosePermission({
      target: { sessionId: 'sess_mine', createdBy: 'mcp' },
      callerSessionId: undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.error?.instruction).toMatch(/caller_session_id/);
    expect(r.error?.message).not.toMatch(/different agent/);
  });

  it('still points an IDENTIFIED caller at allow_foreign', () => {
    const r = evaluateClosePermission({
      target: { sessionId: 'sess_theirs', createdBy: 'mcp' },
      callerSessionId: 'sess_me',
      callerDescendantIds: [],
    });
    expect(r.error?.instruction).toMatch(/allow_foreign/);
    expect(r.error?.message).toMatch(/different agent/);
  });

  it('cannot close a foreign session just by omitting their own id', () => {
    const r = evaluateClosePermission({
      target: { sessionId: 'sess_target', createdBy: 'mcp' },
      callerSessionId: undefined,
    });
    expect(r.allowed).toBe(false);
  });

  it('an undefined caller id does not accidentally match an undefined target id', () => {
    const r = evaluateClosePermission({
      target: { sessionId: '', createdBy: 'mcp' },
      callerSessionId: undefined,
    });
    expect(r.allowed).toBe(false);
  });
});
