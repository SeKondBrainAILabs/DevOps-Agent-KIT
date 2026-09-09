/**
 * Unit Tests for N4 — Agent cost calc + badge formatter
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_MODEL_RATES,
  computeUsdCost,
  findRate,
  formatCostBadge,
  formatTokenCount,
  formatUsdCost,
  sumSessionUsage,
} from '../../../shared/agent-cost';

describe('findRate (N4)', () => {
  it('returns the matching rate', () => {
    expect(findRate('claude-sonnet-4')?.outputUsdPerMTokens).toBe(15);
  });
  it('returns undefined on miss', () => {
    expect(findRate('unknown-model')).toBeUndefined();
  });
  it('honors a custom catalog', () => {
    const custom = [{ model: 'gpt-foo', inputUsdPerMTokens: 5, outputUsdPerMTokens: 10 }];
    expect(findRate('gpt-foo', custom)?.outputUsdPerMTokens).toBe(10);
  });
});

describe('computeUsdCost (N4)', () => {
  const rate = DEFAULT_MODEL_RATES.find((r) => r.model === 'claude-sonnet-4')!;

  it('computes input + output cost', () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(computeUsdCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rate)).toBe(18);
  });

  it('uses cacheReadUsdPerMTokens when provided', () => {
    // 1M cache @ $0.30 + 0 input + 0 output = $0.30
    const cost = computeUsdCost(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      rate
    );
    expect(cost).toBeCloseTo(0.3, 5);
  });

  it('falls back to input rate when cache rate not set', () => {
    const noCache = { ...rate, cacheReadUsdPerMTokens: undefined };
    const cost = computeUsdCost(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      noCache
    );
    expect(cost).toBeCloseTo(3, 5); // input rate $3
  });
});

describe('sumSessionUsage (N4)', () => {
  it('sums tokens across mixed-model entries and computes total $', () => {
    const r = sumSessionUsage([
      { model: 'claude-sonnet-4', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
      { model: 'claude-haiku-4', usage: { inputTokens: 500_000, outputTokens: 50_000 } },
    ]);
    // sonnet:  3 + (15 * 0.1) = 3 + 1.5 = 4.5
    // haiku:   (0.25 * 0.5) + (1.25 * 0.05) = 0.125 + 0.0625 = 0.1875
    expect(r.totalUsd).toBeCloseTo(4.6875);
    expect(r.totalTokens).toBe(1_000_000 + 100_000 + 500_000 + 50_000);
    expect(r.unmatchedModels).toEqual([]);
  });

  it('reports unmatched models without throwing', () => {
    const r = sumSessionUsage([
      { model: 'claude-sonnet-4', usage: { inputTokens: 100, outputTokens: 100 } },
      { model: 'mystery-model', usage: { inputTokens: 50, outputTokens: 50 } },
    ]);
    expect(r.unmatchedModels).toEqual(['mystery-model']);
    expect(r.totalUsd).toBeGreaterThan(0); // sonnet still counted
    expect(r.totalTokens).toBe(300);
  });
});

describe('formatTokenCount (N4)', () => {
  it('returns small numbers as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(999)).toBe('999');
  });
  it('uses k for thousands', () => {
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(12_345)).toBe('12.3k');
    expect(formatTokenCount(999_999)).toBe('1000k'); // intentional: stays in k bucket
  });
  it('uses M for millions', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(2_000_000)).toBe('2M');
  });
  it('handles negative / non-finite gracefully', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(Infinity)).toBe('0');
  });
});

describe('formatUsdCost (N4)', () => {
  it('shows <$0.01 for tiny amounts', () => {
    expect(formatUsdCost(0.001)).toBe('<$0.01');
    expect(formatUsdCost(0)).toBe('$0');
  });
  it('shows two-decimals up to $100', () => {
    expect(formatUsdCost(0.42)).toBe('$0.42');
    expect(formatUsdCost(12.34)).toBe('$12.34');
    expect(formatUsdCost(99.99)).toBe('$99.99');
  });
  it('rounds to whole dollars beyond $100', () => {
    expect(formatUsdCost(100.5)).toBe('$101');
    expect(formatUsdCost(1234.56)).toBe('$1235');
  });
  it('handles negative / non-finite gracefully', () => {
    expect(formatUsdCost(-1)).toBe('$0');
    expect(formatUsdCost(NaN)).toBe('$0');
  });
});

describe('formatCostBadge (N4)', () => {
  it('combines tokens + usd', () => {
    expect(formatCostBadge(12_345, 0.45)).toBe('12.3k · $0.45');
  });
});
