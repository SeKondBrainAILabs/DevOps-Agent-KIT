/**
 * Unit Tests for M2 — Notion Ticket Chip formatter
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildNotionTicketChip,
  classifyStatus,
  truncateTitle,
  TITLE_MAX_LENGTH,
} from '../../../shared/notion-ticket-chip';

describe('classifyStatus (M2)', () => {
  it('todo / backlog / planned / new / open → todo', () => {
    for (const s of ['Todo', 'BACKLOG', 'Planned', 'New', 'open']) {
      expect(classifyStatus(s)).toBe('todo');
    }
  });
  it('In Progress, in-progress, working, active → in-progress', () => {
    for (const s of ['In Progress', 'in-progress', 'Working', 'active']) {
      expect(classifyStatus(s)).toBe('in-progress');
    }
  });
  it('review / staging → review', () => {
    expect(classifyStatus('Under Review')).toBe('review');
    expect(classifyStatus('Staging')).toBe('review');
  });
  it('done / complete / merged → done', () => {
    for (const s of ['Done', 'Complete', 'Completed', 'Merged', 'Shipped', 'Closed']) {
      expect(classifyStatus(s)).toBe('done');
    }
  });
  it('blocked / on hold → blocked', () => {
    expect(classifyStatus('Blocked')).toBe('blocked');
    expect(classifyStatus('On Hold')).toBe('blocked');
  });
  it('unknown / undefined → unknown', () => {
    expect(classifyStatus(undefined)).toBe('unknown');
    expect(classifyStatus('weird-status')).toBe('unknown');
  });
});

describe('truncateTitle (M2)', () => {
  it('short titles pass through', () => {
    expect(truncateTitle('Short title')).toBe('Short title');
  });
  it('long titles truncate with ellipsis', () => {
    const long = 'x'.repeat(TITLE_MAX_LENGTH + 10);
    const out = truncateTitle(long);
    expect(out.length).toBe(TITLE_MAX_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });
  it('honors a custom max', () => {
    expect(truncateTitle('hello world', 5)).toBe('hell…');
  });
  it('trims whitespace before measuring', () => {
    expect(truncateTitle('   hello   ')).toBe('hello');
  });
});

describe('buildNotionTicketChip (M2)', () => {
  it('builds a complete chip model', () => {
    const chip = buildNotionTicketChip({
      ticketId: 'PROJ-9',
      title: '  Implement login flow with magic link  ',
      status: 'In Progress',
      url: 'https://notion.so/PROJ-9',
    });
    expect(chip.ticketId).toBe('PROJ-9');
    expect(chip.title).toBe('Implement login flow with magic link');
    expect(chip.variant).toBe('in-progress');
    expect(chip.statusLabel).toBe('In Progress');
    expect(chip.url).toBe('https://notion.so/PROJ-9');
    expect(chip.tooltip).toMatch(/PROJ-9/);
    expect(chip.tooltip).toMatch(/Status: In Progress/);
    expect(chip.tooltip).toMatch(/notion\.so/);
  });

  it('truncates title for chip display', () => {
    const long = 'x'.repeat(TITLE_MAX_LENGTH + 10);
    const chip = buildNotionTicketChip({ ticketId: 'P-1', title: long });
    expect(chip.truncatedTitle.length).toBe(TITLE_MAX_LENGTH);
    expect(chip.title).toBe(long); // full title preserved on the model
  });

  it('falls back to "Unknown" status label and "unknown" variant', () => {
    const chip = buildNotionTicketChip({ ticketId: 'P-1', title: 'X' });
    expect(chip.statusLabel).toBe('Unknown');
    expect(chip.variant).toBe('unknown');
  });

  it('omits URL line from tooltip when no URL provided', () => {
    const chip = buildNotionTicketChip({ ticketId: 'P-1', title: 'X', status: 'Done' });
    expect(chip.tooltip).not.toMatch(/https?:/);
  });
});
