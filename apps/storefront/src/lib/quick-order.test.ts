import { describe, expect, it } from 'vitest';
import { checkRows, parseQuickOrder, skuBatches, type QuickOrderProduct } from './quick-order.js';

describe('parseQuickOrder', () => {
  it('reads tabs, commas and spaces, with an optional unit and a default quantity of 1', () => {
    expect(parseQuickOrder('HB-M8-40\t400\nwa-m8, 2.5, kg\n\nNUT-M8   10  box\nTAPE')).toEqual({
      rows: [
        { line: 1, sku: 'HB-M8-40', quantity: '400' },
        { line: 2, sku: 'wa-m8', quantity: '2.5', unitCode: 'KG' },
        { line: 4, sku: 'NUT-M8', quantity: '10', unitCode: 'BOX' },
        { line: 5, sku: 'TAPE', quantity: '1' },
      ],
      problems: [],
    });
  });

  it('skips a CSV header row and a byte order mark, and honours quotes', () => {
    expect(parseQuickOrder('\uFEFF"SKU","Quantity","Unit"\r\n"HB,M8",12,EA\r\n')).toEqual({
      rows: [{ line: 2, sku: 'HB,M8', quantity: '12', unitCode: 'EA' }],
      problems: [],
    });
  });

  it('reports a line with too many fields or no SKU, and stops at 500 rows', () => {
    expect(parseQuickOrder('A,1,EA,extra\n,4').problems).toEqual([
      { line: 1, message: 'Give a SKU, a quantity and an optional unit, no more.' },
      { line: 2, message: 'Start the line with a SKU.' },
    ]);
    const many = parseQuickOrder(
      Array.from({ length: 502 }, (_, i) => `S${String(i)} 1`).join('\n'),
    );
    expect(many.rows).toHaveLength(500);
    expect(many.problems).toEqual([
      { line: 501, message: 'A quick order holds at most 500 rows.' },
    ]);
  });
});

describe('skuBatches', () => {
  it('asks for each SKU once, whatever its case, 100 at a time', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      line: i + 1,
      sku: `s${String(i % 150)}`,
      quantity: '1',
    }));
    const batches = skuBatches([...rows, { line: 251, sku: 'S1', quantity: '1' }]);
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
  });
});

describe('checkRows', () => {
  const bolt: QuickOrderProduct = {
    id: 'p1',
    sku: 'HB-M8-40',
    name: 'Hex bolt',
    units: [
      { code: 'EA', name: 'Each', precision: 0 },
      { code: 'KG', name: 'Kilogram', precision: 3 },
    ],
    price: { unitPrice: { amount: '12.50', currency: 'INR' } },
  };
  const unpriced: QuickOrderProduct = { ...bolt, id: 'p2', sku: 'TAPE', price: null };

  it('passes a known SKU in any case, in the primary unit or one it is sold in', () => {
    const [a, b] = checkRows(
      [
        { line: 1, sku: 'hb-m8-40', quantity: '0400' },
        { line: 2, sku: 'HB-M8-40', quantity: '2.50', unitCode: 'KG' },
      ],
      [bolt],
    );
    expect(a).toMatchObject({ ok: true, quantity: '400', unit: { code: 'EA' } });
    expect(b).toMatchObject({ ok: true, quantity: '2.5', unit: { code: 'KG' } });
  });

  it('explains each row that cannot be ordered', () => {
    const messages = checkRows(
      [
        { line: 1, sku: 'NOPE', quantity: '1' },
        { line: 2, sku: 'HB-M8-40', quantity: '1', unitCode: 'BOX' },
        { line: 3, sku: 'HB-M8-40', quantity: '1.5' },
        { line: 4, sku: 'TAPE', quantity: '1' },
      ],
      [bolt, unpriced],
    ).map((r) => (r.ok ? '' : r.message));
    expect(messages).toEqual([
      'We can’t find this SKU in your catalogue.',
      'Not sold in BOX. Units: EA, KG.',
      'Enter a whole number of each, 1 or more.',
      'No price on your account. Ask your account manager for a quote.',
    ]);
  });
});
