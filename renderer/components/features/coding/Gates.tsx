/**
 * Gates (KC-S2.1.5): approve or send back a plan waiting at the plan gate,
 * answer a blocked story's questions, and approve a proposed run from an epic.
 */

import React, { useState } from 'react';

export const MAX_QUESTIONS = 3;

interface PlannedFile { path: string; action?: string; why?: string }
interface PlannedTest { ac?: string; file?: string; kind?: string }
interface Risk { risk?: string; mitigation?: string }

export function PlanApproval({
  plan,
  busy,
  onDecision,
}: {
  plan: Record<string, any> | null;
  busy?: boolean;
  onDecision: (approved: boolean, comment: string) => void;
}): React.ReactElement {
  const [comment, setComment] = useState('');
  const [requesting, setRequesting] = useState(false);
  const files: PlannedFile[] = Array.isArray(plan?.files) ? plan!.files : [];
  const tests: PlannedTest[] = Array.isArray(plan?.tests) ? plan!.tests : [];
  const risks: Risk[] = Array.isArray(plan?.risks) ? plan!.risks : [];
  return (
    <section className="card p-4 border-[rgba(26,138,246,0.35)]" data-testid="plan-approval" aria-label="Plan awaiting approval">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Plan awaiting approval</h3>
        {plan?.size && <span className="badge badge-info">size {String(plan.size)}</span>}
      </div>
      {plan ? (
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
          <div>
            <p className="kb-eyebrow mb-1">Files ({files.length})</p>
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={`${f.action}:${f.path}`} className="font-mono text-xs">
                  <span className="text-text-secondary">{f.action}</span> {f.path}
                  {f.why && <span className="block font-sans text-text-secondary">{f.why}</span>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="kb-eyebrow mb-1">Tests ({tests.length})</p>
            <ul className="space-y-1">
              {tests.map((t, i) => (
                <li key={i} className="font-mono text-xs">
                  <span className="text-text-secondary">{t.ac} · {t.kind}</span> {t.file}
                </li>
              ))}
            </ul>
            {risks.length > 0 && (
              <>
                <p className="kb-eyebrow mt-3 mb-1">Risks</p>
                <ul className="list-disc pl-4 space-y-1 text-xs">
                  {risks.map((r, i) => <li key={i}>{r.risk}{r.mitigation ? ` (${r.mitigation})` : ''}</li>)}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-text-secondary">The plan is not available yet.</p>
      )}
      {requesting && (
        <textarea
          className="input mt-3 h-20"
          placeholder="What should the Planner change?"
          aria-label="Requested changes"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => onDecision(true, '')}>
          Approve
        </button>
        {requesting ? (
          <button
            type="button"
            className="kb-btn"
            disabled={busy || !comment.trim()}
            onClick={() => onDecision(false, comment.trim())}
          >
            Send back to Planner
          </button>
        ) : (
          <button type="button" className="kb-btn" disabled={busy} onClick={() => setRequesting(true)}>
            Request changes
          </button>
        )}
      </div>
    </section>
  );
}

/** A blocked story's questions (up to three) with one answer box each; submits one harness_answer. */
export function QuestionCard({
  questions,
  busy,
  onAnswer,
}: {
  questions: string[];
  busy?: boolean;
  onAnswer: (text: string) => void;
}): React.ReactElement {
  const shown = questions.slice(0, MAX_QUESTIONS);
  const [answers, setAnswers] = useState<string[]>(() => shown.map(() => ''));
  const ready = shown.length > 0 && answers.every((a) => a.trim());
  const submit = () => {
    const text = shown
      .map((q, i) => (shown.length === 1 ? answers[i].trim() : `Q${i + 1}: ${q}\nA: ${answers[i].trim()}`))
      .join('\n\n');
    onAnswer(text);
  };
  return (
    <section className="card p-4 border-[rgba(245,158,11,0.4)]" data-testid="question-card" aria-label="Questions from the Refiner">
      <h3 className="font-semibold">Blocked: the story needs answers</h3>
      <ol className="mt-3 space-y-3">
        {shown.map((q, i) => (
          <li key={i}>
            <label className="text-sm font-medium" htmlFor={`harness-answer-${i}`}>{i + 1}. {q}</label>
            <textarea
              id={`harness-answer-${i}`}
              className="input mt-1 h-16"
              value={answers[i]}
              onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
            />
          </li>
        ))}
      </ol>
      {questions.length > MAX_QUESTIONS && (
        <p className="mt-2 text-xs text-text-secondary">
          {questions.length - MAX_QUESTIONS} more question{questions.length - MAX_QUESTIONS > 1 ? 's' : ''} will follow once these are answered.
        </p>
      )}
      <button type="button" className="btn-primary mt-3" disabled={busy || !ready} onClick={submit}>
        Send answers and re-queue
      </button>
    </section>
  );
}

/** A run proposed from an epic or PRD, waiting in awaiting_approval before any story starts. */
export function RunProposal({
  runId,
  epic,
  storyCount,
  questions,
  busy,
  onDecision,
}: {
  runId: string;
  epic?: string | null;
  storyCount: number;
  questions?: string[];
  busy?: boolean;
  onDecision: (approved: boolean) => void;
}): React.ReactElement {
  return (
    <div className="card p-3 flex items-center justify-between gap-3" data-testid={`run-proposal-${runId}`}>
      <div className="text-sm">
        <strong>{epic || runId}</strong>: proposed run with {storyCount} stor{storyCount === 1 ? 'y' : 'ies'} is waiting for approval.
        {questions && questions.length > 0 && <span className="block text-xs text-text-secondary">{questions[0]}</span>}
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <button type="button" className="btn-primary-sm" disabled={busy} onClick={() => onDecision(true)}>Approve run</button>
        <button type="button" className="kb-btn-sm" disabled={busy} onClick={() => onDecision(false)}>Reject</button>
      </div>
    </div>
  );
}
