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
import { multiply } from '@muziris/money';
import type { TaxProvider } from '@muziris/orders';
import { createOrganization, createWebsite } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import { rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://shop.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');

/** 18% IGST on every line and on shipping, rounded half up: enough to test the wiring. */
const igst18: TaxProvider = {
  name: 'igst_18_test',
  calculate: (request) => {
    const taxed = [
      ...request.lines.map((l) => ({ lineNo: l.lineNo, amount: l.net })),
      ...(request.shipping.minor > 0n ? [{ lineNo: null, amount: request.shipping }] : []),
    ];
    return Promise.resolve({
      lines: taxed.map((t) => ({
        lineNo: t.lineNo,
        name: 'IGST',
        rate: '0.18',
        taxable: t.amount,
        amount: multiply(t.amount, '0.18', 'half-up'),
      })),
      taxCodes: new Map(request.lines.map((l) => [l.lineNo, '8482'])),
    });
  },
};

interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions: { code: string } }[];
}

/** Follows a path of keys into a GraphQL response, undefined where one is missing. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const PREVIEW = `query Preview($input: CheckoutInput!) {
  checkoutPreview(input: $input) {
    preview { paymentTermDays dueOn totals { subtotal { amount } tax { amount } grandTotal { amount currency }
      lines { lineNo sku quantity net { amount } taxCode } taxes { name amount { amount } } } }
    refusal { code message addressRole lines { lineNo code } }
  }
}`;

const PLACE = `mutation Place($input: PlaceOrderInput!) {
  placeOrder(input: $input) {
    order { number step customerName purchaseOrderNumber dueOn grandTotal { amount }
      lines { sku productName quantity } billingAddress { city gstin } }
    replayed
    refusal { code message expectedGrandTotal { amount } totals { grandTotal { amount } } }
  }
}`;

describe.skipIf(!url)('orders through the storefront and admin APIs against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_orders');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate orders_order_tax_line, orders_order_line, orders_order_address, orders_order,
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
    await handle.db.execute(sql`alter sequence orders_order_number_seq restart with 1`);
  });

  afterAll(async () => {
    await handle.close();
  });

  function app(tax?: TaxProvider) {
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
      ...(tax === undefined ? {} : { tax }),
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
    return signIn('admin', email);
  }

  /** A website, one bearing at ₹480.00, and two customers each with an address and a buyer. */
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
    const bearing = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'each',
    });
    const list = await createPriceList(handle.db, { name: 'List price', currency: 'INR' });
    await addPrice(handle.db, list.id, {
      productId: bearing.id,
      unitCode: 'each',
      amount: '480.00',
    });
    await createAssignment(handle.db, {
      priceListId: list.id,
      websiteId: website.id,
      target: 'website',
    });
    await Promise.all([rebuildVisibility(handle.db), rebuildCombinedPrices(handle.db)]);
    const role = await createBuyerRole(handle.db, {
      code: 'orderer',
      name: 'Orderer',
      grants: [
        { permission: 'order.place', accessLevel: 'my_customer' },
        { permission: 'order.view', accessLevel: 'my_customer' },
      ],
    });
    const company = async (name: string, email: string, city: string) => {
      const customer = await createCustomer(handle.db, { name });
      const address = await addAddress(handle.db, {
        customerId: customer.id,
        label: 'Warehouse',
        countryCode: 'IN',
        line1: 'Plot 12',
        city,
        regionCode: '27',
        postalCode: '411026',
        gstin: '27AAPFU0939F1ZV',
      });
      const user = await createUser(handle.db, {
        realm: 'buyer',
        email,
        displayName: email,
        password: PASSWORD,
      });
      await linkBuyerUser(handle.db, customer.id, email);
      await assignBuyerRole(handle.db, user.id, role.id);
      return { customer, address, cookie: await signIn('buyer', email) };
    };
    return {
      bearing,
      pune: await company('Pune Bearing House', 'ravi@punebearing.in', 'Pune'),
      other: await company('Nashik Tools', 'meera@nashiktools.in', 'Nashik'),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  function checkoutInput(w: World, extra: Record<string, unknown> = {}) {
    return {
      lines: [{ productId: w.bearing.id, unitCode: 'each', quantity: '10' }],
      billingAddressId: w.pune.address.id,
      shippingAddressId: w.pune.address.id,
      purchaseOrderNumber: 'PO-7781',
      ...extra,
    };
  }

  async function graphql(
    cookie: string,
    query: string,
    variables: Record<string, unknown> = {},
    tax: TaxProvider | null = igst18,
  ) {
    const res = await app(tax ?? undefined).request('/storefront/v1/graphql', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'Muziris-Website': 'muziris-in',
      },
      body: JSON.stringify({ query, variables }),
    });
    return { status: res.status, body: (await res.json()) as GraphqlResponse };
  }

  async function place(w: World, key = randomUUID()): Promise<unknown> {
    const { body } = await graphql(w.pune.cookie, PLACE, {
      input: { ...checkoutInput(w), idempotencyKey: key, expectedGrandTotal: '5664.00' },
    });
    return at(body.data, 'placeOrder');
  }

  describe('storefront', () => {
    it('refuses checkout with TAX_NOT_CONFIGURED when no tax calculator is set up', async () => {
      const w = await world();
      const preview = await graphql(w.pune.cookie, PREVIEW, { input: checkoutInput(w) }, null);
      expect(preview.body.data?.['checkoutPreview']).toMatchObject({
        preview: null,
        refusal: { code: 'TAX_NOT_CONFIGURED' },
      });
      const placed = await graphql(
        w.pune.cookie,
        PLACE,
        {
          input: {
            ...checkoutInput(w),
            idempotencyKey: randomUUID(),
            expectedGrandTotal: '4800.00',
          },
        },
        null,
      );
      expect(placed.body.data?.['placeOrder']).toMatchObject({
        order: null,
        refusal: { code: 'TAX_NOT_CONFIGURED' },
      });
      const orders = await graphql(w.pune.cookie, '{ orders { nodes { number } } }', {}, null);
      expect(orders.body.data?.['orders']).toEqual({ nodes: [] });
    });

    it("lists the buyer's addresses to check out with", async () => {
      const w = await world();
      const { body } = await graphql(
        w.pune.cookie,
        '{ viewer { customer { addresses { id city gstin isDefaultBilling } } } }',
      );
      expect(at(body.data, 'viewer', 'customer', 'addresses')).toEqual([
        { id: w.pune.address.id, city: 'Pune', gstin: '27AAPFU0939F1ZV', isDefaultBilling: false },
      ]);
    });

    it('previews totals with tax, then places the order once for a repeated key', async () => {
      const w = await world();
      const preview = await graphql(w.pune.cookie, PREVIEW, { input: checkoutInput(w) });
      expect(preview.body.errors).toBeUndefined();
      expect(preview.body.data?.['checkoutPreview']).toEqual({
        preview: {
          paymentTermDays: 30,
          dueOn: '2026-12-20',
          totals: {
            subtotal: { amount: '4800.00' },
            tax: { amount: '864.00' },
            grandTotal: { amount: '5664.00', currency: 'INR' },
            lines: [
              {
                lineNo: 1,
                sku: 'BRG-6205-2RS',
                quantity: '10',
                net: { amount: '4800.00' },
                taxCode: '8482',
              },
            ],
            taxes: [{ name: 'IGST', amount: { amount: '864.00' } }],
          },
        },
        refusal: null,
      });

      const key = randomUUID();
      const first = await place(w, key);
      expect(first).toEqual({
        order: {
          number: 'MZ-000001',
          step: 'NEW',
          customerName: 'Pune Bearing House',
          purchaseOrderNumber: 'PO-7781',
          dueOn: '2026-12-20',
          grandTotal: { amount: '5664.00' },
          lines: [{ sku: 'BRG-6205-2RS', productName: 'Ball bearing 6205-2RS', quantity: '10' }],
          billingAddress: { city: 'Pune', gstin: '27AAPFU0939F1ZV' },
        },
        replayed: false,
        refusal: null,
      });
      const again = await place(w, key);
      expect(again).toMatchObject({ order: { number: 'MZ-000001' }, replayed: true });
    });

    it('refuses a changed total and shows the new one', async () => {
      const w = await world();
      const { body } = await graphql(w.pune.cookie, PLACE, {
        input: { ...checkoutInput(w), idempotencyKey: randomUUID(), expectedGrandTotal: '5000.00' },
      });
      expect(body.data?.['placeOrder']).toMatchObject({
        order: null,
        refusal: {
          code: 'PRICES_CHANGED',
          expectedGrandTotal: { amount: '5000.00' },
          totals: { grandTotal: { amount: '5664.00' } },
        },
      });
    });

    it("refuses another customer's address and names it", async () => {
      const w = await world();
      const { body } = await graphql(w.pune.cookie, PREVIEW, {
        input: checkoutInput(w, { shippingAddressId: w.other.address.id }),
      });
      expect(at(body.data, 'checkoutPreview', 'refusal')).toMatchObject({
        code: 'ADDRESS_NOT_FOUND',
        addressRole: 'SHIPPING',
      });
    });

    it('answers malformed input with BAD_USER_INPUT naming the field', async () => {
      const w = await world();
      const { body } = await graphql(w.pune.cookie, PREVIEW, {
        input: checkoutInput(w, {
          lines: [{ productId: 'nope', unitCode: 'each', quantity: '1' }],
        }),
      });
      expect(body.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.message).toMatch(/^input\.lines\.0\.productId/);
    });

    it('shows a buyer their own orders only', async () => {
      const w = await world();
      expect(at(await place(w), 'order', 'number')).toBe('MZ-000001');
      const list = '{ orders { nodes { number step grandTotal { amount } } nextAfter } }';
      expect((await graphql(w.pune.cookie, list)).body.data?.['orders']).toEqual({
        nodes: [{ number: 'MZ-000001', step: 'NEW', grandTotal: { amount: '5664.00' } }],
        nextAfter: null,
      });
      expect((await graphql(w.other.cookie, list)).body.data?.['orders']).toEqual({
        nodes: [],
        nextAfter: null,
      });
      const one = '{ order(number: "MZ-000001") { number taxes { name } } }';
      expect((await graphql(w.pune.cookie, one)).body.data?.['order']).toEqual({
        number: 'MZ-000001',
        taxes: [{ name: 'IGST' }],
      });
      expect((await graphql(w.other.cookie, one)).body.data?.['order']).toBeNull();
    });
  });

  describe('admin', () => {
    function call(method: string, path: string, cookie: string, body?: unknown) {
      return app().request(`/admin/v1/orders${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it('lists and shows orders to order.view, with history and the open transitions', async () => {
      const w = await world();
      await place(w);
      const viewer = await signedInAdmin('viewer@muziris.in', ['order.view']);
      const nobody = await signedInAdmin('nobody@muziris.in', ['customer.view']);

      expect((await call('GET', '', nobody)).status).toBe(403);
      const list = await call('GET', `?customerId=${w.pune.customer.id}&step=new`, viewer);
      expect(list.status).toBe(200);
      const { orders } = (await list.json()) as {
        orders: { id: string; number: string; grandTotal: string }[];
      };
      expect(orders).toMatchObject([{ number: 'MZ-000001', grandTotal: '5664.00' }]);

      const view = await call('GET', `/${orders[0]!.id}`, viewer);
      expect(await view.json()).toMatchObject({
        order: {
          number: 'MZ-000001',
          step: 'new',
          tax: '864.00',
          lines: [{ sku: 'BRG-6205-2RS', quantity: '10', net: '4800.00' }],
        },
        version: 1,
        transitions: ['confirm', 'decline'],
        history: [{ sequence: 1, toStep: 'new', actor: { type: 'buyer_user' } }],
      });
      expect((await call('GET', `/${randomUUID()}`, viewer)).status).toBe(404);
      expect((await call('GET', '?step=lost', viewer)).status).toBe(400);
    });

    it('moves an order with order.manage, refusing stale versions and closed moves', async () => {
      const w = await world();
      await place(w);
      const manager = await signedInAdmin('ops@muziris.in', ['order.view', 'order.manage']);
      const viewer = await signedInAdmin('viewer@muziris.in', ['order.view']);
      const listed = (await (await call('GET', '', manager)).json()) as {
        orders: { id: string }[];
      };
      const id = listed.orders[0]!.id;
      const move = (cookie: string, body: unknown) =>
        call('POST', `/${id}/transitions`, cookie, body);

      expect((await move(viewer, { transition: 'confirm' })).status).toBe(403);
      const stale = await move(manager, { transition: 'confirm', expectedVersion: 4 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'stale_version' });

      const confirmed = await move(manager, {
        transition: 'confirm',
        expectedVersion: 1,
        note: 'Credit checked',
      });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({
        order: { step: 'confirmed' },
        version: 2,
        transitions: ['start_processing'],
        history: [{ toStep: 'new' }, { toStep: 'confirmed', note: 'Credit checked' }],
      });

      const closed = await move(manager, { transition: 'complete' });
      expect(closed.status).toBe(409);
      expect(await closed.json()).toMatchObject({ code: 'transition_not_allowed' });
      expect((await move(manager, { transition: 'ship' })).status).toBe(400);
      expect(
        (await call('POST', `/${randomUUID()}/transitions`, manager, { transition: 'confirm' }))
          .status,
      ).toBe(404);
    });
  });
});
