/**
 * EvidencePanel (KC-S2.1.6): per acceptance criterion, pass or fail, the
 * commands QA ran with their output, and screenshots for visual criteria;
 * plus the pull request kit_request_review opened.
 */

import React, { useEffect, useState } from 'react';
import type { HarnessCriterionEvidence, HarnessEvidence } from '../../../../shared/harness-types';

export function EvidencePanel({
  evidence,
  prUrl,
  loadScreenshot,
}: {
  evidence: HarnessEvidence | null;
  prUrl?: string | null;
  loadScreenshot: (path: string) => Promise<string | null>;
}): React.ReactElement {
  const criteria = evidence?.acceptance_criteria ?? [];
  const passed = criteria.filter((c) => c.passed).length;
  return (
    <section className="card p-4" data-testid="evidence-panel" aria-label="Evidence">
      <div className="flex items-center justify-between gap-2">
        <h3 className="kb-eyebrow">Evidence</h3>
        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="evidence-pr-link"
            className="text-sm font-medium text-accent-blue hover:underline"
          >
            Pull request ↗
          </a>
        ) : (
          <span className="text-xs text-text-secondary">No pull request yet</span>
        )}
      </div>
      {!evidence ? (
        <p className="mt-2 text-sm text-text-secondary">QA has not produced evidence for this story yet.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-text-secondary">
            {passed}/{criteria.length} criteria passed · {evidence.rounds} coder round{evidence.rounds === 1 ? '' : 's'}
          </p>
          <ul className="mt-3 space-y-3">
            {criteria.map((c) => (
              <Criterion key={c.id} criterion={c} loadScreenshot={loadScreenshot} />
            ))}
          </ul>
          {evidence.static_findings && evidence.static_findings.length > 0 && (
            <div className="mt-4">
              <p className="kb-eyebrow mb-1">Review findings</p>
              <ul className="space-y-1 text-xs">
                {evidence.static_findings.map((f, i) => (
                  <li key={i}>
                    <span className={f.severity === 'blocking' ? 'badge badge-error' : 'badge badge-neutral'}>{f.severity ?? 'note'}</span>{' '}
                    {f.file && <span className="font-mono">{f.file}{f.line ? `:${f.line}` : ''} </span>}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Criterion({
  criterion,
  loadScreenshot,
}: {
  criterion: HarnessCriterionEvidence;
  loadScreenshot: (path: string) => Promise<string | null>;
}): React.ReactElement {
  const [shot, setShot] = useState<string | null>(null);
  const screenshot = criterion.visual?.screenshot;
  useEffect(() => {
    let alive = true;
    setShot(null);
    if (screenshot) {
      void loadScreenshot(screenshot).then((url) => { if (alive) setShot(url); });
    }
    return () => { alive = false; };
  }, [screenshot, loadScreenshot]);

  return (
    <li data-testid={`criterion-${criterion.id}`} className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">
          <span className="font-mono text-xs text-text-secondary mr-1.5">{criterion.id}</span>
          {criterion.text}
        </p>
        <span className={`badge ${criterion.passed ? 'badge-success' : 'badge-error'}`} data-testid={`criterion-${criterion.id}-result`}>
          {criterion.passed ? 'pass' : 'fail'}
        </span>
      </div>
      {criterion.tests && criterion.tests.length > 0 && (
        <p className="mt-1 text-xs text-text-secondary">tests: <span className="font-mono">{criterion.tests.join(', ')}</span></p>
      )}
      {(criterion.checks ?? []).map((check, i) => (
        <details key={i} className="mt-2" open={check.exit_code !== 0}>
          <summary className="cursor-pointer text-xs">
            <span className="font-mono">{check.command}</span>{' '}
            <span className={check.exit_code === 0 ? 'text-status-success' : 'text-status-error'}>exit {check.exit_code}</span>
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-tertiary p-2 text-[11px] whitespace-pre-wrap">
            {check.output_tail || '(no output)'}
          </pre>
        </details>
      ))}
      {criterion.visual !== undefined && (
        <div className="mt-2">
          {criterion.visual?.finding && (
            <p className="text-xs">
              {criterion.visual.advisory && <span className="badge badge-neutral mr-1">advisory</span>}
              {criterion.visual.finding}
              {criterion.visual.confidence !== undefined && (
                <span className="text-text-secondary"> (confidence {Math.round(criterion.visual.confidence * 100)}%)</span>
              )}
            </p>
          )}
          {screenshot ? (
            shot ? (
              <img src={shot} alt={`Screenshot for ${criterion.id}`} className="mt-2 max-h-64 rounded border border-border" />
            ) : (
              <p className="mt-1 text-xs text-text-secondary">Loading screenshot…</p>
            )
          ) : (
            <p className="mt-1 text-xs text-text-secondary">No screenshot recorded.</p>
          )}
        </div>
      )}
    </li>
  );
}
