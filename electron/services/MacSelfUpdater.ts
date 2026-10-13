/**
 * MacSelfUpdater — the I/O half of the macOS stopgap self-updater.
 *
 * Squirrel.Mac needs a Developer ID signature that KIT does not have, so this
 * installs the release zip itself. Nothing reaches /Applications until the new
 * bundle has been:
 *   1. downloaded and checked against the size and sha512 in latest-mac.yml;
 *   2. unpacked and confirmed to be KIT, at the expected version, with its
 *      native modules present;
 *   3. given a valid (ad-hoc) signature;
 *   4. launched against a throwaway user-data dir and seen to start.
 * The swap itself runs in a detached script (see buildSwapScript) after the
 * app quits, and rolls back if the new version does not start.
 *
 * Deliberately free of `electron` imports so it can be exercised in tests
 * against a local feed.
 */

import { spawn, execFile } from 'child_process';
import { createHash } from 'crypto';
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'fs';
import http from 'http';
import https from 'https';
import { dirname, join } from 'path';
import { promisify } from 'util';
import {
  buildSwapScript,
  parseLatestMacYml,
  pickMacZip,
  startedMarkerName,
  type InstallResult,
  type MacFeed,
  type MacFeedFile,
} from '../../shared/mac-self-update';

const execFileAsync = promisify(execFile);

export const BUNDLE_ID = 'com.sekondbrain.kit-for-devops';
/** The LaunchAgent label scripts/install-launch-agent.sh installs. */
export const LAUNCHD_LABEL = 'com.sekondbrain.kit-for-devops';
/** Set on the isolated test launch; the app hides itself and quits once its UI is up. */
export const SMOKE_ENV = 'KIT_UPDATE_SMOKE_DIR';
const GITHUB_RELEASES = 'https://github.com/SeKondBrainAILabs/DevOps-Agent-KIT/releases';

export interface MacSelfUpdaterOptions {
  /** <userData>/updates — staging, rollback, markers and results live here. */
  updatesDir: string;
  /** The running bundle, e.g. /Applications/KIT for DevOps.app */
  appPath: string;
  currentVersion: string;
  arch: string;
  userAgent: string;
  log: (message: string, details?: Record<string, unknown>) => void;
  /**
   * Base URL holding latest-mac.yml and the zips. Defaults to the latest
   * GitHub release. KIT_UPDATE_FEED_BASE overrides it, for testing.
   */
  feedBase?: string;
  /** How long the isolated test launch may take. */
  smokeTimeoutMs?: number;
}

export type Readiness = { ok: true } | { ok: false; reason: string };

export class MacSelfUpdater {
  constructor(private readonly opts: MacSelfUpdaterOptions) {}

  /**
   * The feed override, accepted only as https or a loopback http server (for
   * testing). The feed carries the checksums, so it must not be redirectable
   * to an arbitrary plain-http host.
   */
  private get feedBase(): string | undefined {
    const base = this.opts.feedBase || process.env.KIT_UPDATE_FEED_BASE || undefined;
    if (!base) return undefined;
    if (/^https:\/\//i.test(base) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(base)) {
      return base;
    }
    this.opts.log('Ignoring update feed override that is not https or loopback', { base });
    return undefined;
  }

  /**
   * Where staging and the parked old version live. It must be on the same
   * volume as the app so every move is an atomic rename, not a copy that an
   * interruption could leave half-done.
   */
  workRoot(): string {
    const appParent = dirname(this.opts.appPath);
    try {
      mkdirSync(this.opts.updatesDir, { recursive: true });
      if (statSync(this.opts.updatesDir).dev === statSync(appParent).dev) return this.opts.updatesDir;
    } catch {
      /* fall through to the sibling directory */
    }
    return join(appParent, '.kit-update');
  }

  feedUrl(): string {
    return this.feedBase
      ? `${this.feedBase.replace(/\/+$/, '')}/latest-mac.yml`
      : `${GITHUB_RELEASES}/latest/download/latest-mac.yml`;
  }

  zipUrl(version: string, file: MacFeedFile): string {
    const name = encodeURIComponent(file.url);
    return this.feedBase
      ? `${this.feedBase.replace(/\/+$/, '')}/${name}`
      : `${GITHUB_RELEASES}/download/v${version}/${name}`;
  }

  /** Can this install replace itself? Checked before downloading anything. */
  readiness(expectedBytes = 0): Readiness {
    const parent = dirname(this.opts.appPath);
    try {
      accessSync(parent, constants.W_OK);
      accessSync(this.opts.appPath, constants.W_OK);
    } catch {
      return { ok: false, reason: `${parent} is not writable by this user` };
    }
    try {
      const root = this.workRoot();
      mkdirSync(root, { recursive: true });
      const s = statfsSync(root);
      const free = Number(s.bavail) * Number(s.bsize);
      // zip + unpacked app + parked old app, with headroom.
      const needed = Math.max(expectedBytes * 8, 1_000_000_000);
      if (free < needed) {
        return { ok: false, reason: `not enough free disk space (${Math.round(free / 1e6)} MB free)` };
      }
    } catch (err) {
      return { ok: false, reason: `cannot prepare the update folder: ${(err as Error).message}` };
    }
    return { ok: true };
  }

  async fetchFeed(): Promise<MacFeed> {
    const text = await this.getText(this.feedUrl());
    const feed = parseLatestMacYml(text);
    if (!feed) throw new Error('the update feed could not be read');
    return feed;
  }

  /**
   * Download, verify, unpack, validate, sign and test-launch the update.
   * Returns the staged bundle, ready for {@link launchSwap}.
   */
  async prepare(
    feed: MacFeed,
    onProgress: (p: { percent: number; transferred: number; total: number }) => void
  ): Promise<{ stagedAppPath: string; version: string }> {
    const file = pickMacZip(feed, this.opts.arch);
    if (!file) throw new Error(`the release has no macOS ${this.opts.arch} zip`);

    const ready = this.readiness(file.size ?? 0);
    if (!ready.ok) throw new Error(ready.reason);

    const stagingRoot = join(this.workRoot(), 'staging');
    rmSync(stagingRoot, { recursive: true, force: true });
    const dir = join(stagingRoot, feed.version);
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, 'update.zip');

    this.opts.log('Downloading update', { version: feed.version, file: file.url });
    const digest = await this.download(this.zipUrl(feed.version, file), zipPath, file.size, onProgress);
    const size = statSync(zipPath).size;
    if (file.size !== undefined && size !== file.size) {
      throw new Error(`download is ${size} bytes, the feed says ${file.size}`);
    }
    if (digest !== file.sha512) {
      throw new Error('download checksum does not match the release feed');
    }
    this.opts.log('Download verified', { version: feed.version, bytes: size });

    const unpacked = join(dir, 'unpacked');
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, unpacked]);
    rmSync(zipPath, { force: true });
    const apps = readdirSync(unpacked).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`the zip holds ${apps.length} apps, expected 1`);
    const stagedAppPath = join(unpacked, apps[0]);

    await this.validateBundle(stagedAppPath, feed.version);
    await this.ensureSigned(stagedAppPath);
    await this.smokeTest(stagedAppPath, feed.version);
    this.opts.log('Update staged and test-launched', { version: feed.version, stagedAppPath });
    return { stagedAppPath, version: feed.version };
  }

  /** Is this KIT, at this version, with the native module that has to be there? */
  async validateBundle(appPath: string, version: string): Promise<void> {
    const plist = join(appPath, 'Contents', 'Info.plist');
    const read = async (key: string) =>
      (await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', plist])).stdout.trim();
    const id = await read('CFBundleIdentifier');
    if (id !== BUNDLE_ID) throw new Error(`the update is ${id}, not ${BUNDLE_ID}`);
    const v = await read('CFBundleShortVersionString');
    if (v !== version) throw new Error(`the update reports version ${v}, the feed says ${version}`);
    const resources = join(appPath, 'Contents', 'Resources');
    if (!existsSync(join(resources, 'app.asar'))) throw new Error('the update has no app.asar');
    const native = join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(native)) throw new Error('the update is missing its better-sqlite3 native module');
  }

  /**
   * Clear quarantine and require a valid signature. A bundle that fails
   * verification is rejected rather than re-signed: re-signing would paper over
   * tampering. Release builds (CI's ad-hoc afterSign) pass as they are.
   */
  async ensureSigned(appPath: string): Promise<void> {
    await execFileAsync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => undefined);
    try {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    } catch {
      throw new Error('the update failed code-signature verification');
    }
  }

  /**
   * Launch the staged app against a throwaway user-data dir and wait for it to
   * report that its window loaded. This is what catches a bundle that unpacks
   * fine but cannot start (a missing module, a signing problem that parks it
   * on a native error alert), before the working install is touched.
   */
  async smokeTest(appPath: string, version: string): Promise<void> {
    const exe = this.executableOf(appPath);
    const scratch = join(this.opts.updatesDir, 'smoke');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const marker = join(scratch, 'updates', startedMarkerName(version));

    const env: NodeJS.ProcessEnv = { ...process.env, [SMOKE_ENV]: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.KIT_UPDATE_FEED_BASE;
    const child = spawn(exe, [`--user-data-dir=${scratch}`], { detached: true, stdio: 'ignore', env });
    // If KIT quits mid-test, take the test instance down with it.
    const killNow = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    };
    process.once('exit', killNow);
    const stop = async () => {
      process.removeListener('exit', killNow);
      if (!child.pid || child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      await sleep(3000);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };

    try {
      const deadline = Date.now() + (this.opts.smokeTimeoutMs ?? 90_000);
      let exited = false;
      child.once('exit', () => { exited = true; });
      while (Date.now() < deadline) {
        if (existsSync(marker)) return;
        // The test instance quits itself once its UI is up, so check the
        // marker again before treating an exit as a failure.
        if (exited) {
          if (existsSync(marker)) return;
          throw new Error('the update exited during its test launch');
        }
        await sleep(500);
      }
      throw new Error('the update did not start during its test launch');
    } finally {
      await stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Hand over to the detached swap script. The caller must quit the app right
   * after this returns; the script waits for this PID to exit.
   */
  launchSwap(stagedAppPath: string, toVersion: string): void {
    const appName = this.opts.appPath.split('/').pop()!;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const root = this.workRoot();
    const scriptPath = join(this.opts.updatesDir, `install-${stamp}.sh`);
    writeFileSync(
      scriptPath,
      buildSwapScript({
        oldPid: process.pid,
        appPath: this.opts.appPath,
        stagedAppPath,
        parkedAppPath: join(root, 'rollback', stamp, appName),
        failedAppPath: join(root, `failed-${stamp}`, appName),
        lockDir: join(this.opts.updatesDir, 'install.lock'),
        launchdLabel: LAUNCHD_LABEL,
        startedMarkerPath: join(this.opts.updatesDir, startedMarkerName(toVersion)),
        resultPath: join(this.opts.updatesDir, 'last-install.json'),
        logPath: join(this.opts.updatesDir, 'install.log'),
        fromVersion: this.opts.currentVersion,
        toVersion,
        launchArgs: relaunchArgs(process.argv),
      }),
      { mode: 0o755 }
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore', env });
    child.unref();
    this.opts.log('Install script launched', { toVersion, scriptPath });
  }

  /** The outcome the swap script recorded, consumed once. */
  takeInstallResult(): InstallResult | null {
    const path = join(this.opts.updatesDir, 'last-install.json');
    if (!existsSync(path)) return null;
    try {
      const r = JSON.parse(readFileSync(path, 'utf-8')) as InstallResult;
      renameSync(path, `${path}.seen`);
      return r;
    } catch {
      return null;
    }
  }

  private executableOf(appPath: string): string {
    const plist = join(appPath, 'Contents', 'Info.plist');
    const text = readFileSync(plist, 'utf-8');
    const m = text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    return join(appPath, 'Contents', 'MacOS', m ? m[1] : appPath.split('/').pop()!.replace(/\.app$/, ''));
  }

  private request(url: string, depth = 0): Promise<http.IncomingMessage> {
    if (depth > 5) return Promise.reject(new Error('too many redirects'));
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { headers: { 'User-Agent': this.opts.userAgent } }, (res) => {
        const code = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          if (url.startsWith('https:') && !next.startsWith('https:')) {
            reject(new Error('refusing a redirect from https to plain http'));
            return;
          }
          resolve(this.request(next, depth + 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`${url} returned HTTP ${code}`));
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`${url} timed out`)));
    });
  }

  private async getText(url: string): Promise<string> {
    const res = await this.request(url);
    let body = '';
    for await (const chunk of res) body += chunk;
    return body;
  }

  /** Stream to disk, hashing as it goes. Resolves to the base64 sha512. */
  private async download(
    url: string,
    dest: string,
    expected: number | undefined,
    onProgress: (p: { percent: number; transferred: number; total: number }) => void
  ): Promise<string> {
    const res = await this.request(url);
    const total = expected ?? Number(res.headers['content-length'] ?? 0);
    const hash = createHash('sha512');
    const out = createWriteStream(dest);
    let transferred = 0;
    let lastPercent = -1;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        transferred += chunk.length;
        const percent = total ? Math.floor((transferred / total) * 100) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress({ percent, transferred, total });
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      res.pipe(out);
    });
    return hash.digest('base64');
  }

  /** A version that failed to start and was rolled back is not offered again. */
  blockVersion(version: string): void {
    try {
      mkdirSync(this.opts.updatesDir, { recursive: true });
      writeFileSync(join(this.opts.updatesDir, 'blocked-version'), version);
    } catch {
      /* best effort */
    }
  }

  blockedVersion(): string | null {
    try {
      return readFileSync(join(this.opts.updatesDir, 'blocked-version'), 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /** The new version's "I started" signal; written once its UI reached the main process. */
  static writeStartedMarker(updatesDir: string, version: string): void {
    try {
      mkdirSync(updatesDir, { recursive: true });
      writeFileSync(join(updatesDir, startedMarkerName(version)), new Date().toISOString());
    } catch {
      // Best effort: a missing marker only means the swap script rolls back.
    }
  }
}

/**
 * Arguments worth carrying over to the relaunched version: Chromium/Electron
 * switches like --user-data-dir. Process-serial-number arguments that macOS
 * adds when launching from Finder are dropped.
 */
export function relaunchArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => a.startsWith('--') && !a.startsWith('-psn'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
