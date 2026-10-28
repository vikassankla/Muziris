import { parseDecimal, type RoundingMode } from '@muziris/money';
import { describe, expect, it } from 'vitest';
import {
  isValidUnitPrecision,
  newProductUnitSchema,
  parseQuantity,
  quantitySchema,
  quantityToString,
} from './index.js';

const each = { precision: 0 };
const kg = { precision: 3 };

describe('unit precision', () => {
  it.each([
    [0, true],
    [1, true],
    [3, true],
    [6, true],
    [7, false],
    [-1, false],
    [1.5, false],
    [Number.NaN, false],
  ])('precision %d is valid: %s', (precision, valid) => {
    expect(isValidUnitPrecision(precision)).toBe(valid);
    expect(
      newProductUnitSchema.safeParse({ code: 'kg', name: 'Kilogram', precision }).success,
    ).toBe(valid);
  });
});

describe('parseQuantity without rounding', () => {
  // [input, precision, result]
  it.each([
    ['1', 0, '1'],
    ['12', 0, '12'],
    ['12.000', 0, '12'],
    ['2.5', 1, '2.5'],
    ['2.50', 1, '2.5'],
    ['2', 3, '2.000'],
    ['0.001', 3, '0.001'],
    ['1.2345', 4, '1.2345'],
    ['0.000001', 6, '0.000001'],
    ['999999999999', 0, '999999999999'],
    ['999999999999.999999', 6, '999999999999.999999'],
    [' 7 ', 0, '7'],
  ])('reads %j at precision %d as %s', (input, precision, expected) => {
    const result = parseQuantity(input, { precision });
    expect(quantityToString(result)).toBe(expected);
    expect(result.scale).toBe(precision);
  });

  // [input, precision, message]
  it.each([
    ['1.5', 0, 'at most 0 digits'],
    ['2.25', 1, 'at most 1 digits'],
    ['0.0005', 3, 'at most 3 digits'],
    ['0', 0, 'greater than zero'],
    ['0.000', 3, 'greater than zero'],
    ['-1', 0, 'greater than zero'],
    ['1000000000000', 0, 'at most 12 digits'],
    ['1000000000000.000', 3, 'at most 12 digits'],
  ])('refuses %j at precision %d', (input, precision, message) => {
    expect(() => parseQuantity(input, { precision })).toThrow(RangeError);
    expect(() => parseQuantity(input, { precision })).toThrow(message);
  });

  it.each(['', 'abc', '1e3', '1,5', '.5', '5.', '+1', 'NaN'])(
    'refuses %j as not a number',
    (input) => {
      expect(() => parseQuantity(input, each)).toThrow(TypeError);
    },
  );

  it('refuses a unit with an invalid precision', () => {
    expect(() => parseQuantity('1', { precision: 7 })).toThrow(RangeError);
  });

  it('accepts a Decimal as well as a string', () => {
    expect(quantityToString(parseQuantity(parseDecimal('1.5'), kg))).toBe('1.500');
  });
});

describe('parseQuantity with rounding', () => {
  // [input, precision, half-up, half-even, down, up]; null means refused, as zero or too large.
  it.each([
    ['2.5', 0, '3', '2', '2', '3'],
    ['3.5', 0, '4', '4', '3', '4'],
    ['2.4', 0, '2', '2', '2', '3'],
    ['2.6', 0, '3', '3', '2', '3'],
    ['1.25', 1, '1.3', '1.2', '1.2', '1.3'],
    ['1.35', 1, '1.4', '1.4', '1.3', '1.4'],
    ['1.0005', 3, '1.001', '1.000', '1.000', '1.001'],
    ['1.0015', 3, '1.002', '1.002', '1.001', '1.002'],
    ['1.00049', 3, '1.000', '1.000', '1.000', '1.001'],
    ['0.0004', 3, null, null, null, '0.001'],
    ['0.0005', 3, '0.001', null, null, '0.001'],
    ['0.4', 0, null, null, null, '1'],
    ['2', 2, '2.00', '2.00', '2.00', '2.00'],
    ['999999999999.5', 0, null, null, '999999999999', null],
    ['999999999998.5', 0, '999999999999', '999999999998', '999999999998', '999999999999'],
  ] as const)('rounds %j to precision %d', (input, precision, halfUp, halfEven, down, up) => {
    const modes: [RoundingMode, string | null][] = [
      ['half-up', halfUp],
      ['half-even', halfEven],
      ['down', down],
      ['up', up],
    ];
    for (const [mode, expected] of modes) {
      const run = () => quantityToString(parseQuantity(input, { precision }, mode));
      if (expected === null) expect(run, mode).toThrow(RangeError);
      else expect(run(), mode).toBe(expected);
    }
  });
});

describe('quantitySchema', () => {
  it('parses a decimal string into a quantity at the unit precision', () => {
    expect(quantityToString(quantitySchema(kg).parse('2.5'))).toBe('2.500');
  });

  it('rounds when given a mode', () => {
    expect(quantityToString(quantitySchema(each, 'up').parse('2.1'))).toBe('3');
  });

  it.each([2.5, 1, null, true, '1.5'])('refuses %j for a unit sold whole', (input) => {
    expect(quantitySchema(each).safeParse(input).success).toBe(false);
  });

  it('explains why a quantity was refused', () => {
    const result = quantitySchema(each).safeParse('1.5');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('at most 0 digits');
  });
});
