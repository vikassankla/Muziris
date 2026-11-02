import { readFile } from 'node:fs/promises';
import { getOperationAST, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { limitErrors, measure } from './limits.js';
import { persistedQueriesFrom } from './persisted.js';
import { storefrontSchema } from './schema.js';

// The storefront's committed registry (ADR 0015): every operation the app sends must be valid
// against this schema and inside the depth and cost limits at its largest page.
const REGISTRY = new URL('../../../storefront/persisted-queries.json', import.meta.url);

/** The largest variables each operation is sent with: pages of 50, 100 SKUs per call. */
const LARGEST: Readonly<Record<string, Record<string, unknown>>> = {
  Orders: { first: 50 },
  ShoppingLists: { first: 50 },
  ProductsBySkus: { skus: Array.from({ length: 100 }, (_, i) => `SKU-${String(i)}`) },
};

describe('the storefront registry', async () => {
  const registry = persistedQueriesFrom(JSON.parse(await readFile(REGISTRY, 'utf8')) as unknown);

  it.each([...registry.values()])('runs inside the limits: %s', (text) => {
    const document = parse(text);
    expect(validate(storefrontSchema, document)).toEqual([]);
    const operation = getOperationAST(document);
    if (!operation) throw new Error('No operation');
    const variables = LARGEST[operation.name?.value ?? ''] ?? {};
    expect(limitErrors(measure(storefrontSchema, document, operation, variables))).toEqual([]);
  });
});
