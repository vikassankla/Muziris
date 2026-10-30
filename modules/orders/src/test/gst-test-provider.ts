import { money, multiply, parseDecimal, type Money } from '@muziris/money';
import type { TaxLine, TaxProvider, TaxRequest } from '../totals.js';

// A stand-in for the tax module (ADR 0017), for tests only: one GST rate on everything, split
// into CGST and SGST when the seller and the ship-to address are in the same state, IGST when
// they are not. Each tax is rounded half up per line, once.

function percentOf(amount: Money, rate: string): Money {
  return multiply(amount, parseDecimal(rate), 'half-up');
}

export function gstTestProvider(options: { sellerState: string; rate: string }): TaxProvider {
  const half = (Number(options.rate) / 2).toFixed(6).replace(/0+$/, '');
  return {
    name: 'gst_test',
    calculate: (request: TaxRequest) => {
      const intraState = request.shipTo.regionCode === options.sellerState;
      const taxesOn = (lineNo: number | null, taxable: Money): TaxLine[] =>
        intraState
          ? (['CGST', 'SGST'] as const).map((name) => ({
              lineNo,
              name,
              rate: half,
              taxable,
              amount: percentOf(taxable, half),
            }))
          : [
              {
                lineNo,
                name: 'IGST',
                rate: options.rate,
                taxable,
                amount: percentOf(taxable, options.rate),
              },
            ];
      const lines = request.lines.flatMap((l) => taxesOn(l.lineNo, l.net));
      if (request.shipping.minor > 0n) lines.push(...taxesOn(null, request.shipping));
      return Promise.resolve({
        lines,
        taxCodes: new Map(request.lines.map((l) => [l.lineNo, '8482'])),
      });
    },
  };
}

export const NO_TAX: TaxProvider = {
  name: 'none',
  calculate: () => Promise.resolve({ lines: [], taxCodes: new Map() }),
};

export const inr = (minor: bigint) => money(minor, 'INR');
