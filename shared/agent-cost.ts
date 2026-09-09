/**
 * Agent cost calculator + badge formatter (Epic N / story N4).
 *
 * Pure helpers used by:
 *  - AgentInstanceService (N5) when persisting per-session totals
 *  - The renderer's Agent Cost Badge (U32) for display
 *
 * Rates are configurable per model so the user can adjust as Anthropic /
 * OpenAI / etc. update pricing without a code change.
 */

export interface ModelRate {
  /** Model key as reported by the agent (e.g. 'claude-sonnet-4'). */
  model: string;
  /** Dollars per 1M input tokens. */
  inputUsdPerMTokens: number;
  /** Dollars per 1M output tokens. */
  outputUsdPerMTokens: number;
  /** Optional cache-read rate; falls back to input rate when absent. */
  cacheReadUsdPerMTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/** Default catalog — values are illustrative; user can override at runtime. */
export const DEFAULT_MODEL_RATES: ReadonlyArray<ModelRate> = [
  { model: 'claude-opus-4',   inputUsdPerMTokens: 15, outputUsdPerMTokens: 75, cacheReadUsdPerMTokens: 1.5 },
  { model: 'claude-sonnet-4', inputUsdPerMTokens: 3,  outputUsdPerMTokens: 15, cacheReadUsdPerMTokens: 0.3 },
  { model: 'claude-haiku-4',  inputUsdPerMTokens: 0.25, outputUsdPerMTokens: 1.25, cacheReadUsdPerMTokens: 0.025 },
];

export function findRate(
  model: string,
  catalog: ReadonlyArray<ModelRate> = DEFAULT_MODEL_RATES
): ModelRate | undefined {
  return catalog.find((r) => r.model === model);
}

export function computeUsdCost(
  usage: TokenUsage,
  rate: ModelRate
): number {
  const inUsd = (usage.inputTokens / 1_000_000) * rate.inputUsdPerMTokens;
  const outUsd = (usage.outputTokens / 1_000_000) * rate.outputUsdPerMTokens;
  const cacheRate = rate.cacheReadUsdPerMTokens ?? rate.inputUsdPerMTokens;
  const cacheUsd = ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheRate;
  return inUsd + outUsd + cacheUsd;
}

/**
 * Sum a session's per-call usages into a single total.
 * Each entry can use a different model — the catalog is consulted per entry.
 */
export interface SessionUsageEntry {
  model: string;
  usage: TokenUsage;
}

export function sumSessionUsage(
  entries: ReadonlyArray<SessionUsageEntry>,
  catalog: ReadonlyArray<ModelRate> = DEFAULT_MODEL_RATES
): { totalTokens: number; totalUsd: number; unmatchedModels: string[] } {
  let totalTokens = 0;
  let totalUsd = 0;
  const unmatched = new Set<string>();
  for (const e of entries) {
    totalTokens += e.usage.inputTokens + e.usage.outputTokens + (e.usage.cacheReadTokens ?? 0);
    const rate = findRate(e.model, catalog);
    if (!rate) {
      unmatched.add(e.model);
      continue;
    }
    totalUsd += computeUsdCost(e.usage, rate);
  }
  return { totalTokens, totalUsd, unmatchedModels: Array.from(unmatched).sort() };
}

/** Format a token count as a compact badge string ("12.3k", "1.2M"). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(tokens / 1_000_000).toFixed(2).replace(/\.00$/, '').replace(/0$/, '')}M`;
}

/** Format a USD amount as a compact badge string. */
export function formatUsdCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** Build the full badge label, e.g. "12.3k · $0.45". */
export function formatCostBadge(tokens: number, usd: number): string {
  return `${formatTokenCount(tokens)} · ${formatUsdCost(usd)}`;
}
