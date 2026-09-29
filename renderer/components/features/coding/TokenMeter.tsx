/**
 * TokenMeter (KC-S2.1.7): tokens per role for the selected run, as bars.
 */

import React from 'react';
import { roleTokens, type HarnessUsage } from '../../../../shared/harness-types';
import { formatTokens } from './CodingBoard';

export function TokenMeter({
  roleTotals,
  totals,
}: {
  roleTotals: Record<string, HarnessUsage> | undefined;
  totals?: HarnessUsage;
}): React.ReactElement {
  const rows = roleTokens(roleTotals);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const all = totals ? totals.tokens_in + totals.tokens_out : rows.reduce((n, r) => n + r.total, 0);
  const cost = totals?.cost ?? rows.reduce((n, r) => n + r.cost, 0);
  return (
    <section className="card p-4" data-testid="token-meter" aria-label="Tokens per role">
      <div className="flex items-baseline justify-between">
        <h3 className="kb-eyebrow">Tokens per role</h3>
        <span className="text-xs text-text-secondary">
          {formatTokens(all)} total{cost > 0 ? ` · $${cost.toFixed(2)}` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">No model sessions yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.role} data-testid={`tokens-${row.role}`}>
              <div className="flex justify-between text-xs">
                <span className="font-medium">{row.role}</span>
                <span className="text-text-secondary">
                  {formatTokens(row.total)} ({formatTokens(row.tokens_in)} in / {formatTokens(row.tokens_out)} out)
                  {row.sessions > 1 ? ` · ${row.sessions} sessions` : ''}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-[rgba(0,0,0,0.06)]">
                <div className="h-1.5 rounded-full bg-accent-blue" style={{ width: `${(row.total / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
