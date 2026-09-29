/**
 * KC-S2.3.1: devops-agent:// links from Kanvas's "Build in KIT IDE".
 */

import { describe, it, expect } from '@jest/globals';
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink } from '../../../shared/deep-link';
import { EVENT_CHANNELS, IPC } from '../../../shared/ipc-channels';

describe('parseDeepLink', () => {
  it('reads the run id from devops-agent://coding?run=…', () => {
    expect(parseDeepLink('devops-agent://coding?run=20260929T181500-ab12cd')).toEqual({
      view: 'coding',
      runId: '20260929T181500-ab12cd',
    });
  });

  it('opens the Coding tab without a run for a bare link', () => {
    expect(parseDeepLink('devops-agent://coding')).toEqual({ view: 'coding', runId: null });
    expect(parseDeepLink('devops-agent:///coding?run=r1')).toEqual({ view: 'coding', runId: 'r1' });
  });

  it('drops a run id that is not a plain id', () => {
    expect(parseDeepLink('devops-agent://coding?run=../../etc')).toEqual({ view: 'coding', runId: null });
    expect(parseDeepLink(`devops-agent://coding?run=${'a'.repeat(200)}`)?.runId).toBeNull();
  });

  it('ignores other schemes, other views and garbage', () => {
    expect(parseDeepLink('https://coding?run=r1')).toBeNull();
    expect(parseDeepLink('devops-agent://settings?run=r1')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
  });
});

describe('deepLinkFromArgv', () => {
  it('finds the link Windows and Linux pass on the command line', () => {
    expect(deepLinkFromArgv(['/app/KIT for DevOps', '--flag', 'devops-agent://coding?run=r1'])).toBe(
      'devops-agent://coding?run=r1'
    );
    expect(deepLinkFromArgv(['/app/KIT for DevOps'])).toBeNull();
  });
});

describe('IPC', () => {
  it('delivers the opened run as a main → renderer event', () => {
    expect(EVENT_CHANNELS as readonly string[]).toContain(IPC.HARNESS_OPEN_RUN);
    expect(DEEP_LINK_SCHEME).toBe('devops-agent');
  });
});
