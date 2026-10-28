import { describe, expect, it } from 'vitest';
import {
  MAX_ATTRIBUTES,
  newProductSchema,
  productAttributesSchema,
  productChangesSchema,
  productUnitsSchema,
  skuSchema,
  type NewProduct,
} from './index.js';

const minimal: NewProduct = { sku: 'BLT-M8-40', name: 'Hex bolt M8 x 40', primaryUnitCode: 'each' };

function issues(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  v: unknown,
) {
  const result = schema.safeParse(v);
  if (result.success) return [];
  return (result.error as { issues: { path: PropertyKey[]; message: string }[] }).issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`,
  );
}

describe('new product', () => {
  it('defaults to a disabled simple product with no category, attributes or extra units', () => {
    expect(newProductSchema.parse(minimal)).toEqual({
      sku: 'BLT-M8-40',
      name: 'Hex bolt M8 x 40',
      type: 'simple',
      status: 'disabled',
      categoryId: null,
      attributes: {},
      primaryUnitCode: 'each',
      additionalUnitCodes: [],
    });
  });

  it('trims the SKU and name', () => {
    expect(newProductSchema.parse({ ...minimal, sku: ' BLT-1 ', name: ' Bolt ' })).toMatchObject({
      sku: 'BLT-1',
      name: 'Bolt',
    });
  });

  it.each(['configurable', 'kit', 'bundle'])('refuses the %s type until it is built', (type) => {
    expect(issues(newProductSchema, { ...minimal, type })).toHaveLength(1);
  });

  it('refuses a product without a primary product unit', () => {
    expect(issues(newProductSchema, { sku: 'A1', name: 'A' })).toEqual([
      expect.stringContaining('primaryUnitCode'),
    ]);
  });
});

describe('SKU', () => {
  it.each([
    ['A', true],
    ['BLT-M8-40', true],
    ['abc.123_x/y', true],
    ['9', true],
    ['A'.repeat(64), true],
    ['A'.repeat(65), false],
    ['', false],
    ['-A1', false],
    ['A 1', false],
    ['A1;drop', false],
    ['ÄB1', false],
  ])('%j is valid: %s', (sku, valid) => {
    expect(skuSchema.safeParse(sku).success).toBe(valid);
  });
});

describe('product units on a product', () => {
  it('accepts a primary unit and distinct additional units', () => {
    expect(
      productUnitsSchema.parse({
        primaryUnitCode: 'each',
        additionalUnitCodes: ['box_10', 'pallet'],
      }),
    ).toEqual({ primaryUnitCode: 'each', additionalUnitCodes: ['box_10', 'pallet'] });
  });

  it.each([
    [{ primaryUnitCode: 'each', additionalUnitCodes: ['each'] }, 'additionalUnitCodes.0'],
    [
      { primaryUnitCode: 'each', additionalUnitCodes: ['box_10', 'box_10'] },
      'additionalUnitCodes.1',
    ],
    [{ primaryUnitCode: 'Each' }, 'primaryUnitCode'],
    [
      {
        primaryUnitCode: 'each',
        additionalUnitCodes: Array.from({ length: 20 }, (_, i) => `u${i}`),
      },
      'additionalUnitCodes',
    ],
  ])('refuses %j', (input, path) => {
    expect(issues(productUnitsSchema, input)).toEqual([
      expect.stringMatching(new RegExp(`^${path}:`)),
    ]);
  });
});

describe('product attributes', () => {
  it('accepts text, true or false, and lists of text', () => {
    const attributes = {
      material: 'stainless steel',
      thread_pitch_mm: '1.25',
      rohs_compliant: true,
      standards: ['DIN 933', 'ISO 4017'],
    };
    expect(productAttributesSchema.parse(attributes)).toEqual(attributes);
  });

  it.each([
    ['a JSON number', { weight_kg: 2.5 }],
    ['null', { colour: null }],
    ['a nested object', { size: { width: '10' } }],
    ['empty text', { colour: '  ' }],
    ['an empty list', { standards: [] }],
    ['a list of numbers', { sizes: [8, 10] }],
    ['an upper-case key', { Colour: 'red' }],
    ['a key starting with _', { __proto__x: 'x' }],
    ['a key with spaces', { 'thread pitch': '1.25' }],
    ['text that is too long', { notes: 'x'.repeat(1001) }],
    ['an array instead of an object', ['red']],
    ['text instead of an object', 'red'],
  ])('refuses %s', (_label, attributes) => {
    expect(productAttributesSchema.safeParse(attributes).success).toBe(false);
  });

  it(`refuses more than ${MAX_ATTRIBUTES} attributes`, () => {
    const attributes = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, 'x']));
    expect(productAttributesSchema.safeParse(attributes(MAX_ATTRIBUTES + 1)).success).toBe(false);
    expect(productAttributesSchema.safeParse(attributes(MAX_ATTRIBUTES)).success).toBe(true);
  });
});

describe('product changes', () => {
  it('accepts any subset of the editable fields', () => {
    expect(productChangesSchema.parse({ status: 'enabled' })).toEqual({ status: 'enabled' });
  });

  it.each([{ type: 'kit' }, { primaryUnitCode: 'kg' }, { id: crypto.randomUUID() }])(
    'refuses %j, which cannot be changed this way',
    (changes) => {
      expect(productChangesSchema.safeParse(changes).success).toBe(false);
    },
  );
});
