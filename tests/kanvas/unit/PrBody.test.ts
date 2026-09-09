/**
 * Unit Tests for shared/pr-body.ts (story KIT-PR-P2)
 *
 * ## The thing this module deliberately does NOT read
 *
 * KIT has a `commits` table with files_changed, additions, deletions and author
 * already populated (DatabaseService.ts:136) — an obvious source for a PR body.
 * It is not used, because it is not a complete record of a branch. Rows are
 * written from exactly three places: kit_commit (tools.ts:743), kit_commit_all
 * (:919) and the watcher's idle checkpoint (WatcherService.ts:952). An agent
 * that runs `git commit` in bash produces no row.
 *
 * A body built from it would omit commits, and omit them MOST for the agents
 * least likely to follow instructions — presenting an incomplete summary as
 * complete to the person deciding whether to merge. The commit list is passed
 * in from `git log <base>..<head>` instead.
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildPrTitle,
  buildPrBody,
  parseSessionMarker,
  MAX_BODY_COMMITS,
  type PrBodyInput,
} from '../../../shared/pr-body';

const input = (over: Partial<PrBodyInput> = {}): PrBodyInput => ({
  sessionId: 'sess_abc123',
  branchName: 'claude-session-20260908-ab12',
  baseBranch: 'development',
  taskDescription: 'Add rate limiting to the ingest endpoint',
  commits: [
    { hash: 'aaaaaaa', subject: 'feat(ingest): add a token bucket limiter' },
    { hash: 'bbbbbbb', subject: 'test(ingest): cover the burst case' },
  ],
  ...over,
});

describe('buildPrTitle', () => {
  it('uses the task description', () => {
    expect(buildPrTitle(input())).toBe('Add rate limiting to the ingest endpoint');
  });

  it('falls back to the branch name when there is no task', () => {
    expect(buildPrTitle(input({ taskDescription: '' }))).toBe(
      'claude-session-20260908-ab12'
    );
  });

  it('trims a long task to 72 characters without cutting mid-word', () => {
    const long = 'Refactor the entire ingestion pipeline so that every stage reports its own backpressure metrics correctly';
    const title = buildPrTitle(input({ taskDescription: long }));
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).not.toMatch(/\s$/);
    expect(long.startsWith(title.replace(/…$/, '').trim())).toBe(true);
  });

  it('collapses newlines — a title is one line', () => {
    const title = buildPrTitle(input({ taskDescription: 'Fix the thing\n\nand also the other thing' }));
    expect(title).not.toContain('\n');
  });
});

describe('buildPrBody — content', () => {
  it('lists every commit subject', () => {
    const body = buildPrBody(input());
    expect(body).toContain('feat(ingest): add a token bucket limiter');
    expect(body).toContain('test(ingest): cover the burst case');
  });

  it('states the task and the branches', () => {
    const body = buildPrBody(input());
    expect(body).toContain('Add rate limiting to the ingest endpoint');
    expect(body).toContain('claude-session-20260908-ab12');
    expect(body).toContain('development');
  });

  it('says so explicitly when there are no commits', () => {
    // An empty section reads as "the generator broke". Say what is true.
    const body = buildPrBody(input({ commits: [] }));
    expect(body).toMatch(/no commits/i);
  });

  it('names KIT as the author of the PR', () => {
    // A reviewer should not have to guess why a PR appeared.
    expect(buildPrBody(input())).toMatch(/KIT/);
  });
});

describe('buildPrBody — the session marker', () => {
  it('embeds a marker that round-trips', () => {
    const body = buildPrBody(input());
    expect(parseSessionMarker(body)).toBe('sess_abc123');
  });

  it('returns null for a body with no marker', () => {
    expect(parseSessionMarker('Just an ordinary PR body.')).toBeNull();
  });

  it('returns null for a body whose marker is malformed', () => {
    expect(parseSessionMarker('<!-- kit-session: -->')).toBeNull();
  });

  it('survives a body that a human has edited around', () => {
    // Humans edit PR bodies. The marker must still be findable.
    const edited = `Some notes I added.\n\n${buildPrBody(input())}\n\nMore notes.`;
    expect(parseSessionMarker(edited)).toBe('sess_abc123');
  });
});

describe('buildPrBody — bounds', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      hash: String(i).padStart(7, '0'),
      subject: `commit number ${i}`,
    }));

  it('truncates a long commit list and says how many were omitted', () => {
    const body = buildPrBody(input({ commits: many(500) }));
    expect(body).toMatch(/and \d+ more commits/);
    expect(body.split('\n').length).toBeLessThan(MAX_BODY_COMMITS + 40);
  });

  it('does not truncate when the list fits', () => {
    expect(buildPrBody(input({ commits: many(3) }))).not.toMatch(/more commits/);
  });
});

describe('buildPrBody — what must never appear', () => {
  it('contains no diff content', () => {
    // A PR body is public in most repos. Commit subjects are already public;
    // file contents may not be.
    const body = buildPrBody(input());
    expect(body).not.toContain('diff --git');
    expect(body).not.toMatch(/^\+\+\+ /m);
    expect(body).not.toMatch(/^--- /m);
  });

  it('neutralises a commit subject that tries to close the HTML comment', () => {
    // Commit subjects are attacker-influenceable in any repo taking
    // contributions. A subject containing "-->" could otherwise terminate the
    // marker comment early and inject markup into the body.
    const body = buildPrBody(
      input({ commits: [{ hash: 'ccccccc', subject: 'fix: handle --> in parser' }] })
    );
    expect(parseSessionMarker(body)).toBe('sess_abc123');
  });

  it('does not let a commit subject break out into a heading', () => {
    const body = buildPrBody(
      input({ commits: [{ hash: 'ddddddd', subject: '## Injected heading' }] })
    );
    // The subject renders as list content, not as a top-level heading.
    expect(body).not.toMatch(/^## Injected heading/m);
  });

  it('handles a multi-line commit subject as one line', () => {
    const body = buildPrBody(
      input({ commits: [{ hash: 'eeeeeee', subject: 'line one\nline two' }] })
    );
    expect(body).toContain('line one line two');
  });
});
