import { moneyFromDecimal, toDecimalString, type Money } from '@muziris/money';
import type { TaxAddress, TaxRequest, TaxResult } from '@muziris/orders';
import { describe, expect, it } from 'vitest';
import {
  calculateTax,
  localDay,
  rateText,
  type GstRateRow,
  type TaxData,
  type UsRateRow,
} from './calculate.js';

const NOW = new Date('2026-11-20T06:00:00Z');

function address(countryCode: string, regionCode: string, postalCode: string): TaxAddress {
  return { countryCode, regionCode, postalCode, gstin: null };
}

const PUNE = address('IN', '27', '411026');
const KOCHI = address('IN', '32', '682003');
const CHANDIGARH = address('IN', '04', '160017');
const SAN_FRANCISCO = address('US', 'CA', '94105-1234');
const LOS_ANGELES = address('US', 'CA', '90012');
const AUSTIN = address('US', 'TX', '78701');

interface LineSpec {
  net: string;
  hsn?: string | null;
  us?: string | null;
}

function request(
  country: 'IN' | 'US',
  shipTo: TaxAddress,
  lines: LineSpec[],
  extra: { shipping?: string; orderDiscount?: string; now?: Date } = {},
): TaxRequest {
  const currency = country === 'IN' ? 'INR' : 'USD';
  const m = (amount: string) => moneyFromDecimal(amount, currency);
  return {
    websiteId: '00000000-0000-4000-8000-000000000001',
    websiteCountryCode: country,
    websiteTimeZone: country === 'IN' ? 'Asia/Kolkata' : 'America/Los_Angeles',
    customerId: '00000000-0000-4000-8000-000000000002',
    currency,
    billTo: shipTo,
    shipTo,
    now: extra.now ?? NOW,
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      productId: `00000000-0000-4000-8000-00000000010${i}`,
      net: m(l.net),
      hsnSacCode: l.hsn === undefined ? '84821011' : l.hsn,
      usTaxCategory: l.us ?? null,
    })),
    orderDiscount: m(extra.orderDiscount ?? '0'),
    shipping: m(extra.shipping ?? '0'),
  };
}

const gst = (
  codePrefix: string,
  rate: string,
  validFrom = '2025-09-22',
  validTo: string | null = null,
): GstRateRow => ({
  codePrefix,
  rate,
  validFrom,
  validTo,
});

const usRate = (
  stateCode: string,
  zipPrefix: string | null,
  rate: string,
  shippingTaxable = false,
): UsRateRow => ({
  stateCode,
  zipPrefix,
  rate,
  shippingTaxable,
  validFrom: '2026-01-01',
  validTo: null,
});

const MAHARASHTRA_GSTIN = { regime: 'gst' as const, regionCode: '27', number: '27AAPFU0939F1ZV' };

function india(
  rates: GstRateRow[] = [gst('8482', '0.18')],
  registration = MAHARASHTRA_GSTIN,
): TaxData {
  return { registrations: [registration], gstRates: rates, usRates: [], exemptions: [] };
}

function us(rates: UsRateRow[], extra: Partial<TaxData> = {}): TaxData {
  return {
    registrations: [{ regime: 'us_sales_tax', regionCode: 'CA', number: 'CA-SR-123-456789' }],
    gstRates: [],
    usRates: rates,
    exemptions: [],
    ...extra,
  };
}

/** Each tax line as [lineNo, name, rate, taxable, amount], for compact known answers. */
function taxes(result: TaxResult) {
  if (result.problems?.length) throw new Error(JSON.stringify(result.problems));
  const text = (m: Money) => toDecimalString(m);
  return result.lines.map((t) => [t.lineNo, t.name, t.rate, text(t.taxable), text(t.amount)]);
}

describe('India GST', () => {
  it.each([
    [
      'within the state: CGST and SGST at half the rate each',
      PUNE,
      [{ net: '4100.00' }],
      [
        [1, 'CGST', '0.09', '4100.00', '369.00'],
        [1, 'SGST', '0.09', '4100.00', '369.00'],
      ],
    ],
    [
      'to another state: IGST at the full rate',
      KOCHI,
      [{ net: '4100.00' }],
      [[1, 'IGST', '0.18', '4100.00', '738.00']],
    ],
    [
      'each half rounds on its own: 9% of 12.35 is 1.1115, twice 1.11',
      PUNE,
      [{ net: '12.35' }],
      [
        [1, 'CGST', '0.09', '12.35', '1.11'],
        [1, 'SGST', '0.09', '12.35', '1.11'],
      ],
    ],
    [
      'IGST on the same 12.35 is 2.223, so 2.22',
      KOCHI,
      [{ net: '12.35' }],
      [[1, 'IGST', '0.18', '12.35', '2.22']],
    ],
  ])('%s', (_name, shipTo, lines, expected) => {
    expect(taxes(calculateTax(request('IN', shipTo, lines), india()))).toEqual(expected);
  });

  it('can differ from IGST by a paisa when split: 2.5% of 0.55 is 0.01375 twice, 5% is 0.0275', () => {
    const data = india([gst('8482', '0.05')]);
    expect(taxes(calculateTax(request('IN', PUNE, [{ net: '0.55' }]), data))).toEqual([
      [1, 'CGST', '0.025', '0.55', '0.01'],
      [1, 'SGST', '0.025', '0.55', '0.01'],
    ]);
    expect(taxes(calculateTax(request('IN', KOCHI, [{ net: '0.55' }]), data))).toEqual([
      [1, 'IGST', '0.05', '0.55', '0.03'],
    ]);
  });

  it('charges UTGST in place of SGST in a union territory without a legislature', () => {
    const chandigarh = { regime: 'gst' as const, regionCode: '04', number: '04AAPFU0939F1Z3' };
    const result = calculateTax(
      request('IN', CHANDIGARH, [{ net: '1000.00' }]),
      india(undefined, chandigarh),
    );
    expect(taxes(result)).toEqual([
      [1, 'CGST', '0.09', '1000.00', '90.00'],
      [1, 'UTGST', '0.09', '1000.00', '90.00'],
    ]);
    expect(result.sellerTaxId).toBe('04AAPFU0939F1Z3');
  });

  it.each([
    ['84821011', '0.05', 'the full code beats its heading and chapter'],
    ['84829900', '0.18', 'the heading 8482 beats the chapter 84'],
    ['84131900', '0.12', 'the chapter 84 covers what nothing longer does'],
  ])('rates %s at %s: %s', (code, rate) => {
    const data = india([gst('84', '0.12'), gst('8482', '0.18'), gst('84821011', '0.05')]);
    const result = calculateTax(request('IN', KOCHI, [{ net: '100.00', hsn: code }]), data);
    expect(result.lines[0]?.rate).toBe(rate);
    expect(result.taxCodes.get(1)).toBe(code);
  });

  it("uses the rate of the website's day: 00:30 in Kolkata is already the new rate's first day", () => {
    const data = india([
      gst('8482', '0.18', '2025-09-22', '2026-11-20'),
      gst('8482', '0.05', '2026-11-20'),
    ]);
    const lastEvening = new Date('2026-11-19T18:00:00Z'); // 23:30 IST on the 19th
    const justAfterMidnight = new Date('2026-11-19T19:00:00Z'); // 00:30 IST on the 20th
    const rateAt = (now: Date) =>
      calculateTax(request('IN', KOCHI, [{ net: '100.00' }], { now }), data).lines[0]?.rate;
    expect(rateAt(lastEvening)).toBe('0.18');
    expect(rateAt(justAfterMidnight)).toBe('0.05');
  });

  it('taxes shipping at the highest rate among the lines', () => {
    const data = india([gst('8482', '0.18'), gst('4015', '0.05')]);
    const result = calculateTax(
      request('IN', KOCHI, [{ net: '1000.00', hsn: '40151900' }, { net: '100.00' }], {
        shipping: '250.00',
      }),
      data,
    );
    expect(taxes(result)).toEqual([
      [1, 'IGST', '0.05', '1000.00', '50.00'],
      [2, 'IGST', '0.18', '100.00', '18.00'],
      [null, 'IGST', '0.18', '250.00', '45.00'],
    ]);
  });

  it('spreads order discounts over the lines by net before taxing', () => {
    const result = calculateTax(
      request('IN', KOCHI, [{ net: '300.00' }, { net: '100.00' }], { orderDiscount: '100.00' }),
      india(),
    );
    expect(taxes(result)).toEqual([
      [1, 'IGST', '0.18', '225.00', '40.50'],
      [2, 'IGST', '0.18', '75.00', '13.50'],
    ]);
  });

  it('names every line it cannot tax, and taxes none of them', () => {
    const result = calculateTax(
      request('IN', KOCHI, [
        { net: '1.00' },
        { net: '1.00', hsn: null },
        { net: '1.00', hsn: '90189099' },
      ]),
      india(),
    );
    expect(result.lines).toEqual([]);
    expect(result.problems?.map((p) => [p.lineNo, p.code])).toEqual([
      [2, 'no_tax_code'],
      [3, 'no_rate'],
    ]);
  });

  it('refuses without a GST registration, or for an order shipped abroad', () => {
    const noGstin: TaxData = { ...india(), registrations: [] };
    expect(calculateTax(request('IN', KOCHI, [{ net: '1.00' }]), noGstin).problems).toMatchObject([
      { lineNo: null, code: 'no_registration' },
    ]);
    expect(calculateTax(request('IN', AUSTIN, [{ net: '1.00' }]), india()).problems).toMatchObject([
      { lineNo: null, code: 'cross_border' },
    ]);
  });
});

describe('US sales tax', () => {
  const californiaRates = [usRate('CA', null, '0.0725'), usRate('CA', '941', '0.08625', true)];

  it('charges the longest ZIP prefix rate, reading the ZIP from a ZIP+4', () => {
    const result = calculateTax(
      request('US', SAN_FRANCISCO, [{ net: '100.00' }], { shipping: '20.00' }),
      us(californiaRates),
    );
    // 8.625% of 100.00 is 8.625, half up 8.63; shipping is taxable at this rate: 1.725, 1.73.
    expect(taxes(result)).toEqual([
      [1, 'CA sales tax', '0.08625', '100.00', '8.63'],
      [null, 'CA sales tax', '0.08625', '20.00', '1.73'],
    ]);
    expect(result.sellerTaxId).toBe('CA-SR-123-456789');
    expect(result.taxCodes.get(1)).toBe('general');
  });

  it("falls back to the state's rate, which here does not tax shipping", () => {
    const result = calculateTax(
      request('US', LOS_ANGELES, [{ net: '100.00' }], { shipping: '20.00' }),
      us(californiaRates),
    );
    expect(taxes(result)).toEqual([[1, 'CA sales tax', '0.0725', '100.00', '7.25']]);
  });

  it('charges nothing in a state where the seller has no permit', () => {
    const result = calculateTax(
      request('US', AUSTIN, [{ net: '100.00' }]),
      us([usRate('TX', null, '0.0625')]),
    );
    expect(result).toMatchObject({ lines: [], sellerTaxId: null });
    expect(result.problems).toBeUndefined();
  });

  it('skips exempt products, and shipping when nothing in the order is taxable', () => {
    const rates = [usRate('CA', null, '0.0725', true)];
    const mixed = calculateTax(
      request('US', LOS_ANGELES, [{ net: '100.00', us: 'exempt' }, { net: '50.00' }], {
        shipping: '10.00',
      }),
      us(rates),
    );
    expect(taxes(mixed)).toEqual([
      [2, 'CA sales tax', '0.0725', '50.00', '3.63'],
      [null, 'CA sales tax', '0.0725', '10.00', '0.73'],
    ]);
    const allExempt = calculateTax(
      request('US', LOS_ANGELES, [{ net: '100.00', us: 'exempt' }], { shipping: '10.00' }),
      us(rates),
    );
    expect(allExempt.lines).toEqual([]);
  });

  it('makes the order tax free with a valid exemption certificate, and records it', () => {
    const certificate = {
      stateCode: 'CA',
      certificateNumber: 'CDTFA-230-RESALE-77',
      // NOW is 22:00 on the 19th in Los Angeles: the certificate's last day.
      expiresOn: '2026-11-19',
    };
    const valid = calculateTax(
      request('US', LOS_ANGELES, [{ net: '100.00' }]),
      us(californiaRates, { exemptions: [certificate] }),
    );
    expect(valid).toMatchObject({ lines: [], exemptionCertificate: 'CDTFA-230-RESALE-77' });

    const expired = calculateTax(
      request('US', LOS_ANGELES, [{ net: '100.00' }]),
      us(californiaRates, { exemptions: [{ ...certificate, expiresOn: '2026-11-18' }] }),
    );
    expect(taxes(expired)).toEqual([[1, 'CA sales tax', '0.0725', '100.00', '7.25']]);
  });

  it('refuses when no rate covers the ship-to address', () => {
    const result = calculateTax(request('US', LOS_ANGELES, [{ net: '1.00' }]), us([]));
    expect(result.problems).toMatchObject([{ lineNo: null, code: 'no_rate' }]);
  });
});

describe('helpers', () => {
  it.each([
    ['0.180000', '0.18'],
    ['0.000000', '0'],
    ['0.086250', '0.08625'],
    ['0.5', '0.5'],
  ])('rateText(%j) is %j', (input, expected) => {
    expect(rateText(input)).toBe(expected);
  });

  it.each([
    ['2026-11-19T18:29:59Z', 'Asia/Kolkata', '2026-11-19'],
    ['2026-11-19T18:30:00Z', 'Asia/Kolkata', '2026-11-20'],
    ['2026-11-20T07:59:59Z', 'America/Los_Angeles', '2026-11-19'],
  ])('localDay(%s, %s) is %s', (instant, zone, day) => {
    expect(localDay(new Date(instant), zone)).toBe(day);
  });
});
