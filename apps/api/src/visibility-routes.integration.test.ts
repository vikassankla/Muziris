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
import { visibleProductIdsForBuyer } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const ID = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!url)('visibility routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_visibility');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate visibility_visible_product, visibility_visible_category, visibility_context,
        visibility_rule, visibility_build_state, catalog_product_sold_in, catalog_product,
        catalog_category, catalog_product_unit, customer_buyer_user, customer_customer,
        customer_group, platform_website, platform_organization, access_admin_user_role,
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
    return (await json<{ user: { id: string } }>(me)).user.id;
  }

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return app().request(`/admin/v1/visibility${path}`, {
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

  /**
   * An Indian website with Bearings and Safety categories, a bearing and a safety glove, and two
   * customers: a distributor and a retailer, in their own customer groups.
   */
  async function inWorld() {
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
    const distributors = await createCustomerGroup(handle.db, {
      code: 'distributors',
      name: 'Distributors',
    });
    const retail = await createCustomerGroup(handle.db, { code: 'retail', name: 'Retail' });
    const distributor = await createCustomer(handle.db, {
      name: 'Pune Bearing House',
      groupId: distributors.id,
    });
    const retailer = await createCustomer(handle.db, {
      name: 'Kochi Hardware',
      groupId: retail.id,
    });
    return { website, bearings, safety, bearing, glove, distributors, distributor, retailer };
  }

  it('requires an admin session', async () => {
    const res = await app().request('/admin/v1/visibility/rules');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  it.each([
    ['GET', '/rules', 'visibility.view', undefined],
    ['GET', `/rules/${ID}`, 'visibility.view', undefined],
    ['GET', '/build', 'visibility.view', undefined],
    [
      'GET',
      `/preview?websiteId=${ID}&customerId=${ID}&productId=${ID}`,
      'visibility.view',
      undefined,
    ],
    ['GET', `/visible-products?websiteId=${ID}&customerId=${ID}`, 'visibility.view', undefined],
    [
      'POST',
      '/rules',
      'visibility.manage',
      {
        websiteId: ID,
        subject: 'product',
        subjectId: ID,
        target: 'website',
        visibility: 'hidden',
      },
    ],
    ['PATCH', `/rules/${ID}`, 'visibility.manage', { visibility: 'visible' }],
    ['DELETE', `/rules/${ID}`, 'visibility.manage', undefined],
    ['POST', '/build', 'visibility.manage', undefined],
  ] as const)(
    '%s %s answers 403 without %s, and passes the permission check with it',
    async (method, path, permission, body) => {
      const other: AdminPermission =
        permission === 'visibility.view' ? 'product.view' : 'visibility.view';
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

  it('gate check: each buyer sees only their own catalog', async () => {
    const w = await inWorld();
    const asha = await signedInAdmin('asha@acme.example', ['visibility.view', 'visibility.manage']);

    // Bearings are for distributors only; the safety glove is hidden from one distributor.
    const hideBearings = await call('POST', '/rules', asha, {
      websiteId: w.website.id,
      subject: 'category',
      subjectId: w.bearings.id,
      target: 'website',
      visibility: 'hidden',
    });
    expect(hideBearings.status).toBe(201);
    const showToDistributors = await call('POST', '/rules', asha, {
      websiteId: w.website.id,
      subject: 'category',
      subjectId: w.bearings.id,
      target: 'customer_group',
      targetId: w.distributors.id,
      visibility: 'visible',
    });
    expect(showToDistributors.status).toBe(201);
    const hideGlove = await call('POST', '/rules', asha, {
      websiteId: w.website.id,
      subject: 'product',
      subjectId: w.glove.id,
      target: 'customer',
      targetId: w.distributor.id,
      visibility: 'hidden',
    });
    expect(hideGlove.status).toBe(201);

    const pending = await json<{ build: { pendingChanges: number } }>(
      await call('GET', '/build', asha),
    );
    expect(pending.build.pendingChanges).toBe(3);
    const built = await call('POST', '/build', asha);
    expect(built.status).toBe(200);
    expect(await built.json()).toMatchObject({ build: { contextCount: 4 } });
    expect(logs.join('')).toContain('visibility.built');

    // What the admin sees for each customer.
    const visible = async (customerId: string) =>
      (
        await json<{ productIds: string[] }>(
          await call(
            'GET',
            `/visible-products?websiteId=${w.website.id}&customerId=${customerId}`,
            asha,
          ),
        )
      ).productIds;
    expect(await visible(w.distributor.id)).toEqual([w.bearing.id]);
    expect(await visible(w.retailer.id)).toEqual([w.glove.id]);

    // What each signed-in buyer's own scoped select returns, the select search and the
    // storefront will put in their queries.
    const ravi = await signedInBuyer(w.distributor.id, 'ravi@punebearing.example');
    const leela = await signedInBuyer(w.retailer.id, 'leela@kochihardware.example');
    const seen = async (buyerUserId: string) => {
      const rows = await handle.db.execute<{ product_id: string }>(
        sql`select product_id::text from (${visibleProductIdsForBuyer({
          buyerUserId,
          websiteId: w.website.id,
        })}) v order by 1`,
      );
      return rows.map((r) => r.product_id);
    };
    expect(await seen(ravi)).toEqual([w.bearing.id]);
    expect(await seen(leela)).toEqual([w.glove.id]);

    // The preview explains the retailer's missing bearing.
    const preview = await call(
      'GET',
      `/preview?websiteId=${w.website.id}&customerId=${w.retailer.id}&productId=${w.bearing.id}`,
      asha,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      preview: {
        subject: 'product',
        visible: false,
        reason: 'rule',
        rule: { target: 'website', subject: 'category', subjectId: w.bearings.id },
        categoryDistance: 0,
        built: { visible: false, context: 'website', needsRebuild: false },
        pendingChanges: 0,
      },
    });
  });

  it('lists, reads, changes and deletes rules', async () => {
    const w = await inWorld();
    const asha = await signedInAdmin('asha@acme.example', ['visibility.view', 'visibility.manage']);
    const created = await json<{ rule: { id: string } }>(
      await call('POST', '/rules', asha, {
        websiteId: w.website.id,
        subject: 'product',
        subjectId: w.glove.id,
        target: 'customer',
        targetId: w.retailer.id,
        visibility: 'hidden',
      }),
    );
    const id = created.rule.id;
    const listed = await call('GET', `/rules?websiteId=${w.website.id}&limit=1`, asha);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ rules: [{ id }], nextAfter: null });

    const changed = await call('PATCH', `/rules/${id}`, asha, { visibility: 'visible' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ rule: { id, visibility: 'visible' } });
    const read = await call('GET', `/rules/${id}`, asha);
    expect(await read.json()).toMatchObject({ rule: { visibility: 'visible' } });

    expect((await call('DELETE', `/rules/${id}`, asha)).status).toBe(204);
    const gone = await call('GET', `/rules/${id}`, asha);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'rule_not_found' });
    expect(logs.join('')).toContain('visibility.rule_deleted');
  });

  it('answers problems for refused and invalid requests', async () => {
    const w = await inWorld();
    const asha = await signedInAdmin('asha@acme.example', ['visibility.view', 'visibility.manage']);
    const rule = {
      websiteId: w.website.id,
      subject: 'category',
      subjectId: w.safety.id,
      target: 'website',
      visibility: 'hidden',
    };
    expect((await call('POST', '/rules', asha, rule)).status).toBe(201);
    const taken = await call('POST', '/rules', asha, rule);
    expect(taken.status).toBe(409);
    expect(taken.headers.get('content-type')).toContain('application/problem+json');
    expect(await taken.json()).toMatchObject({ code: 'rule_taken' });

    const missing = await call('POST', '/rules', asha, { ...rule, subjectId: ID });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'category_not_found' });

    const unknownCustomer = await call(
      'GET',
      `/preview?websiteId=${w.website.id}&customerId=${ID}&productId=${w.bearing.id}`,
      asha,
    );
    expect(unknownCustomer.status).toBe(404);
    expect(await unknownCustomer.json()).toMatchObject({ code: 'customer_not_found' });

    const both = await call(
      'GET',
      `/preview?websiteId=${w.website.id}&customerId=${w.retailer.id}&productId=${w.bearing.id}&categoryId=${w.safety.id}`,
      asha,
    );
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ code: 'validation_failed' });

    const badLimit = await call('GET', '/rules?limit=500', asha);
    expect(badLimit.status).toBe(400);
    const badVisibility = await call('POST', '/rules', asha, { ...rule, visibility: 'maybe' });
    expect(badVisibility.status).toBe(400);
    const wrongWebsite = await call('POST', '/rules', asha, { ...rule, targetId: ID });
    expect(wrongWebsite.status).toBe(400);
  });
});
