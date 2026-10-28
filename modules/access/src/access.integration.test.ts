import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser, disableUser } from '@muziris/identity';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccessControlError,
  ADMINISTRATOR_ROLE_CODE,
  assignAdminRole,
  assignBuyerRole,
  buyerScope,
  buyerScopePredicate,
  createAdminRole,
  createBuyerRole,
  deleteAdminRole,
  deleteBuyerRole,
  ensureBuiltInAdminRoles,
  findAdminRoleByCode,
  getAdminAccess,
  getBuyerAccess,
  listAdminRoles,
  listBuyerRoles,
  setAdminRolePermissions,
  setBuyerRoleGrants,
  SYSTEM_ADMIN_ACCESS,
  unassignAdminRole,
  unassignBuyerRole,
  type AccessLevel,
  type AdminAccess,
  type BuyerScopeContext,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];

// Stand-ins for tables the customers and orders modules will own. They exist only in this
// test database and show how those modules plug into buyerScope.
const testCustomers = pgTable('test_customer', {
  id: uuid('id').primaryKey(),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
});
const testRecords = pgTable('test_record', {
  label: text('label').primaryKey(),
  ownerBuyerUserId: uuid('owner_buyer_user_id').notNull(),
  customerId: uuid('customer_id').notNull(),
});
const columns = {
  ownerBuyerUserId: testRecords.ownerBuyerUserId,
  customerId: testRecords.customerId,
};

/** What the customers module will export: every customer below one, at any depth. */
function descendantsOf(customerId: string): SQL {
  return sql`with recursive tree as (
      select id from ${testCustomers} where parent_id = ${customerId}
      union all
      select c.id from ${testCustomers} c join tree on c.parent_id = tree.id
    ) select id from tree`;
}

async function expectRefused(promise: Promise<unknown>, code: AccessControlError['code']) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AccessControlError);
  expect((error as AccessControlError).code).toBe(code);
}

describe.skipIf(!url)('access module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'access');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
    await handle.db.execute(sql`create table if not exists test_customer (
      id uuid primary key, parent_id uuid references test_customer (id), name text not null)`);
    await handle.db.execute(sql`create table if not exists test_record (
      label text primary key, owner_buyer_user_id uuid not null, customer_id uuid not null)`);
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate access_admin_user_role, access_admin_role_permission, access_admin_role,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        identity_session, identity_user, test_record, test_customer cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  const newUser = (realm: 'admin' | 'buyer', email: string) =>
    createUser(handle.db, { realm, email, displayName: email.split('@')[0] ?? email });

  async function administratorRoleId() {
    await ensureBuiltInAdminRoles(handle.db);
    const role = await findAdminRoleByCode(handle.db, ADMINISTRATOR_ROLE_CODE);
    if (!role) throw new Error('administrator role missing');
    return role.id;
  }

  describe('admin roles', () => {
    it('seeds the administrator role once, granting every permission', async () => {
      await ensureBuiltInAdminRoles(handle.db);
      await ensureBuiltInAdminRoles(handle.db);
      const roles = await listAdminRoles(handle.db);
      expect(roles).toHaveLength(1);
      expect(roles[0]).toMatchObject({
        code: 'administrator',
        isBuiltIn: true,
        grantsAllPermissions: true,
      });

      const asha = await newUser('admin', 'asha@acme.example');
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, await administratorRoleId());
      const access = await getAdminAccess(handle.db, asha.id);
      expect(access.all).toBe(true);
      expect(access.permissions.has('price_list.manage')).toBe(true);
    });

    it('unions permissions across roles and ignores keys no longer in the catalogue', async () => {
      const asha = await newUser('admin', 'asha@acme.example');
      const sales = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: 'sales',
        name: 'Sales',
        permissions: ['order.view', 'customer.view'],
      });
      const catalog = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: 'catalog',
        name: 'Catalog',
        permissions: ['product.view', 'product.manage', 'order.view'],
      });
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, sales.id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, catalog.id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, catalog.id);
      await handle.db.execute(
        sql`insert into access_admin_role_permission (role_id, permission) values (${sales.id}, 'legacy.removed')`,
      );

      const access = await getAdminAccess(handle.db, asha.id);
      expect(access.all).toBe(false);
      expect([...access.permissions].sort()).toEqual([
        'customer.view',
        'order.view',
        'product.manage',
        'product.view',
      ]);
    });

    it('gives nothing to an admin with no roles, or to an id that is not a uuid', async () => {
      const asha = await newUser('admin', 'asha@acme.example');
      expect((await getAdminAccess(handle.db, asha.id)).permissions.size).toBe(0);
      expect((await getAdminAccess(handle.db, "' or 1=1 --")).permissions.size).toBe(0);
    });

    it('applies permission changes and removals at once', async () => {
      const asha = await newUser('admin', 'asha@acme.example');
      const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: 'support',
        name: 'Support',
        permissions: ['order.view'],
      });
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, role.id);
      await setAdminRolePermissions(handle.db, SYSTEM_ADMIN_ACCESS, role.id, ['customer.view']);
      expect([...(await getAdminAccess(handle.db, asha.id)).permissions]).toEqual([
        'customer.view',
      ]);
      await unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, role.id);
      expect((await getAdminAccess(handle.db, asha.id)).permissions.size).toBe(0);
    });

    it('refuses unknown permissions and duplicate codes', async () => {
      await expect(
        createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
          code: 'bad',
          name: 'Bad',
          permissions: ['order.delete_everything'],
        }),
      ).rejects.toThrow(/Unknown admin permission/);
      await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: 'sales',
        name: 'Sales',
        permissions: [],
      });
      await expectRefused(
        createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
          code: 'sales',
          name: 'Sales 2',
          permissions: [],
        }),
        'role_code_taken',
      );
    });

    it('protects built-in roles', async () => {
      const id = await administratorRoleId();
      await expectRefused(
        setAdminRolePermissions(handle.db, SYSTEM_ADMIN_ACCESS, id, []),
        'built_in_role',
      );
      await expectRefused(deleteAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, id), 'built_in_role');
    });

    it('refuses a role that grants everything unless it is built in, at the database level', async () => {
      await expect(
        handle.db.execute(
          sql`insert into access_admin_role (code, name, grants_all_permissions) values ('sneaky', 'Sneaky', true)`,
        ),
      ).rejects.toThrow();
    });

    it('assigns admin roles to admin users only', async () => {
      const ravi = await newUser('buyer', 'ravi@buyer.example');
      const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: 'sales',
        name: 'Sales',
        permissions: ['order.view'],
      });
      await expectRefused(
        assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, ravi.id, role.id),
        'user_not_found',
      );
      await expectRefused(
        assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, crypto.randomUUID(), role.id),
        'user_not_found',
      );
      await expectRefused(
        assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, ravi.id, crypto.randomUUID()),
        'role_not_found',
      );
    });

    it('never removes the last administrator', async () => {
      const id = await administratorRoleId();
      const asha = await newUser('admin', 'asha@acme.example');
      const meera = await newUser('admin', 'meera@acme.example');
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);

      await unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);
      await expectRefused(
        unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id),
        'last_administrator',
      );
      expect((await getAdminAccess(handle.db, asha.id)).all).toBe(true);
    });

    it.each([
      ['another active administrator remains', 'active', 'allowed'],
      ['the only other administrator is disabled', 'disabled', 'last_administrator'],
    ] as const)('removing an administrator when %s', async (_label, meeraStatus, expected) => {
      const id = await administratorRoleId();
      const asha = await newUser('admin', 'asha@acme.example');
      const meera = await newUser('admin', 'meera@acme.example');
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);
      if (meeraStatus === 'disabled') await disableUser(handle.db, meera.id);

      const attempt = unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id);
      if (expected === 'allowed') {
        await attempt;
        expect((await getAdminAccess(handle.db, asha.id)).all).toBe(false);
      } else {
        await expectRefused(attempt, expected);
        expect((await getAdminAccess(handle.db, asha.id)).all).toBe(true);
      }
    });

    it('lets a disabled administrator lose the role while an active one remains', async () => {
      const id = await administratorRoleId();
      const asha = await newUser('admin', 'asha@acme.example');
      const meera = await newUser('admin', 'meera@acme.example');
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);
      await disableUser(handle.db, meera.id);
      await unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);
      expect((await getAdminAccess(handle.db, meera.id)).all).toBe(false);
    });

    it('refuses two concurrent removals that would leave no administrator', async () => {
      const id = await administratorRoleId();
      const asha = await newUser('admin', 'asha@acme.example');
      const meera = await newUser('admin', 'meera@acme.example');
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id);
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id);

      const results = await Promise.allSettled([
        unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, asha.id, id),
        unassignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, meera.id, id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const remaining = await Promise.all(
        [asha, meera].map((u) => getAdminAccess(handle.db, u.id)),
      );
      expect(remaining.filter((a) => a.all)).toHaveLength(1);
    });

    describe('no privilege escalation', () => {
      // A sales manager may manage and assign roles, but holds only these permissions.
      const manager: AdminAccess = {
        all: false,
        permissions: new Set([
          'admin_role.manage',
          'admin_role.assign',
          'order.view',
          'customer.view',
        ]),
      };

      it.each([
        ['create a role within their own permissions', ['order.view'], 'allowed'],
        ['create a role with a permission they lack', ['order.manage'], 'privilege_escalation'],
        [
          'create a role mixing held and missing permissions',
          ['order.view', 'price_list.manage'],
          'privilege_escalation',
        ],
      ] as const)('may %s: %s', async (_label, permissions, expected) => {
        const attempt = createAdminRole(handle.db, manager, {
          code: 'new_role',
          name: 'New role',
          permissions: [...permissions],
        });
        if (expected === 'allowed') await expect(attempt).resolves.toBeDefined();
        else await expectRefused(attempt, expected);
      });

      it('may not widen, narrow beyond, assign or delete roles carrying permissions they lack', async () => {
        const asha = await newUser('admin', 'asha@acme.example');
        const finance = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
          code: 'finance',
          name: 'Finance',
          permissions: ['order.view', 'price_list.manage'],
        });
        const sales = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
          code: 'sales',
          name: 'Sales',
          permissions: ['order.view'],
        });

        await expectRefused(
          setAdminRolePermissions(handle.db, manager, sales.id, ['order.view', 'order.manage']),
          'privilege_escalation',
        );
        await expectRefused(
          setAdminRolePermissions(handle.db, manager, finance.id, ['order.view']),
          'privilege_escalation',
        );
        await expectRefused(
          assignAdminRole(handle.db, manager, asha.id, finance.id),
          'privilege_escalation',
        );
        await expectRefused(
          assignAdminRole(handle.db, manager, asha.id, await administratorRoleId()),
          'privilege_escalation',
        );
        await expectRefused(
          deleteAdminRole(handle.db, manager, finance.id),
          'privilege_escalation',
        );

        // Within their own permissions, all of it works.
        await setAdminRolePermissions(handle.db, manager, sales.id, [
          'order.view',
          'customer.view',
        ]);
        await assignAdminRole(handle.db, manager, asha.id, sales.id);
        await unassignAdminRole(handle.db, manager, asha.id, sales.id);
        await deleteAdminRole(handle.db, manager, sales.id);
      });
    });
  });

  describe('buyer roles', () => {
    it('creates, lists, changes and deletes buyer roles', async () => {
      const role = await createBuyerRole(handle.db, {
        code: 'buyer',
        name: 'Buyer',
        grants: [
          { permission: 'order.view', accessLevel: 'own_records' },
          { permission: 'order.place', accessLevel: 'my_customer' },
        ],
      });
      await setBuyerRoleGrants(handle.db, role.id, [
        { permission: 'order.view', accessLevel: 'my_customer_and_subsidiaries' },
      ]);
      expect(await listBuyerRoles(handle.db)).toEqual({
        nextAfter: null,
        buyerRoles: [
          {
            id: role.id,
            code: 'buyer',
            name: 'Buyer',
            description: '',
            isBuiltIn: false,
            grants: [{ permission: 'order.view', accessLevel: 'my_customer_and_subsidiaries' }],
          },
        ],
      });
      await deleteBuyerRole(handle.db, role.id);
      expect((await listBuyerRoles(handle.db)).buyerRoles).toEqual([]);
    });

    it('pages buyer roles by code, each with its own grants', async () => {
      const ids = new Map<string, string>();
      for (const code of ['c_role', 'a_role', 'b_role']) {
        const role = await createBuyerRole(handle.db, {
          code,
          name: code,
          grants: [{ permission: 'order.view', accessLevel: 'own_records' }],
        });
        ids.set(code, role.id);
      }
      const first = await listBuyerRoles(handle.db, { limit: 2 });
      expect(first.buyerRoles.map((r) => [r.code, r.grants.length])).toEqual([
        ['a_role', 1],
        ['b_role', 1],
      ]);
      expect(first.nextAfter).toBe(ids.get('b_role'));
      const second = await listBuyerRoles(handle.db, { limit: 2, after: first.nextAfter ?? '' });
      expect(second).toMatchObject({ buyerRoles: [{ code: 'c_role' }], nextAfter: null });
      await expect(listBuyerRoles(handle.db, { limit: 201 })).rejects.toThrow();
    });

    it('refuses an unknown permission, an unknown level, or the same permission twice', async () => {
      const base = { code: 'x_role', name: 'X' };
      await expect(
        createBuyerRole(handle.db, {
          ...base,
          grants: [{ permission: 'price_list.manage', accessLevel: 'my_customer' }],
        }),
      ).rejects.toThrow();
      await expect(
        createBuyerRole(handle.db, {
          ...base,
          grants: [{ permission: 'order.view', accessLevel: 'everyone' as AccessLevel }],
        }),
      ).rejects.toThrow();
      await expect(
        createBuyerRole(handle.db, {
          ...base,
          grants: [
            { permission: 'order.view', accessLevel: 'own_records' },
            { permission: 'order.view', accessLevel: 'my_customer' },
          ],
        }),
      ).rejects.toThrow(/once/);
    });

    it('assigns buyer roles to buyer users only, and takes the widest level across roles', async () => {
      const ravi = await newUser('buyer', 'ravi@buyer.example');
      const asha = await newUser('admin', 'asha@acme.example');
      const own = await createBuyerRole(handle.db, {
        code: 'buyer',
        name: 'Buyer',
        grants: [
          { permission: 'order.view', accessLevel: 'own_records' },
          { permission: 'order.place', accessLevel: 'own_records' },
        ],
      });
      const manager = await createBuyerRole(handle.db, {
        code: 'buyer_manager',
        name: 'Buyer manager',
        grants: [{ permission: 'order.view', accessLevel: 'my_customer' }],
      });
      await expectRefused(assignBuyerRole(handle.db, asha.id, own.id), 'user_not_found');

      await assignBuyerRole(handle.db, ravi.id, own.id);
      await assignBuyerRole(handle.db, ravi.id, manager.id);
      expect(Object.fromEntries(await getBuyerAccess(handle.db, ravi.id))).toEqual({
        'order.view': 'my_customer',
        'order.place': 'own_records',
      });

      await unassignBuyerRole(handle.db, ravi.id, manager.id);
      expect((await getBuyerAccess(handle.db, ravi.id)).get('order.view')).toBe('own_records');
    });
  });

  describe('buyerScope against real rows', () => {
    // Acme has subsidiaries West and East; West has a subsidiary, West Pune. Globex is an
    // unrelated customer with its own subsidiary. Records are labelled owner@customer.
    const ids = {
      acme: crypto.randomUUID(),
      west: crypto.randomUUID(),
      westPune: crypto.randomUUID(),
      east: crypto.randomUUID(),
      globex: crypto.randomUUID(),
      globexUk: crypto.randomUUID(),
      ravi: crypto.randomUUID(),
      meera: crypto.randomUUID(),
      sunil: crypto.randomUUID(),
      priya: crypto.randomUUID(),
      other: crypto.randomUUID(),
    };

    beforeEach(async () => {
      await handle.db.insert(testCustomers).values([
        { id: ids.acme, parentId: null, name: 'Acme' },
        { id: ids.west, parentId: ids.acme, name: 'Acme West' },
        { id: ids.westPune, parentId: ids.west, name: 'Acme West Pune' },
        { id: ids.east, parentId: ids.acme, name: 'Acme East' },
        { id: ids.globex, parentId: null, name: 'Globex' },
        { id: ids.globexUk, parentId: ids.globex, name: 'Globex UK' },
      ]);
      await handle.db.insert(testRecords).values([
        { label: 'ravi@acme', ownerBuyerUserId: ids.ravi, customerId: ids.acme },
        { label: 'meera@acme', ownerBuyerUserId: ids.meera, customerId: ids.acme },
        { label: 'sunil@west', ownerBuyerUserId: ids.sunil, customerId: ids.west },
        { label: 'other@west_pune', ownerBuyerUserId: ids.other, customerId: ids.westPune },
        { label: 'other@east', ownerBuyerUserId: ids.other, customerId: ids.east },
        { label: 'priya@globex', ownerBuyerUserId: ids.priya, customerId: ids.globex },
        { label: 'other@globex_uk', ownerBuyerUserId: ids.other, customerId: ids.globexUk },
        // Ravi's own record at another customer, as after moving companies.
        { label: 'ravi@globex', ownerBuyerUserId: ids.ravi, customerId: ids.globex },
      ]);
    });

    type Who = 'ravi' | 'sunil' | 'priya';
    const actsFor: Record<Who, keyof typeof ids> = { ravi: 'acme', sunil: 'west', priya: 'globex' };

    function contextFor(who: Who, descendants: 'subquery' | 'list' | 'none'): BuyerScopeContext {
      const customerId = ids[actsFor[who]];
      const listed: Record<Who, string[]> = {
        ravi: [ids.west, ids.westPune, ids.east],
        sunil: [ids.westPune],
        priya: [ids.globexUk],
      };
      return {
        buyerUserId: ids[who],
        customerId,
        descendantCustomerIds:
          descendants === 'subquery'
            ? descendantsOf(customerId)
            : descendants === 'list'
              ? listed[who]
              : [],
      };
    }

    async function visible(predicate: SQL): Promise<string[]> {
      const rows = await handle.db
        .select({ label: testRecords.label })
        .from(testRecords)
        .where(predicate)
        .orderBy(asc(testRecords.label));
      return rows.map((r) => r.label);
    }

    it.each([
      // Own records: only what the buyer owns at the customer they act for.
      ['ravi', 'own_records', 'subquery', ['ravi@acme']],
      ['sunil', 'own_records', 'subquery', ['sunil@west']],
      ['priya', 'own_records', 'subquery', ['priya@globex']],
      // My customer: everyone's records at that customer, never the parent's or a sibling's.
      ['ravi', 'my_customer', 'subquery', ['meera@acme', 'ravi@acme']],
      ['sunil', 'my_customer', 'subquery', ['sunil@west']],
      ['priya', 'my_customer', 'subquery', ['priya@globex', 'ravi@globex']],
      // My customer and subsidiaries: the whole subtree below, at any depth, and nothing above.
      [
        'ravi',
        'my_customer_and_subsidiaries',
        'subquery',
        ['meera@acme', 'other@east', 'other@west_pune', 'ravi@acme', 'sunil@west'],
      ],
      [
        'ravi',
        'my_customer_and_subsidiaries',
        'list',
        ['meera@acme', 'other@east', 'other@west_pune', 'ravi@acme', 'sunil@west'],
      ],
      ['sunil', 'my_customer_and_subsidiaries', 'subquery', ['other@west_pune', 'sunil@west']],
      ['sunil', 'my_customer_and_subsidiaries', 'list', ['other@west_pune', 'sunil@west']],
      [
        'priya',
        'my_customer_and_subsidiaries',
        'subquery',
        ['other@globex_uk', 'priya@globex', 'ravi@globex'],
      ],
      ['ravi', 'my_customer_and_subsidiaries', 'none', ['meera@acme', 'ravi@acme']],
      // No access level: nothing at all.
      ['ravi', undefined, 'subquery', []],
      ['priya', undefined, 'list', []],
    ] as const)(
      '%s at %s (descendants as %s) sees %j',
      async (who, level, descendants, expected) => {
        const predicate = buyerScopePredicate(level, contextFor(who, descendants), columns);
        expect(await visible(predicate)).toEqual(expected);
      },
    );

    it('never leaks across customers, whatever the level', async () => {
      const acmeTree = new Set([
        'ravi@acme',
        'meera@acme',
        'sunil@west',
        'other@west_pune',
        'other@east',
      ]);
      for (const level of ['own_records', 'my_customer', 'my_customer_and_subsidiaries'] as const) {
        for (const descendants of ['subquery', 'list'] as const) {
          const seenByRavi = await visible(
            buyerScopePredicate(level, contextFor('ravi', descendants), columns),
          );
          for (const label of seenByRavi) expect(acmeTree.has(label)).toBe(true);
          const seenByPriya = await visible(
            buyerScopePredicate(level, contextFor('priya', descendants), columns),
          );
          for (const label of seenByPriya) expect(acmeTree.has(label)).toBe(false);
        }
      }
    });

    it('accepts a query builder subquery through getSQL()', async () => {
      const children = handle.db
        .select({ id: testCustomers.id })
        .from(testCustomers)
        .where(eq(testCustomers.parentId, ids.acme))
        .getSQL();
      const context = { ...contextFor('ravi', 'none'), descendantCustomerIds: children };
      expect(
        await visible(buyerScopePredicate('my_customer_and_subsidiaries', context, columns)),
      ).toEqual(['meera@acme', 'other@east', 'ravi@acme', 'sunil@west']);
    });

    it('scopes through real role assignments and combines with other conditions', async () => {
      const ravi = await newUser('buyer', 'ravi@acme.example');
      const role = await createBuyerRole(handle.db, {
        code: 'buyer',
        name: 'Buyer',
        grants: [{ permission: 'order.view', accessLevel: 'my_customer' }],
      });
      await assignBuyerRole(handle.db, ravi.id, role.id);
      const access = await getBuyerAccess(handle.db, ravi.id);
      const context = { ...contextFor('ravi', 'subquery'), buyerUserId: ravi.id };

      const orders = buyerScope(access, 'order.view', context, columns);
      expect(await visible(and(orders, sql`${testRecords.label} like 'meera%'`) ?? orders)).toEqual(
        ['meera@acme'],
      );
      // A permission the role does not grant reaches nothing.
      expect(await visible(buyerScope(access, 'quote.view', context, columns))).toEqual([]);
    });
  });
});
