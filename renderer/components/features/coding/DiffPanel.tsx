/**
 * DiffPanel (KC-S2.1.4 AC3): the story worktree's changes. The diff is read
 * locally when the worktree is on this machine; otherwise the files the
 * story's commits touched are listed from the evidence.
 */

import React, { useCallback, useState } from 'react';
import { DiffViewer } from '../../ui/DiffViewer';
import { splitUnifiedDiff, type HarnessEvidence } from '../../../../shared/harness-types';
import type { SessionDiff } from '../../../../shared/git-name-status';

export function DiffPanel({
  loadDiff,
  evidence,
}: {
  loadDiff: () => Promise<{ diff: SessionDiff | null; error?: string }>;
  evidence: HarnessEvidence | null;
}): React.ReactElement {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadDiff();
    setDiff(res.diff);
    setError(res.error ?? null);
    setLoading(false);
  }, [loadDiff]);

  const stats = new Map((diff?.files ?? []).map((f) => [f.path, f]));
  return (
    <section className="card p-4" data-testid="diff-panel" aria-label="Worktree diff">
      <div className="flex items-center justify-between">
        <h3 className="kb-eyebrow">Changes</h3>
        <button type="button" className="kb-btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : diff ? 'Refresh diff' : 'Load diff'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-text-secondary">{error}</p>}
      {diff ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-text-secondary">
            {diff.files.length} file{diff.files.length === 1 ? '' : 's'} against {diff.base.slice(0, 7)}
            {diff.truncated ? ' · truncated' : ''}
          </p>
          {splitUnifiedDiff(diff.diff).map((file) => (
            <DiffViewer
              key={file.path}
              filePath={file.path}
              diff={file.diff}
              additions={stats.get(file.path)?.additions ?? 0}
              deletions={stats.get(file.path)?.deletions ?? 0}
              defaultCollapsed={false}
              maxLines={60}
            />
          ))}
        </div>
      ) : (
        <FilesFromEvidence evidence={evidence} />
      )}
    </section>
  );
}

function FilesFromEvidence({ evidence }: { evidence: HarnessEvidence | null }): React.ReactElement {
  const commits = evidence?.commits ?? [];
  if (commits.length === 0) return <p className="mt-2 text-sm text-text-secondary">No commits yet.</p>;
  return (
    <ul className="mt-2 space-y-2 text-xs">
      {commits.map((c) => (
        <li key={c.hash}>
          <span className="font-mono text-text-secondary">{c.hash.slice(0, 7)}</span> {c.message}
          <ul className="ml-4 mt-0.5 font-mono text-text-secondary">
            {c.files.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}
