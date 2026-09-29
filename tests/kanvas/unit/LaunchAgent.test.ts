/**
 * KC-S2.2.3: the LaunchAgent that keeps KIT for DevOps running unattended on
 * the Mac mini. The install itself needs macOS (launchctl, a reboot); this
 * checks what can be checked anywhere: the script parses, and the plist it
 * renders is well-formed and starts the app at login, restarting it on a crash.
 */

import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../../scripts/install-launch-agent.sh');

function render(appPath: string): string {
  return execFileSync('bash', [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/Users/kit', KIT_APP_PATH: appPath },
  });
}

/** The plist's top-level dict as key -> element. */
function plistEntries(xml: string): Map<string, Element> {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  const dict = doc.querySelector('plist > dict')!;
  const entries = new Map<string, Element>();
  const children = Array.from(dict.children);
  for (let i = 0; i < children.length; i += 2) {
    entries.set(children[i].textContent!, children[i + 1]);
  }
  return entries;
}

describe('LaunchAgent for unattended runs (KC-S2.2.3)', () => {
  it('the install script parses', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  it('renders a plist that starts the app at login and restarts it after a crash', () => {
    const entries = plistEntries(render('/Applications/KIT for DevOps.app'));
    expect(entries.get('Label')!.textContent).toBe('com.sekondbrain.kit-for-devops');
    expect(entries.get('ProgramArguments')!.querySelector('string')!.textContent).toBe(
      '/Applications/KIT for DevOps.app/Contents/MacOS/KIT for DevOps'
    );
    expect(entries.get('RunAtLoad')!.tagName).toBe('true');
    const keepAlive = entries.get('KeepAlive')!;
    expect(keepAlive.querySelector('key')!.textContent).toBe('SuccessfulExit');
    expect(keepAlive.querySelector('false')).not.toBeNull();
    expect(entries.get('LimitLoadToSessionType')!.textContent).toBe('Aqua');
    expect(entries.get('StandardOutPath')!.textContent).toBe('/Users/kit/Library/Logs/kit-for-devops.log');
  });

  it('takes the executable name from a custom app bundle', () => {
    const entries = plistEntries(render('/opt/apps/KIT Nightly.app'));
    expect(entries.get('ProgramArguments')!.querySelector('string')!.textContent).toBe(
      '/opt/apps/KIT Nightly.app/Contents/MacOS/KIT Nightly'
    );
  });

  it('rejects unknown flags', () => {
    expect(() => execFileSync('bash', [SCRIPT, '--bogus'], { stdio: 'pipe' })).toThrow();
  });
});
