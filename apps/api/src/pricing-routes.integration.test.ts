import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import { createProduct, createProductUnit } from '@muziris/catalog';
import { createCustomer, createCustomerGroup } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const ID = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!url)('pricing routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_pricing');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate pricing_combined_price, pricing_combined_price_list_target,
        pricing_combined_price_list, pricing_assignment, pricing_price, pricing_price_list,
        pricing_build_state, catalog_product_sold_in, catalog_product, catalog_product_unit,
        customer_customer, customer_group, platform_website, platform_organization,
        access_admin_user_role, access_admin_role_permission, access_admin_role,
        identity_session, identity_user, identity_rate_limit cascade`,
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
      now: () => new Date('2026-11-04T09:00:00.000Z'),
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

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return app().request(`/admin/v1/pricing${path}`, {
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

  /** A US website, a product sold each, and a customer in a customer group. */
  async function usWorld() {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    const website = await createWebsite(handle.db, {
      organizationId: org.id,
      code: 'muziris-us',
      name: 'Muziris US',
      countryCode: 'US',
      defaultCurrency: 'USD',
      defaultLocale: 'en-US',
      timeZone: 'America/Chicago',
    });
    await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
    const product = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      primaryUnitCode: 'each',
    });
    const group = await createCustomerGroup(handle.db, {
      code: 'us_distributors',
      name: 'US distributors',
    });
    const customer = await createCustomer(handle.db, {
      name: 'Gulf Coast Industrial Supply',
      groupId: group.id,
    });
    return { website, product, group, customer };
  }

  it('requires an admin session', async () => {
    const res = await app().request('/admin/v1/pricing/price-lists');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  it.each([
    ['GET', '/price-lists', 'price_list.view', undefined],
    ['GET', `/price-lists/${ID}`, 'price_list.view', undefined],
    ['GET', `/price-lists/${ID}/prices`, 'price_list.view', undefined],
    ['GET', '/assignments', 'price_list.view', undefined],
    ['GET', '/build', 'price_list.view', undefined],
    [
      'GET',
      `/preview?customerId=${ID}&websiteId=${ID}&productId=${ID}&unitCode=each&quantity=1`,
      'price_list.view',
      undefined,
    ],
    ['POST', '/price-lists', 'price_list.manage', { name: 'A', currency: 'USD' }],
    ['PATCH', `/price-lists/${ID}`, 'price_list.manage', { name: 'B' }],
    ['DELETE', `/price-lists/${ID}`, 'price_list.manage', undefined],
    [
      'POST',
      `/price-lists/${ID}/prices`,
      'price_list.manage',
      { productId: ID, unitCode: 'each', amount: '1.00' },
    ],
    ['PATCH', `/prices/${ID}`, 'price_list.manage', { amount: '1.00' }],
    ['DELETE', `/prices/${ID}`, 'price_list.manage', undefined],
    [
      'POST',
      '/assignments',
      'price_list.manage',
      { priceListId: ID, websiteId: ID, target: 'website' },
    ],
    ['PATCH', `/assignments/${ID}`, 'price_list.manage', { priority: 2 }],
    ['DELETE', `/assignments/${ID}`, 'price_list.manage', undefined],
    ['POST', '/build', 'price_list.manage', undefined],
  ] as const)(
    '%s %s answers 403 without %s, and passes the permission check with it',
    async (method, path, permission, body) => {
      const other: AdminPermission =
        permission === 'price_list.view' ? 'product.view' : 'price_list.view';
      const without = await signedInAdmin('meera@acme.example', [other]);
      const denied = await call(method, path, without, body);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      expect(await denied.json()).toMatchObject({ code: 'permission_denied' });

      const withIt = await signedInAdmin('asha@acme.example', [permission]);
      const allowed = await call(method, path, withIt, body);
      expect(allowed.status).not.toBe(403);
      expect(allowed.status).toBeLessThan(500);
    },
  );

  it('lets a pricing manager set up the fallback chain, build and preview', async () => {
    const w = await usWorld();
    const asha = await signedInAdmin('asha@acme.example', ['price_list.view', 'price_list.manage']);

    const created = await call('POST', '/price-lists', asha, {
      name: 'US distributor net 2026',
      currency: 'USD',
      activeFrom: '2026-01-01T00:00:00-06:00',
      activeUntil: '2027-01-01T00:00:00-06:00',
    });
    expect(created.status).toBe(201);
    const { priceList: net } = await json<{ priceList: { id: string } }>(created);
    expect(await json(await call('GET', `/price-lists/${net.id}`, asha))).toMatchObject({
      priceList: {
        name: 'US distributor net 2026',
        currency: 'USD',
        status: 'active',
        activeFrom: '2026-01-01T06:00:00.000Z',
      },
    });
    const { priceList: list } = await json<{ priceList: { id: string } }>(
      await call('POST', '/price-lists', asha, { name: 'US list price', currency: 'USD' }),
    );

    for (const [minQuantity, amount] of [
      ['1', '5.38'],
      ['100', '4.86'],
      ['1000', '4.41'],
    ]) {
      const res = await call('POST', `/price-lists/${net.id}/prices`, asha, {
        productId: w.product.id,
        unitCode: 'each',
        minQuantity,
        amount,
      });
      expect(res.status).toBe(201);
    }
    const added = await call('POST', `/price-lists/${list.id}/prices`, asha, {
      productId: w.product.id,
      unitCode: 'each',
      amount: '6.4',
    });
    expect(await json(added)).toMatchObject({
      price: { minQuantity: '1', amount: '6.40', currency: 'USD' },
    });

    const prices = await json<{ prices: { amount: string }[]; nextAfter: string | null }>(
      await call('GET', `/price-lists/${net.id}/prices?limit=2`, asha),
    );
    expect(prices.prices.map((p) => p.amount)).toEqual(['5.38', '4.86']);
    const rest = await json<{ prices: { amount: string }[]; nextAfter: string | null }>(
      await call(
        'GET',
        `/price-lists/${net.id}/prices?limit=2&after=${prices.nextAfter ?? ''}`,
        asha,
      ),
    );
    expect(rest).toMatchObject({ prices: [{ amount: '4.41' }], nextAfter: null });

    expect(
      (
        await call('POST', '/assignments', asha, {
          priceListId: net.id,
          websiteId: w.website.id,
          target: 'customer_group',
          targetId: w.group.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call('POST', '/assignments', asha, {
          priceListId: list.id,
          websiteId: w.website.id,
          target: 'website',
        })
      ).status,
    ).toBe(201);
    const assigned = await json<{ assignments: { target: string }[] }>(
      await call('GET', `/assignments?websiteId=${w.website.id}`, asha),
    );
    expect(assigned.assignments.map((a) => a.target)).toEqual(['customer_group', 'website']);

    const lists = await json<{ priceLists: unknown[] }>(await call('GET', '/price-lists', asha));
    expect(lists.priceLists).toMatchObject([
      { name: 'US distributor net 2026', priceCount: 3, assignmentCount: 1 },
      { name: 'US list price', priceCount: 1, assignmentCount: 1 },
    ]);

    const preview = `/preview?customerId=${w.customer.id}&websiteId=${w.website.id}&productId=${w.product.id}&unitCode=each&quantity=120`;
    const before = await json<{ preview: unknown }>(await call('GET', preview, asha));
    expect(before.preview).toMatchObject({
      price: null,
      reason: 'no_price',
      unbuiltPrice: { unitPrice: '4.86', minQuantity: '100' },
      pendingChanges: 8,
    });
    expect(await json(await call('GET', '/build', asha))).toMatchObject({
      build: { pendingChanges: 8, lastBuild: null },
    });

    const built = await call('POST', '/build', asha);
    expect(built.status).toBe(200);
    // The website chain has one price. The group chain is split at the net list's dates: before
    // and after 2026 only the list price applies (one row each), during 2026 three tiers do.
    expect(await json(built)).toMatchObject({
      build: { combinedPriceListCount: 2, combinedPriceCount: 6 },
    });
    expect(logs.some((l) => l.includes('pricing.combined_prices_built'))).toBe(true);

    const after = await json<{ preview: unknown }>(await call('GET', preview, asha));
    expect(after.preview).toEqual({
      currency: 'USD',
      quantity: '120',
      price: { unitPrice: '4.86', minQuantity: '100', priceListId: net.id },
      lineAmount: '583.20',
      reason: null,
      steps: [
        {
          target: 'customer_group',
          targetId: w.group.id,
          priority: 1,
          priceListId: net.id,
          priceListName: 'US distributor net 2026',
          status: 'used',
          tier: { minQuantity: '100', unitPrice: '4.86' },
        },
        {
          target: 'website',
          targetId: w.website.id,
          priority: 1,
          priceListId: list.id,
          priceListName: 'US list price',
          status: 'not_reached',
          tier: { minQuantity: '1', unitPrice: '6.40' },
        },
      ],
      unbuiltPrice: { unitPrice: '4.86', minQuantity: '100', priceListId: net.id },
      pendingChanges: 0,
    });

    expect((await call('DELETE', `/price-lists/${list.id}`, asha)).status).toBe(204);
    expect((await call('GET', `/price-lists/${list.id}`, asha)).status).toBe(404);
  });

  it.each([
    ['a JSON number amount', { amount: 4.86 }, 400, 'validation_failed'],
    ['an amount with too many decimals', { amount: '4.865' }, 400, 'invalid_amount'],
    ['a fractional quantity in each', { minQuantity: '1.5' }, 400, 'invalid_quantity'],
    ['an unknown product', { productId: ID }, 404, 'product_not_found'],
    ['a unit the product is not sold in', { unitCode: 'kg' }, 422, 'product_unit_not_sold'],
  ] as const)('refuses a price with %s', async (_, change, status, code) => {
    const w = await usWorld();
    await createProductUnit(handle.db, { code: 'kg', name: 'Kilogram', precision: 3 });
    const asha = await signedInAdmin('asha@acme.example', ['price_list.manage']);
    const { priceList } = await json<{ priceList: { id: string } }>(
      await call('POST', '/price-lists', asha, { name: 'US', currency: 'USD' }),
    );
    const res = await call('POST', `/price-lists/${priceList.id}/prices`, asha, {
      productId: w.product.id,
      unitCode: 'each',
      amount: '1.00',
      ...change,
    });
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code });
  });

  it.each([
    ['an unsupported currency', { name: 'X', currency: 'XYZ' }, 400, 'validation_failed'],
    [
      'a date without an offset',
      { name: 'X', currency: 'USD', activeFrom: '2026-01-01' },
      400,
      'validation_failed',
    ],
    [
      'dates out of order',
      {
        name: 'X',
        currency: 'USD',
        activeFrom: '2027-01-01T00:00:00Z',
        activeUntil: '2026-01-01T00:00:00Z',
      },
      400,
      'active_dates_out_of_order',
    ],
  ] as const)('refuses a price list with %s', async (_, input, status, code) => {
    const asha = await signedInAdmin('asha@acme.example', ['price_list.manage']);
    const res = await call('POST', '/price-lists', asha, input);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it('refuses to change a price list currency, and an assignment in another currency', async () => {
    const w = await usWorld();
    const asha = await signedInAdmin('asha@acme.example', ['price_list.manage']);
    const { priceList } = await json<{ priceList: { id: string } }>(
      await call('POST', '/price-lists', asha, { name: 'India', currency: 'INR' }),
    );
    const change = await call('PATCH', `/price-lists/${priceList.id}`, asha, { currency: 'USD' });
    expect(change.status).toBe(400);
    expect(await change.json()).toMatchObject({ code: 'validation_failed' });

    const assign = await call('POST', '/assignments', asha, {
      priceListId: priceList.id,
      websiteId: w.website.id,
      target: 'customer',
      targetId: w.customer.id,
    });
    expect(assign.status).toBe(422);
    expect(await assign.json()).toMatchObject({ code: 'currency_mismatch' });
  });

  it('answers 404 problems for a preview of unknown records', async () => {
    const w = await usWorld();
    const asha = await signedInAdmin('asha@acme.example', ['price_list.view']);
    const res = await call(
      'GET',
      `/preview?customerId=${ID}&websiteId=${w.website.id}&productId=${w.product.id}&unitCode=each&quantity=1`,
      asha,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'customer_not_found' });
    const missing = await call('GET', `/preview?customerId=${w.customer.id}`, asha);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'validation_failed' });
  });
});
