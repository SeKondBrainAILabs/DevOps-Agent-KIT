/**
 * Search ranker (Epic L / story L1).
 *
 * Pure tokenizer + scorer for the Cmd+K palette and SearchIndexService.
 * The full FTS5 backend lives in the service; this module owns the rules
 * for breaking strings into tokens, doing case-insensitive subsequence
 * matching, and producing a deterministic score so the renderer can
 * sort hits.
 *
 * Scoring components (sum):
 *   +1000  exact match (full label === query, case-insensitive)
 *   + 500  prefix match (label starts with query)
 *   + 200  word-boundary substring match (after split on /[-/_\s.]+/)
 *   + 100  any substring match
 *   + token-coverage bonus: 30 × (matched tokens / query tokens)
 *   - 0.5 × (label.length) — short matches preferred over long ones
 */

export type ResultKind = 'repo' | 'branch' | 'commit' | 'file' | 'session' | 'pr';

export interface SearchableItem {
  /** Globally unique within the index. */
  id: string;
  kind: ResultKind;
  /** The string searched against. */
  label: string;
  /** Optional second-line context (path, sha, etc.). */
  detail?: string;
}

export interface ScoredHit {
  item: SearchableItem;
  score: number;
}

const TOKEN_SPLIT = /[-_/\\.\s]+/;

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

export function scoreItem(item: SearchableItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = item.label.toLowerCase();

  let score = 0;
  if (label === q) score += 1000;
  else if (label.startsWith(q)) score += 500;

  // Word-boundary substring
  const words = label.split(TOKEN_SPLIT);
  if (words.some((w) => w.startsWith(q))) score += 200;
  else if (label.includes(q)) score += 100;

  // Token coverage
  const queryTokens = tokenize(q);
  const labelTokens = new Set(tokenize(item.label));
  if (queryTokens.length > 0) {
    let matched = 0;
    for (const qt of queryTokens) {
      for (const lt of labelTokens) {
        if (lt.includes(qt)) {
          matched += 1;
          break;
        }
      }
    }
    score += Math.round((matched / queryTokens.length) * 30);
  }

  // Length penalty — only apply when there's a positive base score
  if (score > 0) score -= 0.5 * item.label.length;
  return score;
}

export interface SearchOptions {
  /** Limit on the number of returned hits. Default 25. */
  limit?: number;
  /** Optional kind filter. */
  kinds?: ReadonlyArray<ResultKind>;
}

/**
 * Score every item against the query and return ranked hits. Items with
 * a non-positive score are filtered out. Output is sorted by score
 * descending, then by label ascending for determinism.
 */
export function rankSearch(
  items: ReadonlyArray<SearchableItem>,
  query: string,
  options: SearchOptions = {}
): ScoredHit[] {
  const limit = options.limit ?? 25;
  const filtered = options.kinds
    ? items.filter((i) => options.kinds!.includes(i.kind))
    : items;
  const hits: ScoredHit[] = [];
  for (const item of filtered) {
    const score = scoreItem(item, query);
    if (score > 0) hits.push({ item, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.label.localeCompare(b.item.label) ||
      a.item.id.localeCompare(b.item.id)
  );
  return hits.slice(0, Math.max(0, limit));
}
