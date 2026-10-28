import {
  compareDecimals,
  decimalToString,
  parseDecimal,
  rescale,
  type Decimal,
  type RoundingMode,
} from '@muziris/money';
import { z } from 'zod';

/** The most digits after the decimal point a product unit may allow. */
export const MAX_UNIT_PRECISION = 6;

/** Quantities stay below 10^12, so they fit numeric(18, 6) columns at every precision. */
export const MAX_QUANTITY_INTEGER_DIGITS = 12;

const QUANTITY_LIMIT: Decimal = { units: 10n ** BigInt(MAX_QUANTITY_INTEGER_DIGITS), scale: 0 };

export function isValidUnitPrecision(precision: number): boolean {
  return Number.isInteger(precision) && precision >= 0 && precision <= MAX_UNIT_PRECISION;
}

/**
 * Reads a quantity in a product unit from a plain decimal string ("12", "2.500"). The result has
 * exactly the unit's precision as its scale.
 *
 * Without a rounding mode, a quantity with more significant decimals than the unit allows is
 * refused, so a buyer's "1.25" box is never silently changed. With one, the quantity is rounded
 * once, here. Either way the result must be greater than zero and below 10^12.
 */
export function parseQuantity(
  input: string | Decimal,
  unit: { readonly precision: number },
  rounding?: RoundingMode,
): Decimal {
  if (!isValidUnitPrecision(unit.precision)) {
    throw new RangeError(`Unit precision must be an integer from 0 to ${MAX_UNIT_PRECISION}`);
  }
  const value = typeof input === 'string' ? parseDecimal(input) : input;
  let result: Decimal;
  if (value.scale <= unit.precision) {
    result = rescale(value, unit.precision, 'down');
  } else if (rounding === undefined) {
    result = rescale(value, unit.precision, 'down');
    if (compareDecimals(result, value) !== 0) {
      throw new RangeError(
        `This unit allows at most ${unit.precision} digits after the decimal point`,
      );
    }
  } else {
    result = rescale(value, unit.precision, rounding);
  }
  if (result.units <= 0n) {
    throw new RangeError('A quantity must be greater than zero');
  }
  if (compareDecimals(result, QUANTITY_LIMIT) >= 0) {
    throw new RangeError(
      `A quantity must have at most ${MAX_QUANTITY_INTEGER_DIGITS} digits before the decimal point`,
    );
  }
  return result;
}

/** A quantity as a decimal string with the unit's precision, for example "2.500". */
export function quantityToString(quantity: Decimal): string {
  return decimalToString(quantity);
}

/**
 * A zod schema for a quantity in a unit, given as a decimal string. JSON numbers are refused,
 * because a binary float may already have lost the value the buyer typed.
 */
export function quantitySchema(
  unit: { readonly precision: number },
  rounding?: RoundingMode,
): z.ZodType<Decimal, string> {
  return z
    .string()
    .max(40)
    .transform((input, ctx) => {
      try {
        return parseQuantity(input, unit, rounding);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Not a valid quantity',
        });
        return z.NEVER;
      }
    });
}
