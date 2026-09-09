/**
 * electron-builder afterPack hook.
 *
 * Signs the entire app bundle with an ad-hoc identity after packing so
 * every binary inside shares the same empty Team ID.  Without this step
 * macOS rejects the app at launch with:
 *   "mapping process and mapped file (non-platform) have different Team IDs"
 *
 * IMPORTANT: codesign --deep signs outside-in, which is wrong for Electron.
 * We must sign inside-out: frameworks/helpers first, then the main .app last.
 *
 * Runs on macOS only; no-ops silently on other platforms.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function sign(target) {
  if (!fs.existsSync(target)) return;
  console.log(`[afterPack] Signing: ${path.basename(target)}`);
  execSync(`codesign --force --sign - "${target}"`, { stdio: 'inherit' });
}

function signDeep(target) {
  if (!fs.existsSync(target)) return;
  console.log(`[afterPack] Deep-signing: ${path.basename(target)}`);
  // Sign all nested executables inside a .framework or .app first, then the bundle itself
  execSync(`find "${target}" -type f \\( -perm -0111 -o -name "*.dylib" -o -name "*.so" \\) | while read f; do codesign --force --sign - "$f" 2>/dev/null || true; done`, { stdio: 'inherit', shell: true });
  execSync(`codesign --force --sign - "${target}"`, { stdio: 'inherit' });
}

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  console.log(`[afterPack] Ad-hoc re-signing (inside-out): ${appPath}`);

  // Step 1: Sign Electron Framework first (innermost — contains the runtime)
  const electronFramework = path.join(frameworksDir, 'Electron Framework.framework');
  signDeep(electronFramework);

  // Step 2: Sign helper .app bundles
  const helpers = [
    'KIT for DevOps Helper (GPU).app',
    'KIT for DevOps Helper (Plugin).app',
    'KIT for DevOps Helper (Renderer).app',
    'KIT for DevOps Helper.app',
  ];
  for (const helper of helpers) {
    const helperPath = path.join(frameworksDir, helper);
    signDeep(helperPath);
  }

  // Step 3: Sign other frameworks (Squirrel, Mantle, ReactiveObjC)
  if (fs.existsSync(frameworksDir)) {
    const entries = fs.readdirSync(frameworksDir);
    for (const entry of entries) {
      if (entry.endsWith('.framework') && entry !== 'Electron Framework.framework') {
        signDeep(path.join(frameworksDir, entry));
      }
    }
  }

  // Step 4: Sign the main .app last (outermost)
  console.log(`[afterPack] Signing main app bundle last`);
  execSync(`codesign --force --sign - "${appPath}"`, { stdio: 'inherit' });

  console.log('[afterPack] Re-sign complete.');
};
