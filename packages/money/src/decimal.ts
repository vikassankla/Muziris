/**
 * Exact fixed-point decimals backed by bigint. Used for quantities and rates so that
 * floating-point rounding never reaches a price, a tax amount or a total.
 */

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

export interface Decimal {
  /** The value multiplied by 10^scale. */
  readonly units: bigint;
  /** Number of digits after the decimal point. */
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;
const MAX_SCALE = 18;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`Decimal scale must be an integer from 0 to ${MAX_SCALE}, got ${scale}`);
  }
}

/** Parses a plain decimal string such as "12", "-0.5" or "3.125". Exponents are rejected. */
export function parseDecimal(input: string): Decimal {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) {
    throw new TypeError(`Not a plain decimal number: "${input}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  assertScale(fraction.length);
  const magnitude = BigInt(whole + fraction);
  return { units: sign ? -magnitude : magnitude, scale: fraction.length };
}

export function decimalToString(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale);
  const body = value.scale > 0 ? `${whole}.${fraction}` : whole;
  return negative && value.units !== 0n ? `-${body}` : body;
}

/** Divides a bigint by a positive divisor, rounding the quotient with the given mode. */
export function divideRounded(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  if (divisor <= 0n) {
    throw new RangeError('Divisor must be positive');
  }
  const quotient = numerator / divisor; // truncates toward zero
  const remainder = numerator % divisor;
  if (remainder === 0n) {
    return quotient;
  }
  const direction = numerator < 0n ? -1n : 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return quotient + direction;
    case 'half-up':
      return twiceRemainder >= divisor ? quotient + direction : quotient;
    case 'half-even': {
      if (twiceRemainder > divisor) return quotient + direction;
      if (twiceRemainder < divisor) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + direction;
    }
  }
}

/** Changes the scale of a decimal, rounding when digits are dropped. */
export function rescale(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  assertScale(scale);
  if (scale >= value.scale) {
    return { units: value.units * pow10(scale - value.scale), scale };
  }
  return { units: divideRounded(value.units, pow10(value.scale - scale), mode), scale };
}

export function multiplyDecimals(a: Decimal, b: Decimal): Decimal {
  const scale = a.scale + b.scale;
  assertScale(scale);
  return { units: a.units * b.units, scale };
}

export function compareDecimals(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * pow10(scale - a.scale);
  const right = b.units * pow10(scale - b.scale);
  return left === right ? 0 : left < right ? -1 : 1;
}
