import { describe, expect, it } from 'vitest';
import { checkQuantity, formatPrice, lineTotal } from './format.js';

const EACH = { name: 'Each', precision: 0 };
const METRE = { name: 'Metre', precision: 3 };

describe('formatPrice', () => {
  it('groups in lakhs for en-IN', () => {
    expect(formatPrice({ amount: '112500', currency: 'INR' }, 'en-IN')).toBe('₹1,12,500.00');
  });

  it('shows an unknown currency as text', () => {
    expect(formatPrice({ amount: '5', currency: 'XYZ' }, 'en-IN')).toBe('5 XYZ');
  });
});

describe('lineTotal', () => {
  it('multiplies exactly and rounds once to paise', () => {
    expect(lineTotal({ amount: '12.50', currency: 'INR' }, '3')).toBe('37.50');
    expect(lineTotal({ amount: '0.10', currency: 'INR' }, '2.555')).toBe('0.26');
  });
});

describe('checkQuantity', () => {
  it.each([
    ['12', EACH, '12'],
    [' 007 ', EACH, '7'],
    ['2.500', METRE, '2.5'],
    ['3.', METRE, '3'],
  ])('accepts %j', (text, unit, quantity) => {
    expect(checkQuantity(text, unit)).toEqual({ ok: true, quantity });
  });

  it.each([
    ['', EACH, 'Enter a whole number of each, 1 or more.'],
    ['1.5', EACH, 'Enter a whole number of each, 1 or more.'],
    ['-2', EACH, 'Enter a whole number of each, 1 or more.'],
    ['1e3', EACH, 'Enter a whole number of each, 1 or more.'],
    ['1.2345', METRE, 'Enter a number with at most 3 decimals, more than 0.'],
    ['0', EACH, 'Enter a quantity more than 0.'],
    ['0.000', METRE, 'Enter a quantity more than 0.'],
  ])('refuses %j', (text, unit, message) => {
    expect(checkQuantity(text, unit)).toEqual({ ok: false, message });
  });
});
