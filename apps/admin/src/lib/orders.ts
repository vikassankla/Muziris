import { moneyFromDecimal, sum, toDecimalString } from '@muziris/money';
import { GST_STATE_CODES, US_STATES } from './address-rules.js';
import type { Order, OrderAddress, OrderStep } from './endpoints.js';
import type { DisplayContext } from './format.js';
import { PLACEHOLDER_WEBSITES } from './website.js';

// How orders read in the admin: step names and tones, transition buttons, and the display
// context an order's own currency implies.

export const STEP_LABELS: Record<OrderStep, string> = {
  new: 'New',
  confirmed: 'Confirmed',
  processing: 'Processing',
  completed: 'Completed',
  declined: 'Declined',
};

export const STEP_TONES: Record<OrderStep, 'warning' | 'info' | 'success' | 'neutral'> = {
  new: 'warning',
  confirmed: 'info',
  processing: 'info',
  completed: 'success',
  declined: 'neutral',
};

/** The steps an order passes through when nothing goes wrong, for the progress strip. */
export const HAPPY_PATH: readonly OrderStep[] = ['new', 'confirmed', 'processing', 'completed'];

export const TRANSITION_LABELS: Record<string, { label: string; destructive?: boolean }> = {
  confirm: { label: 'Confirm order' },
  start_processing: { label: 'Start processing' },
  complete: { label: 'Mark delivered' },
  decline: { label: 'Decline order', destructive: true },
};

export function transitionLabel(transition: string): string {
  return TRANSITION_LABELS[transition]?.label ?? transition;
}

/**
 * An order is shown in its own currency's format, whatever website the top bar is set to:
 * INR the Indian way in IST, USD the US way. There is no websites API to say more yet.
 */
export function orderDisplay(currency: string): DisplayContext {
  const match = PLACEHOLDER_WEBSITES.find((w) => w.currency === currency);
  return match ?? { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' };
}

/** An order address as printed lines: label, street, city with region, GSTIN when held. */
export function addressLines(address: OrderAddress): string[] {
  const india = address.countryCode === 'IN';
  const region = india
    ? `${GST_STATE_CODES[address.regionCode] ?? address.regionCode} (${address.regionCode})`
    : (US_STATES[address.regionCode] ?? address.regionCode);
  const lines = [address.label, address.line1];
  if (address.line2) lines.push(address.line2);
  lines.push(`${address.city}, ${region} ${address.postalCode}`);
  lines.push(
    india ? 'India' : address.countryCode === 'US' ? 'United States' : address.countryCode,
  );
  if (address.gstin) lines.push(`GSTIN ${address.gstin}`);
  return lines;
}

/** "Net 30" for payment terms. */
export function paymentTerm(days: number): string {
  return days === 0 ? 'Due on receipt' : `Net ${String(days)}`;
}

/** A tax rate fraction as a percentage: "0.09" is 9%, "0.0725" is 7.25%. */
export function ratePercent(rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const padded = fraction.padEnd(2, '0');
  const units = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = padded.slice(2).replace(/0+$/, '');
  return `${units}${rest ? `.${rest}` : ''}%`;
}

/**
 * The order's taxes as the totals show them: one row per tax and rate, adding the lines and
 * shipping together ("CGST 9%": 16,734.60).
 */
export function taxTotals(order: Pick<Order, 'taxes' | 'currency'>): {
  label: string;
  amount: string;
}[] {
  const groups = new Map<string, string[]>();
  for (const tax of order.taxes) {
    const label = `${tax.name} ${ratePercent(tax.rate)}`;
    groups.set(label, [...(groups.get(label) ?? []), tax.amount]);
  }
  const currency = order.currency as 'INR' | 'USD';
  return [...groups].map(([label, amounts]) => ({
    label,
    amount: toDecimalString(
      sum(
        amounts.map((a) => moneyFromDecimal(a, currency)),
        currency,
      ),
    ),
  }));
}

/** True for a decimal string that is zero ("0.00"). */
export function isZeroAmount(amount: string): boolean {
  return /^-?0*(\.0*)?$/.test(amount);
}
