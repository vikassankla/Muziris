import { decimalToString, toDecimalString } from '@muziris/money';
import { describe, expect, it } from 'vitest';
import { PricingError } from './errors.js';
import { parseAmount, parseUnitQuantity } from './prices.js';

describe('parseAmount', () => {
  it.each([
    ['4.86', 'USD', '4.86'],
    ['4.8', 'USD', '4.80'],
    ['4', 'USD', '4.00'],
    ['0', 'INR', '0.00'],
    ['1250.50', 'INR', '1250.50'],
    ['1500', 'JPY', '1500'],
    ['9999999999999.99', 'INR', '9999999999999.99'],
  ] as const)('reads %s %s as %s', (input, currency, expected) => {
    expect(toDecimalString(parseAmount(input, currency))).toBe(expected);
  });

  it.each([
    ['4.865', 'USD', 'more decimals than the currency allows'],
    ['1500.5', 'JPY', 'decimals in a currency without a minor unit'],
    ['-1.00', 'INR', 'a negative amount'],
    ['10000000000000.00', 'INR', '10^15 minor units'],
    ['1e3', 'INR', 'an exponent'],
    ['4,86', 'USD', 'a decimal comma'],
    ['', 'USD', 'nothing'],
  ] as const)('refuses %s %s (%s) without rounding', (input, currency) => {
    expect(() => parseAmount(input, currency)).toThrow(PricingError);
  });
});

describe('parseUnitQuantity', () => {
  it.each([
    ['1', 0, '1'],
    ['100', 0, '100'],
    ['0.5', 3, '0.500'],
    ['2.5', 3, '2.500'],
    ['2.500', 3, '2.500'],
  ] as const)('reads %s at precision %i as %s', (input, precision, expected) => {
    expect(decimalToString(parseUnitQuantity(input, { precision }))).toBe(expected);
  });

  it.each([
    ['1.5', 0],
    ['0.0005', 3],
    ['0', 0],
    ['-1', 0],
    ['abc', 0],
  ] as const)('refuses %s at precision %i', (input, precision) => {
    expect(() => parseUnitQuantity(input, { precision })).toThrow(PricingError);
  });
});
