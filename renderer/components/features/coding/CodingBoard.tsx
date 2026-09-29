/**
 * CodingBoard (KC-S2.1.3): every story of the recent KIT Harness runs, in a
 * column per stage. Clicking a card opens that story's run view.
 */

import React from 'react';
import { CODING_COLUMNS, boardColumns, type BoardCard, type HarnessRun } from '../../../../shared/harness-types';

interface CodingBoardProps {
  runs: HarnessRun[];
  onOpenStory: (runId: string, storyId: string) => void;
}

export function CodingBoard({ runs, onOpenStory }: CodingBoardProps): React.ReactElement {
  const columns = boardColumns(runs);
  return (
    <div className="flex gap-3 p-4 items-start" data-testid="coding-board">
      {CODING_COLUMNS.map((column) => (
        <section
          key={column.id}
          data-testid={`column-${column.id}`}
          aria-label={column.title}
          className="flex-1 min-w-[11rem] max-w-[16rem] rounded-xl bg-surface-secondary border border-border p-2"
        >
          <h2 className="flex items-center justify-between px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            <span>{column.title}</span>
            <span className="rounded-full bg-[rgba(0,0,0,0.06)] px-2 py-0.5 text-[11px] text-text-primary">
              {columns[column.id].length}
            </span>
          </h2>
          <div className="flex flex-col gap-2">
            {columns[column.id].map((card) => (
              <StoryCard key={`${card.run_id}/${card.story_id}`} card={card} onOpen={onOpenStory} />
            ))}
            {columns[column.id].length === 0 && (
              <p className="px-1 py-3 text-xs text-text-secondary">No stories</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function StoryCard({ card, onOpen }: { card: BoardCard; onOpen: CodingBoardProps['onOpenStory'] }): React.ReactElement {
  const questions = card.questions?.length ?? 0;
  const tokens = (card.tokens?.tokens_in ?? 0) + (card.tokens?.tokens_out ?? 0);
  return (
    <button
      type="button"
      data-testid={`story-card-${card.story_id}`}
      onClick={() => onOpen(card.run_id, card.story_id)}
      className="w-full text-left rounded-lg bg-surface border border-border p-2.5 hover:shadow-kit-card transition-shadow"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-text-secondary whitespace-nowrap">{card.story_id}</span>
        <span className="text-[10px] text-text-secondary truncate">{card.state.replace(/_/g, ' ')}</span>
      </div>
      <p className="mt-1 text-sm font-medium leading-snug line-clamp-2">{card.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
        {card.rounds ? <span>round {card.rounds}</span> : null}
        {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
        {questions > 0 && <span className="badge badge-warning">{questions} question{questions > 1 ? 's' : ''}</span>}
        {card.pr_url && <span className="badge badge-success">PR</span>}
      </div>
    </button>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
