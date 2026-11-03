import { findProductBySku, listCategories } from '@muziris/catalog';
import { createCustomer } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { parseDecimal, toDecimalString } from '@muziris/money';
import { createWebsite } from '@muziris/platform';
import { findPrice } from '@muziris/pricing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CATEGORIES, DEMO_PRODUCTS, DemoSeedError, seedDemoCatalog } from './demo-catalog.js';
import { runSetup } from './setup.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('the demo catalog against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_demo_catalog');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    const tables = await handle.db.execute<{ name: string }>(
      sql`select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
    );
    await handle.db.execute(
      sql.raw(`truncate ${tables.map((t) => t.name).join(', ')} restart identity cascade`),
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function website(code: string, countryCode: 'IN' | 'US') {
    const { organization } = await runSetup(handle.db, { organizationName: 'Acme' });
    return createWebsite(handle.db, {
      organizationId: organization.id,
      code,
      name: code,
      countryCode,
      defaultCurrency: countryCode === 'IN' ? 'INR' : 'USD',
      defaultLocale: countryCode === 'IN' ? 'en-IN' : 'en-US',
      timeZone: countryCode === 'IN' ? 'Asia/Kolkata' : 'America/New_York',
    });
  }

  async function priceOf(
    websiteId: string,
    sku: string,
    quantity: string,
    currency: 'INR' | 'USD',
  ) {
    const product = await findProductBySku(handle.db, sku);
    const customer = await createCustomer(handle.db, { name: `Buyer ${sku} ${quantity}` });
    const found = await findPrice(handle.db, {
      customerId: customer.id,
      websiteId,
      productId: product!.id,
      unitCode: product!.primaryUnitCode,
      quantity: parseDecimal(quantity),
      currency,
      now: new Date(),
    });
    return found.found ? toDecimalString(found.unitPrice) : found.reason;
  }

  it('adds the catalog with tiered prices, visible at once, and changes nothing the second time', async () => {
    const india = await website('main', 'IN');
    const first = await seedDemoCatalog(handle.db, { websiteCode: 'main' });
    expect(first).toMatchObject({
      currency: 'INR',
      categoriesAdded: DEMO_CATEGORIES.length,
      productsAdded: DEMO_PRODUCTS.length,
      priceListCreated: true,
      pricesAdded: DEMO_PRODUCTS.length * 3,
      visibleProductCount: DEMO_PRODUCTS.length,
    });
    const bearings = (await listCategories(handle.db)).find((c) => c.code === 'bearings');
    const parent = (await listCategories(handle.db)).find((c) => c.code === 'power_transmission');
    expect(bearings?.parentId).toBe(parent?.id);
    expect(await findProductBySku(handle.db, 'BRG-6205-2RS')).toMatchObject({
      status: 'enabled',
      hsnSacCode: '84821011',
      usTaxCategory: 'general',
      categoryId: bearings?.id,
    });
    expect(await priceOf(india.id, 'BRG-6205-2RS', '1', 'INR')).toBe('450.00');
    expect(await priceOf(india.id, 'BRG-6205-2RS', '99', 'INR')).toBe('430.00');
    expect(await priceOf(india.id, 'BRG-6205-2RS', '100', 'INR')).toBe('410.00');
    expect(await priceOf(india.id, 'LUB-GRS-EP2', '2.5', 'INR')).toBe('330.00');

    expect(await seedDemoCatalog(handle.db, { websiteCode: 'main' })).toMatchObject({
      categoriesAdded: 0,
      productsAdded: 0,
      priceListCreated: false,
      pricesAdded: 0,
      visibleProductCount: DEMO_PRODUCTS.length,
    });
  });

  it('prices a US website in dollars from its own list, sharing the products', async () => {
    await website('main', 'IN');
    await seedDemoCatalog(handle.db, { websiteCode: 'main' });
    const us = await website('us', 'US');
    expect(await seedDemoCatalog(handle.db, { websiteCode: 'us' })).toMatchObject({
      currency: 'USD',
      productsAdded: 0,
      priceListCreated: true,
      pricesAdded: DEMO_PRODUCTS.length * 3,
    });
    expect(await priceOf(us.id, 'BRG-6205-2RS', '100', 'USD')).toBe('11.95');
  });

  it('says what to do first without setup or the website', async () => {
    await expect(seedDemoCatalog(handle.db, { websiteCode: 'main' })).rejects.toThrow(
      'run setup first',
    );
    await runSetup(handle.db, { organizationName: 'Acme' });
    await expect(seedDemoCatalog(handle.db, { websiteCode: 'main' })).rejects.toBeInstanceOf(
      DemoSeedError,
    );
  });

  it('keeps every demo product valid: unique SKUs, known categories, three rising breaks', () => {
    expect(new Set(DEMO_PRODUCTS.map((d) => d.sku)).size).toBe(DEMO_PRODUCTS.length);
    const codes = new Set(DEMO_CATEGORIES.map((c) => c.code));
    for (const product of DEMO_PRODUCTS) {
      expect(codes.has(product.category)).toBe(true);
      for (const prices of [product.inr, product.usd]) {
        const [one, ten, hundred] = prices.map(Number);
        expect(one! > ten! && ten! > hundred!, `${product.sku} ${prices.join(' ')}`).toBe(true);
      }
    }
  });
});
