import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFeature, defineSetting, scopeChain } from './definitions.js';
import { InvalidStoredSettingError, resolveSetting, type StoredValue } from './resolve.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const WEB = '00000000-0000-4000-8000-000000000002';
const GROUP = '00000000-0000-4000-8000-000000000003';
const CUSTOMER = '00000000-0000-4000-8000-000000000004';

const minOrder = defineSetting({
  key: 'checkout.minimum_order_minor',
  description: 'Minimum order value in minor units',
  schema: z.number().int().nonnegative(),
  defaultValue: 0,
  allowedScopes: ['global', 'organization', 'website', 'customer_group', 'customer'],
});

const guestCheckout = defineFeature(
  'checkout.guest_enabled',
  'Allow checkout without an account',
  false,
);

function row(
  scopeType: StoredValue['scopeType'],
  scopeId: string | null,
  value: unknown,
): StoredValue {
  return { key: minOrder.key, scopeType, scopeId, value };
}

const everyScope: StoredValue[] = [
  row('global', null, 100),
  row('organization', ORG, 200),
  row('website', WEB, 300),
  row('customer_group', GROUP, 400),
  row('customer', CUSTOMER, 500),
];

describe('scopeChain', () => {
  it('orders scopes from most to least specific and always ends at global', () => {
    expect(scopeChain({ websiteId: WEB, customerId: CUSTOMER }).map((s) => s.type)).toEqual([
      'customer',
      'website',
      'global',
    ]);
    expect(scopeChain({})).toEqual([{ type: 'global' }]);
  });
});

describe('resolveSetting', () => {
  // Known answers: which scope wins for each request context.
  it.each([
    [{}, 100, 'global'],
    [{ organizationId: ORG }, 200, 'organization'],
    [{ organizationId: ORG, websiteId: WEB }, 300, 'website'],
    [{ organizationId: ORG, websiteId: WEB, customerGroupId: GROUP }, 400, 'customer_group'],
    [
      { organizationId: ORG, websiteId: WEB, customerGroupId: GROUP, customerId: CUSTOMER },
      500,
      'customer',
    ],
  ])('context %j resolves to %d from %s', (context, value, source) => {
    expect(resolveSetting(minOrder, everyScope, context)).toEqual({ value, source });
  });

  it('skips scopes with no value and falls through to the next one', () => {
    const stored = [row('global', null, 100), row('website', WEB, 300)];
    expect(resolveSetting(minOrder, stored, { customerId: CUSTOMER, websiteId: WEB })).toEqual({
      value: 300,
      source: 'website',
    });
  });

  it('uses the default when nothing is stored', () => {
    expect(resolveSetting(guestCheckout, [], { websiteId: WEB })).toEqual({
      value: false,
      source: 'default',
    });
  });

  it('ignores values stored for another website or customer', () => {
    const otherWebsite = '00000000-0000-4000-8000-000000000099';
    const stored = [row('website', otherWebsite, 999), row('global', null, 100)];
    expect(resolveSetting(minOrder, stored, { websiteId: WEB }).value).toBe(100);
  });

  it('ignores values at scopes the setting does not allow', () => {
    const websiteOnly = defineSetting({
      key: 'tax.prices_include_tax',
      description: 'Whether catalog prices include tax',
      schema: z.boolean(),
      defaultValue: false,
      allowedScopes: ['website', 'global'],
    });
    const stored: StoredValue[] = [
      { key: websiteOnly.key, scopeType: 'customer', scopeId: CUSTOMER, value: true },
    ];
    expect(resolveSetting(websiteOnly, stored, { customerId: CUSTOMER, websiteId: WEB })).toEqual({
      value: false,
      source: 'default',
    });
  });

  it('fails loudly on a stored value that breaks the schema', () => {
    expect(() =>
      resolveSetting(minOrder, [row('website', WEB, 'not a number')], { websiteId: WEB }),
    ).toThrow(InvalidStoredSettingError);
  });
});

describe('defineSetting', () => {
  it('rejects badly named keys', () => {
    expect(() => defineFeature('NoNamespace', 'x', false)).toThrow(TypeError);
  });

  it('rejects a default that fails its own schema', () => {
    expect(() =>
      defineSetting({
        key: 'catalog.page_size',
        description: 'Products per page',
        schema: z.number().int().min(1),
        defaultValue: 0,
        allowedScopes: ['website'],
      }),
    ).toThrow();
  });
});
