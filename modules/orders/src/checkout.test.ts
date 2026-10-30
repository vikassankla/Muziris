import { describe, expect, it } from 'vitest';
import { dueDate } from './checkout.js';

describe('dueDate', () => {
  it.each([
    // 20:00 UTC on 30 Oct is already 31 Oct in India; net 30 is 30 Nov.
    ['2026-10-30T20:00:00Z', 'Asia/Kolkata', 30, '2026-11-30'],
    // The same moment is still 30 Oct in New York.
    ['2026-10-30T20:00:00Z', 'America/New_York', 30, '2026-11-29'],
    ['2026-12-15T06:00:00Z', 'Asia/Kolkata', 30, '2027-01-14'],
    ['2028-02-10T06:00:00Z', 'Asia/Kolkata', 20, '2028-03-01'],
    ['2026-11-20T06:00:00Z', 'Asia/Kolkata', 0, '2026-11-20'],
  ])('%s in %s plus %i days is %s', (now, zone, days, due) => {
    expect(dueDate(new Date(now), zone, days)).toBe(due);
  });
});
