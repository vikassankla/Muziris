import { assignBuyerRole, createBuyerRole } from '@muziris/access';
import { createProduct, createProductUnit, updateProduct } from '@muziris/catalog';
import { addAddress, createCustomer, createCustomerGroup, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { decimalToString, toDecimalString } from '@muziris/money';
import { createOrganization, createWebsite, setSetting } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
  updatePrice,
  listPrices,
} from '@muziris/pricing';
import { createRule, rebuildVisibility } from '@muziris/visibility';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findOrderById,
  findOrderForBuyer,
  listOrders,
  listOrdersForBuyer,
  orderHistory,
  PAYMENT_TERM_DAYS,
  placeOrder,
  previewCheckout,
  SHIPPING_FLAT_RATE,
  transitionOrder,
  type CheckoutDependencies,
  type PlaceOrderRequest,
} from './index.js';
import { gstTestProvider } from './test/gst-test-provider.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-11-20T06:00:00Z');
const deps: CheckoutDependencies = { tax: gstTestProvider({ sellerState: '27', rate: '0.18' }) };

describe.skipIf(!url)('orders against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'orders');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate orders_order_tax_line, orders_order_line, orders_order_address, orders_order,
        workflow_transition_log, workflow_instance, platform_config_value,
        pricing_combined_price, pricing_combined_price_list_target, pricing_assignment,
        pricing_price, pricing_price_list, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule,
        visibility_build_state, catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit, customer_address, customer_buyer_user, customer_customer,
        customer_group, access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        identity_session, identity_user, platform_website, platform_organization cascade`,
    );
    await handle.db.execute(sql`alter sequence orders_order_number_seq restart with 1`);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function buyer(customerId: string, email: string, roleId?: string): Promise<string> {
    const user = await createUser(handle.db, {
      realm: 'buyer',
      email,
      displayName: email,
      password: PASSWORD,
    });
    await linkBuyerUser(handle.db, customerId, email);
    if (roleId !== undefined) await assignBuyerRole(handle.db, user.id, roleId);
    return user.id;
  }

  /**
   * An Indian website selling from Maharashtra. A bearing (each), gloves (each or kg) and a
   * hidden cable. List prices for everyone, a contract bearing price for the distributor, and
   * ₹250 flat shipping. A distributor with two buyers (an orderer and a viewer of their own
   * orders) and a Pune and a Kochi address; a retailer with one buyer and one address.
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
    const bearing = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'each',
    });
    const glove = await createProduct(handle.db, {
      sku: 'GLV-NITRILE-L',
      name: 'Nitrile gloves, large',
      status: 'enabled',
      attributes: {},
      primaryUnitCode: 'each',
      additionalUnitCodes: ['kg'],
    });
    const cable = await createProduct(handle.db, {
      sku: 'CBL-2.5',
      name: 'Copper cable 2.5 mm²',
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
    const list = await createPriceList(handle.db, { name: 'List price', currency: 'INR' });
    await addPrice(handle.db, list.id, {
      productId: bearing.id,
      unitCode: 'each',
      amount: '480.00',
    });
    await addPrice(handle.db, list.id, { productId: glove.id, unitCode: 'each', amount: '95.50' });
    await addPrice(handle.db, list.id, {
      productId: glove.id,
      unitCode: 'each',
      minQuantity: '100',
      amount: '89.00',
    });
    await addPrice(handle.db, list.id, { productId: cable.id, unitCode: 'each', amount: '60.00' });
    await createAssignment(handle.db, {
      priceListId: list.id,
      websiteId: website.id,
      target: 'website',
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
    const contract = await createPriceList(handle.db, { name: 'Contract', currency: 'INR' });
    await addPrice(handle.db, contract.id, {
      productId: bearing.id,
      unitCode: 'each',
      amount: '410.00',
    });
    await createAssignment(handle.db, {
      priceListId: contract.id,
      websiteId: website.id,
      target: 'customer',
      targetId: distributor.id,
    });
    await setSetting(
      handle.db,
      SHIPPING_FLAT_RATE,
      { type: 'website', id: website.id },
      {
        amount: '250.00',
      },
    );
    await Promise.all([rebuildVisibility(handle.db), rebuildCombinedPrices(handle.db)]);

    const orderer = await createBuyerRole(handle.db, {
      code: 'orderer',
      name: 'Orderer',
      grants: [
        { permission: 'order.place', accessLevel: 'my_customer' },
        { permission: 'order.view', accessLevel: 'my_customer' },
      ],
    });
    const ownViewer = await createBuyerRole(handle.db, {
      code: 'own_viewer',
      name: 'Sees own orders',
      grants: [
        { permission: 'order.place', accessLevel: 'own_records' },
        { permission: 'order.view', accessLevel: 'own_records' },
      ],
    });
    const pune = await addAddress(handle.db, {
      customerId: distributor.id,
      label: 'Pune warehouse',
      countryCode: 'IN',
      line1: 'Plot 12, Bhosari MIDC',
      city: 'Pune',
      regionCode: '27',
      postalCode: '411026',
      gstin: '27AAPFU0939F1ZV',
    });
    const kochi = await addAddress(handle.db, {
      customerId: distributor.id,
      label: 'Kochi branch',
      countryCode: 'IN',
      line1: 'Willingdon Island',
      city: 'Kochi',
      regionCode: '32',
      postalCode: '682003',
    });
    const retailAddress = await addAddress(handle.db, {
      customerId: retailer.id,
      label: 'Shop',
      countryCode: 'IN',
      line1: 'MG Road',
      city: 'Kochi',
      regionCode: '32',
      postalCode: '682016',
    });
    return {
      website,
      bearing,
      glove,
      cable,
      list,
      distributor,
      retailer,
      pune,
      kochi,
      retailAddress,
      ravi: await buyer(distributor.id, 'ravi@punebearing.in', orderer.id),
      asha: await buyer(distributor.id, 'asha@punebearing.in', ownViewer.id),
      noRole: await buyer(distributor.id, 'intern@punebearing.in'),
      lena: await buyer(retailer.id, 'lena@kochihardware.in', orderer.id),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  function request(w: World, overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
    return {
      websiteId: w.website.id,
      lines: [
        { productId: w.bearing.id, unitCode: 'each', quantity: '10' },
        { productId: w.glove.id, unitCode: 'each', quantity: '100' },
      ],
      billingAddressId: w.pune.id,
      shippingAddressId: w.pune.id,
      purchaseOrderNumber: 'PO-7781',
      idempotencyKey: randomUUID(),
      // 4100.00 + 8900.00 + 250.00 shipping, plus 18% GST on all of it (2385.00).
      expectedGrandTotal: '15635.00',
      ...overrides,
    };
  }

  describe('preview', () => {
    it('prices with the buyer’s prices, flat shipping and GST, without saving', async () => {
      const w = await world();
      const result = await previewCheckout(
        handle.db,
        { buyerUserId: w.ravi, request: request(w), now: NOW },
        deps,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.refusal));
      const t = result.preview.totals;
      expect(t.lines.map((l) => toDecimalString(l.unitPrice))).toEqual(['410.00', '89.00']);
      expect(toDecimalString(t.subtotal)).toBe('13000.00');
      expect(toDecimalString(t.shipping)).toBe('250.00');
      expect(toDecimalString(t.tax)).toBe('2385.00');
      expect(toDecimalString(t.grandTotal)).toBe('15635.00');
      expect(new Set(t.taxes.map((x) => x.name))).toEqual(new Set(['CGST', 'SGST']));
      expect(result.preview.paymentTermDays).toBe(30);
      expect(result.preview.dueOn).toBe('2026-12-20');
      expect((await listOrders(handle.db, {})).orders).toHaveLength(0);
    });

    it('charges IGST when shipping to another state', async () => {
      const w = await world();
      const result = await previewCheckout(
        handle.db,
        { buyerUserId: w.ravi, request: request(w, { shippingAddressId: w.kochi.id }), now: NOW },
        deps,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.refusal));
      expect(new Set(result.preview.totals.taxes.map((x) => x.name))).toEqual(new Set(['IGST']));
    });

    it('takes the payment term from the customer, then its group', async () => {
      const w = await world();
      await setSetting(
        handle.db,
        PAYMENT_TERM_DAYS,
        { type: 'customer_group', id: w.distributor.groupId! },
        45,
      );
      const preview = async () => {
        const r = await previewCheckout(
          handle.db,
          { buyerUserId: w.ravi, request: request(w), now: NOW },
          deps,
        );
        if (!r.ok) throw new Error(r.refusal.code);
        return r.preview;
      };
      expect((await preview()).paymentTermDays).toBe(45);
      await setSetting(
        handle.db,
        PAYMENT_TERM_DAYS,
        { type: 'customer', id: w.distributor.id },
        15,
      );
      expect(await preview()).toMatchObject({ paymentTermDays: 15, dueOn: '2026-12-05' });
    });
  });

  describe('refusals', () => {
    it('refuses a buyer without order.place, and an identity that is no buyer', async () => {
      const w = await world();
      for (const buyerUserId of [w.noRole, randomUUID()]) {
        const r = await placeOrder(handle.db, { buyerUserId, request: request(w), now: NOW }, deps);
        expect(r).toEqual({ ok: false, refusal: { code: 'not_allowed' } });
      }
    });

    it('refuses another customer’s address', async () => {
      const w = await world();
      const r = await placeOrder(
        handle.db,
        {
          buyerUserId: w.ravi,
          request: request(w, { shippingAddressId: w.retailAddress.id }),
          now: NOW,
        },
        deps,
      );
      expect(r).toEqual({ ok: false, refusal: { code: 'address_not_found', role: 'shipping' } });
    });

    it('names each line it cannot order and why', async () => {
      const w = await world();
      const r = await placeOrder(
        handle.db,
        {
          buyerUserId: w.ravi,
          request: request(w, {
            lines: [
              { productId: w.cable.id, unitCode: 'each', quantity: '1' },
              { productId: w.bearing.id, unitCode: 'kg', quantity: '1' },
              { productId: w.glove.id, unitCode: 'each', quantity: '1.5' },
              { productId: w.glove.id, unitCode: 'kg', quantity: '2.5' },
              { productId: randomUUID(), unitCode: 'each', quantity: '1' },
              { productId: w.bearing.id, unitCode: 'each', quantity: '2' },
            ],
          }),
          now: NOW,
        },
        deps,
      );
      if (r.ok || r.refusal.code !== 'line_problems') throw new Error('expected line problems');
      expect(r.refusal.lines.map((l) => [l.lineNo, l.code])).toEqual([
        [1, 'product_not_available'],
        [2, 'unit_not_sold'],
        [3, 'invalid_quantity'],
        [4, 'no_price'],
        [5, 'product_not_available'],
      ]);
    });

    it('refuses a disabled product even before the next visibility build', async () => {
      const w = await world();
      await updateProduct(handle.db, w.glove.id, { status: 'disabled' });
      const r = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: request(w), now: NOW },
        deps,
      );
      if (r.ok || r.refusal.code !== 'line_problems') throw new Error('expected line problems');
      expect(r.refusal.lines.map((l) => [l.lineNo, l.code])).toEqual([
        [2, 'product_not_available'],
      ]);
    });

    it('refuses when the total is not the one the buyer saw, and shows the new totals', async () => {
      const w = await world();
      const [tier] = (await listPrices(handle.db, w.list.id, {})).prices.filter(
        (p) => p.productId === w.glove.id && p.minQuantity === '100',
      );
      await updatePrice(handle.db, tier!.id, { amount: '91.00' });
      await rebuildCombinedPrices(handle.db);
      const r = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: request(w), now: NOW },
        deps,
      );
      if (r.ok || r.refusal.code !== 'prices_changed') throw new Error('expected prices_changed');
      expect(toDecimalString(r.refusal.expected)).toBe('15635.00');
      expect(toDecimalString(r.refusal.totals.grandTotal)).toBe('15871.00');
      expect((await listOrders(handle.db, {})).orders).toHaveLength(0);
    });
  });

  describe('placing', () => {
    it('stores an order with its own copies and starts the workflow', async () => {
      const w = await world();
      const r = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: request(w), now: NOW },
        deps,
      );
      if (!r.ok) throw new Error(JSON.stringify(r.refusal));
      const { order } = r;
      expect(r.replayed).toBe(false);
      expect(order).toMatchObject({
        number: 'MZ-000001',
        step: 'new',
        customerName: 'Pune Bearing House',
        purchaseOrderNumber: 'PO-7781',
        paymentMethod: 'terms',
        paymentTermDays: 30,
        dueOn: '2026-12-20',
        shippingMethod: 'flat_rate',
        taxProvider: 'gst_test',
      });
      expect(toDecimalString(order.grandTotal)).toBe('15635.00');
      expect(
        order.lines.map((l) => [
          l.sku,
          decimalToString(l.quantity),
          toDecimalString(l.net),
          l.taxCode,
        ]),
      ).toEqual([
        ['BRG-6205-2RS', '10', '4100.00', '8482'],
        ['GLV-NITRILE-L', '100', '8900.00', '8482'],
      ]);
      expect(
        order.taxes.filter((t) => t.lineNo === null).map((t) => toDecimalString(t.amount)),
      ).toEqual(['22.50', '22.50']);
      expect(order.billingAddress).toMatchObject({ city: 'Pune', gstin: '27AAPFU0939F1ZV' });
      expect((await orderHistory(handle.db, order.id)).map((e) => e.toStep)).toEqual(['new']);

      // Later catalog and price changes never alter the order.
      await updateProduct(handle.db, w.bearing.id, { name: 'Renamed bearing' });
      const again = await findOrderById(handle.db, order.id);
      expect(again?.lines[0]?.productName).toBe('Ball bearing 6205-2RS');
    });

    it('numbers orders in sequence', async () => {
      const w = await world();
      const numbers: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await placeOrder(
          handle.db,
          { buyerUserId: w.ravi, request: request(w), now: NOW },
          deps,
        );
        if (!r.ok) throw new Error(r.refusal.code);
        numbers.push(r.order.number);
      }
      expect(numbers).toEqual(['MZ-000001', 'MZ-000002', 'MZ-000003']);
    });

    it('returns the same order for a repeated key, even when two attempts race', async () => {
      const w = await world();
      const req = request(w);
      const [a, b] = await Promise.all([
        placeOrder(handle.db, { buyerUserId: w.ravi, request: req, now: NOW }, deps),
        placeOrder(handle.db, { buyerUserId: w.ravi, request: req, now: NOW }, deps),
      ]);
      const c = await placeOrder(handle.db, { buyerUserId: w.ravi, request: req, now: NOW }, deps);
      if (!a.ok || !b.ok || !c.ok) throw new Error('expected orders');
      expect(new Set([a.order.id, b.order.id, c.order.id]).size).toBe(1);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(c.replayed).toBe(true);
      expect((await listOrders(handle.db, {})).orders).toHaveLength(1);
    });

    it('refuses a key reused for a different order', async () => {
      const w = await world();
      const req = request(w);
      const first = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: req, now: NOW },
        deps,
      );
      expect(first.ok).toBe(true);
      const second = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: { ...req, purchaseOrderNumber: 'PO-OTHER' }, now: NOW },
        deps,
      );
      expect(second).toEqual({ ok: false, refusal: { code: 'idempotency_key_reused' } });
    });
  });

  describe('who sees an order', () => {
    it('scopes buyer reads by order.view and its access level', async () => {
      const w = await world();
      const place = async (buyerUserId: string, overrides: Partial<PlaceOrderRequest> = {}) => {
        const r = await placeOrder(
          handle.db,
          { buyerUserId, request: request(w, overrides), now: NOW },
          deps,
        );
        if (!r.ok) throw new Error(r.refusal.code);
        return r.order;
      };
      const byRavi = await place(w.ravi);
      const byAsha = await place(w.asha);
      const byLena = await place(w.lena, {
        lines: [{ productId: w.glove.id, unitCode: 'each', quantity: '2' }],
        billingAddressId: w.retailAddress.id,
        shippingAddressId: w.retailAddress.id,
        // 191.00 + 250.00 shipping + 18% IGST (79.38).
        expectedGrandTotal: '520.38',
      });
      const numbersFor = async (buyerUserId: string) =>
        (await listOrdersForBuyer(handle.db, buyerUserId, { websiteId: w.website.id })).orders.map(
          (o) => o.number,
        );

      // Ravi sees his customer's orders, newest first by placing time then id; Asha only her own.
      expect(new Set(await numbersFor(w.ravi))).toEqual(new Set([byRavi.number, byAsha.number]));
      expect(await numbersFor(w.asha)).toEqual([byAsha.number]);
      expect(await numbersFor(w.lena)).toEqual([byLena.number]);
      expect(await numbersFor(w.noRole)).toEqual([]);

      const find = (buyerUserId: string, number: string) =>
        findOrderForBuyer(handle.db, buyerUserId, { websiteId: w.website.id, number });
      expect((await find(w.ravi, byAsha.number))?.id).toBe(byAsha.id);
      expect(await find(w.asha, byRavi.number)).toBeUndefined();
      expect(await find(w.lena, byRavi.number)).toBeUndefined();
    });

    it('pages admin lists newest first', async () => {
      const w = await world();
      for (let i = 0; i < 3; i += 1) {
        const r = await placeOrder(
          handle.db,
          { buyerUserId: w.ravi, request: request(w), now: new Date(NOW.getTime() + i * 60_000) },
          deps,
        );
        expect(r.ok).toBe(true);
      }
      const first = await listOrders(handle.db, { limit: 2 });
      expect(first.orders.map((o) => o.number)).toEqual(['MZ-000003', 'MZ-000002']);
      const second = await listOrders(handle.db, { limit: 2, after: first.nextAfter! });
      expect(second).toMatchObject({ nextAfter: null });
      expect(second.orders.map((o) => o.number)).toEqual(['MZ-000001']);
      expect((await listOrders(handle.db, { customerId: w.retailer.id })).orders).toEqual([]);
    });
  });

  describe('the order workflow', () => {
    it('moves an order from new to completed, keeping its step and history', async () => {
      const w = await world();
      const placed = await placeOrder(
        handle.db,
        { buyerUserId: w.ravi, request: request(w), now: NOW },
        deps,
      );
      if (!placed.ok) throw new Error(placed.refusal.code);
      const admin = { type: 'admin_user' as const, id: randomUUID() };
      const move = (
        transition: 'confirm' | 'decline' | 'start_processing' | 'complete',
        expectedVersion?: number,
      ) =>
        transitionOrder(handle.db, {
          orderId: placed.order.id,
          transition,
          actor: admin,
          now: NOW,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });

      expect(await move('complete')).toMatchObject({
        ok: false,
        refusal: { code: 'not_allowed_from_step' },
      });
      expect(await move('confirm', 5)).toMatchObject({
        ok: false,
        refusal: { code: 'stale_version' },
      });
      expect(await move('confirm', 1)).toMatchObject({ ok: true, order: { step: 'confirmed' } });
      expect(await move('decline')).toMatchObject({
        ok: false,
        refusal: { code: 'not_allowed_from_step' },
      });
      expect(await move('start_processing')).toMatchObject({
        ok: true,
        order: { step: 'processing' },
      });
      expect(await move('complete')).toMatchObject({ ok: true, order: { step: 'completed' } });
      expect((await orderHistory(handle.db, placed.order.id)).map((e) => e.toStep)).toEqual([
        'new',
        'confirmed',
        'processing',
        'completed',
      ]);
      expect((await listOrders(handle.db, { step: 'completed' })).orders).toHaveLength(1);
    });
  });
});
