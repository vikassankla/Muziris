import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatQuantity,
  type DisplayContext,
} from './format.js';

const IN: DisplayContext = { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' };
const US: DisplayContext = { locale: 'en-US', currency: 'USD', timeZone: 'America/Chicago' };
const kg = { code: 'kg', name: 'Kilogram', precision: 3 };
const each = { code: 'each', name: 'Each', precision: 0 };

// The "Numbers, money, dates" table on the Tokens board.
describe('formatting as on the Tokens board', () => {
  it.each([
    ['1234567.50', IN, '₹12,34,567.50'],
    ['1234567.50', US, '$1,234,567.50'],
    ['42618940.00', IN, '₹4,26,18,940.00'],
    ['426189.40', US, '$426,189.40'],
    ['0.5', IN, '₹0.50'],
  ])('money %s in %o is %s', (amount, ctx, text) => {
    expect(formatAmount(amount, ctx)).toBe(text);
  });

  it.each([
    ['2', kg, IN, '2.000 kg'],
    ['2', kg, US, '2.000 kg'],
    ['1250', each, IN, '1,250 Each'],
    ['1250', each, US, '1,250 Each'],
    ['1234567', each, IN, '12,34,567 Each'],
    ['1234567', each, US, '1,234,567 Each'],
    ['15.5', { code: 'm', name: 'Metre', precision: 2 }, IN, '15.50 m'],
    ['0.125', kg, IN, '0.125 kg'],
  ])('quantity %s of %o in %o is %s', (quantity, unit, ctx, text) => {
    expect(formatQuantity(quantity, unit, ctx)).toBe(text);
  });

  it('shows dates in the website time zone', () => {
    const iso = '2026-10-27T08:35:00.000Z';
    expect(formatDate(iso, IN)).toBe('27 Oct 2026');
    expect(formatDate(iso, US)).toBe('Oct 27, 2026');
    expect(formatDateTime(iso, IN)).toBe('27 Oct 2026, 14:05 IST');
    expect(formatDateTime('2026-10-27T19:05:00.000Z', US)).toBe('Oct 27, 2026, 2:05 PM CT');
  });
});
