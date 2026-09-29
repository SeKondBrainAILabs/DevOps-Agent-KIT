/**
 * HarnessOffline (KC-S2.1.2 AC3): what the Coding tab shows when the harness
 * is not configured, refuses the token or cannot be reached.
 */

import React from 'react';
import type { HarnessLoadState } from '../../../hooks/useHarness';

const COPY: Record<string, { title: string; body: string }> = {
  unconfigured: {
    title: 'Connect KIT Harness',
    body: 'Set the harness URL (for example http://mac-mini:39200/mcp) and its token in Settings → Credentials.',
  },
  unauthorized: {
    title: 'KIT Harness refused the token',
    body: 'Check the token in Settings → Credentials; it must match KIT_HARNESS_TOKEN on the harness.',
  },
  offline: {
    title: 'KIT Harness is offline',
    body: 'Kanvas cannot reach the harness. Check that kit-harness serve is running and the URL in Settings is right. Retrying automatically.',
  },
};

export function HarnessOffline({
  state,
  error,
  onOpenSettings,
  onRetry,
  compact = false,
}: {
  state: HarnessLoadState;
  error?: string;
  onOpenSettings: () => void;
  onRetry: () => void;
  compact?: boolean;
}): React.ReactElement {
  const copy = COPY[state] ?? COPY.offline;
  if (compact) {
    return (
      <div role="status" data-testid="harness-offline-banner" className="mx-4 mt-3 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.06)] px-3 py-2 text-sm flex items-center justify-between gap-3">
        <span><strong>{copy.title}.</strong> Showing the last known state.</span>
        <button type="button" className="kb-btn-sm" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center p-8" data-testid="harness-offline" data-state={state}>
      <div role="status" className="max-w-md text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-surface-tertiary flex items-center justify-center">
          <svg className="h-6 w-6 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="mt-2 text-sm text-text-secondary">{copy.body}</p>
        {error && <p className="mt-2 font-mono text-xs text-text-secondary break-words">{error}</p>}
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" className="btn-primary" onClick={onOpenSettings}>Open Settings</button>
          <button type="button" className="kb-btn" onClick={onRetry}>Retry</button>
        </div>
      </div>
    </div>
  );
}
