import { describe, expect, it } from 'vitest';
import { newAddressSchema, type NewAddress } from './index.js';

const customerId = '0b9cc2a4-58b5-4d3e-a7a2-4d2fd3bc9f4b';

const india: NewAddress = {
  customerId,
  label: 'Pune plant',
  countryCode: 'IN',
  line1: 'Plot 12, MIDC Bhosari',
  city: 'Pune',
  regionCode: '27',
  postalCode: '411 026',
  gstin: '27aapfu0939f1zv',
};

const us: NewAddress = {
  customerId,
  label: 'Head office',
  countryCode: 'US',
  line1: '1 Market St',
  city: 'San Francisco',
  regionCode: 'ca',
  postalCode: '941051234',
};

function messages(input: unknown): string[] {
  const result = newAddressSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('new address', () => {
  it('normalises an Indian address', () => {
    expect(newAddressSchema.parse(india)).toMatchObject({
      postalCode: '411026',
      gstin: '27AAPFU0939F1ZV',
      line2: null,
      isDefaultBilling: false,
    });
  });

  it('normalises a US address', () => {
    expect(newAddressSchema.parse(us)).toMatchObject({
      regionCode: 'CA',
      postalCode: '94105-1234',
      gstin: null,
    });
  });

  it('treats an empty second line as none', () => {
    expect(newAddressSchema.parse({ ...us, line2: '  ' }).line2).toBeNull();
  });

  it.each([
    ['an Indian PIN code with five digits', { ...india, postalCode: '41102' }, 'postalCode'],
    ['a US ZIP code in an Indian address', { ...india, postalCode: '94105' }, 'postalCode'],
    ['a retired GST state code', { ...india, regionCode: '25', gstin: null }, 'regionCode'],
    ['a state name instead of a code', { ...india, regionCode: 'MH', gstin: null }, 'regionCode'],
    ['a GSTIN with a wrong check character', { ...india, gstin: '27AAPFU0939F1ZW' }, 'gstin'],
    ['a GSTIN from another state', { ...india, regionCode: '29' }, 'gstin'],
    ['a ZIP code with four digits', { ...us, postalCode: '9410' }, 'postalCode'],
    ['an Indian PIN code in a US address', { ...us, postalCode: '411026' }, 'postalCode'],
    ['an unknown US state', { ...us, regionCode: 'XX' }, 'regionCode'],
    ['a GSTIN on a US address', { ...us, gstin: '27AAPFU0939F1ZV' }, 'gstin'],
    ['another country', { ...us, countryCode: 'GB' }, 'countryCode'],
    ['a blank first line', { ...us, line1: '   ' }, 'line1'],
  ])('refuses %s', (_label, input, field) => {
    const problems = messages(input);
    expect(problems.some((p) => p.startsWith(`${field}:`))).toBe(true);
  });

  it('names the state when a GSTIN does not match it', () => {
    expect(messages({ ...india, regionCode: '29' })).toContain(
      'gstin: A GSTIN for an address in Karnataka starts with 29',
    );
  });
});
