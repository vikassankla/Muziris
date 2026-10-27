import { currencyExponent, isCurrencyCode, type CurrencyCode } from './currency.js';
import {
  compareDecimals,
  divideRounded,
  multiplyDecimals,
  parseDecimal,
  rescale,
  type Decimal,
  type RoundingMode,
} from './decimal.js';

/**
 * An amount of money in integer minor units (paise, cents). Immutable.
 * Amounts in different currencies never mix: every operation checks the currency.
 */
export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`Cannot combine ${left} with ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function money(minor: bigint, currency: CurrencyCode): Money {
  return Object.freeze({ minor, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

/**
 * Builds money from a decimal string in major units, for example "1250.50" INR.
 * Rejects values with more fractional digits than the currency allows unless a rounding mode is given.
 */
export function moneyFromDecimal(amount: string, currency: string, rounding?: RoundingMode): Money {
  if (!isCurrencyCode(currency)) {
    throw new TypeError(`Unsupported currency: ${currency}`);
  }
  const exponent = currencyExponent(currency);
  const value = parseDecimal(amount);
  if (value.scale > exponent && rounding === undefined) {
    throw new RangeError(`${currency} allows ${exponent} decimal places, got "${amount}"`);
  }
  return money(rescale(value, exponent, rounding ?? 'half-up').units, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((total, item) => add(total, item), zero(currency));
}

/**
 * Multiplies by an exact decimal factor (a quantity such as "2.5" or a rate such as "0.18"),
 * rounding once to the currency's minor unit.
 */
export function multiply(amount: Money, factor: string | Decimal, rounding: RoundingMode): Money {
  const exact = multiplyDecimals(
    { units: amount.minor, scale: 0 },
    typeof factor === 'string' ? parseDecimal(factor) : factor,
  );
  return money(rescale(exact, 0, rounding).units, amount.currency);
}

/**
 * Splits an amount into parts proportional to the given weights without losing a single minor unit.
 * Leftover units go to the parts with the largest remainders, earliest first.
 */
export function allocate(amount: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0 || weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new RangeError('Weights must be non-negative integers');
  }
  const total = BigInt(weights.reduce((acc, w) => acc + w, 0));
  if (total === 0n) {
    throw new RangeError('At least one weight must be positive');
  }
  const shares = weights.map((w) => {
    const exact = amount.minor * BigInt(w);
    return { base: divideRounded(exact, total, 'down'), remainder: exact % total };
  });
  let leftover = amount.minor - shares.reduce((acc, s) => acc + s.base, 0n);
  const step = leftover < 0n ? -1n : 1n;
  const order = shares
    .map((share, index) => ({
      index,
      remainder: share.remainder < 0n ? -share.remainder : share.remainder,
    }))
    .sort((x, y) =>
      y.remainder > x.remainder ? 1 : y.remainder < x.remainder ? -1 : x.index - y.index,
    );
  const result = shares.map((s) => s.base);
  for (const { index } of order) {
    if (leftover === 0n) break;
    result[index] = (result[index] ?? 0n) + step;
    leftover -= step;
  }
  return result.map((minor) => money(minor, amount.currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return compareDecimals({ units: a.minor, scale: 0 }, { units: b.minor, scale: 0 });
}

export function isZero(amount: Money): boolean {
  return amount.minor === 0n;
}

/** The amount as a plain decimal string in major units, for APIs and storage: "1250.50". */
export function toDecimalString(amount: Money): string {
  const exponent = currencyExponent(amount.currency);
  const negative = amount.minor < 0n;
  const digits = (negative ? -amount.minor : amount.minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const body = exponent > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/**
 * Formats for display. Locale decides grouping: "en-IN" gives lakh and crore grouping
 * (₹1,00,000.00), "en-US" gives thousands grouping ($100,000.00).
 */
export function format(amount: Money, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: currencyExponent(amount.currency),
    maximumFractionDigits: currencyExponent(amount.currency),
  });
  // Intl accepts decimal strings exactly, so no float conversion happens here.
  return formatter.format(toDecimalString(amount) as `${number}`);
}
