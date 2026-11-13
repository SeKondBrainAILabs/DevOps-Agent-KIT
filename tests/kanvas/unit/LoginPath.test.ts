/**
 * Unit Tests for shared/login-path.ts
 *
 * A KIT started by launchd got PATH=/usr/bin:/bin:/usr/sbin:/sbin, so git
 * hooks calling npm failed ("npm: command not found") and pushes never
 * reached GitHub. KIT now merges in the login shell's PATH and standard tool
 * directories at startup.
 */

import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import {
  PRINT_PATH_COMMAND,
  fallbackToolDirs,
  looksLikeLaunchdPath,
  mergePath,
  parseShellPath,
} from '../../../shared/login-path';

const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('mergePath', () => {
  const all = () => true;

  it('puts the login shell first, then the original, then fallbacks', () => {
    expect(
      mergePath({
        current: LAUNCHD,
        loginShell: '/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin',
        fallbacks: ['/opt/homebrew/bin', '/usr/local/bin'],
        exists: all,
      })
    ).toBe(
      '/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'
    );
  });

  it('adds Homebrew when the login shell cannot be read — the reported failure', () => {
    const p = mergePath({ current: LAUNCHD, loginShell: null, fallbacks: fallbackToolDirs('/Users/me'), exists: (d) => d === '/opt/homebrew/bin' });
    expect(p).toBe(`${LAUNCHD}:/opt/homebrew/bin`);
  });

  it('only adds fallback directories that exist', () => {
    expect(mergePath({ current: LAUNCHD, loginShell: null, fallbacks: ['/nope/bin'], exists: () => false })).toBe(LAUNCHD);
  });

  it('drops duplicates, empties and trailing slashes, keeping first position', () => {
    expect(
      mergePath({ current: '/usr/bin::/bin/:/usr/bin', loginShell: '/bin', fallbacks: [], exists: all })
    ).toBe('/bin:/usr/bin');
  });

  it('copes with no PATH at all', () => {
    expect(mergePath({ current: undefined, loginShell: null, fallbacks: ['/opt/homebrew/bin'], exists: all })).toBe(
      '/opt/homebrew/bin'
    );
  });
});

describe('parseShellPath', () => {
  it('ignores shell banner noise around the markers', () => {
    const out = `Last login: today\nwelcome!\n__KIT_PATH_START__/opt/homebrew/bin:/usr/bin__KIT_PATH_END__`;
    expect(parseShellPath(out)).toBe('/opt/homebrew/bin:/usr/bin');
  });
  it('is null when the shell printed nothing usable', () => {
    expect(parseShellPath('')).toBeNull();
    expect(parseShellPath('__KIT_PATH_START____KIT_PATH_END__')).toBeNull();
  });
  it('round-trips through a real shell', () => {
    const out = execFileSync('/bin/sh', ['-c', PRINT_PATH_COMMAND], {
      env: { PATH: '/a/b:/c/d' },
      encoding: 'utf-8',
    });
    expect(parseShellPath(out)).toBe('/a/b:/c/d');
  });
});

describe('looksLikeLaunchdPath', () => {
  const exists = (d: string) => d === '/opt/homebrew/bin';
  it('is true for launchd\'s bare PATH', () => {
    expect(looksLikeLaunchdPath(LAUNCHD, exists)).toBe(true);
  });
  it('is false once Homebrew is on PATH, so a terminal launch skips the shell', () => {
    expect(looksLikeLaunchdPath(`/opt/homebrew/bin:${LAUNCHD}`, exists)).toBe(false);
  });
});
