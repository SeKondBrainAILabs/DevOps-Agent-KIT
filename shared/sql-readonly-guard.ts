/**
 * SQL read-only guard (Epic I / story I3).
 *
 * The DB Query Library only ships read-only saved queries. Before sending
 * a query to a remote DB via `docker exec`, this guard verifies the query
 * is read-only and does not contain any write keywords or multi-statement
 * separators that could sneak past the UI.
 *
 * This is defense-in-depth — it does NOT replace setting the connection's
 * user to read-only at the DB level.
 */

const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'GRANT',
  'REVOKE',
  'REPLACE',
  'MERGE',
  'CALL',
  'COPY',
  'EXEC',
  'EXECUTE',
  'VACUUM',
];

export interface SqlGuardOptions {
  /** Allow multi-statement queries (default false). */
  allowMultiStatement?: boolean;
}

export type SqlGuardKind = 'allowed' | 'blocked-keyword' | 'blocked-multi-statement' | 'blocked-empty';

export interface SqlGuardResult {
  ok: boolean;
  kind: SqlGuardKind;
  /** Normalized query (line/comment stripped) used for evaluation. */
  normalized: string;
  /** Specific keyword that triggered the block, when applicable. */
  keyword?: string;
  message?: string;
}

/** Strip /* ... *\/, -- line comments, and # comments. Returns lowercase result. */
export function normalizeSql(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/(^|\s)#.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function evaluateSqlGuard(
  query: string,
  options: SqlGuardOptions = {}
): SqlGuardResult {
  const normalized = normalizeSql(query);
  if (!normalized) {
    return {
      ok: false,
      kind: 'blocked-empty',
      normalized,
      message: 'Query is empty.',
    };
  }

  // Multi-statement check — strip a trailing single semicolon (common in saved
  // queries) before deciding it's "multi".
  const trimmedSemis = normalized.replace(/;\s*$/, '');
  if (!options.allowMultiStatement && trimmedSemis.includes(';')) {
    return {
      ok: false,
      kind: 'blocked-multi-statement',
      normalized,
      message:
        'Multi-statement queries are blocked by the read-only library. ' +
        'Run statements one at a time.',
    };
  }

  // Word-boundary keyword match.
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw.toLowerCase()}\\b`);
    if (re.test(normalized)) {
      return {
        ok: false,
        kind: 'blocked-keyword',
        normalized,
        keyword: kw,
        message: `${kw} statements are blocked by the read-only library.`,
      };
    }
  }

  return { ok: true, kind: 'allowed', normalized };
}
