/**
 * Unit Tests for I1 — SSH command template / param sub / secret masking
 */

import { describe, it, expect } from '@jest/globals';
import {
  listPlaceholders,
  maskKnownSecrets,
  renderSshCommand,
} from '../../../shared/ssh-command-template';

describe('listPlaceholders (I1)', () => {
  it('extracts unique placeholders', () => {
    expect(listPlaceholders('docker logs --since 1h {service} | grep {user_email}')).toEqual([
      'service',
      'user_email',
    ]);
  });
  it('dedupes repeats', () => {
    expect(listPlaceholders('echo {x} {x} {x}')).toEqual(['x']);
  });
  it('rejects malformed placeholders', () => {
    expect(listPlaceholders('echo {Not-Snake} {123}')).toEqual([]);
  });
});

describe('renderSshCommand — happy path (I1)', () => {
  it('substitutes placeholders', () => {
    const r = renderSshCommand({
      template: 'echo {greeting} {name}',
      params: { greeting: 'hi', name: 'world' },
    });
    expect(r.ok).toBe(true);
    expect(r.commandToRun).toBe('echo hi world');
    expect(r.commandForDisplay).toBe('echo hi world');
  });

  it('repeats placeholders are all substituted', () => {
    const r = renderSshCommand({
      template: 'cp {f} {f}.bak',
      params: { f: 'log.txt' },
    });
    expect(r.commandToRun).toBe('cp log.txt log.txt.bak');
  });

  it('reports unused params (declared but not referenced)', () => {
    const r = renderSshCommand({
      template: 'echo {a}',
      params: { a: '1', b: '2' },
    });
    expect(r.unused).toEqual(['b']);
  });
});

describe('renderSshCommand — secret masking (I1)', () => {
  it('masks secret param in display but not in commandToRun', () => {
    const r = renderSshCommand({
      template: 'curl -H "Authorization: Bearer {token}" https://api.example.com',
      params: { token: { value: 'sk_real_secret', secret: true } },
    });
    expect(r.ok).toBe(true);
    expect(r.commandToRun).toContain('sk_real_secret');
    expect(r.commandForDisplay).not.toContain('sk_real_secret');
    expect(r.commandForDisplay).toContain('***');
  });

  it('non-secret params render plainly', () => {
    const r = renderSshCommand({
      template: 'ls {dir}',
      params: { dir: '/tmp' },
    });
    expect(r.commandForDisplay).toBe('ls /tmp');
  });
});

describe('renderSshCommand — missing params (I1)', () => {
  it('blocks render and lists missing names', () => {
    const r = renderSshCommand({
      template: 'echo {a} {b} {c}',
      params: { a: '1' },
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['b', 'c']);
    expect(r.message).toMatch(/Missing parameters/);
  });

  it('singular wording when exactly one is missing', () => {
    const r = renderSshCommand({
      template: 'echo {a}',
      params: {},
    });
    expect(r.message).toMatch(/Missing parameter:/);
  });
});

describe('maskKnownSecrets (I1)', () => {
  it('replaces every occurrence of every known secret', () => {
    const out = maskKnownSecrets(
      'auth=ABC; db=PASSWORD; trace=PASSWORD/x',
      ['ABC', 'PASSWORD']
    );
    expect(out).toBe('auth=***; db=***; trace=***/x');
  });
  it('ignores empty / falsy entries', () => {
    expect(maskKnownSecrets('hi', ['', null as unknown as string])).toBe('hi');
  });
});
