import { decimalToString, parseDecimal, type Decimal } from '@muziris/money';

/**
 * A stored numeric(18, 6) quantity as a short decimal string without trailing zeros:
 * "100.000000" becomes "100" and "2.500000" becomes "2.5". The value is unchanged.
 */
export function storedQuantity(text: string): string {
  return decimalToString(trimmed(parseDecimal(text)));
}

function trimmed(value: Decimal): Decimal {
  let { units, scale } = value;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}
