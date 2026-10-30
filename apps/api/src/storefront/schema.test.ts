import { readFile } from 'node:fs/promises';
import { printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { storefrontSchema } from './schema.js';

describe('storefront schema', () => {
  it('matches the committed schema.graphql (run pnpm --filter @muziris/api storefront:schema)', async () => {
    const committed = await readFile(new URL('./schema.graphql', import.meta.url), 'utf8');
    expect(committed).toBe(`${printSchema(storefrontSchema)}\n`);
  });

  it('has one mutation, placeOrder, and no subscriptions', () => {
    expect(Object.keys(storefrontSchema.getMutationType()?.getFields() ?? {})).toEqual([
      'placeOrder',
    ]);
    expect(storefrontSchema.getSubscriptionType()).toBeUndefined();
  });
});
