import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  assignAdminRole,
  assignBuyerRole,
  createAdminRole,
  createBuyerRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import { createCustomer, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import { createShoppingList } from '@muziris/shopping-lists';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';

describe.skipIf(!url)('admin shopping list routes against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_shopping_lists');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate shopping_list_line, shopping_list, customer_buyer_user, customer_customer,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        access_admin_user_role, access_admin_role_permission, access_admin_role,
        platform_website, platform_organization, identity_session, identity_user,
        identity_rate_limit cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
    return createApp({
      logger: createLogger(
        'silent',
        new Writable({
          write: (_c, _e, done) => {
            done();
          },
        }),
      ),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => new Date(),
      clientIp: () => '203.0.113.7',
      storefront: { persistedQueries: new Map(), allowAdhocQueries: true },
    });
  }

  async function signedInAdmin(email: string, permissions: AdminPermission[]): Promise<string> {
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email,
      password: PASSWORD,
    });
    const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
      code: `role_${email.split('@')[0] ?? 'x'}`,
      name: email,
      permissions,
    });
    await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    const res = await app().request('/admin/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  const get = (path: string, cookie: string) =>
    app().request(`/admin/v1/shopping-lists${path}`, { headers: { Cookie: cookie } });

  it('shows support staff with customer.view a customer’s lists, read only', async () => {
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
    const customer = await createCustomer(handle.db, { name: 'Kochi Hardware' });
    const buyer = await createUser(handle.db, {
      realm: 'buyer',
      email: 'meera@kochihardware.in',
      displayName: 'Meera',
      password: PASSWORD,
    });
    await linkBuyerUser(handle.db, customer.id, 'meera@kochihardware.in');
    const role = await createBuyerRole(handle.db, {
      code: 'lists',
      name: 'Lists',
      grants: [{ permission: 'shopping_list.manage', accessLevel: 'own_records' }],
    });
    await assignBuyerRole(handle.db, buyer.id, role.id);
    const created = await createShoppingList(handle.db, buyer.id, {
      websiteId: website.id,
      name: 'Monthly',
    });
    if (!created.ok) throw new Error('Expected a list');

    const support = await signedInAdmin('support@muziris.example', ['customer.view']);
    const page = await get(`?customerId=${customer.id}`, support);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      shoppingLists: [{ id: created.list.id, name: 'Monthly', lineCount: 0, ownerId: buyer.id }],
      nextAfter: null,
    });
    const one = await get(`/${created.list.id}`, support);
    expect(await one.json()).toMatchObject({ shoppingList: { name: 'Monthly', lines: [] } });
    expect((await get(`/${randomUUID()}`, support)).status).toBe(404);

    const other = await signedInAdmin('catalog@muziris.example', ['product.view']);
    expect((await get(`?customerId=${customer.id}`, other)).status).toBe(403);
  });
});
