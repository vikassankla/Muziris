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
import { createProduct, createProductUnit } from '@muziris/catalog';
import { addAddress, createCustomer, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import { tableTaxProvider } from '@muziris/tax';
import { rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');
const GSTIN = '27AAPFU0939F1ZV';

describe.skipIf(!url)('tax routes and checkout with the tax engine against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_tax');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate tax_exemption, tax_us_rate, tax_gst_rate, tax_registration,
        orders_order_tax_line, orders_order_line, orders_order_address, orders_order,
        workflow_transition_log, workflow_instance, platform_config_value,
        pricing_combined_price, pricing_combined_price_list_target, pricing_combined_price_list,
        pricing_build_state, pricing_assignment, pricing_price, pricing_price_list,
        visibility_visible_product, visibility_visible_category, visibility_context,
        visibility_rule, visibility_build_state, catalog_product_sold_in, catalog_product,
        catalog_category, catalog_product_unit, customer_address, customer_buyer_user,
        customer_customer, customer_group, access_buyer_user_role, access_buyer_role_permission,
        access_buyer_role, access_admin_user_role, access_admin_role_permission,
        access_admin_role, platform_website, platform_organization, identity_session,
        identity_user, identity_rate_limit cascade`,
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
      maxBodyBytes: 256 * 1024,
      now: () => NOW,
      clientIp: () => '203.0.113.7',
      storefront: { persistedQueries: new Map(), allowAdhocQueries: true },
      tax: tableTaxProvider(handle.db),
    });
  }

  async function signIn(realm: 'buyer' | 'admin', email: string): Promise<string> {
    const res = await app().request(
      `/${realm === 'buyer' ? 'storefront' : 'admin'}/v1/auth/sign-in`,
      {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      },
    );
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
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
    return signIn('admin', email);
  }

  function call(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
    contentType = 'application/json',
  ) {
    return app().request(`/admin/v1/tax${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': contentType }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  }

  async function website(countryCode = 'IN') {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    return createWebsite(handle.db, {
      organizationId: org.id,
      code: countryCode === 'IN' ? 'muziris-in' : 'muziris-us',
      name: 'Muziris',
      countryCode,
      defaultCurrency: countryCode === 'IN' ? 'INR' : 'USD',
      defaultLocale: countryCode === 'IN' ? 'en-IN' : 'en-US',
      timeZone: countryCode === 'IN' ? 'Asia/Kolkata' : 'America/Los_Angeles',
    });
  }

  it('lets tax.manage set registrations and rates, and tax.view only read them', async () => {
    const site = await website();
    const manager = await signedInAdmin('tax@muziris.in', ['tax.view', 'tax.manage']);
    const viewer = await signedInAdmin('viewer@muziris.in', ['tax.view']);

    expect(
      (await call('PUT', `/websites/${site.id}/gst-registration`, viewer, { gstin: GSTIN })).status,
    ).toBe(403);
    const set = await call('PUT', `/websites/${site.id}/gst-registration`, manager, {
      gstin: GSTIN,
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ registration: { regionCode: '27', number: GSTIN } });
    const listed = await call('GET', `/websites/${site.id}/registrations`, viewer);
    expect(await listed.json()).toMatchObject({ registrations: [{ number: GSTIN }] });

    const rate = await call('POST', '/gst-rates', manager, {
      codePrefix: '8482',
      ratePercent: '18',
      validFrom: '2025-09-22',
    });
    expect(rate.status).toBe(201);
    const { rate: created } = (await rate.json()) as { rate: { id: string } };
    const overlap = await call('POST', '/gst-rates', manager, {
      codePrefix: '8482',
      ratePercent: '5',
      validFrom: '2026-12-01',
    });
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ code: 'rate_overlaps' });
    const ended = await call('PATCH', `/gst-rates/${created.id}`, manager, {
      validTo: '2026-12-01',
    });
    expect(await ended.json()).toMatchObject({ rate: { validTo: '2026-12-01' } });
    const onDay = await call('GET', '/gst-rates?on=2026-11-30', viewer);
    expect(await onDay.json()).toMatchObject({
      rates: [{ codePrefix: '8482', ratePercent: '18' }],
    });
    expect((await call('POST', '/gst-rates', manager, { codePrefix: '848' })).status).toBe(400);
  });

  it('imports US rates from CSV, naming the rows it refuses', async () => {
    const manager = await signedInAdmin('tax@muziris.in', ['tax.view', 'tax.manage']);
    const header = 'state,zip_prefix,rate_percent,shipping_taxable,valid_from,valid_to';
    const bad = await call(
      'POST',
      '/us-rates/import',
      manager,
      `${header}\nCA,,7.25,false,2026-01-01,\nZZ,,1,false,2026-01-01,\n`,
      'text/csv',
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({
      code: 'invalid_import',
      errors: [{ path: 'row 2' }],
    });
    const good = await call(
      'POST',
      '/us-rates/import',
      manager,
      `${header}\nCA,,7.25,false,2026-01-01,\n`,
      'text/csv',
    );
    expect(await good.json()).toEqual({ imported: 1 });
    expect((await call('POST', '/us-rates/import', manager, { csv: 'x' })).status).toBe(415);
    const rates = await call('GET', '/us-rates?stateCode=ca', manager);
    expect(await rates.json()).toMatchObject({ rates: [{ stateCode: 'CA', ratePercent: '7.25' }] });
  });

  describe('checkout with the tax engine', () => {
    async function shop() {
      const site = await website();
      await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
      const product = (sku: string, hsnSacCode: string | null) =>
        createProduct(handle.db, {
          sku,
          name: sku,
          status: 'enabled',
          attributes: {},
          primaryUnitCode: 'each',
          hsnSacCode,
        });
      const bearing = await product('BRG-6205', '84821011');
      const unclassified = await product('MISC-1', null);
      const list = await createPriceList(handle.db, { name: 'List', currency: 'INR' });
      for (const p of [bearing, unclassified]) {
        await addPrice(handle.db, list.id, { productId: p.id, unitCode: 'each', amount: '480.00' });
      }
      await createAssignment(handle.db, {
        priceListId: list.id,
        websiteId: site.id,
        target: 'website',
      });
      await Promise.all([rebuildVisibility(handle.db), rebuildCombinedPrices(handle.db)]);
      const customer = await createCustomer(handle.db, { name: 'Pune Bearing House' });
      const address = await addAddress(handle.db, {
        customerId: customer.id,
        label: 'Warehouse',
        countryCode: 'IN',
        line1: 'Plot 12',
        city: 'Pune',
        regionCode: '27',
        postalCode: '411026',
      });
      const role = await createBuyerRole(handle.db, {
        code: 'orderer',
        name: 'Orderer',
        grants: [
          { permission: 'order.place', accessLevel: 'my_customer' },
          { permission: 'order.view', accessLevel: 'my_customer' },
        ],
      });
      const user = await createUser(handle.db, {
        realm: 'buyer',
        email: 'ravi@punebearing.in',
        displayName: 'Ravi',
        password: PASSWORD,
      });
      await linkBuyerUser(handle.db, customer.id, 'ravi@punebearing.in');
      await assignBuyerRole(handle.db, user.id, role.id);
      const manager = await signedInAdmin('tax@muziris.in', ['tax.view', 'tax.manage']);
      await call('PUT', `/websites/${site.id}/gst-registration`, manager, { gstin: GSTIN });
      await call('POST', '/gst-rates', manager, {
        codePrefix: '8482',
        ratePercent: '18',
        validFrom: '2025-09-22',
      });
      return {
        site,
        bearing,
        unclassified,
        address,
        buyer: await signIn('buyer', 'ravi@punebearing.in'),
      };
    }

    async function preview(w: Awaited<ReturnType<typeof shop>>, productId: string) {
      const res = await app().request('/storefront/v1/graphql', {
        method: 'POST',
        headers: {
          Cookie: w.buyer,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'Muziris-Website': 'muziris-in',
        },
        body: JSON.stringify({
          query: `query P($input: CheckoutInput!) { checkoutPreview(input: $input) {
            preview { totals { tax { amount } grandTotal { amount } taxes { name amount { amount } } } }
            refusal { code taxProblems { lineNo code } } } }`,
          variables: {
            input: {
              lines: [{ productId, unitCode: 'each', quantity: '10' }],
              billingAddressId: w.address.id,
              shippingAddressId: w.address.id,
            },
          },
        }),
      });
      return ((await res.json()) as { data: { checkoutPreview: unknown } }).data.checkoutPreview;
    }

    it('charges CGST and SGST from the rates the admin entered', async () => {
      const w = await shop();
      expect(await preview(w, w.bearing.id)).toEqual({
        preview: {
          totals: {
            tax: { amount: '864.00' },
            grandTotal: { amount: '5664.00' },
            taxes: [
              { name: 'CGST', amount: { amount: '432.00' } },
              { name: 'SGST', amount: { amount: '432.00' } },
            ],
          },
        },
        refusal: null,
      });
    });

    it('refuses a product without an HSN code with TAX_PROBLEMS', async () => {
      const w = await shop();
      expect(await preview(w, w.unclassified.id)).toEqual({
        preview: null,
        refusal: { code: 'TAX_PROBLEMS', taxProblems: [{ lineNo: 1, code: 'NO_TAX_CODE' }] },
      });
    });
  });

  it('refuses a request for an unknown rate id', async () => {
    const manager = await signedInAdmin('tax@muziris.in', ['tax.view', 'tax.manage']);
    expect((await call('DELETE', `/gst-rates/${randomUUID()}`, manager)).status).toBe(404);
  });
});
