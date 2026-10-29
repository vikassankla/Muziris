import { createProduct, createProductUnit } from '@muziris/catalog';
import {
  createCustomer,
  createCustomerGroup,
  linkBuyerUser,
  setCustomerGroup,
} from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { decimalToString, parseDecimal, toDecimalString } from '@muziris/money';
import { createOrganization, createWebsite } from '@muziris/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addPrice,
  createAssignment,
  createPriceList,
  deleteAssignment,
  deletePrice,
  deletePriceList,
  findPrice,
  findPriceForBuyer,
  getBuildState,
  listAssignments,
  listPriceLists,
  listPrices,
  previewPrice,
  PricingError,
  rebuildCombinedPrices,
  updateAssignment,
  updatePrice,
  updatePriceList,
  type PricingErrorCode,
} from './index.js';
import {
  chainOrder,
  CURRENCY_CASES,
  DATE_CASES,
  FALLBACK_CASES,
  ROUNDING_CASES,
  TIER_CASES,
  UNIT_PRECISION,
  type PriceCase,
} from './test/known-answers.js';

const url = process.env['TEST_DATABASE_URL'];

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-11-04T09:00:00.000Z');

async function expectRefused(promise: Promise<unknown>, code: PricingErrorCode) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PricingError);
  expect((error as PricingError).code).toBe(code);
}

describe.skipIf(!url)('pricing module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'pricing');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate pricing_combined_price, pricing_combined_price_list_target,
        pricing_combined_price_list, pricing_assignment, pricing_price, pricing_price_list,
        pricing_build_state, catalog_product_sold_in, catalog_product, catalog_product_unit,
        customer_buyer_user, customer_customer, customer_group, identity_session, identity_user,
        platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  let siteCount = 0;

  /** A website in a currency, the `each` and `kg` product units, a product, a group and a customer in it. */
  async function world(currency: 'INR' | 'USD' | 'JPY' = 'INR') {
    const db = handle.db;
    siteCount += 1;
    const org = await createOrganization(db, 'Muziris Industrial');
    const website = await createWebsite(db, {
      organizationId: org.id,
      code: `site-${siteCount}`,
      name: `Site ${siteCount}`,
      countryCode: currency === 'USD' ? 'US' : currency === 'JPY' ? 'JP' : 'IN',
      defaultCurrency: currency,
      defaultLocale: currency === 'USD' ? 'en-US' : currency === 'JPY' ? 'ja-JP' : 'en-IN',
      timeZone:
        currency === 'USD' ? 'America/Chicago' : currency === 'JPY' ? 'Asia/Tokyo' : 'Asia/Kolkata',
    });
    await createProductUnit(db, { code: 'each', name: 'Each', precision: UNIT_PRECISION.each });
    await createProductUnit(db, { code: 'kg', name: 'Kilogram', precision: UNIT_PRECISION.kg });
    const product = await createProduct(db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      primaryUnitCode: 'each',
      additionalUnitCodes: ['kg'],
    });
    const group = await createCustomerGroup(db, { code: 'distributors', name: 'Distributors' });
    const customer = await createCustomer(db, { name: 'Gulf Coast Industrial', groupId: group.id });
    const targetOf = (target: 'customer' | 'customer_group' | 'website') =>
      target === 'customer' ? customer.id : target === 'customer_group' ? group.id : website.id;
    return { website, product, group, customer, targetOf };
  }

  /** Sets a known-answer case up through the module's own functions, then builds. */
  async function setUp(c: PriceCase) {
    const w = await world(c.currency);
    const names = new Map<string, string>();
    for (const spec of chainOrder(c.lists)) {
      const list = await createPriceList(handle.db, {
        name: spec.name,
        currency: c.currency,
        activeFrom: spec.activeFrom ?? null,
        activeUntil: spec.activeUntil ?? null,
      });
      names.set(list.id, spec.name);
      for (const [unitCode, minQuantity, amount] of spec.tiers) {
        await addPrice(handle.db, list.id, {
          productId: w.product.id,
          unitCode,
          minQuantity,
          amount,
        });
      }
      await createAssignment(handle.db, {
        priceListId: list.id,
        websiteId: w.website.id,
        target: spec.target,
        targetId: w.targetOf(spec.target),
        priority: spec.priority,
      });
    }
    await rebuildCombinedPrices(handle.db);
    return { ...w, names };
  }

  describe('known answers through the build and the combined price list', () => {
    const run = async (c: PriceCase) => {
      const w = await setUp(c);
      const preview = await previewPrice(
        handle.db,
        {
          customerId: w.customer.id,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: c.unit,
          quantity: c.quantity,
        },
        new Date(c.now),
      );
      // The set-based build and the plain-code rule must agree on every case.
      expect(preview.price?.unitPrice ?? null).toEqual(preview.unbuiltPrice?.unitPrice ?? null);
      expect(preview.price?.priceListId ?? null).toEqual(preview.unbuiltPrice?.priceListId ?? null);
      expect(preview.pendingChanges).toBe(0);
      if (preview.price === null || preview.lineAmount === null) {
        expect(preview.reason).toBe('no_price');
        return null;
      }
      return {
        amount: toDecimalString(preview.price.unitPrice),
        from: w.names.get(preview.price.priceListId),
        minQuantity: preview.price.minQuantity,
        line: toDecimalString(preview.lineAmount),
      };
    };
    it.each(FALLBACK_CASES.map((c) => [c.title, c] as const))('fallback: %s', async (_, c) => {
      expect(await run(c)).toEqual(c.expected);
    });
    it.each(TIER_CASES.map((c) => [c.title, c] as const))('tiers: %s', async (_, c) => {
      expect(await run(c)).toEqual(c.expected);
    });
    it.each(CURRENCY_CASES.map((c) => [c.title, c] as const))('currency: %s', async (_, c) => {
      expect(await run(c)).toEqual(c.expected);
    });
    it.each(DATE_CASES.map((c) => [c.title, c] as const))('active dates: %s', async (_, c) => {
      expect(await run(c)).toEqual(c.expected);
    });
    it.each(ROUNDING_CASES.map((c) => [c.title, c] as const))('rounding: %s', async (_, c) => {
      expect(await run(c)).toEqual(c.expected);
    });
  });

  /** One customer-level contract over a website list price, built. */
  async function contractWorld() {
    const w = await world('INR');
    const listPrice = await createPriceList(handle.db, { name: 'List price', currency: 'INR' });
    await addPrice(handle.db, listPrice.id, {
      productId: w.product.id,
      unitCode: 'each',
      amount: '80.00',
    });
    await createAssignment(handle.db, {
      priceListId: listPrice.id,
      websiteId: w.website.id,
      target: 'website',
    });
    const contract = await createPriceList(handle.db, { name: 'Contract', currency: 'INR' });
    await addPrice(handle.db, contract.id, {
      productId: w.product.id,
      unitCode: 'each',
      amount: '70.00',
    });
    await createAssignment(handle.db, {
      priceListId: contract.id,
      websiteId: w.website.id,
      target: 'customer',
      targetId: w.customer.id,
    });
    await rebuildCombinedPrices(handle.db);
    const priceOf = (customerId: string) =>
      findPrice(handle.db, {
        customerId,
        websiteId: w.website.id,
        productId: w.product.id,
        unitCode: 'each',
        quantity: parseDecimal('1'),
        currency: 'INR',
        now: NOW,
      });
    return { ...w, listPrice, contract, priceOf };
  }

  const amountOf = (lookup: Awaited<ReturnType<typeof findPrice>>) =>
    lookup.found ? toDecimalString(lookup.unitPrice) : lookup.reason;

  describe('the build', () => {
    it('serves edits only after a build, and counts the changes waiting', async () => {
      const w = await contractWorld();
      expect((await getBuildState(handle.db)).pendingChanges).toBe(0);

      const [tier] = (await listPrices(handle.db, w.contract.id)).prices;
      await updatePrice(handle.db, tier!.id, { amount: '65.00' });
      expect(await getBuildState(handle.db)).toMatchObject({ pendingChanges: 1 });
      expect(amountOf(await w.priceOf(w.customer.id))).toBe('70.00');

      const result = await rebuildCombinedPrices(handle.db);
      expect(result).toMatchObject({ combinedPriceListCount: 2, combinedPriceCount: 2 });
      expect(amountOf(await w.priceOf(w.customer.id))).toBe('65.00');
      const state = await getBuildState(handle.db);
      expect(state.pendingChanges).toBe(0);
      expect(state.lastBuild).toMatchObject({ combinedPriceListCount: 2, combinedPriceCount: 2 });
    });

    it('shares one combined price list between customers with the same chain', async () => {
      const w = await contractWorld();
      const other = await createCustomer(handle.db, { name: 'Other', groupId: w.group.id });
      const third = await createCustomer(handle.db, { name: 'Third' });
      await rebuildCombinedPrices(handle.db);
      expect(amountOf(await w.priceOf(other.id))).toBe('80.00');
      expect(amountOf(await w.priceOf(third.id))).toBe('80.00');
      const [count] = await handle.db.execute(
        sql`select count(*)::int as n from pricing_combined_price_list`,
      );
      // The website chain and the contract chain; the group has no price lists of its own.
      expect(count).toEqual({ n: 2 });
    });

    it('keeps serving the previous build after a price list is deleted, until the next', async () => {
      const w = await contractWorld();
      await deletePriceList(handle.db, w.contract.id);
      expect(amountOf(await w.priceOf(w.customer.id))).toBe('70.00');
      await rebuildCombinedPrices(handle.db);
      expect(amountOf(await w.priceOf(w.customer.id))).toBe('80.00');
    });

    it('builds nothing, and prices nothing, without assignments', async () => {
      const w = await world();
      const list = await createPriceList(handle.db, { name: 'Unassigned', currency: 'INR' });
      await addPrice(handle.db, list.id, {
        productId: w.product.id,
        unitCode: 'each',
        amount: '1',
      });
      expect(await rebuildCombinedPrices(handle.db)).toMatchObject({
        combinedPriceListCount: 0,
        combinedPriceCount: 0,
      });
    });

    it('runs one build at a time', async () => {
      await contractWorld();
      const results = await Promise.all([
        rebuildCombinedPrices(handle.db),
        rebuildCombinedPrices(handle.db),
        rebuildCombinedPrices(handle.db),
      ]);
      expect(results.map((r) => r.combinedPriceCount)).toEqual([2, 2, 2]);
    });
  });

  describe('customer groups', () => {
    it('refuses a price built for the old group once a customer with its own price lists moves', async () => {
      const w = await contractWorld();
      const other = await createCustomerGroup(handle.db, { code: 'oem', name: 'OEM' });
      await setCustomerGroup(handle.db, w.customer.id, other.id);
      expect(await w.priceOf(w.customer.id)).toEqual({ found: false, reason: 'needs_rebuild' });
      await rebuildCombinedPrices(handle.db);
      expect(amountOf(await w.priceOf(w.customer.id))).toBe('70.00');
    });

    it('follows a group change at once for a customer without its own price lists', async () => {
      const w = await world();
      const plain = await createCustomer(handle.db, { name: 'Plain' });
      const net = await createPriceList(handle.db, { name: 'Distributor net', currency: 'INR' });
      await addPrice(handle.db, net.id, { productId: w.product.id, unitCode: 'each', amount: '9' });
      await createAssignment(handle.db, {
        priceListId: net.id,
        websiteId: w.website.id,
        target: 'customer_group',
        targetId: w.group.id,
      });
      await rebuildCombinedPrices(handle.db);
      const priceOf = (customerId: string) =>
        findPrice(handle.db, {
          customerId,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: 'each',
          quantity: parseDecimal('1'),
          currency: 'INR',
          now: NOW,
        });
      expect(amountOf(await priceOf(plain.id))).toBe('no_price');
      await setCustomerGroup(handle.db, plain.id, w.group.id);
      expect(amountOf(await priceOf(plain.id))).toBe('9.00');
    });

    it('answers customer_not_found for an unknown customer', async () => {
      const w = await contractWorld();
      expect(await w.priceOf(MISSING_ID)).toEqual({ found: false, reason: 'customer_not_found' });
    });
  });

  describe('buyer scoping', () => {
    it('prices a buyer from their own customer only', async () => {
      const w = await contractWorld();
      const rival = await createCustomer(handle.db, { name: 'Rival', groupId: w.group.id });
      const asha = await createUser(handle.db, {
        realm: 'buyer',
        email: 'asha@gulfcoast.example',
        displayName: 'Asha',
        password: 'correct horse battery staple',
      });
      const ravi = await createUser(handle.db, {
        realm: 'buyer',
        email: 'ravi@rival.example',
        displayName: 'Ravi',
        password: 'correct horse battery staple',
      });
      await linkBuyerUser(handle.db, w.customer.id, 'asha@gulfcoast.example');
      await linkBuyerUser(handle.db, rival.id, 'ravi@rival.example');
      const buyerPrice = (buyerUserId: string) =>
        findPriceForBuyer(handle.db, {
          buyerUserId,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: 'each',
          quantity: parseDecimal('1'),
          currency: 'INR',
          now: NOW,
        });
      expect(amountOf(await buyerPrice(asha.id))).toBe('70.00');
      expect(amountOf(await buyerPrice(ravi.id))).toBe('80.00');
      expect(await buyerPrice(MISSING_ID)).toEqual({ found: false, reason: 'customer_not_found' });
    });
  });

  describe('price lists', () => {
    it('refuses dates out of order, on create and on change', async () => {
      await expectRefused(
        createPriceList(handle.db, {
          name: 'Backwards',
          currency: 'INR',
          activeFrom: '2027-01-01T00:00:00+05:30',
          activeUntil: '2026-01-01T00:00:00+05:30',
        }),
        'active_dates_out_of_order',
      );
      const list = await createPriceList(handle.db, {
        name: 'FY 2026-27',
        currency: 'INR',
        activeFrom: '2026-04-01T00:00:00+05:30',
      });
      expect(list.activeFrom?.toISOString()).toBe('2026-03-31T18:30:00.000Z');
      await expectRefused(
        updatePriceList(handle.db, list.id, { activeUntil: '2026-03-01T00:00:00+05:30' }),
        'active_dates_out_of_order',
      );
      const renamed = await updatePriceList(handle.db, list.id, { name: 'FY 2026-27 contract' });
      expect(renamed.name).toBe('FY 2026-27 contract');
      await expect(
        updatePriceList(handle.db, list.id, { currency: 'USD' } as never),
      ).rejects.toThrow();
      await expectRefused(
        updatePriceList(handle.db, MISSING_ID, { name: 'x' }),
        'price_list_not_found',
      );
      await expectRefused(deletePriceList(handle.db, MISSING_ID), 'price_list_not_found');
    });

    it('lists by name a page at a time, with status and counts', async () => {
      const w = await world();
      for (const name of ['Delta', 'Alpha', 'Charlie', 'Bravo']) {
        await createPriceList(handle.db, {
          name,
          currency: 'INR',
          ...(name === 'Charlie' ? { activeFrom: '2027-01-01T00:00:00Z' } : {}),
          ...(name === 'Bravo' ? { activeUntil: '2026-01-01T00:00:00Z' } : {}),
        });
      }
      const usd = await createPriceList(handle.db, { name: 'Echo', currency: 'USD' });
      const first = await listPriceLists(handle.db, { limit: 2 }, NOW);
      expect(first.priceLists.map((l) => [l.name, l.status])).toEqual([
        ['Alpha', 'active'],
        ['Bravo', 'expired'],
      ]);
      const second = await listPriceLists(handle.db, { limit: 2, after: first.nextAfter! }, NOW);
      expect(second.priceLists.map((l) => [l.name, l.status])).toEqual([
        ['Charlie', 'scheduled'],
        ['Delta', 'active'],
      ]);
      const third = await listPriceLists(handle.db, { limit: 2, after: second.nextAfter! }, NOW);
      expect(third).toMatchObject({ nextAfter: null });
      expect(third.priceLists.map((l) => l.name)).toEqual(['Echo']);

      await addPrice(handle.db, usd.id, { productId: w.product.id, unitCode: 'each', amount: '1' });
      const usdOnly = await listPriceLists(handle.db, { currency: 'USD' }, NOW);
      expect(usdOnly.priceLists).toMatchObject([
        { name: 'Echo', priceCount: 1, assignmentCount: 0 },
      ]);
    });
  });

  describe('prices', () => {
    it('checks the product, the product unit, the quantity and the amount', async () => {
      const w = await world('USD');
      const list = await createPriceList(handle.db, { name: 'US list', currency: 'USD' });
      const add = (input: Partial<Parameters<typeof addPrice>[2]>) =>
        addPrice(handle.db, list.id, {
          productId: w.product.id,
          unitCode: 'each',
          amount: '1.00',
          ...input,
        });
      await expectRefused(add({ productId: MISSING_ID }), 'product_not_found');
      await createProductUnit(handle.db, { code: 'box_10', name: 'Box of 10', precision: 0 });
      await expectRefused(add({ unitCode: 'box_10' }), 'product_unit_not_sold');
      await expectRefused(add({ minQuantity: '1.5' }), 'invalid_quantity');
      await expectRefused(add({ minQuantity: '0' }), 'invalid_quantity');
      await expectRefused(add({ amount: '4.865' }), 'invalid_amount');
      await expectRefused(add({ amount: '-4.86' }), 'invalid_amount');
      await expectRefused(
        addPrice(handle.db, MISSING_ID, { productId: w.product.id, unitCode: 'each', amount: '1' }),
        'price_list_not_found',
      );

      const kg = await add({ unitCode: 'kg', minQuantity: '2.5', amount: '4.86' });
      expect(kg).toMatchObject({ minQuantity: '2.5', unitCode: 'kg' });
      expect(toDecimalString(kg.amount)).toBe('4.86');
      await expectRefused(add({ unitCode: 'kg', minQuantity: '2.500' }), 'price_tier_taken');

      const changed = await updatePrice(handle.db, kg.id, { amount: '4.5' });
      expect(toDecimalString(changed.amount)).toBe('4.50');
      await expectRefused(updatePrice(handle.db, kg.id, { amount: '4.501' }), 'invalid_amount');
      await expectRefused(updatePrice(handle.db, MISSING_ID, { amount: '1' }), 'price_not_found');
      await deletePrice(handle.db, kg.id);
      await expectRefused(deletePrice(handle.db, kg.id), 'price_not_found');
    });

    it('lists the tiers of a product and unit together, lowest first, a page at a time', async () => {
      const w = await world();
      const list = await createPriceList(handle.db, { name: 'Tiers', currency: 'INR' });
      for (const [unitCode, minQuantity] of [
        ['each', '100'],
        ['kg', '0.5'],
        ['each', '1'],
        ['each', '10'],
      ] as const) {
        await addPrice(handle.db, list.id, {
          productId: w.product.id,
          unitCode,
          minQuantity,
          amount: '1',
        });
      }
      const first = await listPrices(handle.db, list.id, { limit: 3 });
      expect(first.prices.map((p) => [p.unitCode, p.minQuantity])).toEqual([
        ['each', '1'],
        ['each', '10'],
        ['each', '100'],
      ]);
      const second = await listPrices(handle.db, list.id, { limit: 3, after: first.nextAfter! });
      expect(second).toMatchObject({
        nextAfter: null,
        prices: [{ unitCode: 'kg', minQuantity: '0.5' }],
      });
      const kgOnly = await listPrices(handle.db, list.id, { unitCode: 'kg' });
      expect(kgOnly.prices).toHaveLength(1);
      await expectRefused(listPrices(handle.db, MISSING_ID), 'price_list_not_found');
    });
  });

  describe('assignments', () => {
    it('checks the website, the target, the currency and the order', async () => {
      const w = await world('INR');
      const inr = await createPriceList(handle.db, { name: 'INR', currency: 'INR' });
      const usd = await createPriceList(handle.db, { name: 'USD', currency: 'USD' });
      const assign = (input: Partial<Parameters<typeof createAssignment>[1]>) =>
        createAssignment(handle.db, {
          priceListId: inr.id,
          websiteId: w.website.id,
          target: 'customer',
          targetId: w.customer.id,
          ...input,
        });
      await expectRefused(assign({ websiteId: MISSING_ID }), 'website_not_found');
      await expectRefused(assign({ priceListId: MISSING_ID }), 'price_list_not_found');
      await expectRefused(assign({ priceListId: usd.id }), 'currency_mismatch');
      await expectRefused(assign({ targetId: MISSING_ID }), 'customer_not_found');
      await expectRefused(
        assign({ target: 'customer_group', targetId: MISSING_ID }),
        'customer_group_not_found',
      );
      await expect(assign({ target: 'website', targetId: w.customer.id })).rejects.toThrow();

      const first = await assign({});
      expect(first.priority).toBe(1);
      await expectRefused(assign({}), 'assignment_taken');
      const second = await createPriceList(handle.db, { name: 'Second', currency: 'INR' });
      const next = await assign({ priceListId: second.id });
      expect(next.priority).toBe(2);
      await expectRefused(
        updateAssignment(handle.db, next.id, { priority: 1 }),
        'assignment_priority_taken',
      );
      expect(await updateAssignment(handle.db, next.id, { priority: 5 })).toMatchObject({
        priority: 5,
      });
      const site = await assign({ target: 'website', targetId: undefined });
      expect(site).toMatchObject({ target: 'website', targetId: w.website.id, priority: 1 });

      const page = await listAssignments(handle.db, { websiteId: w.website.id, limit: 2 });
      expect(page.assignments.map((a) => [a.target, a.priority])).toEqual([
        ['customer', 1],
        ['customer', 5],
      ]);
      const rest = await listAssignments(handle.db, {
        websiteId: w.website.id,
        limit: 2,
        after: page.nextAfter!,
      });
      expect(rest).toMatchObject({ nextAfter: null, assignments: [{ target: 'website' }] });
      expect(
        (await listAssignments(handle.db, { priceListId: second.id })).assignments,
      ).toHaveLength(1);

      await deleteAssignment(handle.db, site.id);
      await expectRefused(deleteAssignment(handle.db, site.id), 'assignment_not_found');
      await expectRefused(
        updateAssignment(handle.db, site.id, { priority: 2 }),
        'assignment_not_found',
      );
    });
  });

  describe('preview', () => {
    it('explains the chain and the rounding, and shows changes waiting for a build', async () => {
      const w = await contractWorld();
      const preview = await previewPrice(
        handle.db,
        {
          customerId: w.customer.id,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: 'kg',
          quantity: '2.5',
        },
        NOW,
      );
      expect(preview).toMatchObject({ price: null, reason: 'no_price', lineAmount: null });
      expect(decimalToString(preview.quantity)).toBe('2.500');
      expect(preview.steps.map((s) => [s.entry.priceList.name, s.status])).toEqual([
        ['Contract', 'skipped'],
        ['List price', 'skipped'],
      ]);

      await addPrice(handle.db, w.listPrice.id, {
        productId: w.product.id,
        unitCode: 'kg',
        minQuantity: '0.001',
        amount: '33.33',
      });
      const unbuilt = await previewPrice(
        handle.db,
        {
          customerId: w.customer.id,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: 'kg',
          quantity: '2.5',
        },
        NOW,
      );
      expect(unbuilt).toMatchObject({ price: null, pendingChanges: 1 });
      expect(toDecimalString(unbuilt.unbuiltPrice!.unitPrice)).toBe('33.33');

      await rebuildCombinedPrices(handle.db);
      const built = await previewPrice(
        handle.db,
        {
          customerId: w.customer.id,
          websiteId: w.website.id,
          productId: w.product.id,
          unitCode: 'kg',
          quantity: '2.5',
        },
        NOW,
      );
      expect(toDecimalString(built.lineAmount!)).toBe('83.33');
      expect(built.steps.map((s) => s.status)).toEqual(['skipped', 'used']);
    });

    it('refuses unknown customers, websites, products and bad quantities', async () => {
      const w = await contractWorld();
      const base = {
        customerId: w.customer.id,
        websiteId: w.website.id,
        productId: w.product.id,
        unitCode: 'each',
        quantity: '1',
      };
      await expectRefused(
        previewPrice(handle.db, { ...base, customerId: MISSING_ID }, NOW),
        'customer_not_found',
      );
      await expectRefused(
        previewPrice(handle.db, { ...base, websiteId: MISSING_ID }, NOW),
        'website_not_found',
      );
      await expectRefused(
        previewPrice(handle.db, { ...base, productId: MISSING_ID }, NOW),
        'product_not_found',
      );
      await expectRefused(
        previewPrice(handle.db, { ...base, unitCode: 'box' }, NOW),
        'product_unit_not_sold',
      );
      await expectRefused(
        previewPrice(handle.db, { ...base, quantity: '1.5' }, NOW),
        'invalid_quantity',
      );
    });
  });
});
