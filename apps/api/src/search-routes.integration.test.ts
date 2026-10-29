import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import { createCategory, createProduct, createProductUnit } from '@muziris/catalog';
import { createCustomer, createCustomerGroup, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import { rebuildSearchIndex, searchProductsForBuyer, type SearchPage } from '@muziris/search';
import { createRule, rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';

interface Hit {
  productId: string;
  sku: string;
  name: string;
  match: string;
  status: string;
}

describe.skipIf(!url)('search routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_search');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate search_product, search_build_state, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule,
        visibility_build_state, catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit, customer_buyer_user, customer_customer, customer_group,
        platform_website, platform_organization, access_admin_user_role,
        access_admin_role_permission, access_admin_role, identity_session, identity_user,
        identity_rate_limit cascade`,
    );
    logs = [];
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    return createApp({
      logger: createLogger('info', stream),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => new Date('2026-11-12T09:00:00.000Z'),
      clientIp: () => '203.0.113.7',
    });
  }

  /** Creates an admin holding exactly these permissions and signs them in. */
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

  /** Creates a buyer user for a customer, signs them in to the storefront, and returns their id. */
  async function signedInBuyer(customerId: string, email: string): Promise<string> {
    await createUser(handle.db, { realm: 'buyer', email, displayName: email, password: PASSWORD });
    await linkBuyerUser(handle.db, customerId, email);
    const signIn = await app().request('/storefront/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(signIn.status).toBe(200);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const me = await app().request('/storefront/v1/auth/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    return ((await me.json()) as { user: { id: string } }).user.id;
  }

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return app().request(`/admin/v1/search${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  /** Bearings and Safety, a bearing and a glove, indexed. */
  async function catalog() {
    await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
    const bearings = await createCategory(handle.db, { code: 'bearings', name: 'Bearings' });
    const safety = await createCategory(handle.db, { code: 'safety', name: 'Safety' });
    const bearing = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      status: 'enabled',
      categoryId: bearings.id,
      primaryUnitCode: 'each',
    });
    const glove = await createProduct(handle.db, {
      sku: 'GLV-NITRILE-L',
      name: 'Nitrile gloves, large',
      status: 'enabled',
      categoryId: safety.id,
      primaryUnitCode: 'each',
    });
    await rebuildSearchIndex(handle.db);
    return { bearings, safety, bearing, glove };
  }

  it('requires an admin session', async () => {
    const res = await app().request('/admin/v1/search/products?q=bearing');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  it.each([
    ['GET', '/products?q=bearing', 'product.view'],
    ['GET', '/build', 'product.view'],
    ['POST', '/build', 'product.manage'],
  ] as const)(
    '%s %s answers 403 without %s, and passes the permission check with it',
    async (method, path, permission) => {
      const other: AdminPermission =
        permission === 'product.view' ? 'visibility.view' : 'product.view';
      const without = await signedInAdmin('meera@acme.example', [other]);
      const denied = await call(method, path, without);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      expect(await denied.json()).toMatchObject({ code: 'permission_denied' });

      const withIt = await signedInAdmin('asha@acme.example', [permission]);
      const allowed = await call(method, path, withIt);
      expect(allowed.status).toBe(200);
    },
  );

  it('searches every product, ranked, and never logs the query', async () => {
    const { bearing } = await catalog();
    const asha = await signedInAdmin('asha@acme.example', ['product.view']);
    const res = await call('GET', '/products?q=BRG-6205-2RS', asha);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = await json<SearchPage<Hit>>(res);
    expect(page.results[0]).toMatchObject({
      productId: bearing.id,
      sku: 'BRG-6205-2RS',
      match: 'sku_exact',
      status: 'enabled',
    });
    const typo = await json<SearchPage<Hit>>(await call('GET', '/products?q=nitrle', asha));
    expect(typo.results.map((r) => [r.sku, r.match])).toEqual([['GLV-NITRILE-L', 'close']]);
    expect(logs.join('\n')).not.toContain('nitrle');
    expect(logs.join('\n')).not.toContain('BRG-6205-2RS');
  });

  it.each([
    ['', 'no query'],
    ['?q=', 'an empty query'],
    [`?q=${'x'.repeat(101)}`, 'a query that is too long'],
    ['?q=bearing&limit=51', 'a page that is too large'],
    ['?q=bearing&limit=50&offset=951', 'a page beyond the first 1,000 results'],
    ['?q=bearing&limit=-1', 'a negative page size'],
    ['?q=bearing&status=archived', 'an unknown status'],
  ])('refuses %j (%s)', async (query, _why) => {
    const asha = await signedInAdmin('asha@acme.example', ['product.view']);
    const res = await call('GET', `/products${query}`, asha);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('indexes products as the catalog routes change them', async () => {
    const { safety } = await catalog();
    const asha = await signedInAdmin('asha@acme.example', ['product.view', 'product.manage']);
    const catalogCall = (method: string, path: string, body: unknown) =>
      app().request(`/admin/v1/catalog${path}`, {
        method,
        headers: { Cookie: asha, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const created = await catalogCall('POST', '/products', {
      sku: 'HLM-YEL',
      name: 'Safety helmet, yellow',
      categoryId: safety.id,
      primaryUnitCode: 'each',
    });
    expect(created.status).toBe(201);
    const { product } = await json<{ product: { id: string } }>(created);
    const found = await json<SearchPage<Hit>>(await call('GET', '/products?q=helmet', asha));
    expect(found.results.map((r) => r.productId)).toEqual([product.id]);

    expect(
      (await catalogCall('PATCH', `/products/${product.id}`, { name: 'Hard hat' })).status,
    ).toBe(200);
    const renamed = await json<SearchPage<Hit>>(await call('GET', '/products?q=hard+hat', asha));
    expect(renamed.results.map((r) => r.name)).toEqual(['Hard hat']);

    expect((await catalogCall('PATCH', `/categories/${safety.id}`, { name: 'PPE' })).status).toBe(
      200,
    );
    const byCategory = await json<SearchPage<Hit>>(await call('GET', '/products?q=ppe', asha));
    expect(byCategory.results.map((r) => r.sku).sort()).toEqual(['GLV-NITRILE-L', 'HLM-YEL']);

    const state = await json<{ build: { waitingProducts: number } }>(
      await call('GET', '/build', asha),
    );
    expect(state.build.waitingProducts).toBe(0);
  });

  it('rebuilds the index on request and records who ran it', async () => {
    await catalog();
    await handle.db.execute(sql`truncate search_product`);
    const asha = await signedInAdmin('asha@acme.example', ['product.view', 'product.manage']);
    const waiting = await json<{ build: { waitingProducts: number } }>(
      await call('GET', '/build', asha),
    );
    expect(waiting.build.waitingProducts).toBe(2);
    const res = await call('POST', '/build', asha);
    expect(res.status).toBe(200);
    const { build } = await json<{ build: { productCount: number; builtBy: string } }>(res);
    expect(build.productCount).toBe(2);
    const after = await json<{
      build: { waitingProducts: number; lastBuild: { builtBy: string } };
    }>(await call('GET', '/build', asha));
    expect(after.build.waitingProducts).toBe(0);
    expect(after.build.lastBuild.builtBy).toBe(build.builtBy);
  });

  it('gate check: a signed-in buyer finds only their own catalog', async () => {
    const { bearings, bearing, glove } = await catalog();
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
    const distributors = await createCustomerGroup(handle.db, {
      code: 'distributors',
      name: 'Distributors',
    });
    const distributor = await createCustomer(handle.db, {
      name: 'Pune Bearing House',
      groupId: distributors.id,
    });
    const retailer = await createCustomer(handle.db, { name: 'Kochi Hardware' });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: bearings.id,
      target: 'website',
      visibility: 'hidden',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: bearings.id,
      target: 'customer_group',
      targetId: distributors.id,
      visibility: 'visible',
    });
    await rebuildVisibility(handle.db);
    const ravi = await signedInBuyer(distributor.id, 'ravi@punebearing.in');
    const lena = await signedInBuyer(retailer.id, 'lena@kochihardware.in');

    const find = async (buyerUserId: string, q: string) =>
      (
        await searchProductsForBuyer(handle.db, { buyerUserId, websiteId: website.id }, { q })
      ).results.map((r) => r.productId);
    expect(await find(ravi, 'BRG-6205-2RS')).toEqual([bearing.id]);
    expect(await find(lena, 'BRG-6205-2RS')).toEqual([]);
    expect(await find(lena, 'bearing')).toEqual([]);
    expect(await find(lena, 'gloves')).toEqual([glove.id]);
  });
});
