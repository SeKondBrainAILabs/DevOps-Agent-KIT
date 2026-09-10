import { describe, it, expect } from '@jest/globals';
import { formatDateTime, formatDateTimeShort } from '../../../shared/format-datetime';

describe('format-datetime', () => {
  const iso = '2026-08-08T14:32:07.000Z';

  it('formatDateTime includes month, day AND time (with seconds)', () => {
    const out = formatDateTime(iso);
    // Must carry a date component — the whole point of the change.
    expect(out).toMatch(/[A-Za-z]{3}/); // short month name
    expect(out).toMatch(/\d/); // day + time digits
    // Seconds present (two digits after the last colon).
    expect(out).toMatch(/:\d{2}:\d{2}/);
  });

  it('formatDateTimeShort includes the date but omits seconds', () => {
    const out = formatDateTimeShort(iso);
    expect(out).toMatch(/[A-Za-z]{3}/);
    // Exactly one colon (HH:MM), no seconds.
    expect((out.match(/:/g) || []).length).toBe(1);
  });

  it('accepts epoch millis and Date instances', () => {
    const ms = Date.parse(iso);
    expect(formatDateTime(ms)).toEqual(formatDateTime(new Date(ms)));
  });

  it('returns the raw input on an unparseable value instead of "Invalid Date"', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(formatDateTimeShort('')).toBe('');
  });
});
