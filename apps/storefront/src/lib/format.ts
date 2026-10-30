import {
  format,
  isCurrencyCode,
  moneyFromDecimal,
  multiply,
  toDecimalString,
} from '@muziris/money';

/**
 * A price in the website's locale: ₹1,12,500.00 for en-IN. The amount is a decimal string and
 * never becomes a JavaScript number.
 */
export function formatPrice(price: { amount: string; currency: string }, locale: string): string {
  if (!isCurrencyCode(price.currency)) return `${price.amount} ${price.currency}`;
  return format(moneyFromDecimal(price.amount, price.currency), locale);
}

export type QuantityCheck = { ok: true; quantity: string } | { ok: false; message: string };

/**
 * Checks a quantity typed by the buyer against the unit's precision (ADR 0009): "12" for Each,
 * up to "2.500" for a unit with three decimals. Leading zeros and a trailing dot are tidied.
 */
export function checkQuantity(
  text: string,
  unit: { name: string; precision: number },
): QuantityCheck {
  const value = text.trim();
  const match = /^(\d{1,9})(?:\.(\d*))?$/.exec(value);
  const decimals = match?.[2] ?? '';
  const unitWord = unit.name.toLowerCase();
  if (!match || decimals.length > unit.precision) {
    return {
      ok: false,
      message:
        unit.precision === 0
          ? `Enter a whole number of ${unitWord}, 1 or more.`
          : `Enter a number with at most ${unit.precision} decimals, more than 0.`,
    };
  }
  const whole = String(Number(match[1]));
  const trimmed = decimals.replace(/0+$/, '');
  const quantity = trimmed === '' ? whole : `${whole}.${trimmed}`;
  if (/^0(\.0*)?$/.test(quantity)) {
    return { ok: false, message: 'Enter a quantity more than 0.' };
  }
  return { ok: true, quantity };
}

/**
 * The line total for a checked quantity, as a decimal string: the unit price times the quantity,
 * rounded once half-up to the currency's minor unit (ADR 0009). An unknown currency gives back
 * the unit price, which formatPrice shows as text.
 */
export function lineTotal(
  unitPrice: { amount: string; currency: string },
  quantity: string,
): string {
  if (!isCurrencyCode(unitPrice.currency)) return unitPrice.amount;
  return toDecimalString(
    multiply(moneyFromDecimal(unitPrice.amount, unitPrice.currency), quantity, 'half-up'),
  );
}
