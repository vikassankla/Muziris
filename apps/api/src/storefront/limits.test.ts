import { getOperationAST, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { limitErrors, MAX_COST, MAX_DEPTH, measure } from './limits.js';
import { storefrontSchema } from './schema.js';

function measured(query: string, variables: Record<string, unknown> = {}) {
  const document = parse(query);
  expect(validate(storefrontSchema, document)).toEqual([]);
  const operation = getOperationAST(document);
  if (!operation) throw new Error('No operation');
  return measure(storefrontSchema, document, operation, variables);
}

describe('measure', () => {
  it.each([
    ['{ website { code } }', 2, 2],
    ['{ viewer { customer { name } } }', 3, 3],
    // 1 products + 1 nextAfter + 1 nodes, then 20 nodes of sku and name.
    ['{ products { nextAfter nodes { sku name } } }', 3, 3 + 20 * 2],
    ['{ products(first: 50) { nodes { sku } } }', 3, 2 + 50],
    // Each price costs its four fields per product.
    [
      '{ products(first: 50) { nodes { sku price { unitPrice { amount currency } } } } }',
      5,
      2 + 50 * (1 + 1 + 1 + 2),
    ],
    ['{ search(query: "x", first: 10) { nodes { match product { sku } } } }', 4, 2 + 10 * 3],
    // A list without first uses its declared size.
    ['{ categories { id name } }', 2, 1 + 100 * 2],
    ['{ __typename website { __typename code } }', 2, 2],
  ])('%s is %i deep and costs %i', (query, depth, cost) => {
    expect(measured(query)).toEqual({ depth, cost });
  });

  it('reads first from variables, and counts through fragments', () => {
    const query = `query Page($n: Int) { products(first: $n) { nodes { ...Card } } }
      fragment Card on Product { sku category { name } }`;
    expect(measured(query, { n: 5 })).toEqual({ depth: 4, cost: 2 + 5 * 3 });
    // A missing variable falls back to 1 here; execution then uses the default.
    expect(measured(query, {}).cost).toBe(2 + 3);
  });

  it('counts inline fragments and aliases', () => {
    const query = `{ a: product(sku: "A") { sku } b: product(sku: "B") { ... on Product { name } } }`;
    expect(measured(query)).toEqual({ depth: 2, cost: 4 });
  });
});

describe('limitErrors', () => {
  it('passes a query within the limits', () => {
    expect(limitErrors({ depth: MAX_DEPTH, cost: MAX_COST })).toEqual([]);
  });

  it('names the limit broken and the value measured', () => {
    const errors = limitErrors({ depth: MAX_DEPTH + 1, cost: MAX_COST + 1 });
    expect(errors.map((e) => e.extensions)).toEqual([
      { code: 'QUERY_TOO_DEEP', limit: MAX_DEPTH, measured: MAX_DEPTH + 1 },
      { code: 'QUERY_TOO_COSTLY', limit: MAX_COST, measured: MAX_COST + 1 },
    ]);
  });

  it('refuses 50 products asked for many times over with aliases', () => {
    const one = 'nodes { sku name price { unitPrice { amount } } }';
    const aliased = Array.from({ length: 12 }, (_, i) => `p${i}: products(first: 50) { ${one} }`);
    const found = measured(`{ ${aliased.join(' ')} }`);
    expect(found.cost).toBeGreaterThan(MAX_COST);
  });
});
