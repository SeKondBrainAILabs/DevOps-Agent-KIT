/**
 * Version utilities for package.json version management.
 * Supports xx.yy.zz semver scheme:
 *   xx (major) = manual only
 *   yy (minor) = increments on merge to parent branch
 *   zz (patch) = increments on daily rollover
 */

import fs from 'fs';
import path from 'path';

/**
 * Parse a semver version string into its components.
 * @param {string} versionStr - Version string like "1.2.3"
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseVersion(versionStr) {
  if (!versionStr || typeof versionStr !== 'string') {
    return { major: 0, minor: 0, patch: 0 };
  }

  const parts = versionStr.trim().split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return { major: 0, minor: 0, patch: 0 };
  }

  return { major, minor, patch };
}

/**
 * Bump the version in package.json for the given component.
 *   'minor' => xx.(yy+1).0   (patch resets)
 *   'patch' => xx.yy.(zz+1)
 *   'major' => (xx+1).0.0    (minor and patch reset)
 *
 * @param {string} repoRoot - Absolute path to the repo root containing package.json
 * @param {'major' | 'minor' | 'patch'} component - Which version component to bump
 * @returns {string | null} The new version string, or null on failure
 */
export function bumpPackageVersion(repoRoot, component) {
  try {
    const pkgPath = path.join(repoRoot, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      console.error('[version-utils] package.json not found at', pkgPath);
      return null;
    }

    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const current = parseVersion(pkg.version);

    let newVersion;
    switch (component) {
      case 'major':
        newVersion = `${current.major + 1}.0.0`;
        break;
      case 'minor':
        newVersion = `${current.major}.${current.minor + 1}.0`;
        break;
      case 'patch':
        newVersion = `${current.major}.${current.minor}.${current.patch + 1}`;
        break;
      default:
        console.error('[version-utils] Unknown component:', component);
        return null;
    }

    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log(`[version-utils] Bumped version: ${pkg.version ? current.major + '.' + current.minor + '.' + current.patch : '?'} -> ${newVersion} (${component})`);

    return newVersion;
  } catch (err) {
    console.error('[version-utils] Failed to bump version:', err.message);
    return null;
  }
}
