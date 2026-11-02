import { Writable } from 'node:stream';
import { createHmac, randomUUID } from 'node:crypto';
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
import { PAYMENT_METHODS_SETTING, type TaxProvider } from '@muziris/orders';
import { createGatewayClients, type PaymentGateways } from '@muziris/payments';
import { createOrganization, createWebsite, setSetting } from '@muziris/platform';
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

const WEBHOOK_SECRET = 'razorpay-webhook-test-secret';
const GATEWAYS: PaymentGateways = {
  razorpay: { keyId: 'rzp_test_key', keySecret: 'key-secret', webhookSecret: WEBHOOK_SECRET },
};

/** A fake Razorpay behind fetch: it makes orders and reports none of them paid. */
function fakeRazorpay() {
  let made = 0;
  const fetcher = (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === '/v1/orders' && init.method === 'POST') {
      made += 1;
      const { amount, currency } = JSON.parse(init.body as string) as {
        amount: number;
        currency: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: `order_${String(made)}`, amount, currency, status: 'created' }),
        ),
      );
    }
    if (path.endsWith('/payments')) return Promise.resolve(new Response('{"items":[]}'));
    return Promise.resolve(
      new Response(JSON.stringify({ id: path.split('/')[3], amount: 566400, currency: 'INR' })),
    );
  };
  return {
    made: () => made,
    clients: createGatewayClients(GATEWAYS, {
      fetch: fetcher,
      razorpayApi: 'https://razorpay.test',
    }),
  };
}

const razorpay = fakeRazorpay();

const PREVIEW = `query Preview($input: CheckoutInput!) {
  checkoutPreview(input: $input) { preview { paymentMethods totals { grandTotal { amount } } } refusal { code } }
}`;

const PLACE = `mutation Place($input: PlaceOrderInput!) {
  placeOrder(input: $input) {
    order { number paymentMethod paymentTermDays dueOn payment { status amount { amount } } }
    refusal { code message }
  }
}`;

const START = `mutation Start($n: String!) {
  startPayment(orderNumber: $n) {
    stripe { publishableKey }
    razorpay { keyId orderId amount { amount currency } }
    refusal { code message }
  }
}`;

const CHECK = `mutation Check($n: String!) {
  checkPayment(orderNumber: $n) { payment { status } refusal { code } }
}`;

describe.skipIf(!url)(
  'paying online through the storefront, webhooks and admin APIs against PostgreSQL',
  () => {
    let handle: DatabaseHandle;

    beforeAll(async () => {
      const testUrl = await prepareTestDatabase(url!, 'api_payments');
      await runMigrations(testUrl);
      handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
    });

    beforeEach(async () => {
      await handle.db.execute(
        sql`truncate payment_transaction, payment, orders_order_tax_line, orders_order_line, orders_order_address, orders_order,
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

    function app(tax?: TaxProvider, gateways: PaymentGateways | null = GATEWAYS) {
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
        ...(gateways ? { payments: { gateways, clients: razorpay.clients } } : {}),
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
      await setSetting(handle.db, PAYMENT_METHODS_SETTING, { type: 'website', id: website.id }, [
        'razorpay',
        'terms',
      ]);
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

    async function placeOnline(w: World) {
      const { body } = await graphql(w.pune.cookie, PLACE, {
        input: {
          ...checkoutInput(w),
          idempotencyKey: randomUUID(),
          expectedGrandTotal: '5664.00',
          paymentMethod: 'RAZORPAY',
        },
      });
      return at(body.data, 'placeOrder', 'order', 'number') as string;
    }

    function webhook(body: string, signature: string, eventId = 'evt_1', gateways = GATEWAYS) {
      return app(igst18, gateways).request('/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': signature,
          'X-Razorpay-Event-Id': eventId,
        },
        body,
      });
    }

    const sign = (body: string) => createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    const captured = (orderId: string, amount = 566400) =>
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: orderId, amount, currency: 'INR' } } },
      });

    it('offers Razorpay, places an order to pay online and starts paying it', async () => {
      const w = await world();
      const preview = await graphql(w.pune.cookie, PREVIEW, { input: checkoutInput(w) });
      expect(at(preview.body.data, 'checkoutPreview', 'preview', 'paymentMethods')).toEqual([
        'RAZORPAY',
        'TERMS',
      ]);
      const { body } = await graphql(w.pune.cookie, PLACE, {
        input: {
          ...checkoutInput(w),
          idempotencyKey: randomUUID(),
          expectedGrandTotal: '5664.00',
          paymentMethod: 'RAZORPAY',
        },
      });
      expect(at(body.data, 'placeOrder', 'order')).toMatchObject({
        paymentMethod: 'RAZORPAY',
        paymentTermDays: 0,
        dueOn: null,
        payment: { status: 'PENDING', amount: { amount: '5664.00' } },
      });
      const number = at(body.data, 'placeOrder', 'order', 'number') as string;
      const start = await graphql(w.pune.cookie, START, { n: number });
      expect(at(start.body.data, 'startPayment')).toEqual({
        stripe: null,
        razorpay: {
          keyId: 'rzp_test_key',
          orderId: expect.stringMatching(/^order_/) as string,
          amount: { amount: '5664.00', currency: 'INR' },
        },
        refusal: null,
      });
      // Another customer's buyer cannot start or read it.
      const theirs = await graphql(w.other.cookie, START, { n: number });
      expect(at(theirs.body.data, 'startPayment', 'refusal', 'code')).toBe('ORDER_NOT_FOUND');
      const check = await graphql(w.pune.cookie, CHECK, { n: number });
      expect(at(check.body.data, 'checkPayment', 'payment', 'status')).toBe('PENDING');
    });

    it('offers terms only, and refuses an online method, when no gateway is configured', async () => {
      const w = await world();
      const res = await app(igst18, null).request('/storefront/v1/graphql', {
        method: 'POST',
        headers: {
          Cookie: w.pune.cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'Muziris-Website': 'muziris-in',
        },
        body: JSON.stringify({ query: PREVIEW, variables: { input: checkoutInput(w) } }),
      });
      const body = (await res.json()) as GraphqlResponse;
      expect(at(body.data, 'checkoutPreview', 'preview', 'paymentMethods')).toEqual(['TERMS']);
      expect((await webhook('{}', sign('{}'), 'e', {})).status).toBe(404);
    });

    it('marks the payment paid only from a signed webhook, then lets an admin confirm', async () => {
      const w = await world();
      const number = await placeOnline(w);
      const start = await graphql(w.pune.cookie, START, { n: number });
      const orderId = at(start.body.data, 'startPayment', 'razorpay', 'orderId') as string;
      const admin = await signedInAdmin('ops@muziris.example', ['order.view', 'order.manage']);
      const adminApp = app(igst18);
      const list = await adminApp.request('/admin/v1/orders', { headers: { Cookie: admin } });
      const id = (at(await list.json(), 'orders') as { id: string }[])[0]?.id ?? '';
      const confirm = () =>
        adminApp.request(`/admin/v1/orders/${id}/transitions`, {
          method: 'POST',
          headers: { Cookie: admin, Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transition: 'confirm' }),
        });

      const early = await confirm();
      expect(early.status).toBe(409);
      expect(await early.json()).toMatchObject({ code: 'payment_not_received' });

      const body = captured(orderId);
      expect((await webhook(body, '0'.repeat(64))).status).toBe(400);
      expect((await webhook(body, sign(`${body} `))).status).toBe(400);
      const changed = captured(orderId, 100);
      expect((await webhook(changed, sign(changed), 'evt_small')).status).toBe(200);
      expect((await webhook(body, sign(body))).status).toBe(200);
      expect((await webhook(body, sign(body))).status).toBe(200);

      const check = await graphql(w.pune.cookie, CHECK, { n: number });
      expect(at(check.body.data, 'checkPayment', 'payment', 'status')).toBe('PAID');
      const view = (await (
        await adminApp.request(`/admin/v1/orders/${id}`, { headers: { Cookie: admin } })
      ).json()) as {
        payment: { status: string; transactions: { eventId: string; outcome: string }[] };
      };
      expect(view.payment.status).toBe('paid');
      expect(view.payment.transactions.map((t) => [t.eventId, t.outcome])).toEqual([
        ['evt_small', 'amount_mismatch'],
        ['evt_1', 'applied'],
      ]);
      expect((await confirm()).status).toBe(200);
      const again = await graphql(w.pune.cookie, START, { n: number });
      expect(at(again.body.data, 'startPayment', 'refusal', 'code')).toBe('ALREADY_PAID');
    });
  },
);
