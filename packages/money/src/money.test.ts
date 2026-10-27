import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  CurrencyMismatchError,
  decimalToString,
  divideRounded,
  format,
  money,
  moneyFromDecimal,
  multiply,
  parseDecimal,
  subtract,
  sum,
  toDecimalString,
} from './index.js';

describe('parseDecimal', () => {
  it.each([
    ['0', 0n, 0],
    ['12', 12n, 0],
    ['3.125', 3125n, 3],
    ['-0.50', -50n, 2],
    ['  7.0 ', 70n, 1],
  ])('parses %s', (input, units, scale) => {
    expect(parseDecimal(input)).toEqual({ units, scale });
  });

  it.each(['', '1e3', '1.2.3', 'abc', '.5', '5.', 'NaN', 'Infinity'])('rejects %j', (input) => {
    expect(() => parseDecimal(input)).toThrow(TypeError);
  });

  it('round-trips to a string', () => {
    expect(decimalToString(parseDecimal('-0.050'))).toBe('-0.050');
    expect(decimalToString(parseDecimal('42'))).toBe('42');
  });
});

describe('divideRounded', () => {
  // [numerator, divisor, half-up, half-even, down, up]
  it.each([
    [25n, 10n, 3n, 2n, 2n, 3n],
    [35n, 10n, 4n, 4n, 3n, 4n],
    [-25n, 10n, -3n, -2n, -2n, -3n],
    [24n, 10n, 2n, 2n, 2n, 3n],
    [26n, 10n, 3n, 3n, 2n, 3n],
    [20n, 10n, 2n, 2n, 2n, 2n],
  ])('%d / %d', (n, d, halfUp, halfEven, down, up) => {
    expect(divideRounded(n, d, 'half-up')).toBe(halfUp);
    expect(divideRounded(n, d, 'half-even')).toBe(halfEven);
    expect(divideRounded(n, d, 'down')).toBe(down);
    expect(divideRounded(n, d, 'up')).toBe(up);
  });

  it('rejects a zero divisor', () => {
    expect(() => divideRounded(1n, 0n, 'half-up')).toThrow(RangeError);
  });
});

describe('money', () => {
  it('builds from a decimal string in major units', () => {
    expect(moneyFromDecimal('1250.50', 'INR')).toEqual(money(125050n, 'INR'));
    expect(moneyFromDecimal('1250', 'JPY')).toEqual(money(1250n, 'JPY'));
  });

  it('refuses extra decimal places unless a rounding mode is given', () => {
    expect(() => moneyFromDecimal('10.005', 'USD')).toThrow(RangeError);
    expect(moneyFromDecimal('10.005', 'USD', 'half-up').minor).toBe(1001n);
    expect(moneyFromDecimal('10.005', 'USD', 'half-even').minor).toBe(1000n);
  });

  it('refuses unknown currencies', () => {
    expect(() => moneyFromDecimal('1', 'XYZ')).toThrow(TypeError);
  });

  it('never mixes currencies', () => {
    expect(() => add(money(1n, 'INR'), money(1n, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('adds, subtracts and sums exactly', () => {
    const a = moneyFromDecimal('0.10', 'USD');
    const b = moneyFromDecimal('0.20', 'USD');
    expect(toDecimalString(add(a, b))).toBe('0.30');
    expect(toDecimalString(subtract(a, b))).toBe('-0.10');
    expect(toDecimalString(sum([a, b, a], 'USD'))).toBe('0.40');
  });

  // Known answers: line totals for fractional quantities and GST at 18%.
  it.each([
    ['199.99', '3', 'half-up', '599.97'],
    ['12.50', '2.5', 'half-up', '31.25'],
    ['0.33', '0.5', 'half-up', '0.17'],
    ['0.33', '0.5', 'half-even', '0.16'],
    ['1000.00', '0.18', 'half-up', '180.00'],
    ['999.99', '0.18', 'half-up', '180.00'],
    ['999.99', '0.09', 'half-up', '90.00'],
  ])('%s INR x %s (%s) = %s', (price, factor, mode, expected) => {
    const result = multiply(moneyFromDecimal(price, 'INR'), factor, mode as 'half-up');
    expect(toDecimalString(result)).toBe(expected);
  });

  it('allocates without losing a minor unit', () => {
    const parts = allocate(moneyFromDecimal('100.00', 'INR'), [1, 1, 1]);
    expect(parts.map(toDecimalString)).toEqual(['33.34', '33.33', '33.33']);
    expect(toDecimalString(sum(parts, 'INR'))).toBe('100.00');

    const weighted = allocate(moneyFromDecimal('10.00', 'USD'), [70, 20, 10]);
    expect(weighted.map(toDecimalString)).toEqual(['7.00', '2.00', '1.00']);

    const negative = allocate(moneyFromDecimal('-1.00', 'USD'), [1, 1, 1]);
    expect(toDecimalString(sum(negative, 'USD'))).toBe('-1.00');
  });

  it('formats rupees in lakhs and crores, dollars in thousands', () => {
    expect(format(moneyFromDecimal('100000', 'INR'), 'en-IN')).toBe('₹1,00,000.00');
    expect(format(moneyFromDecimal('12345678.9', 'INR'), 'en-IN')).toBe('₹1,23,45,678.90');
    expect(format(moneyFromDecimal('100000', 'USD'), 'en-US')).toBe('$100,000.00');
  });

  it('formats amounts beyond float precision exactly', () => {
    expect(format(money(9007199254740993n, 'USD'), 'en-US')).toBe('$90,071,992,547,409.93');
  });
});
