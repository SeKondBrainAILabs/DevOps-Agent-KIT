/**
 * Notion Ticket Chip data formatter (Epic M / story M2).
 *
 * Renderer atom (U31) that sits next to a branch name. Pure helpers for:
 *  - resolving a stable color from the ticket status (e.g. "In Progress" → blue)
 *  - truncating long titles for the chip
 *  - building a tooltip body
 *  - producing a final NotionTicketChipModel the React component renders
 */

export type TicketStatusVariant = 'todo' | 'in-progress' | 'review' | 'done' | 'blocked' | 'unknown';

export interface NotionTicketRaw {
  ticketId: string;
  title: string;
  status?: string;
  url?: string;
}

export interface NotionTicketChipModel {
  ticketId: string;
  title: string;
  truncatedTitle: string;
  statusLabel: string;
  variant: TicketStatusVariant;
  url?: string;
  tooltip: string;
}

export const TITLE_MAX_LENGTH = 32;

export function classifyStatus(status: string | undefined): TicketStatusVariant {
  if (!status) return 'unknown';
  const s = status.toLowerCase();
  if (/^(todo|backlog|planned|new|open)$/.test(s)) return 'todo';
  if (/^(in[- ]?progress|active|working)$/.test(s) || s.includes('progress')) return 'in-progress';
  if (/(review|staging)/.test(s)) return 'review';
  if (/^(done|complete|completed|merged|shipped|closed)$/.test(s)) return 'done';
  if (/(block|stuck|paused|on hold)/.test(s)) return 'blocked';
  return 'unknown';
}

export function truncateTitle(title: string, max: number = TITLE_MAX_LENGTH): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)) + '…';
}

export function buildNotionTicketChip(raw: NotionTicketRaw): NotionTicketChipModel {
  const truncatedTitle = truncateTitle(raw.title);
  const variant = classifyStatus(raw.status);
  const statusLabel = raw.status?.trim() || 'Unknown';
  const tooltip = `${raw.ticketId} · ${raw.title.trim()}\nStatus: ${statusLabel}` +
    (raw.url ? `\n${raw.url}` : '');
  return {
    ticketId: raw.ticketId,
    title: raw.title.trim(),
    truncatedTitle,
    statusLabel,
    variant,
    url: raw.url,
    tooltip,
  };
}
