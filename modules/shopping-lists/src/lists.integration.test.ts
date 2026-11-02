import { assignBuyerRole, createBuyerRole } from '@muziris/access';
import { createProduct, createProductUnit } from '@muziris/catalog';
import { createCustomer, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import { createRule, rebuildVisibility } from '@muziris/visibility';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addShoppingListLines,
  createShoppingList,
  deleteShoppingList,
  duplicateShoppingList,
  findShoppingList,
  listShoppingLists,
  listShoppingListsForCustomer,
  moveShoppingListLines,
  removeShoppingListLines,
  renameShoppingList,
  updateShoppingListLine,
  type ShoppingListResult,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';

function listOf(result: ShoppingListResult) {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.refusal)}`);
  return result.list;
}

function refusalOf(result: { ok: boolean; refusal?: { code: string } }) {
  return result.ok ? 'ok' : result.refusal?.code;
}

describe.skipIf(!url)('shopping lists against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'shopping_lists');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate shopping_list_line, shopping_list, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule,
        visibility_build_state, catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit, customer_buyer_user, customer_customer, customer_group,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        identity_session, identity_user, platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function buyer(customerId: string, email: string, roleId: string): Promise<string> {
    const user = await createUser(handle.db, {
      realm: 'buyer',
      email,
      displayName: email,
      password: PASSWORD,
    });
    await linkBuyerUser(handle.db, customerId, email);
    await assignBuyerRole(handle.db, user.id, roleId);
    return user.id;
  }

  /**
   * A website with a bolt (each), grease (kg, three decimals) and a hidden cable. A parent
   * customer with a subsidiary. On the parent: a buyer admin who sees and manages every list
   * of the parent and its subsidiaries, and a buyer who manages their own lists only. On the
   * subsidiary: a buyer who can only view lists.
   */
  async function world() {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    const website = await createWebsite(handle.db, {
      organizationId: org.id,
      code: 'muziris-in',
      name: 'Muziris India',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      defaultLocale: 'en-IN',
      timeZone: 'Asia/Kolkata',
    });
    await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
    await createProductUnit(handle.db, { code: 'kg', name: 'Kilogram', precision: 3 });
    const bolt = await createProduct(handle.db, {
      sku: 'HB-M8-40',
      name: 'Hex bolt M8 × 40',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'each',
    });
    const grease = await createProduct(handle.db, {
      sku: 'GRS-LGMT2',
      name: 'Bearing grease',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'kg',
      additionalUnitCodes: ['each'],
    });
    const cable = await createProduct(handle.db, {
      sku: 'CBL-2.5',
      name: 'Copper cable',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'each',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'product',
      subjectId: cable.id,
      target: 'website',
      visibility: 'hidden',
    });
    await rebuildVisibility(handle.db);

    const parent = await createCustomer(handle.db, { name: 'Acme Engineering' });
    const plant = await createCustomer(handle.db, { name: 'Acme Hosur', parentId: parent.id });
    const admin = await createBuyerRole(handle.db, {
      code: 'list_admin',
      name: 'List admin',
      grants: [
        { permission: 'shopping_list.view', accessLevel: 'my_customer_and_subsidiaries' },
        { permission: 'shopping_list.manage', accessLevel: 'my_customer_and_subsidiaries' },
      ],
    });
    const own = await createBuyerRole(handle.db, {
      code: 'own_lists',
      name: 'Own lists',
      grants: [
        { permission: 'shopping_list.view', accessLevel: 'own_records' },
        { permission: 'shopping_list.manage', accessLevel: 'own_records' },
      ],
    });
    const viewer = await createBuyerRole(handle.db, {
      code: 'list_viewer',
      name: 'List viewer',
      grants: [{ permission: 'shopping_list.view', accessLevel: 'my_customer' }],
    });
    return {
      websiteId: website.id,
      bolt,
      grease,
      cable,
      parent,
      plant,
      admin: await buyer(parent.id, 'admin@acme.example', admin.id),
      meera: await buyer(parent.id, 'meera@acme.example', own.id),
      ravi: await buyer(parent.id, 'ravi@acme.example', own.id),
      plantViewer: await buyer(plant.id, 'viewer@hosur.example', viewer.id),
    };
  }

  it('adds lines, merging the same product and unit, and keeps quantities exact', async () => {
    const w = await world();
    const list = listOf(
      await createShoppingList(handle.db, w.meera, { websiteId: w.websiteId, name: ' Monthly ' }),
    );
    expect(list).toMatchObject({ name: 'Monthly', ownerId: w.meera, customerId: w.parent.id });

    const added = listOf(
      await addShoppingListLines(handle.db, w.meera, {
        websiteId: w.websiteId,
        listId: list.id,
        lines: [
          { productId: w.bolt.id, unitCode: 'each', quantity: '100', note: 'Zinc plated only' },
          { productId: w.grease.id, unitCode: 'kg', quantity: '2.500' },
        ],
      }),
    );
    expect(added.lines.map((l) => [l.position, l.unitCode, l.quantity, l.note])).toEqual([
      [1, 'each', '100', 'Zinc plated only'],
      [2, 'kg', '2.5', null],
    ]);

    const merged = listOf(
      await addShoppingListLines(handle.db, w.meera, {
        websiteId: w.websiteId,
        listId: list.id,
        lines: [
          { productId: w.grease.id, unitCode: 'kg', quantity: '0.125' },
          { productId: w.grease.id, unitCode: 'each', quantity: '3' },
        ],
      }),
    );
    expect(merged.lines.map((l) => [l.position, l.unitCode, l.quantity])).toEqual([
      [1, 'each', '100'],
      [2, 'kg', '2.625'],
      [3, 'each', '3'],
    ]);
  });

  it('adds nothing when any line is a hidden product, an unsold unit or a bad quantity', async () => {
    const w = await world();
    const list = listOf(
      await createShoppingList(handle.db, w.meera, { websiteId: w.websiteId, name: 'Site' }),
    );
    const result = await addShoppingListLines(handle.db, w.meera, {
      websiteId: w.websiteId,
      listId: list.id,
      lines: [
        { productId: w.bolt.id, unitCode: 'each', quantity: '10' },
        { productId: w.cable.id, unitCode: 'each', quantity: '1' },
        { productId: w.bolt.id, unitCode: 'kg', quantity: '1' },
        { productId: w.grease.id, unitCode: 'kg', quantity: '1.2345' },
        { productId: w.bolt.id, unitCode: 'each', quantity: '0' },
        { productId: randomUUID(), unitCode: 'each', quantity: '1' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.refusal.code !== 'line_problems') throw new Error('Expected problems');
    expect(result.refusal.lines.map((p) => [p.index, p.code])).toEqual([
      [1, 'product_not_available'],
      [2, 'unit_not_sold'],
      [3, 'invalid_quantity'],
      [4, 'invalid_quantity'],
      [5, 'product_not_available'],
    ]);
    expect((await findShoppingList(handle.db, w.meera, w.websiteId, list.id))?.lines).toEqual([]);
  });

  it('scopes lists by access level: own lists, the customer and its subsidiaries', async () => {
    const w = await world();
    const make = async (who: string, name: string) =>
      listOf(await createShoppingList(handle.db, who, { websiteId: w.websiteId, name })).id;
    const meeras = await make(w.meera, 'Meera');
    const ravis = await make(w.ravi, 'Ravi');

    const names = async (who: string) =>
      (await listShoppingLists(handle.db, who, { websiteId: w.websiteId })).lists
        .map((l) => l.name)
        .sort();
    expect(await names(w.meera)).toEqual(['Meera']);
    expect(await names(w.admin)).toEqual(['Meera', 'Ravi']);
    // The plant's viewer sees its own customer's lists only: none.
    expect(await names(w.plantViewer)).toEqual([]);

    // Meera can neither read nor change Ravi's list; the admin can do both.
    expect(await findShoppingList(handle.db, w.meera, w.websiteId, ravis)).toBeUndefined();
    expect(
      refusalOf(
        await renameShoppingList(handle.db, w.meera, {
          websiteId: w.websiteId,
          listId: ravis,
          name: 'Mine now',
        }),
      ),
    ).toBe('list_not_found');
    expect(
      listOf(
        await renameShoppingList(handle.db, w.admin, {
          websiteId: w.websiteId,
          listId: ravis,
          name: 'Ravi, checked',
        }),
      ).name,
    ).toBe('Ravi, checked');

    // A viewer cannot create or delete.
    expect(
      refusalOf(
        await createShoppingList(handle.db, w.plantViewer, { websiteId: w.websiteId, name: 'X' }),
      ),
    ).toBe('not_allowed');
    expect(
      refusalOf(
        await deleteShoppingList(handle.db, w.meera, { websiteId: w.websiteId, listId: ravis }),
      ),
    ).toBe('list_not_found');
    expect(
      refusalOf(
        await deleteShoppingList(handle.db, w.admin, { websiteId: w.websiteId, listId: meeras }),
      ),
    ).toBe('ok');
    expect(await names(w.meera)).toEqual([]);
    // A list on another website is not found.
    expect(await findShoppingList(handle.db, w.ravi, randomUUID(), ravis)).toBeUndefined();
  });

  it('changes, removes and moves lines, merging into the target list', async () => {
    const w = await world();
    const add = (listId: string, lines: Parameters<typeof addShoppingListLines>[2]['lines']) =>
      addShoppingListLines(handle.db, w.meera, { websiteId: w.websiteId, listId, lines });
    const a = listOf(
      await createShoppingList(handle.db, w.meera, { websiteId: w.websiteId, name: 'A' }),
    );
    const b = listOf(
      await createShoppingList(handle.db, w.meera, { websiteId: w.websiteId, name: 'B' }),
    );
    const onA = listOf(
      await add(a.id, [
        { productId: w.bolt.id, unitCode: 'each', quantity: '10' },
        { productId: w.grease.id, unitCode: 'kg', quantity: '1' },
      ]),
    );
    listOf(await add(b.id, [{ productId: w.bolt.id, unitCode: 'each', quantity: '5' }]));
    const [boltLine, greaseLine] = onA.lines;

    const changed = listOf(
      await updateShoppingListLine(handle.db, w.meera, {
        websiteId: w.websiteId,
        listId: a.id,
        lineId: greaseLine!.id,
        quantity: '1.750',
        note: 'For the press line',
      }),
    );
    expect(changed.lines[1]).toMatchObject({ quantity: '1.75', note: 'For the press line' });
    expect(
      refusalOf(
        await updateShoppingListLine(handle.db, w.meera, {
          websiteId: w.websiteId,
          listId: a.id,
          lineId: greaseLine!.id,
          quantity: '1.7501',
        }),
      ),
    ).toBe('line_problems');

    const moved = listOf(
      await moveShoppingListLines(handle.db, w.meera, {
        websiteId: w.websiteId,
        fromListId: a.id,
        toListId: b.id,
        lineIds: [boltLine!.id, greaseLine!.id],
      }),
    );
    expect(moved.name).toBe('B');
    expect(moved.lines.map((l) => [l.unitCode, l.quantity, l.note])).toEqual([
      ['each', '15', null],
      ['kg', '1.75', 'For the press line'],
    ]);
    expect((await findShoppingList(handle.db, w.meera, w.websiteId, a.id))?.lines).toEqual([]);
    expect(
      refusalOf(
        await moveShoppingListLines(handle.db, w.meera, {
          websiteId: w.websiteId,
          fromListId: b.id,
          toListId: b.id,
          lineIds: [boltLine!.id],
        }),
      ),
    ).toBe('same_list');

    const left = listOf(
      await removeShoppingListLines(handle.db, w.meera, {
        websiteId: w.websiteId,
        listId: b.id,
        lineIds: [moved.lines[0]!.id],
      }),
    );
    expect(left.lines.map((l) => l.unitCode)).toEqual(['kg']);
    expect(
      refusalOf(
        await removeShoppingListLines(handle.db, w.meera, {
          websiteId: w.websiteId,
          listId: b.id,
          lineIds: [randomUUID()],
        }),
      ),
    ).toBe('line_not_found');
  });

  it('duplicates a list it may see into a list the buyer owns, skipping hidden products', async () => {
    const w = await world();
    const ravis = listOf(
      await createShoppingList(handle.db, w.ravi, { websiteId: w.websiteId, name: 'Ravi' }),
    );
    listOf(
      await addShoppingListLines(handle.db, w.ravi, {
        websiteId: w.websiteId,
        listId: ravis.id,
        lines: [{ productId: w.bolt.id, unitCode: 'each', quantity: '40' }],
      }),
    );
    const copy = listOf(
      await duplicateShoppingList(handle.db, w.admin, {
        websiteId: w.websiteId,
        listId: ravis.id,
        name: 'Copy of Ravi',
      }),
    );
    expect(copy).toMatchObject({ ownerId: w.admin, name: 'Copy of Ravi' });
    expect(copy.lines.map((l) => l.quantity)).toEqual(['40']);
    expect(
      refusalOf(
        await duplicateShoppingList(handle.db, w.meera, {
          websiteId: w.websiteId,
          listId: ravis.id,
          name: 'Nope',
        }),
      ),
    ).toBe('list_not_found');

    const page = await listShoppingListsForCustomer(handle.db, w.parent.id);
    expect(page.lists.map((l) => [l.name, l.lineCount]).sort()).toEqual([
      ['Copy of Ravi', 1],
      ['Ravi', 1],
    ]);
  });

  it('pages lists newest change first', async () => {
    const w = await world();
    for (const name of ['One', 'Two', 'Three']) {
      listOf(await createShoppingList(handle.db, w.meera, { websiteId: w.websiteId, name }));
    }
    const first = await listShoppingLists(handle.db, w.meera, { websiteId: w.websiteId, limit: 2 });
    expect(first.lists.map((l) => l.name)).toEqual(['Three', 'Two']);
    const second = await listShoppingLists(handle.db, w.meera, {
      websiteId: w.websiteId,
      limit: 2,
      after: first.nextAfter!,
    });
    expect(second).toMatchObject({ nextAfter: null });
    expect(second.lists.map((l) => l.name)).toEqual(['One']);
  });
});
