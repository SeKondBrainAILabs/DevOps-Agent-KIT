/**
 * electron-builder afterSign hook.
 *
 * Runs AFTER electron-builder's own signing step, just before DMG creation.
 * This ensures our inside-out re-signing is the final step and cannot be
 * overwritten by electron-builder's signing pass.
 *
 * Why afterSign instead of afterPack:
 *   afterPack → electron-builder signs → our signing is OVERWRITTEN (broken)
 *   afterPack → electron-builder signs → afterSign → DMG (correct)
 *
 * Why inside-out order matters:
 *   codesign --deep signs outside-in. On macOS 26+, DYLD enforces that all
 *   binaries in a process share the same Team ID. The Electron Framework binary
 *   ships with the Electron Project's Team ID. We must re-sign it (and every
 *   nested binary) to ad-hoc (no Team ID) before sealing the outer bundle.
 *
 * Order: Electron Framework binary → helper .apps → other frameworks → main .app
 */

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function signTarget(target) {
  if (!fs.existsSync(target)) return;
  // Ensure writable before signing
  execSync(`chmod -R u+w "${target}"`, { stdio: 'pipe' });
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], { stdio: 'inherit' });
}

function signBundleInsideOut(bundlePath) {
  if (!fs.existsSync(bundlePath)) return;
  const name = path.basename(bundlePath);
  console.log(`[afterSign] Signing: ${name}`);

  // Make everything writable
  execSync(`chmod -R u+w "${bundlePath}"`, { stdio: 'pipe' });

  // Sign every executable and dylib inside the bundle first
  const result = execSync(
    `find "${bundlePath}" -type f \\( -perm +0111 -o -name "*.dylib" -o -name "*.so" \\)`,
    { encoding: 'utf8', stdio: 'pipe' }
  );
  const files = result.trim().split('\n').filter(Boolean);
  for (const f of files) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', f], { stdio: 'pipe' });
    } catch {
      // Some files inside frameworks are not signable (e.g. resource files) — skip them
    }
  }

  // Now seal the bundle itself
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', bundlePath], { stdio: 'inherit' });
}

module.exports = async function afterSign(context) {
  if (process.platform !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  if (!fs.existsSync(appPath)) {
    console.log('[afterSign] App bundle not found, skipping.');
    return;
  }

  console.log(`[afterSign] Inside-out re-signing: ${appPath}`);
  console.log('[afterSign] (runs after electron-builder sign — final step before DMG)');

  // 1. Electron Framework (innermost — contains the Electron Project Team ID)
  signBundleInsideOut(path.join(frameworksDir, 'Electron Framework.framework'));

  // 2. Helper .app bundles
  for (const helper of [
    'KIT for DevOps Helper (GPU).app',
    'KIT for DevOps Helper (Plugin).app',
    'KIT for DevOps Helper (Renderer).app',
    'KIT for DevOps Helper.app',
  ]) {
    signBundleInsideOut(path.join(frameworksDir, helper));
  }

  // 3. Other frameworks (Squirrel, Mantle, ReactiveObjC)
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (entry.endsWith('.framework') && entry !== 'Electron Framework.framework') {
        signBundleInsideOut(path.join(frameworksDir, entry));
      }
    }
  }

  // 4. Main app bundle (outermost — must be last)
  console.log('[afterSign] Sealing main app bundle');
  execSync(`chmod -R u+w "${appPath}"`, { stdio: 'pipe' });
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });

  // Verify the critical binary
  const efBinary = path.join(frameworksDir, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  if (fs.existsSync(efBinary)) {
    const info = execSync(`codesign -dv "${efBinary}" 2>&1`, { encoding: 'utf8' });
    const teamLine = info.match(/TeamIdentifier=(.+)/)?.[1] ?? 'unknown';
    console.log(`[afterSign] Electron Framework TeamIdentifier=${teamLine}`);
    if (teamLine !== 'not set') {
      throw new Error(`[afterSign] FATAL: Electron Framework still has TeamIdentifier=${teamLine}. Signing failed.`);
    }
  }

  console.log('[afterSign] Re-sign complete. All binaries: TeamIdentifier=not set');
};
