/**
 * Unit Tests for the macOS stopgap self-updater.
 *
 * KIT on macOS used to stop at "Update available" forever (no Developer ID,
 * so no Squirrel.Mac). The updater now installs releases itself, which means
 * it replaces the user's working app — so the swap script is run for real
 * here, against throwaway bundles, for success, rollback and refusal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appBundleFromExecPath,
  buildSwapScript,
  describeInstallResult,
  isNewerVersion,
  parseLatestMacYml,
  pickMacZip,
  shQuote,
  startedMarkerName,
} from '../../../shared/mac-self-update';
import { MacSelfUpdater, relaunchArgs } from '../../../electron/services/MacSelfUpdater';

describe('relaunchArgs', () => {
  it('keeps switches and drops the binary path and Finder serial number', () => {
    expect(
      relaunchArgs(['/A.app/Contents/MacOS/A', '-psn_0_12345', '--user-data-dir=/x', 'stray'])
    ).toEqual(['--user-data-dir=/x']);
  });
});

// The real v2.10.1 feed.
const FEED = `version: 2.10.1
files:
  - url: KIT-for-DevOps-2.10.1-arm64-mac.zip
    sha512: HK2DcQ44sGeeoyOoQsTwISEbYVdYNP3Vy3kKfyEg15A2M0Rsj+eXzUR64zK4MxPC4bbJkJxXJs25Q0Qy0WM1wg==
    size: 103834748
  - url: KIT-for-DevOps-2.10.1-arm64.dmg
    sha512: r60zgPPVCn2McrnuNF+FMMBW/2zGXLkstQoBP/xChvm0wCYIyIOaNaqEBxtRE7dvxRfxy/mmPe9gLEHON8ZpZg==
    size: 107699888
path: KIT-for-DevOps-2.10.1-arm64-mac.zip
sha512: HK2DcQ44sGeeoyOoQsTwISEbYVdYNP3Vy3kKfyEg15A2M0Rsj+eXzUR64zK4MxPC4bbJkJxXJs25Q0Qy0WM1wg==
releaseDate: '2026-10-12T10:21:57.005Z'
`;

describe('parseLatestMacYml', () => {
  it('reads the real release feed', () => {
    const feed = parseLatestMacYml(FEED)!;
    expect(feed.version).toBe('2.10.1');
    expect(feed.files).toHaveLength(2);
    expect(feed.files[0]).toEqual({
      url: 'KIT-for-DevOps-2.10.1-arm64-mac.zip',
      sha512: 'HK2DcQ44sGeeoyOoQsTwISEbYVdYNP3Vy3kKfyEg15A2M0Rsj+eXzUR64zK4MxPC4bbJkJxXJs25Q0Qy0WM1wg==',
      size: 103834748,
    });
    expect(feed.releaseDate).toBe('2026-10-12T10:21:57.005Z');
  });

  it('rejects text with no version', () => {
    expect(parseLatestMacYml('<html>Not Found</html>')).toBeNull();
  });
});

describe('pickMacZip', () => {
  const feed = parseLatestMacYml(FEED)!;
  it('picks the Apple Silicon zip, never the dmg', () => {
    expect(pickMacZip(feed, 'arm64')?.url).toBe('KIT-for-DevOps-2.10.1-arm64-mac.zip');
  });
  it('finds nothing for Intel when only an arm64 zip was published', () => {
    expect(pickMacZip(feed, 'x64')).toBeNull();
  });
  it('picks the Intel zip when there is one', () => {
    const both = { ...feed, files: [...feed.files, { url: 'KIT-for-DevOps-2.10.1-mac.zip', sha512: 'x' }] };
    expect(pickMacZip(both, 'x64')?.url).toBe('KIT-for-DevOps-2.10.1-mac.zip');
  });
});

describe('isNewerVersion', () => {
  it.each([
    ['2.10.1', '2.9.2', true],
    ['2.10.0', '2.9.10', true],
    ['3.0.0', '2.99.99', true],
    ['2.10.1', '2.10.1', false],
    ['2.9.2', '2.10.1', false],
    ['v2.11.0', '2.10.1', true],
    ['2.11.0-beta.1', '2.10.1', false],
    ['garbage', '2.10.1', false],
  ])('%s newer than %s → %s', (a, b, want) => {
    expect(isNewerVersion(a, b)).toBe(want);
  });
});

describe('appBundleFromExecPath', () => {
  it('finds the bundle around the running binary', () => {
    expect(appBundleFromExecPath('/Applications/KIT for DevOps.app/Contents/MacOS/KIT for DevOps')).toBe(
      '/Applications/KIT for DevOps.app'
    );
  });
  it('is null outside a bundle (dev runs)', () => {
    expect(appBundleFromExecPath('/repo/node_modules/electron/dist/Electron')).toBeNull();
  });
});

describe('shQuote', () => {
  it('survives quotes, spaces and $', () => {
    const nasty = `/tmp/a b/it's $HOME`;
    expect(execFileSync('/bin/bash', ['-c', `printf %s ${shQuote(nasty)}`]).toString()).toBe(nasty);
  });
});

describe('describeInstallResult', () => {
  const base = { from: '2.10.1', to: '2.11.0', detail: 'x', at: 't' };
  it('is silent after a good update', () => {
    expect(describeInstallResult({ ...base, outcome: 'updated' }, '2.11.0')).toBeNull();
  });
  it('explains a rollback', () => {
    expect(describeInstallResult({ ...base, outcome: 'rolled_back' }, '2.10.1')).toMatch(/v2\.10\.1 was restored/);
  });
});

// ─── The swap script, run for real ───────────────────────────────────────────

// macOS kills a copied /bin/sleep when it runs from another path, so the
// "process running from the bundle" fixtures use a sleeper compiled here.
let SLEEPER = '';
beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'kit-sleeper-'));
  writeFileSync(
    join(d, 's.c'),
    '#include <unistd.h>\n#include <stdlib.h>\nint main(int c,char**v){sleep(c>1?atoi(v[1]):30);return 0;}\n'
  );
  execFileSync('/usr/bin/cc', ['-o', join(d, 'sleeper'), join(d, 's.c')]);
  SLEEPER = join(d, 'sleeper');
});

describe('swap script', () => {
  let dir: string;
  const appPath = () => join(dir, 'Applications', 'KIT for DevOps.app');
  const staged = () => join(dir, 'staging', 'KIT for DevOps.app');
  const marker = () => join(dir, 'updates', startedMarkerName('2.11.0'));
  const parked = () => join(dir, 'updates', 'rollback', 'run-1', 'KIT for DevOps.app');
  const result = () => JSON.parse(readFileSync(join(dir, 'updates', 'last-install.json'), 'utf-8'));

  const fakeBundle = (path: string, version: string) => {
    mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(path, 'Contents', 'VERSION'), version);
  };
  // Stub for `open`: records launches, and for the new version writes the
  // started marker unless told the new build is broken.
  const launcher = (newStarts: boolean) => {
    const p = join(dir, 'fake-open.sh');
    writeFileSync(
      p,
      `#!/bin/bash
BUNDLE="$1"; shift
echo "$(cat "$BUNDLE/Contents/VERSION")" >> ${shQuote(join(dir, 'launched.txt'))}
printf '%s\n' "$@" >> ${shQuote(join(dir, 'args.txt'))}
if [ "$(cat "$BUNDLE/Contents/VERSION")" = "2.11.0" ] && [ "${newStarts ? 'yes' : 'no'}" = yes ]; then
  mkdir -p ${shQuote(join(dir, 'updates'))}; touch ${shQuote(marker())}
fi
`,
      { mode: 0o755 }
    );
    return p;
  };
  const scriptFor = (opts: {
    newStarts: boolean;
    oldPid: number;
    quitTimeoutSeconds?: number;
    launchArgs?: string[];
    runId?: string;
    launchCommand?: string;
  }) => {
    const id = opts.runId ?? '1';
    const script = join(dir, `install-${id}.sh`);
    writeFileSync(
      script,
      buildSwapScript({
        oldPid: opts.oldPid,
        appPath: appPath(),
        stagedAppPath: staged(),
        parkedAppPath: id === '1' ? parked() : join(dir, 'updates', 'rollback', `run-${id}`, 'KIT for DevOps.app'),
        failedAppPath: join(dir, 'updates', `failed-${id}`, 'KIT for DevOps.app'),
        lockDir: join(dir, 'updates', 'install.lock'),
        startedMarkerPath: marker(),
        resultPath: join(dir, 'updates', 'last-install.json'),
        logPath: join(dir, 'updates', 'install.log'),
        fromVersion: '2.10.1',
        toVersion: '2.11.0',
        // A started version returns at once; only the rollback case waits it out.
        startTimeoutSeconds: opts.newStarts ? 20 : 2,
        quitTimeoutSeconds: opts.quitTimeoutSeconds ?? 4,
        launchCommand: opts.launchCommand ?? launcher(opts.newStarts),
        launchArgs: opts.launchArgs,
      })
    );
    return script;
  };
  const run = (opts: Parameters<typeof scriptFor>[0]) =>
    spawnSync('/bin/bash', [scriptFor(opts)], { encoding: 'utf-8', timeout: 60_000 });
  // Above macOS's PID ceiling (99998), so it can never be a live or reused
  // process — a just-exited PID can be reissued under load.
  const deadPid = () => 999_999;
  const installed = () => readFileSync(join(appPath(), 'Contents', 'VERSION'), 'utf-8');
  const launched = () => readFileSync(join(dir, 'launched.txt'), 'utf-8').trim().split('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit swap '));
    mkdirSync(join(dir, 'updates'), { recursive: true });
    fakeBundle(appPath(), '2.10.1');
    fakeBundle(staged(), '2.11.0');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('installs the new version when it starts', () => {
    const r = run({ newStarts: true, oldPid: deadPid() });
    expect(r.status).toBe(0);
    expect(installed()).toBe('2.11.0');
    expect(result()).toMatchObject({ outcome: 'updated', from: '2.10.1', to: '2.11.0' });
    expect(launched()).toEqual(['2.11.0']);
    // The old version stays parked for a manual restore.
    expect(existsSync(parked())).toBe(true);
  });

  it('relaunches with the same arguments, so a custom data dir is kept', () => {
    run({ newStarts: true, oldPid: deadPid(), launchArgs: ['--user-data-dir=/tmp/kit data'] });
    expect(readFileSync(join(dir, 'args.txt'), 'utf-8').trim()).toBe('--user-data-dir=/tmp/kit data');
  });

  it('puts the old version back and relaunches it when the new one does not start', () => {
    const r = run({ newStarts: false, oldPid: deadPid() });
    expect(r.status).toBe(1);
    expect(installed()).toBe('2.10.1');
    expect(result().outcome).toBe('rolled_back');
    expect(launched()).toEqual(['2.11.0', '2.10.1']);
  });

  it('waits for the old app to quit before touching anything', () => {
    // Started via a shell that exits at once, so the sleeper is re-parented and
    // reaped by the OS — as KIT is. A direct child of this (blocked) test
    // process would linger as a zombie that `kill -0` still reports alive.
    const oldPid = Number(
      execFileSync('/bin/bash', ['-c', 'sleep 2 >/dev/null 2>&1 & echo $!']).toString().trim()
    );
    const started = Date.now();
    const r = run({ newStarts: true, oldPid });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(r.status).toBe(0);
    expect(installed()).toBe('2.11.0');
  });

  it('changes nothing when the old app will not quit', () => {
    // Ignores TERM, so it outlives the quit timeout.
    const stubborn = spawn('/bin/bash', ['-c', 'trap "" TERM; sleep 30'], { detached: true });
    try {
      const r = run({ newStarts: true, oldPid: stubborn.pid!, quitTimeoutSeconds: 2 });
      expect(r.status).toBe(1);
      expect(installed()).toBe('2.10.1');
      expect(existsSync(staged())).toBe(true);
      expect(result().outcome).toBe('aborted');
      expect(existsSync(join(dir, 'launched.txt'))).toBe(false);
    } finally {
      try { process.kill(-stubborn.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });
  // ── Reproductions of the review findings ──────────────────────────────

  it('C1: a second install run cannot destroy the first one\'s parked copy', async () => {
    const a = scriptFor({ newStarts: true, oldPid: deadPid(), runId: '1' });
    const b = scriptFor({ newStarts: true, oldPid: deadPid(), runId: '2' });
    const go = (p: string) =>
      new Promise<number>((res) => spawn('/bin/bash', [p]).on('exit', (c) => res(c ?? -1)));
    const codes = await Promise.all([go(a), go(b)]);
    expect(codes.sort()).toEqual([0, 3]); // one installs, the other backs off
    expect(installed()).toBe('2.11.0');
    expect(launched()).toEqual(['2.11.0']); // launched exactly once
    expect(result().outcome).toBe('updated');
  });

  it('C2: a rollback never nests the old app inside a half-deleted new one', () => {
    // An undeletable file in the new bundle made the old rm -rf stop half way.
    const locked = join(staged(), 'Contents', 'locked');
    writeFileSync(locked, 'x');
    execFileSync('/usr/bin/chflags', ['uchg', locked]);
    try {
      const r = run({ newStarts: false, oldPid: deadPid() });
      expect(r.status).toBe(1);
      expect(result().outcome).toBe('rolled_back');
      expect(installed()).toBe('2.10.1');
      expect(existsSync(join(appPath(), 'KIT for DevOps.app'))).toBe(false);
    } finally {
      spawnSync('/bin/bash', ['-c', `chflags -R nouchg ${shQuote(dir)}`]);
    }
  });

  it('H1: refuses to swap while another KIT runs from the bundle, and changes nothing', () => {
    // A process whose command line starts with the bundle's MacOS dir, like a
    // second KIT profile or a launchd relaunch of the old version.
    const exe = join(appPath(), 'Contents', 'MacOS', 'kit-sleep');
    execFileSync('/bin/cp', [SLEEPER, exe]);
    const other = spawn(exe, ['30'], { detached: true, stdio: 'ignore' });
    execFileSync('/bin/sleep', ['0.3']);
    expect(() => process.kill(other.pid!, 0)).not.toThrow(); // the fixture really runs
    try {
      const r = run({ newStarts: true, oldPid: deadPid() });
      expect(r.status).toBe(1);
      expect(result().outcome).toBe('aborted');
      expect(installed()).toBe('2.10.1');
      expect(existsSync(staged())).toBe(true);
      expect(() => process.kill(other.pid!, 0)).not.toThrow(); // left running
    } finally {
      try { process.kill(other.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('H1: on rollback, kills only what runs from the bundle — not a look-alike path', () => {
    // The "new version" starts a process from the bundle but never reports in.
    execFileSync('/bin/cp', [SLEEPER, join(staged(), 'Contents', 'MacOS', 'kit-sleep')]);
    const starter = join(dir, 'start-hung.sh');
    writeFileSync(
      starter,
      `#!/bin/bash
BUNDLE="$1"
echo "$(cat "$BUNDLE/Contents/VERSION")" >> ${shQuote(join(dir, 'launched.txt'))}
if [ "$(cat "$BUNDLE/Contents/VERSION")" = "2.11.0" ]; then
  nohup "$BUNDLE/Contents/MacOS/kit-sleep" 60 >/dev/null 2>&1 &
  echo $! > ${shQuote(join(dir, 'hung.pid'))}
fi
`,
      { mode: 0o755 }
    );
    // Same name with a suffix: a regex or substring match would hit it.
    const lookalike = `${appPath()}.backup/Contents/MacOS`;
    mkdirSync(lookalike, { recursive: true });
    execFileSync('/bin/cp', [SLEEPER, join(lookalike, 'kit-sleep')]);
    const decoy = spawn(join(lookalike, 'kit-sleep'), ['60'], { detached: true, stdio: 'ignore' });
    execFileSync('/bin/sleep', ['0.3']);
    expect(() => process.kill(decoy.pid!, 0)).not.toThrow(); // the fixture really runs
    try {
      const r = run({ newStarts: false, oldPid: deadPid(), launchCommand: starter });
      expect(r.status).toBe(1);
      expect(result().outcome).toBe('rolled_back');
      const hung = Number(readFileSync(join(dir, 'hung.pid'), 'utf-8'));
      expect(hung).toBeGreaterThan(0);
      expect(() => process.kill(hung, 0)).toThrow(); // the hung new version was stopped
      expect(() => process.kill(decoy.pid!, 0)).not.toThrow(); // the look-alike was not
    } finally {
      try { process.kill(decoy.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('aborts without touching anything when the staged update has gone missing', () => {
    rmSync(staged(), { recursive: true, force: true });
    const r = run({ newStarts: true, oldPid: deadPid() });
    expect(r.status).toBe(1);
    expect(result()).toMatchObject({ outcome: 'aborted', detail: 'the downloaded update is missing' });
    expect(installed()).toBe('2.10.1');
  });

  it('writes valid JSON even when a path contains quotes and backslashes', () => {
    rmSync(staged(), { recursive: true, force: true });
    const r = spawnSync('/bin/bash', [
      '-c',
      `${readFileSync(scriptFor({ newStarts: true, oldPid: deadPid() }), 'utf-8').split('\n# ── one install')[0]}
FROM='2.10.1 "x" \\ y'; result aborted 'detail "q" \\ z'`,
    ]);
    expect(r.status).toBe(0);
    expect(result()).toMatchObject({ from: '2.10.1 "x" \\ y', detail: 'detail "q" \\ z' });
  });
});


// ─── Download and verification, against a local feed ────────────────────────

describe('MacSelfUpdater download and checks', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  const payload = Buffer.from('not really a zip, but bytes to hash'.repeat(1000));
  const sha = createHash('sha512').update(payload).digest('base64');

  const updater = (over: Partial<ConstructorParameters<typeof MacSelfUpdater>[0]> = {}) =>
    new MacSelfUpdater({
      updatesDir: join(dir, 'updates'),
      appPath: join(dir, 'KIT for DevOps.app'),
      currentVersion: '2.10.1',
      arch: 'arm64',
      userAgent: 'test',
      log: () => undefined,
      feedBase: base,
      ...over,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kit-dl-'));
    mkdirSync(join(dir, 'KIT for DevOps.app'));
    server = http.createServer((req, res) => {
      if (req.url === '/latest-mac.yml') {
        res.end(`version: 2.11.0\nfiles:\n  - url: K-2.11.0-arm64-mac.zip\n    sha512: ${sha}\n    size: ${payload.length}\n`);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/K-2.11.0-arm64-mac.zip' }).end();
      } else if (req.url === '/K-2.11.0-arm64-mac.zip') {
        res.end(payload);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the feed from the configured base', async () => {
    const feed = await updater().fetchFeed();
    expect(feed.version).toBe('2.11.0');
    expect(feed.files[0].sha512).toBe(sha);
  });

  it('refuses a download whose checksum does not match the feed', async () => {
    const feed = await updater().fetchFeed();
    feed.files[0].sha512 = createHash('sha512').update('tampered').digest('base64');
    await expect(updater().prepare(feed, () => undefined)).rejects.toThrow(/checksum/);
  });

  it('refuses a download whose size does not match the feed', async () => {
    const feed = await updater().fetchFeed();
    feed.files[0].size = payload.length + 1;
    await expect(updater().prepare(feed, () => undefined)).rejects.toThrow(/bytes/);
  });

  it('reports progress up to 100% for a matching download', async () => {
    const feed = await updater().fetchFeed();
    const seen: number[] = [];
    // The payload is not a real zip, so preparation stops at unpacking — after
    // the checksum passed, which is what this test is about.
    await expect(
      updater().prepare(feed, (p) => seen.push(p.percent))
    ).rejects.toThrow();
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('is unavailable when the app folder is not writable', () => {
    const r = updater({ appPath: '/System/Applications/Calculator.app' }).readiness();
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a bundle that is not KIT, or is missing its native module', async () => {
    const app = join(dir, 'Fake.app');
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
    const plist = (id: string, v: string) =>
      writeFileSync(
        join(app, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`
      );
    plist('com.example.other', '2.11.0');
    await expect(updater().validateBundle(app, '2.11.0')).rejects.toThrow(/not com\.sekondbrain/);
    plist('com.sekondbrain.kit-for-devops', '2.10.9');
    await expect(updater().validateBundle(app, '2.11.0')).rejects.toThrow(/reports version 2\.10\.9/);
    plist('com.sekondbrain.kit-for-devops', '2.11.0');
    writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), '');
    await expect(updater().validateBundle(app, '2.11.0')).rejects.toThrow(/better-sqlite3/);
  });

  it('records and consumes the install outcome once', () => {
    const u = updater();
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      join(dir, 'updates', 'last-install.json'),
      JSON.stringify({ from: '2.10.1', to: '2.11.0', outcome: 'rolled_back', detail: 'd', at: 't' })
    );
    expect(u.takeInstallResult()?.outcome).toBe('rolled_back');
    expect(u.takeInstallResult()).toBeNull();
  });
});
