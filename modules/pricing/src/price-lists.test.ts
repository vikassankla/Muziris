import { describe, expect, it } from 'vitest';
import { priceListStatus } from './price-lists.js';

const d = (iso: string) => new Date(iso);

describe('priceListStatus', () => {
  const year = { activeFrom: d('2026-04-01T00:00:00Z'), activeUntil: d('2027-04-01T00:00:00Z') };
  it.each([
    [year, '2026-03-31T23:59:59.999Z', 'scheduled'],
    [year, '2026-04-01T00:00:00.000Z', 'active'],
    [year, '2027-03-31T23:59:59.999Z', 'active'],
    [year, '2027-04-01T00:00:00.000Z', 'expired'],
    [{ activeFrom: null, activeUntil: null }, '2026-11-04T00:00:00Z', 'active'],
    [
      { activeFrom: null, activeUntil: d('2026-01-01T00:00:00Z') },
      '2026-11-04T00:00:00Z',
      'expired',
    ],
    [
      { activeFrom: d('2027-01-01T00:00:00Z'), activeUntil: null },
      '2026-11-04T00:00:00Z',
      'scheduled',
    ],
  ] as const)('%o at %s is %s', (list, now, status) => {
    expect(priceListStatus(list, d(now))).toBe(status);
  });
});
