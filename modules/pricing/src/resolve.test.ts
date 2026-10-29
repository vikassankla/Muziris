import { decimalToString, moneyFromDecimal, parseDecimal, toDecimalString } from '@muziris/money';
import { describe, expect, it } from 'vitest';
import { lineAmount } from './preview.js';
import { resolvePrice, type ChainEntry } from './resolve.js';
import {
  chainOrder,
  CURRENCY_CASES,
  DATE_CASES,
  FALLBACK_CASES,
  ROUNDING_CASES,
  TIER_CASES,
  type PriceCase,
} from './test/known-answers.js';

function chainOf(c: PriceCase): ChainEntry[] {
  return chainOrder(c.lists).map((spec, index) => ({
    target: spec.target,
    targetId: `target-${spec.target}`,
    priority: spec.priority,
    priceList: {
      id: `list-${index}-${spec.name}`,
      name: spec.name,
      currency: c.currency,
      activeFrom: spec.activeFrom === undefined ? null : new Date(spec.activeFrom),
      activeUntil: spec.activeUntil === undefined ? null : new Date(spec.activeUntil),
    },
    tiers: spec.tiers
      .filter(([unit]) => unit === c.unit)
      .map(([, minQuantity, amount]) => ({
        minQuantity: parseDecimal(minQuantity),
        amount: moneyFromDecimal(amount, c.currency),
      })),
  }));
}

function run(c: PriceCase) {
  const chain = chainOf(c);
  const quantity = parseDecimal(c.quantity);
  const { price } = resolvePrice(chain, { currency: c.currency, quantity, now: new Date(c.now) });
  if (price === null) return null;
  return {
    amount: toDecimalString(price.unitPrice),
    from: chain.find((e) => e.priceList.id === price.priceListId)?.priceList.name,
    minQuantity: decimalToString(price.minQuantity),
    line: toDecimalString(lineAmount(price.unitPrice, quantity)),
  };
}

describe('resolvePrice known answers', () => {
  it.each(FALLBACK_CASES.map((c) => [c.title, c] as const))('fallback: %s', (_, c) => {
    expect(run(c)).toEqual(c.expected);
  });
  it.each(TIER_CASES.map((c) => [c.title, c] as const))('tiers: %s', (_, c) => {
    expect(run(c)).toEqual(c.expected);
  });
  it.each(CURRENCY_CASES.map((c) => [c.title, c] as const))('currency: %s', (_, c) => {
    expect(run(c)).toEqual(c.expected);
  });
  it.each(DATE_CASES.map((c) => [c.title, c] as const))('active dates: %s', (_, c) => {
    expect(run(c)).toEqual(c.expected);
  });
  it.each(ROUNDING_CASES.map((c) => [c.title, c] as const))('rounding: %s', (_, c) => {
    expect(run(c)).toEqual(c.expected);
  });
});

describe('resolvePrice steps', () => {
  const at = {
    currency: 'USD' as const,
    quantity: parseDecimal('120'),
    now: new Date('2026-11-04T09:00:00Z'),
  };
  const usd = (amount: string) => moneyFromDecimal(amount, 'USD');
  const entry = (
    name: string,
    target: ChainEntry['target'],
    tiers: [string, string][],
    extra: Partial<ChainEntry['priceList']> = {},
  ): ChainEntry => ({
    target,
    targetId: name,
    priority: 1,
    priceList: { id: name, name, currency: 'USD', activeFrom: null, activeUntil: null, ...extra },
    tiers: tiers.map(([q, a]) => ({ minQuantity: parseDecimal(q), amount: usd(a) })),
  });

  it('says which step was skipped, used, not reached or inactive, as the preview board shows', () => {
    const { steps } = resolvePrice(
      [
        entry('Gulf Coast contract 2026', 'customer', []),
        entry('Expired contract', 'customer', [['1', '1.00']], {
          activeUntil: new Date('2026-01-01T00:00:00Z'),
        }),
        entry('US distributor net 2026', 'customer_group', [
          ['1', '5.38'],
          ['100', '4.86'],
        ]),
        entry('US list price', 'website', [['1', '6.40']]),
        entry('Wholesale only', 'website', [['500', '3.00']]),
      ],
      at,
    );
    expect(
      steps.map((s) => [
        s.entry.priceList.name,
        s.status,
        s.tier === null ? null : toDecimalString(s.tier.amount),
      ]),
    ).toEqual([
      ['Gulf Coast contract 2026', 'skipped', null],
      ['Expired contract', 'inactive', null],
      ['US distributor net 2026', 'used', '4.86'],
      ['US list price', 'not_reached', '6.40'],
      ['Wholesale only', 'not_reached', null],
    ]);
  });

  it('treats a price list in another currency as inactive', () => {
    const { price, steps } = resolvePrice(
      [entry('Rupee list', 'website', [['1', '1.00']], { currency: 'INR' })],
      at,
    );
    expect(price).toBeNull();
    expect(steps[0]?.status).toBe('inactive');
  });

  it('gives no price for an empty chain', () => {
    expect(resolvePrice([], at)).toEqual({ price: null, steps: [] });
  });
});
