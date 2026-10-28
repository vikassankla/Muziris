import { sql } from 'drizzle-orm';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS,
  ADMIN_PERMISSIONS,
  BUYER_PERMISSIONS,
  buyerScope,
  buyerScopePredicate,
  hasAdminPermission,
  isAdminPermission,
  mergeBuyerGrants,
  SYSTEM_ADMIN_ACCESS,
  widerAccessLevel,
  type AccessLevel,
  type AdminAccess,
  type BuyerRoleGrant,
  type BuyerScopeContext,
} from './index.js';

const RAVI = '0b8f5a52-3f43-4c1e-9a52-6f0e8d1a0001';
const ACME = '0b8f5a52-3f43-4c1e-9a52-6f0e8d1a00a0';
const ACME_WEST = '0b8f5a52-3f43-4c1e-9a52-6f0e8d1a00a1';
const ACME_EAST = '0b8f5a52-3f43-4c1e-9a52-6f0e8d1a00a2';

const records = pgTable('test_record', {
  id: uuid('id').primaryKey(),
  ownerBuyerUserId: uuid('owner_buyer_user_id').notNull(),
  customerId: uuid('customer_id').notNull(),
});
const columns = { ownerBuyerUserId: records.ownerBuyerUserId, customerId: records.customerId };
const dialect = new PgDialect();
const render = (predicate: ReturnType<typeof buyerScopePredicate>) => {
  const { sql: text, params } = dialect.sqlToQuery(predicate);
  return { sql: text, params };
};

const context = (descendantCustomerIds: BuyerScopeContext['descendantCustomerIds'] = []) => ({
  buyerUserId: RAVI,
  customerId: ACME,
  descendantCustomerIds,
});

describe('permission catalogues', () => {
  it.each([
    ['admin', ADMIN_PERMISSIONS],
    ['buyer', BUYER_PERMISSIONS],
  ])('%s keys are area.action and every permission is described', (_realm, catalogue) => {
    for (const [key, description] of Object.entries(catalogue)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it('does not treat inherited object keys as permissions', () => {
    expect(isAdminPermission('toString')).toBe(false);
    expect(isAdminPermission('__proto__')).toBe(false);
    expect(isAdminPermission('order.view')).toBe(true);
  });
});

describe('hasAdminPermission', () => {
  const salesRep: AdminAccess = { all: false, permissions: new Set(['order.view']) };
  const nobody: AdminAccess = { all: false, permissions: new Set() };
  it.each([
    ['granted permission', salesRep, 'order.view', true],
    ['permission not granted', salesRep, 'order.manage', false],
    ['no roles at all', nobody, 'order.view', false],
    ['administrator', SYSTEM_ADMIN_ACCESS, 'admin_role.assign', true],
  ] as const)('%s', (_label, access, permission, expected) => {
    expect(hasAdminPermission(access, permission)).toBe(expected);
  });
});

describe('access levels', () => {
  it('are ordered narrowest first, matching the glossary', () => {
    expect(ACCESS_LEVELS).toEqual(['own_records', 'my_customer', 'my_customer_and_subsidiaries']);
  });

  it.each([
    [undefined, undefined, undefined],
    [undefined, 'own_records', 'own_records'],
    ['my_customer', undefined, 'my_customer'],
    ['own_records', 'my_customer', 'my_customer'],
    ['my_customer', 'own_records', 'my_customer'],
    ['my_customer_and_subsidiaries', 'own_records', 'my_customer_and_subsidiaries'],
    ['my_customer', 'my_customer', 'my_customer'],
  ] as const)('wider of %s and %s is %s', (a, b, expected) => {
    expect(widerAccessLevel(a, b)).toBe(expected);
  });

  it('merges several roles into the widest level per permission', () => {
    const grants: BuyerRoleGrant[] = [
      { permission: 'order.view', accessLevel: 'own_records' },
      { permission: 'order.view', accessLevel: 'my_customer' },
      { permission: 'order.place', accessLevel: 'own_records' },
      { permission: 'order.view', accessLevel: 'own_records' },
    ];
    expect(Object.fromEntries(mergeBuyerGrants(grants))).toEqual({
      'order.view': 'my_customer',
      'order.place': 'own_records',
    });
  });
});

describe('buyerScopePredicate', () => {
  it.each([
    ['no access matches nothing', undefined, [], { sql: 'false', params: [] }],
    [
      'own records: owner and current customer',
      'own_records',
      [],
      {
        sql: '("test_record"."customer_id" = $1 and "test_record"."owner_buyer_user_id" = $2)',
        params: [ACME, RAVI],
      },
    ],
    [
      'my customer: the customer only',
      'my_customer',
      [ACME_WEST],
      { sql: '"test_record"."customer_id" = $1', params: [ACME] },
    ],
    [
      'my customer and subsidiaries: customer and listed descendants',
      'my_customer_and_subsidiaries',
      [ACME_WEST, ACME_EAST],
      {
        sql: '("test_record"."customer_id" = $1 or "test_record"."customer_id" in ($2, $3))',
        params: [ACME, ACME_WEST, ACME_EAST],
      },
    ],
    [
      'my customer and subsidiaries with no descendants: the customer only',
      'my_customer_and_subsidiaries',
      [],
      { sql: '"test_record"."customer_id" = $1', params: [ACME] },
    ],
  ] satisfies [string, AccessLevel | undefined, string[], unknown][])(
    '%s',
    (_label, level, descendants, expected) => {
      expect(render(buyerScopePredicate(level, context(descendants), columns))).toEqual(expected);
    },
  );

  it('embeds a descendant subquery with its own parameters bound', () => {
    const subquery = sql`select id from test_customer where parent_id = ${ACME}`;
    expect(
      render(buyerScopePredicate('my_customer_and_subsidiaries', context(subquery), columns)),
    ).toEqual({
      sql: '("test_record"."customer_id" = $1 or "test_record"."customer_id" in (select id from test_customer where parent_id = $2))',
      params: [ACME, ACME],
    });
  });

  it('never places caller values in the SQL text', () => {
    const hostile = { ...context(), buyerUserId: "x' or '1'='1" };
    expect(() => buyerScopePredicate('own_records', hostile, columns)).toThrow();
    expect(() =>
      buyerScopePredicate('my_customer_and_subsidiaries', context(["x') or (1=1"]), columns),
    ).toThrow();
    expect(() =>
      buyerScopePredicate('my_customer', { ...context(), customerId: '' }, columns),
    ).toThrow();
  });

  it('looks up the level for one permission', () => {
    const access = mergeBuyerGrants([{ permission: 'order.view', accessLevel: 'my_customer' }]);
    expect(render(buyerScope(access, 'order.view', context(), columns)).params).toEqual([ACME]);
    expect(render(buyerScope(access, 'order.place', context(), columns)).sql).toBe('false');
  });
});
