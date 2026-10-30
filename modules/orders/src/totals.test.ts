import { moneyFromDecimal, parseDecimal, toDecimalString } from '@muziris/money';
import { describe, expect, it } from 'vitest';
import { gstTestProvider, NO_TAX } from './test/gst-test-provider.js';
import {
  computeTotals,
  flatRateShipping,
  noLineDiscounts,
  noOrderDiscounts,
  noShippingDiscounts,
  type PricedLine,
  type TotalsContext,
  type TotalsProviders,
} from './totals.js';

const rupees = (amount: string) => moneyFromDecimal(amount, 'INR');
const text = toDecimalString;

const MAHARASHTRA = { countryCode: 'IN', regionCode: '27', postalCode: '411001', gstin: null };
const KERALA = { countryCode: 'IN', regionCode: '32', postalCode: '682001', gstin: null };

function context(shipTo = MAHARASHTRA): TotalsContext {
  return {
    websiteId: '00000000-0000-4000-8000-000000000001',
    websiteCountryCode: 'IN',
    websiteTimeZone: 'Asia/Kolkata',
    customerId: '00000000-0000-4000-8000-000000000002',
    currency: 'INR',
    billTo: MAHARASHTRA,
    shipTo,
    now: new Date('2026-11-20T06:00:00Z'),
  };
}

function line(lineNo: number, unitPrice: string, quantity: string): PricedLine {
  return {
    lineNo,
    productId: `00000000-0000-4000-8000-00000000010${lineNo}`,
    sku: `SKU-${lineNo}`,
    productName: `Product ${lineNo}`,
    unitCode: 'each',
    unitName: 'Each',
    quantity: parseDecimal(quantity),
    unitPrice: rupees(unitPrice),
    priceListId: '00000000-0000-4000-8000-000000000200',
    hsnSacCode: '8482',
    usTaxCategory: null,
  };
}

/** The totals of a result that must have them. */
async function totalsOf(result: ReturnType<typeof computeTotals>) {
  const r = await result;
  if (!r.ok) throw new Error(`Expected totals, got ${JSON.stringify(r.taxProblems)}`);
  return r.totals;
}

function providers(overrides: Partial<TotalsProviders> = {}): TotalsProviders {
  return {
    lineDiscounts: noLineDiscounts,
    orderDiscounts: noOrderDiscounts,
    shipping: flatRateShipping(rupees('0')),
    shippingDiscounts: noShippingDiscounts,
    tax: NO_TAX,
    ...overrides,
  };
}

describe('computeTotals', () => {
  // Known answers: unit price, quantity, flat shipping, ship-to state → subtotal, tax, total.
  it.each<[string, [string, string][], string, typeof MAHARASHTRA, string, string, string]>([
    [
      'one line, no shipping, same state',
      [['480.00', '10']],
      '0',
      MAHARASHTRA,
      '4800.00',
      '864.00',
      '5664.00',
    ],
    // 2.555 × 10.10 = 25.8055, rounded half up once to 25.81.
    [
      'a fractional quantity rounds the line once',
      [['10.10', '2.555']],
      '0',
      MAHARASHTRA,
      '25.81',
      '4.64',
      '30.45',
    ],
    // 9% of 0.05 is 0.0045: each half rounds to 0.00, so a tiny line pays no tax.
    [
      'tax on a tiny line rounds to zero per half',
      [['0.05', '1']],
      '0',
      MAHARASHTRA,
      '0.05',
      '0.00',
      '0.05',
    ],
    // Shipping is taxed too: 18% of 250 = 45.
    [
      'shipping is taxed',
      [['95.50', '100']],
      '250.00',
      MAHARASHTRA,
      '9550.00',
      '1764.00',
      '11564.00',
    ],
    // Out of state: one IGST at 18% instead of two halves; same total when nothing rounds.
    ['another state pays IGST', [['480.00', '10']], '0', KERALA, '4800.00', '864.00', '5664.00'],
    // 18% of 0.05 is 0.009, which rounds to 0.01 as IGST but to 0.00 + 0.00 as CGST and SGST.
    [
      'IGST rounds once where the halves round twice',
      [['0.05', '1']],
      '0',
      KERALA,
      '0.05',
      '0.01',
      '0.06',
    ],
    [
      'several lines add up',
      [
        ['480.00', '3'],
        ['95.50', '120'],
        ['12.35', '1'],
      ],
      '100.00',
      MAHARASHTRA,
      // Tax: 259.20 + 2062.80 + 2.22 (9% of 12.35 is 1.1115, twice 1.11) + 18.00 on shipping.
      '12912.35',
      '2342.22',
      '15354.57',
    ],
  ])('%s', async (_name, lines, shipping, shipTo, subtotal, tax, grandTotal) => {
    const priced = lines.map(([price, qty], i) => line(i + 1, price, qty));
    const totals = await totalsOf(
      computeTotals(
        priced,
        context(shipTo),
        providers({
          shipping: flatRateShipping(rupees(shipping)),
          tax: gstTestProvider({ sellerState: '27', rate: '0.18' }),
        }),
      ),
    );
    expect(text(totals.subtotal)).toBe(subtotal);
    expect(text(totals.tax)).toBe(tax);
    expect(text(totals.grandTotal)).toBe(grandTotal);
    expect(
      totals.taxes.every((t) => (shipTo === KERALA ? t.name === 'IGST' : t.name !== 'IGST')),
    ).toBe(true);
  });

  it('applies line, order and shipping discounts before tax, in that order', async () => {
    const totals = await totalsOf(
      computeTotals(
        [line(1, '100.00', '10'), line(2, '50.00', '2')],
        context(),
        providers({
          lineDiscounts: {
            name: 'test',
            lineDiscounts: () =>
              Promise.resolve([
                { lineNo: 1, adjustment: { reason: '10% off', amount: rupees('100.00') } },
              ]),
          },
          orderDiscounts: {
            name: 'test',
            orderDiscounts: (net) => {
              expect(text(net)).toBe('1000.00');
              return Promise.resolve([{ reason: 'Loyalty', amount: rupees('50.00') }]);
            },
          },
          shipping: {
            name: 'test',
            quote: (goods) => {
              expect(text(goods)).toBe('950.00');
              return Promise.resolve({ method: 'courier', amount: rupees('80.00') });
            },
          },
          shippingDiscounts: {
            name: 'test',
            shippingDiscounts: () =>
              Promise.resolve([{ reason: 'Free over 900', amount: rupees('80.00') }]),
          },
          tax: {
            name: 'check',
            calculate: (request) => {
              expect(request.lines.map((l) => text(l.net))).toEqual(['900.00', '100.00']);
              expect(text(request.orderDiscount)).toBe('50.00');
              expect(text(request.shipping)).toBe('0.00');
              return Promise.resolve({ lines: [], taxCodes: new Map() });
            },
          },
        }),
      ),
    );
    expect(text(totals.subtotal)).toBe('1100.00');
    expect(text(totals.discount)).toBe('150.00');
    expect(text(totals.shipping)).toBe('80.00');
    expect(text(totals.shippingDiscount)).toBe('80.00');
    expect(text(totals.grandTotal)).toBe('950.00');
    expect(totals.shippingMethod).toBe('courier');
    expect(totals.lines[0]?.discounts).toEqual([{ reason: '10% off', amount: rupees('100.00') }]);
  });

  it('records the tax code the provider used per line', async () => {
    const totals = await totalsOf(
      computeTotals(
        [line(1, '10.00', '1')],
        context(),
        providers({ tax: gstTestProvider({ sellerState: '27', rate: '0.18' }) }),
      ),
    );
    expect(totals.lines[0]?.taxCode).toBe('8482');
    expect(totals.taxProvider).toBe('gst_test');
  });

  it.each<[string, Partial<TotalsProviders>]>([
    [
      'a line discounted below zero',
      {
        lineDiscounts: {
          name: 'bad',
          lineDiscounts: () =>
            Promise.resolve([{ lineNo: 1, adjustment: { reason: 'x', amount: rupees('11.00') } }]),
        },
      },
    ],
    [
      'a discount on a missing line',
      {
        lineDiscounts: {
          name: 'bad',
          lineDiscounts: () =>
            Promise.resolve([{ lineNo: 9, adjustment: { reason: 'x', amount: rupees('1.00') } }]),
        },
      },
    ],
    [
      'a negative order discount',
      {
        orderDiscounts: {
          name: 'bad',
          orderDiscounts: () => Promise.resolve([{ reason: 'x', amount: rupees('-1.00') }]),
        },
      },
    ],
    ['shipping in another currency', { shipping: flatRateShipping(moneyFromDecimal('5', 'USD')) }],
    [
      'a tax on a missing line',
      {
        tax: {
          name: 'bad',
          calculate: () =>
            Promise.resolve({
              lines: [
                {
                  lineNo: 4,
                  name: 'IGST',
                  rate: '0.18',
                  taxable: rupees('1'),
                  amount: rupees('0.18'),
                },
              ],
              taxCodes: new Map(),
            }),
        },
      },
    ],
  ])('refuses a provider that returns %s', async (_name, overrides) => {
    await expect(
      computeTotals([line(1, '10.00', '1')], context(), providers(overrides)),
    ).rejects.toThrow();
  });

  it("returns the tax provider's problems instead of totals", async () => {
    const problems = [
      { lineNo: 1, code: 'no_tax_code' as const, message: 'SKU-1 has no HSN or SAC code' },
      { lineNo: null, code: 'no_registration' as const, message: 'No GSTIN' },
    ];
    const result = await computeTotals(
      [line(1, '10.00', '1')],
      context(),
      providers({
        tax: {
          name: 'refusing',
          calculate: () => Promise.resolve({ lines: [], taxCodes: new Map(), problems }),
        },
      }),
    );
    expect(result).toEqual({ ok: false, taxProblems: problems });
  });

  it('passes the tax codes and the website to the tax provider', async () => {
    let seen: unknown;
    await computeTotals(
      [{ ...line(1, '10.00', '1'), hsnSacCode: null, usTaxCategory: 'exempt' }],
      context(),
      providers({
        tax: {
          name: 'spy',
          calculate: (request) => {
            seen = request;
            return Promise.resolve({ lines: [], taxCodes: new Map() });
          },
        },
      }),
    );
    expect(seen).toMatchObject({
      websiteCountryCode: 'IN',
      websiteTimeZone: 'Asia/Kolkata',
      lines: [{ lineNo: 1, hsnSacCode: null, usTaxCategory: 'exempt' }],
    });
  });

  it('refuses lines in another currency, or the same line twice', async () => {
    const usd = { ...line(1, '1.00', '1'), unitPrice: moneyFromDecimal('1', 'USD') };
    await expect(computeTotals([usd], context(), providers())).rejects.toThrow(/USD/);
    await expect(
      computeTotals([line(1, '1', '1'), line(1, '2', '1')], context(), providers()),
    ).rejects.toThrow(/twice/);
  });
});
