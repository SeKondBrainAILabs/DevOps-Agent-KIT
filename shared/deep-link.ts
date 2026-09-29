/**
 * devops-agent:// deep links (KC-S2.3.1).
 *
 * Kanvas's "Build in KIT IDE" shows the run KIT Harness created with a link
 * that opens this app's Coding tab on it: devops-agent://coding?run=<run_id>.
 * Parsed in the main process, which only forwards a well-formed run id to the
 * renderer; anything else is ignored.
 */

export const DEEP_LINK_SCHEME = 'devops-agent';

export type DeepLink = { view: 'coding'; runId: string | null };

const RUN_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // devops-agent://coding?run=… parses with "coding" as the host; accept a path form too.
  const view = (url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
  if (view !== 'coding') return null;
  const run = url.searchParams.get('run');
  return { view: 'coding', runId: run && RUN_ID.test(run) ? run : null };
}

/** The first devops-agent:// argument, for a cold start on Windows and Linux. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
