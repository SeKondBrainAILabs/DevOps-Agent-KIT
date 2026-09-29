/**
 * Protected paths (KC-S3.1.2). A session can protect paths or globs so that
 * kit_commit in that SAME session refuses a commit touching them: KIT Harness
 * protects the Test Writer's tests before the Coder, which commits through the
 * same session, gets to work.
 *
 * Advisory locks only warn OTHER sessions; a protection binds its own session.
 */

export interface PathProtection {
  /** A repo-relative path or glob: `tests/**`, `src/*.test.ts`, `tests/` or `tests`. */
  pattern: string;
  sessionId: string;
  protectedAt: string;
  reason?: string;
}

export interface ProtectedPathHit {
  path: string;
  pattern: string;
}

/** Error code kit_commit returns when a commit would touch a protected path. */
export const PROTECTED_PATH = 'PROTECTED_PATH';

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Glob to RegExp. `**` spans directories, `*` and `?` stay within one segment.
 * A pattern with no glob characters matches the path itself and, as a
 * directory, everything under it; a trailing slash means the same.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = normalise(pattern);
  let suffix = '';
  if (p.endsWith('/')) p += '**';
  else if (!/[*?]/.test(p)) suffix = '(?:/.*)?'; // a plain path also covers a directory's contents
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}${suffix}$`);
}

export function matchesPathPattern(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalise(filePath));
}

/** The paths that fall under any of the protections, each with the first pattern it hit. */
export function protectedHits(paths: string[], protections: PathProtection[]): ProtectedPathHit[] {
  const hits: ProtectedPathHit[] = [];
  for (const filePath of paths) {
    const hit = protections.find((p) => matchesPathPattern(filePath, p.pattern));
    if (hit) hits.push({ path: normalise(filePath), pattern: hit.pattern });
  }
  return hits;
}
