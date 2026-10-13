/**
 * Pure parts of the macOS self-updater (S9N ticket "KIT: the Mac app never
 * installs its own updates", stopgap option).
 *
 * KIT is ad-hoc signed, so Squirrel.Mac cannot install updates and the app
 * used to stop at "Update available" and open the release page — installs
 * sat on old versions indefinitely. The stopgap downloads the release zip
 * named in latest-mac.yml, verifies it against the feed's sha512, test-launches
 * it in isolation, and has a detached script swap it in with automatic
 * rollback. Everything here is free of I/O so it can be tested directly.
 */

export interface MacFeedFile {
  url: string;
  sha512: string;
  size?: number;
}

export interface MacFeed {
  version: string;
  files: MacFeedFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
}

const unquote = (v: string) => v.trim().replace(/^['"]|['"]$/g, '');

/**
 * Parse the latest-mac.yml electron-builder publishes. The shape is fixed and
 * small, so a line parser is enough and avoids a YAML dependency.
 */
export function parseLatestMacYml(text: string): MacFeed | null {
  const feed: MacFeed = { version: '', files: [] };
  let current: Partial<MacFeedFile> | null = null;
  let inFiles = false;
  const flush = () => {
    if (current?.url && current.sha512) feed.files.push(current as MacFeedFile);
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const top = raw.match(/^([A-Za-z][\w]*):\s*(.*)$/);
    if (top) {
      flush();
      inFiles = top[1] === 'files';
      const [, key, value] = top;
      if (key === 'version') feed.version = unquote(value);
      else if (key === 'path') feed.path = unquote(value);
      else if (key === 'sha512') feed.sha512 = unquote(value);
      else if (key === 'releaseDate') feed.releaseDate = unquote(value);
      continue;
    }
    if (!inFiles) continue;
    const item = raw.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const field = raw.match(/^\s+(\w+):\s*(.*)$/);
    const kv = item ?? field;
    if (!kv) continue;
    if (item) flush();
    current = current ?? {};
    const [, key, value] = kv;
    if (key === 'url') current.url = unquote(value);
    else if (key === 'sha512') current.sha512 = unquote(value);
    else if (key === 'size') current.size = Number(unquote(value));
  }
  flush();
  return feed.version ? feed : null;
}

/**
 * The zip for this machine. electron-builder names the Apple Silicon zip
 * `<name>-<version>-arm64-mac.zip` and the Intel one `<name>-<version>-mac.zip`.
 * Only zips: a dmg needs mounting and cannot be verified as simply.
 */
export function pickMacZip(feed: MacFeed, arch: string): MacFeedFile | null {
  const zips = feed.files.filter((f) => /\.zip$/i.test(f.url));
  if (arch === 'arm64') return zips.find((f) => /-arm64-mac\.zip$/i.test(f.url)) ?? null;
  return zips.find((f) => /-mac\.zip$/i.test(f.url) && !/-arm64-/i.test(f.url)) ?? null;
}

/** True when `candidate` is a strictly newer x.y.z than `current`. Pre-release tags are never offered. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The `.app` bundle the running binary lives in, or null when not run from a bundle. */
export function appBundleFromExecPath(execPath: string): string | null {
  const m = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

/** Marker the new version writes once its window has loaded — the "it really started" signal. */
export function startedMarkerName(version: string): string {
  return `started-${version}`;
}

export interface SwapScriptInput {
  /** PID of the running (old) app, which the script waits on. */
  oldPid: number;
  /** Bundle being replaced, e.g. /Applications/KIT for DevOps.app */
  appPath: string;
  /** Verified, test-launched new bundle. Must be on the same volume as appPath. */
  stagedAppPath: string;
  /**
   * Where the old bundle is parked. Unique per run (a timestamped directory),
   * so a second run can never delete the copy a first run depends on.
   */
  parkedAppPath: string;
  /** Where a failed new bundle is moved before the old one is restored. Unique per run. */
  failedAppPath: string;
  /** Directory whose existence is the install lock. */
  lockDir: string;
  /** Marker the new version writes when its UI is up (see startedMarkerName). */
  startedMarkerPath: string;
  /** JSON file the script writes its outcome to; read by the next launch. */
  resultPath: string;
  logPath: string;
  fromVersion: string;
  toVersion: string;
  /** How long the new version gets to start before it is rolled back. Default 300. */
  startTimeoutSeconds?: number;
  /** How long the old app gets to quit before the swap is abandoned. Default 60. */
  quitTimeoutSeconds?: number;
  /** Command that launches a bundle. Default `open`; tests substitute a stub. */
  launchCommand?: string;
  /**
   * Arguments the app was started with (e.g. --user-data-dir), passed to the
   * relaunched version so it comes back on the same data.
   */
  launchArgs?: string[];
  /**
   * LaunchAgent label. When a loaded job with this label runs this bundle, the
   * new version is started through launchd, so it stays supervised.
   */
  launchdLabel?: string;
}

/** Single-quote for bash, safe for any path (spaces, quotes, $). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The detached bash script that performs the swap after the app quits.
 *
 * Invariants, each of which a reviewer broke an earlier draft on:
 *   - one install at a time (a lock directory, with stale-lock takeover);
 *   - nothing is moved while any process still runs from the bundle — that
 *     covers a second KIT profile and a launchd relaunch of the old version;
 *   - the live path is never deleted, only renamed aside, and every move into
 *     it first checks that it is empty, so a partial failure cannot nest one
 *     bundle inside another;
 *   - every move is checked, and the outcome written reflects what happened;
 *   - only processes started from the bundle after the swap are ever killed.
 */
export function buildSwapScript(input: SwapScriptInput): string {
  const q = shQuote;
  const timeout = input.startTimeoutSeconds ?? 300;
  const quitTicks = (input.quitTimeoutSeconds ?? 60) * 2;
  const termTick = Math.floor(quitTicks / 2);
  return `#!/bin/bash
set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
LOG=${q(input.logPath)}
RESULT=${q(input.resultPath)}
LOCK=${q(input.lockDir)}
APP=${q(input.appPath)}
STAGED=${q(input.stagedAppPath)}
PARKED=${q(input.parkedAppPath)}
FAILED=${q(input.failedAppPath)}
MARKER=${q(input.startedMarkerPath)}
OLD_PID=${Number(input.oldPid)}
FROM=${q(input.fromVersion)}
TO=${q(input.toVersion)}
LAUNCH=${q(input.launchCommand ?? 'open')}
LABEL=${q(input.launchdLabel ?? '')}
ARGS=(${(input.launchArgs ?? []).map(q).join(' ')})
BIN="$APP/Contents/MacOS/"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }
esc() { local s="\${1//\\\\/\\\\\\\\}"; s="\${s//\\"/\\\\\\"}"; printf '%s' "$s"; }
result() {
  printf '{"from":"%s","to":"%s","outcome":"%s","detail":"%s","at":"%s"}\n' \
    "$(esc "$FROM")" "$(esc "$TO")" "$1" "$(esc "$2")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT"
}

# PIDs of processes whose command line starts with this bundle's MacOS dir.
# A prefix match on the literal path — no regex, so dots and spaces are safe.
bundle_pids() {
  ps -axo pid=,command= | while read -r pid cmd; do
    case "$cmd" in "$BIN"*) echo "$pid" ;; esac
  done
}

# -n: always start this bundle, never just activate another running copy.
# The \${ARGS[@]+...} form keeps an empty array legal under set -u in bash 3.2.
launch_app() {
  if [ "$LAUNCH" != open ]; then
    "$LAUNCH" "$APP" \${ARGS[@]+"\${ARGS[@]}"}
    return
  fi
  if [ -n "$LABEL" ] && launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -qF "$BIN"; then
    log "starting through launchd job $LABEL"
    launchctl kickstart "gui/$(id -u)/$LABEL" && return
  fi
  open -n "$APP" \${ARGS[@]+--args "\${ARGS[@]}"}
}

# Put the old version back. Never deletes the live path: whatever is there is
# renamed aside first, and the restore only happens into an empty path.
restore_old() {
  mkdir -p "$(dirname "$FAILED")"
  if [ -e "$APP" ] && ! mv "$APP" "$FAILED"; then
    log "ROLLBACK FAILED: could not move the new version aside; previous version is at $PARKED"
    result rollback_failed "the previous version is at $PARKED"
    exit 2
  fi
  if [ -e "$APP" ] || ! mv "$PARKED" "$APP"; then
    log "ROLLBACK FAILED: previous version is at $PARKED"
    result rollback_failed "the previous version is at $PARKED"
    exit 2
  fi
  log "restored $FROM: $1"
  result rolled_back "$1"
  launch_app
  rm -rf "$(dirname "$FAILED")" 2>/dev/null
  exit 1
}

# ── one install at a time ────────────────────────────────────────────────
if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "another install ($holder) is already running; this one exits"
    exit 3
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { log "could not take the install lock"; exit 3; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

log "update $FROM -> $TO: waiting for pid $OLD_PID to exit"
i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -eq ${termTick} ]; then log "still running, sending TERM"; kill -TERM "$OLD_PID" 2>/dev/null; fi
  if [ "$i" -ge ${quitTicks} ]; then
    log "old app did not exit; nothing was changed"
    result aborted "the running app did not quit"
    exit 1
  fi
  sleep 0.5
done
log "old app exited"

# Helpers may outlive the main process briefly; anything still running from
# the bundle after that is another instance (a second profile, or launchd
# relaunching the old version) and moving the bundle under it is unsafe.
for _ in $(seq 1 30); do
  [ -z "$(bundle_pids)" ] && break
  sleep 0.5
done
if [ -n "$(bundle_pids)" ]; then
  log "another KIT is still running from $APP: $(bundle_pids | tr '\n' ' '); nothing was changed"
  result aborted "another copy of KIT is still running"
  exit 1
fi
if [ ! -d "$STAGED" ]; then
  log "staged update missing at $STAGED; nothing was changed"
  result aborted "the downloaded update is missing"
  exit 1
fi

rm -f "$MARKER"
mkdir -p "$(dirname "$PARKED")"
if [ -e "$PARKED" ] || ! mv "$APP" "$PARKED"; then
  log "could not move the current app aside; nothing was changed"
  result aborted "could not move the current app aside"
  [ -e "$APP" ] && launch_app
  exit 1
fi
if [ -e "$APP" ] || ! mv "$STAGED" "$APP"; then
  log "could not move the new app into place"
  restore_old "could not move the new app into place"
fi
log "new app in place; launching"
launch_app

for _ in $(seq 1 ${timeout}); do
  if [ -f "$MARKER" ]; then
    log "version $TO started"
    result updated "started"
    # Keep only this run's parked copy.
    for d in "$(dirname "$(dirname "$PARKED")")"/*; do
      [ "$d" = "$(dirname "$PARKED")" ] || rm -rf "$d"
    done
    exit 0
  fi
  sleep 1
done

log "version $TO did not start within ${timeout}s; rolling back"
for pid in $(bundle_pids); do kill -TERM "$pid" 2>/dev/null; done
for _ in $(seq 1 20); do [ -z "$(bundle_pids)" ] && break; sleep 0.5; done
for pid in $(bundle_pids); do kill -KILL "$pid" 2>/dev/null; done
restore_old "the new version did not start within ${timeout}s"
`;
}

export interface InstallResult {
  from: string;
  to: string;
  outcome: 'updated' | 'rolled_back' | 'aborted' | 'rollback_failed';
  detail: string;
  at: string;
}

/** What to tell the user on the next launch, or null when there is nothing to say. */
export function describeInstallResult(r: InstallResult, runningVersion: string): string | null {
  if (r.outcome === 'updated') {
    // The script saw the new version start, but this launch is not it: the
    // user (or launchd) brought the old bundle back some other way.
    return r.to === runningVersion
      ? null
      : `v${r.to} was installed, but v${runningVersion} is the version running now.`;
  }
  if (r.outcome === 'rolled_back')
    return `Update to v${r.to} failed and v${r.from} was restored: ${r.detail}.`;
  if (r.outcome === 'aborted') return `Update to v${r.to} did not run: ${r.detail}.`;
  return `Update to v${r.to} failed and could not restore v${r.from} automatically: ${r.detail}.`;
}
