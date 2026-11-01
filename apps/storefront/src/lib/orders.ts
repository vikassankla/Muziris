import { isCurrencyCode, moneyFromDecimal, sum, toDecimalString } from '@muziris/money';
import type { OrderResult } from '../operations/generated.js';

// How an order reads for the buyer: its status, dates in the website's time zone, and the taxes
// added up per rate.

export type OrderStep = NonNullable<OrderResult['order']>['step'];

export const STEP_LABELS: Record<OrderStep, string> = {
  NEW: 'Placed',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  COMPLETED: 'Delivered',
  DECLINED: 'Declined',
};

export const STEP_TONES: Record<OrderStep, 'warning' | 'info' | 'success' | 'neutral'> = {
  NEW: 'warning',
  CONFIRMED: 'info',
  PROCESSING: 'info',
  COMPLETED: 'success',
  DECLINED: 'neutral',
};

/** "27 Oct 2026, 14:05 IST" or "Oct 27, 2026, 2:05 PM CT", in the website's time zone. */
export function formatDateTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: locale === 'en-US' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: locale === 'en-US',
    timeZoneName: locale === 'en-US' ? 'shortGeneric' : 'short',
  }).format(new Date(iso));
}

/** A YYYY-MM-DD day as "25 Nov 2026" or "Nov 25, 2026". */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));
}

/** A tax rate fraction as a percentage: "0.09" is 9%, "0.0725" is 7.25%. */
export function ratePercent(rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const padded = fraction.padEnd(2, '0');
  const units = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = padded.slice(2).replace(/0+$/, '');
  return `${units}${rest ? `.${rest}` : ''}%`;
}

interface TaxLine {
  name: string;
  rate: string;
  amount: { amount: string; currency: string };
}

/** One row per tax and rate, lines and shipping added together: "CGST 9%" ₹4,342.50. */
export function taxTotals(
  taxes: readonly TaxLine[],
): { label: string; amount: { amount: string; currency: string } }[] {
  const groups = new Map<string, TaxLine['amount'][]>();
  for (const tax of taxes) {
    const label = `${tax.name} ${ratePercent(tax.rate)}`;
    groups.set(label, [...(groups.get(label) ?? []), tax.amount]);
  }
  return [...groups].map(([label, amounts]) => {
    const currency = amounts[0]?.currency ?? '';
    if (!isCurrencyCode(currency)) return { label, amount: { amount: '', currency } };
    const total = sum(
      amounts.map((a) => moneyFromDecimal(a.amount, currency)),
      currency,
    );
    return { label, amount: { amount: toDecimalString(total), currency } };
  });
}

/** True for a zero amount ("0.00"). */
export function isZero(amount: { amount: string }): boolean {
  return /^-?0*(\.0*)?$/.test(amount.amount);
}
