import { assignBuyerRole, createBuyerRole } from '@muziris/access';
import { createProduct, createProductUnit } from '@muziris/catalog';
import { addAddress, createCustomer, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { placeOrder, PAYMENT_METHODS_SETTING, type TaxProvider } from '@muziris/orders';
import { createOrganization, createWebsite, setSetting } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import { rebuildVisibility } from '@muziris/visibility';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyGatewayEvent,
  checkPayment,
  createGatewayClients,
  findPaymentByGatewayRef,
  findPaymentForOrder,
  listPaymentTransactions,
  readRazorpayEvent,
  startPayment,
  type GatewayClients,
  webhookActivity,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];
const NOW = new Date('2026-11-20T06:00:00Z');
const NO_TAX: TaxProvider = {
  name: 'none',
  calculate: () => Promise.resolve({ lines: [], taxCodes: new Map() }),
};

/** A fake Razorpay: orders it made, and the status of each order's one payment. */
function fakeRazorpay() {
  const orders = new Map<string, { amount: number; currency: string; payment?: string }>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  let down = false;
  const fetcher = (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    if (down) return Promise.reject(new Error('connection refused'));
    const reply = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value)));
    if (path === '/v1/orders' && init.method === 'POST') {
      const { amount, currency } = body as { amount: number; currency: string };
      const id = `order_${String(orders.size + 1)}`;
      orders.set(id, { amount, currency });
      return reply({ id, amount, currency, status: 'created' });
    }
    const match = /^\/v1\/orders\/([^/]+)(\/payments)?$/.exec(path);
    const order = match?.[1] === undefined ? undefined : orders.get(match[1]);
    if (!match || !order) return Promise.resolve(new Response('{}', { status: 404 }));
    if (match[2]) return reply({ items: order.payment ? [{ status: order.payment }] : [] });
    return reply({ id: match[1], amount: order.amount, currency: order.currency });
  };
  return {
    orders,
    calls,
    setDown: (value: boolean) => {
      down = value;
    },
    clients: createGatewayClients(
      { razorpay: { keyId: 'rzp_test_key', keySecret: 'not-shown', webhookSecret: 'whsec' } },
      { fetch: fetcher, razorpayApi: 'https://razorpay.test' },
    ),
  };
}

describe.skipIf(!url)('payments against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'payments');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate payment_transaction, payment, orders_order_tax_line, orders_order_line,
        orders_order_address, orders_order, workflow_transition_log, workflow_instance,
        platform_config_value, pricing_combined_price, pricing_combined_price_list_target,
        pricing_assignment, pricing_price, pricing_price_list, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule, visibility_build_state,
        catalog_product_sold_in, catalog_product, catalog_category, catalog_product_unit,
        customer_address, customer_buyer_user, customer_customer, customer_group,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        identity_session, identity_user, platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  /** One Indian website with Razorpay on, one product at ₹480, and a buyer's order of two. */
  async function placedOrder() {
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
    ]);
    await Promise.all([rebuildVisibility(handle.db), rebuildCombinedPrices(handle.db)]);
    const customer = await createCustomer(handle.db, { name: 'Kochi Hardware' });
    const address = await addAddress(handle.db, {
      customerId: customer.id,
      label: 'Shop',
      countryCode: 'IN',
      line1: 'MG Road',
      city: 'Kochi',
      regionCode: '32',
      postalCode: '682016',
    });
    const role = await createBuyerRole(handle.db, {
      code: 'orderer',
      name: 'Orderer',
      grants: [
        { permission: 'order.place', accessLevel: 'own_records' },
        { permission: 'order.view', accessLevel: 'own_records' },
      ],
    });
    const buyer = async (email: string) => {
      const user = await createUser(handle.db, {
        realm: 'buyer',
        email,
        displayName: email,
        password: 'correct horse battery staple',
      });
      await linkBuyerUser(handle.db, customer.id, email);
      await assignBuyerRole(handle.db, user.id, role.id);
      return user.id;
    };
    const lena = await buyer('lena@kochihardware.in');
    const placed = await placeOrder(
      handle.db,
      {
        buyerUserId: lena,
        request: {
          websiteId: website.id,
          lines: [{ productId: bearing.id, unitCode: 'each', quantity: '2' }],
          billingAddressId: address.id,
          shippingAddressId: address.id,
          paymentMethod: 'razorpay',
          idempotencyKey: randomUUID(),
          expectedGrandTotal: '960.00',
        },
        now: NOW,
      },
      { tax: NO_TAX, paymentMethods: new Set(['razorpay']) },
    );
    if (!placed.ok) throw new Error(placed.refusal.code);
    const other = await buyer('arun@kochihardware.in');
    return { website, order: placed.order, lena, other };
  }

  const start = (
    clients: GatewayClients,
    w: Awaited<ReturnType<typeof placedOrder>>,
    who = w.lena,
  ) =>
    startPayment(handle.db, clients, {
      buyerUserId: who,
      websiteId: w.website.id,
      orderNumber: w.order.number,
      now: NOW,
    });

  const webhook = (event: string, ref: string, id: string, amount = 96000) =>
    readRazorpayEvent(
      JSON.stringify({
        event,
        payload: {
          payment: { entity: { order_id: ref, amount, currency: 'INR', amount_refunded: amount } },
        },
      }),
      id,
    );

  it('makes one gateway order per payment, for the order total, and only for its buyer', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    const first = await start(gateway.clients, w);
    if (!first.ok) throw new Error(first.refusal);
    expect(first.start).toEqual({
      gateway: 'razorpay',
      keyId: 'rzp_test_key',
      razorpayOrderId: 'order_1',
      amountMinor: 96000n,
      currency: 'INR',
    });
    expect(gateway.calls[0]?.body).toMatchObject({
      amount: 96000,
      currency: 'INR',
      receipt: w.order.number,
    });
    const again = await start(gateway.clients, w);
    expect(again.ok && again.start).toMatchObject({ razorpayOrderId: 'order_1' });
    expect(gateway.orders.size).toBe(1);
    expect(await start(gateway.clients, w, w.other)).toEqual({
      ok: false,
      refusal: 'order_not_found',
    });
    expect(await start({}, w)).toEqual({ ok: false, refusal: 'gateway_not_configured' });
  });

  it('says so when the gateway is down, and makes nothing', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    gateway.setDown(true);
    expect(await start(gateway.clients, w)).toEqual({ ok: false, refusal: 'gateway_unavailable' });
    expect(await findPaymentForOrder(handle.db, w.order.id)).toBeUndefined();
  });

  it('marks the payment paid from a webhook once, however often it is delivered', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    await start(gateway.clients, w);
    const event = webhook('payment.captured', 'order_1', 'evt_1');
    const applied = await applyGatewayEvent(handle.db, 'razorpay', event, NOW);
    expect(applied).toMatchObject({
      outcome: 'applied',
      changedTo: 'paid',
      payment: { status: 'paid' },
    });
    expect(await applyGatewayEvent(handle.db, 'razorpay', event, NOW)).toEqual({
      outcome: 'duplicate',
    });
    const payment = await findPaymentForOrder(handle.db, w.order.id);
    expect(payment).toMatchObject({ status: 'paid', paidAt: NOW });
    expect(await start(gateway.clients, w)).toEqual({ ok: false, refusal: 'already_paid' });
    // A failure reported after the payment was captured changes nothing.
    expect(
      await applyGatewayEvent(
        handle.db,
        'razorpay',
        webhook('payment.failed', 'order_1', 'evt_2'),
        NOW,
      ),
    ).toMatchObject({ outcome: 'ignored', changedTo: undefined });
    const log = await listPaymentTransactions(handle.db, payment?.id ?? '');
    expect(log.map((t) => [t.eventId, t.outcome, t.statusAfter])).toEqual([
      ['evt_1', 'applied', 'paid'],
      ['evt_2', 'ignored', 'paid'],
    ]);
  });

  it('runs the status hook once per change, in the change transaction', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    await start(gateway.clients, w);
    const changes: string[] = [];
    const hooks = {
      onStatusChanged: (_tx: unknown, change: { from: string; to: string }) => {
        changes.push(`${change.from}->${change.to}`);
        return Promise.resolve();
      },
    };
    const event = webhook('payment.captured', 'order_1', 'evt_1');
    await expect(
      applyGatewayEvent(handle.db, 'razorpay', event, NOW, {
        onStatusChanged: () => Promise.reject(new Error('the email could not be queued')),
      }),
    ).rejects.toThrow('the email could not be queued');
    // Rolled back with the hook: neither the status nor the log row stayed.
    expect(await findPaymentForOrder(handle.db, w.order.id)).toMatchObject({ status: 'pending' });
    await applyGatewayEvent(handle.db, 'razorpay', event, NOW, hooks);
    await applyGatewayEvent(handle.db, 'razorpay', event, NOW, hooks);
    await applyGatewayEvent(
      handle.db,
      'razorpay',
      webhook('payment.failed', 'order_1', 'evt_2'),
      NOW,
      hooks,
    );
    expect(changes).toEqual(['pending->paid']);
    expect(await findPaymentByGatewayRef(handle.db, 'razorpay', 'order_1')).toMatchObject({
      orderId: w.order.id,
      status: 'paid',
    });
    expect(await findPaymentByGatewayRef(handle.db, 'stripe', 'order_1')).toBeUndefined();
  });

  it('logs an event whose amount differs, or whose payment is unknown, and changes nothing', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    await start(gateway.clients, w);
    expect(
      await applyGatewayEvent(
        handle.db,
        'razorpay',
        webhook('payment.captured', 'order_1', 'e1', 100),
        NOW,
      ),
    ).toMatchObject({ outcome: 'amount_mismatch', changedTo: undefined });
    expect(
      await applyGatewayEvent(
        handle.db,
        'razorpay',
        webhook('payment.captured', 'order_9', 'e2'),
        NOW,
      ),
    ).toMatchObject({ outcome: 'unknown_payment' });
    expect(await findPaymentForOrder(handle.db, w.order.id)).toMatchObject({ status: 'pending' });
  });

  it('tracks a full refund after payment', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    await start(gateway.clients, w);
    await applyGatewayEvent(
      handle.db,
      'razorpay',
      webhook('payment.captured', 'order_1', 'e1'),
      NOW,
    );
    expect(
      await applyGatewayEvent(
        handle.db,
        'razorpay',
        webhook('refund.processed', 'order_1', 'e2', 40000),
        NOW,
      ),
    ).toMatchObject({ changedTo: 'partially_refunded', payment: { refundedMinor: 40000n } });
    expect(
      await applyGatewayEvent(
        handle.db,
        'razorpay',
        webhook('refund.processed', 'order_1', 'e3'),
        NOW,
      ),
    ).toMatchObject({ changedTo: 'refunded', payment: { refundedMinor: 96000n } });
  });

  it('reads a pending payment from the gateway once when the buyer comes back', async () => {
    const w = await placedOrder();
    const gateway = fakeRazorpay();
    await start(gateway.clients, w);
    const check = () =>
      checkPayment(handle.db, gateway.clients, {
        buyerUserId: w.lena,
        websiteId: w.website.id,
        orderNumber: w.order.number,
        now: NOW,
      });
    expect(await check()).toMatchObject({ ok: true, payment: { status: 'pending' } });
    const order = gateway.orders.get('order_1');
    if (order) order.payment = 'captured';
    expect(await check()).toMatchObject({
      ok: true,
      changedTo: 'paid',
      payment: { status: 'paid' },
    });
    const calls = gateway.calls.length;
    expect(await check()).toMatchObject({ ok: true, payment: { status: 'paid' } });
    expect(gateway.calls).toHaveLength(calls);
  });
  it('reports the latest webhook event of each gateway and the refused ones of the last 7 days', async () => {
    const event = (eventId: string, ref: string, kind: 'status' | 'none') => ({
      eventId,
      eventType: kind === 'none' ? 'payment.authorized' : 'payment.captured',
      ref,
      amountMinor: 100n,
      currency: 'INR',
      effect:
        kind === 'none'
          ? ({ kind: 'none' } as const)
          : ({ kind: 'status', status: 'paid' } as const),
    });
    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * day);
    expect(await webhookActivity(handle.db, at(7))).toEqual({
      stripe: { lastEvent: null, refusedSince: 0 },
      razorpay: { lastEvent: null, refusedSince: 0 },
    });

    // Unknown payments: one too old to count, two within the week.
    await applyGatewayEvent(handle.db, 'razorpay', event('r1', 'order_x', 'status'), at(8));
    await applyGatewayEvent(handle.db, 'razorpay', event('r2', 'order_y', 'status'), at(3));
    await applyGatewayEvent(handle.db, 'razorpay', event('r3', 'order_z', 'status'), at(1));
    // The latest event is an ignored one, which is not refused.
    await applyGatewayEvent(handle.db, 'razorpay', event('r4', 'order_z', 'none'), at(0));
    await applyGatewayEvent(handle.db, 'stripe', event('s1', 'pi_1', 'none'), at(2));

    expect(await webhookActivity(handle.db, at(7))).toEqual({
      stripe: {
        lastEvent: { receivedAt: at(2), type: 'payment.authorized', outcome: 'ignored' },
        refusedSince: 0,
      },
      razorpay: {
        lastEvent: { receivedAt: at(0), type: 'payment.authorized', outcome: 'ignored' },
        refusedSince: 2,
      },
    });
  });
});
