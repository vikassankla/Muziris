import { describe, expect, it } from 'vitest';
import { validateAddress } from '../components/address-sheet.js';
import type { NewAddress } from './endpoints.js';
import { gstinMessage, isPinCode, isZipCode } from './address-rules.js';

const india: NewAddress = {
  countryCode: 'IN',
  label: 'Chakan stores',
  line1: 'Gat No. 118',
  line2: '',
  city: 'Khed, Pune',
  regionCode: '27',
  postalCode: '410501',
  gstin: null,
  isDefaultBilling: false,
  isDefaultShipping: false,
};

describe('India and US address rules', () => {
  it.each([
    ['410501', true],
    ['410 501', true],
    ['010501', false],
    ['41050', false],
    ['4105011', false],
  ])('PIN code %s is valid: %s', (pin, ok) => {
    expect(isPinCode(pin)).toBe(ok);
  });

  it.each([
    ['77029', true],
    ['77029-1234', true],
    ['770291234', true],
    ['77029-12', false],
    ['7702', false],
  ])('ZIP code %s is valid: %s', (zip, ok) => {
    expect(isZipCode(zip)).toBe(ok);
  });

  it.each([
    ['27AAPFU0939F1ZV', '27', undefined],
    ['27aapfu0939f1zv', '27', undefined],
    [
      '27AAPFU0939F1ZV',
      '29',
      'GSTIN starts with 27 (Maharashtra) but the state is 29 (Karnataka).',
    ],
    ['27AAPFU0939F1ZX', '27', 'The GSTIN check character is wrong; check for a typing mistake.'],
    ['99AAPFU0939F1ZV', '27', 'The GSTIN starts with an unknown GST state code.'],
    [
      '27AAPFU0939',
      '27',
      'Use a 15-character GSTIN: state code, PAN, entity number, Z and a check character.',
    ],
  ])('GSTIN %s for state %s gives %s', (gstin, state, message) => {
    expect(gstinMessage(gstin, state)).toBe(message);
  });

  it('checks an India address before sending it', () => {
    expect(validateAddress(india)).toEqual({});
    expect(validateAddress({ ...india, postalCode: '4105' })).toEqual({
      postalCode: 'Enter a 6-digit PIN code, such as 410501.',
    });
    expect(validateAddress({ ...india, regionCode: '', gstin: null })).toEqual({
      regionCode: 'Choose a state.',
    });
    expect(validateAddress({ ...india, gstin: '29AABCA1234F2Z4' })['gstin']).toMatch(
      /^GSTIN starts with 29/,
    );
  });

  it('checks a US address before sending it', () => {
    const us: NewAddress = {
      ...india,
      countryCode: 'US',
      regionCode: 'TX',
      postalCode: '77029-12',
    };
    expect(validateAddress(us)).toEqual({
      postalCode: 'Enter a 5-digit ZIP code (77029) or ZIP+4 (77029-1234).',
    });
  });
});
