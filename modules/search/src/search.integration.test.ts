import {
  createCategory,
  createProduct,
  createProductUnit,
  setCategoryParent,
  updateCategory,
  updateProduct,
  type Category,
  type Product,
} from '@muziris/catalog';
import { createCustomer, createCustomerGroup, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createOrganization, createWebsite } from '@muziris/platform';
import { createRule, rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getBuildState,
  indexProducts,
  indexProductsInCategory,
  MAX_RESULTS,
  rebuildSearchIndex,
  searchProducts,
  searchProductsForBuyer,
} from './index.js';
import {
  CATALOG,
  CATEGORIES,
  CATEGORY_ORDER,
  HIDDEN_FROM_RETAIL,
  LEAKAGE_QUERIES,
  RANKING_CASES,
  type CategoryCode,
} from './test/known-answers.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';

/** One buyer search over 10,000 products must answer within this, warm, on CI hardware. */
const SEARCH_BUDGET_MS = 250;

describe.skipIf(!url)('search against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'search');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate search_product, search_build_state, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule,
        visibility_build_state, catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit, customer_buyer_user, customer_customer, customer_group,
        identity_session, identity_user, platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function buyer(customerId: string, email: string): Promise<string> {
    const user = await createUser(handle.db, {
      realm: 'buyer',
      email,
      displayName: email,
      password: PASSWORD,
    });
    await linkBuyerUser(handle.db, customerId, email);
    return user.id;
  }

  /** The known-answer catalog, indexed. */
  async function catalog() {
    await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
    const categories = {} as Record<CategoryCode, Category>;
    for (const code of CATEGORY_ORDER) {
      const { name, parent } = CATEGORIES[code];
      categories[code] = await createCategory(handle.db, {
        code,
        name,
        parentId: parent === null ? null : categories[parent].id,
      });
    }
    const bySku = new Map<string, Product>();
    for (const p of CATALOG) {
      const product = await createProduct(handle.db, {
        sku: p.sku,
        name: p.name,
        status: p.status ?? 'enabled',
        categoryId: p.category === null ? null : categories[p.category].id,
        attributes: p.attributes ?? {},
        primaryUnitCode: 'each',
      });
      bySku.set(p.sku, product);
    }
    await rebuildSearchIndex(handle.db);
    const product = (sku: string) => {
      const found = bySku.get(sku);
      if (!found) throw new Error(`No product ${sku} in the test catalog`);
      return found;
    };
    return { categories, product };
  }

  /**
   * An Indian website on which Bearings is hidden and shown to distributors, and the gloves are
   * hidden from one retail customer. A distributor buyer and a retail buyer.
   */
  async function world() {
    const { categories, product } = await catalog();
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
    const retail = await createCustomerGroup(handle.db, { code: 'retail', name: 'Retail' });
    const distributor = await createCustomer(handle.db, {
      name: 'Pune Bearing House',
      groupId: distributors.id,
    });
    const shop = await createCustomer(handle.db, { name: 'Kochi Hardware', groupId: retail.id });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: categories.bearings.id,
      target: 'website',
      visibility: 'hidden',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: categories.bearings.id,
      target: 'customer_group',
      targetId: distributors.id,
      visibility: 'visible',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'product',
      subjectId: product('GLV-NIT-L').id,
      target: 'customer',
      targetId: shop.id,
      visibility: 'hidden',
    });
    await rebuildVisibility(handle.db);
    return {
      categories,
      product,
      website,
      shop,
      distributorBuyer: await buyer(distributor.id, 'buyer@punebearing.in'),
      retailBuyer: await buyer(shop.id, 'buyer@kochihardware.in'),
    };
  }

  describe('ranking', () => {
    it.each(RANKING_CASES)('$q: $why', async ({ q, first }) => {
      await catalog();
      const page = await searchProducts(handle.db, { q, limit: 50 });
      expect(page.results.slice(0, first.length).map((r) => [r.sku, r.match])).toEqual(first);
    });

    it('returns the product, its category and its status now', async () => {
      const { categories, product } = await catalog();
      const page = await searchProducts(handle.db, { q: 'BRG-6205-2RS' });
      expect(page.results[0]).toEqual({
        productId: product('BRG-6205-2RS').id,
        sku: 'BRG-6205-2RS',
        name: 'Ball bearing 6205-2RS sealed',
        categoryId: categories.bearings.id,
        match: 'sku_exact',
        status: 'enabled',
      });
    });

    it('lets an admin find disabled products, and filter on status live', async () => {
      const { product } = await catalog();
      expect((await searchProducts(handle.db, { q: 'BRG-OLD-1' })).results[0]).toMatchObject({
        sku: 'BRG-OLD-1',
        status: 'disabled',
      });
      await updateProduct(handle.db, product('BRG-6205').id, { status: 'disabled' });
      // The status is read from catalog, so it is current before any reindex.
      const disabled = await searchProducts(handle.db, { q: 'BRG-', status: 'disabled' });
      expect(disabled.results.map((r) => r.sku)).toEqual(['BRG-6205', 'BRG-OLD-1']);
    });

    it('reads %, _ and \\ in a query as text, not as patterns', async () => {
      await catalog();
      for (const q of ['BRG%', 'BRG_6205', '%', '_', 'BRG\\']) {
        const page = await searchProducts(handle.db, { q, limit: 50 });
        const bySku = page.results.filter(
          (r) => r.match === 'sku_exact' || r.match === 'sku_prefix',
        );
        expect(bySku).toEqual([]);
      }
    });

    it('finds nothing for words in no product, and for stop words only', async () => {
      await catalog();
      expect((await searchProducts(handle.db, { q: 'hydraulic pump' })).results).toEqual([]);
      expect((await searchProducts(handle.db, { q: 'the of and' })).results).toEqual([]);
    });

    it('reads a page at a time, up to the first results', async () => {
      await catalog();
      const first = await searchProducts(handle.db, { q: 'BRG-', limit: 2 });
      expect(first.results.map((r) => r.sku)).toEqual(['BRG-6205', 'BRG-6205-2RS']);
      expect(first.nextOffset).toBe(2);
      const second = await searchProducts(handle.db, { q: 'BRG-', limit: 2, offset: 2 });
      expect(second.results.map((r) => r.sku)).toEqual(['BRG-6206-ZZ', 'BRG-OLD-1']);
      const rest = await searchProducts(handle.db, { q: 'BRG-', limit: 50, offset: 4 });
      expect(rest.results.every((r) => r.match !== 'sku_prefix')).toBe(true);
      expect(rest.nextOffset).toBeNull();
    });

    it('refuses pages that are too large or too deep, and empty queries', async () => {
      await expect(searchProducts(handle.db, { q: 'bearing', limit: 51 })).rejects.toThrow();
      await expect(
        searchProducts(handle.db, { q: 'bearing', limit: 50, offset: MAX_RESULTS - 49 }),
      ).rejects.toThrow();
      await expect(searchProducts(handle.db, { q: '   ' })).rejects.toThrow();
      await expect(searchProducts(handle.db, { q: 'x'.repeat(101) })).rejects.toThrow();
    });
  });

  describe('buyer scoping', () => {
    it.each(LEAKAGE_QUERIES)('a retail buyer searching %j sees nothing hidden', async (q) => {
      const w = await world();
      const hidden = new Set(HIDDEN_FROM_RETAIL.map((sku) => w.product(sku).id));
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await searchProductsForBuyer(
          handle.db,
          { buyerUserId: w.retailBuyer, websiteId: w.website.id },
          { q, limit: 50, offset },
        );
        for (const r of page.results) expect(hidden.has(r.productId)).toBe(false);
        offset = page.nextOffset;
      }
    });

    it('shows the distributor the bearings the retail buyer cannot see', async () => {
      const w = await world();
      const asDistributor = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.distributorBuyer, websiteId: w.website.id },
        { q: 'BRG-6205' },
      );
      expect(asDistributor.results.slice(0, 2).map((r) => [r.sku, r.match])).toEqual([
        ['BRG-6205', 'sku_exact'],
        ['BRG-6205-2RS', 'sku_prefix'],
      ]);
      const asRetail = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.retailBuyer, websiteId: w.website.id },
        { q: 'BRG-6205' },
      );
      // The puller is in Hand tools, which the retail buyer may see.
      expect(asRetail.results.map((r) => r.sku)).toEqual(['XBRG-6205']);
      // Gloves are hidden from the retail customer only.
      const gloves = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.distributorBuyer, websiteId: w.website.id },
        { q: 'gloves' },
      );
      expect(gloves.results.map((r) => r.sku)).toEqual(['GLV-NIT-L']);
    });

    it('never shows a disabled product, even before the index or visibility catch up', async () => {
      const w = await world();
      const asDistributor = { buyerUserId: w.distributorBuyer, websiteId: w.website.id };
      const before = await searchProductsForBuyer(handle.db, asDistributor, { q: 'BRG-6206-ZZ' });
      expect(before.results[0]?.sku).toBe('BRG-6206-ZZ');
      await updateProduct(handle.db, w.product('BRG-6206-ZZ').id, { status: 'disabled' });
      const after = await searchProductsForBuyer(handle.db, asDistributor, { q: 'BRG-6206-ZZ' });
      expect(after.results.map((r) => r.sku)).not.toContain('BRG-6206-ZZ');
      const old = await searchProductsForBuyer(handle.db, asDistributor, { q: 'BRG-OLD-1' });
      expect(old.results.map((r) => r.sku)).not.toContain('BRG-OLD-1');
    });

    it('returns a category id only when the buyer may see the category', async () => {
      const w = await world();
      // Show one bearing to the retail customer while Bearings stays hidden from them.
      await createRule(handle.db, {
        websiteId: w.website.id,
        subject: 'product',
        subjectId: w.product('BRG-6206-ZZ').id,
        target: 'customer',
        targetId: w.shop.id,
        visibility: 'visible',
      });
      await rebuildVisibility(handle.db);
      const asRetail = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.retailBuyer, websiteId: w.website.id },
        { q: 'BRG-6206-ZZ' },
      );
      expect(asRetail.results).toEqual([
        {
          productId: w.product('BRG-6206-ZZ').id,
          sku: 'BRG-6206-ZZ',
          name: 'Ball bearing 6206-ZZ shielded',
          categoryId: null,
          match: 'sku_exact',
        },
      ]);
      const asDistributor = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.distributorBuyer, websiteId: w.website.id },
        { q: 'BRG-6206-ZZ' },
      );
      expect(asDistributor.results[0]?.categoryId).toBe(w.categories.bearings.id);
    });

    it('finds nothing for a user who is not a buyer user, or on another website', async () => {
      const w = await world();
      const admin = await createUser(handle.db, {
        realm: 'admin',
        email: 'admin@muziris.in',
        displayName: 'Admin',
        password: PASSWORD,
      });
      const asAdmin = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: admin.id, websiteId: w.website.id },
        { q: 'puller' },
      );
      expect(asAdmin.results).toEqual([]);
      const unknownSite = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.retailBuyer, websiteId: '00000000-0000-4000-8000-000000000000' },
        { q: 'puller' },
      );
      // An unknown website has no rules, so the default context serves it; it is still scoped.
      expect(unknownSite.results.map((r) => r.sku)).toEqual(['XBRG-6205']);
    });

    it('finds nothing before the first visibility build', async () => {
      const w = await world();
      await handle.db.execute(sql`truncate visibility_context cascade`);
      const page = await searchProductsForBuyer(
        handle.db,
        { buyerUserId: w.distributorBuyer, websiteId: w.website.id },
        { q: 'puller' },
      );
      expect(page.results).toEqual([]);
    });
  });

  describe('keeping the index current', () => {
    it('reindexes a product after it is created or changed', async () => {
      const { categories } = await catalog();
      const pump = await createProduct(handle.db, {
        sku: 'PMP-1',
        name: 'Gear pump',
        status: 'enabled',
        categoryId: categories.tools.id,
        primaryUnitCode: 'each',
      });
      expect((await getBuildState(handle.db)).waitingProducts).toBe(1);
      expect((await searchProducts(handle.db, { q: 'gear pump' })).results).toEqual([]);
      await indexProducts(handle.db, [pump.id]);
      expect((await getBuildState(handle.db)).waitingProducts).toBe(0);
      expect((await searchProducts(handle.db, { q: 'gear pump' })).results[0]?.sku).toBe('PMP-1');

      await updateProduct(handle.db, pump.id, { name: 'Vane pump' });
      expect((await getBuildState(handle.db)).waitingProducts).toBe(1);
      await indexProducts(handle.db, [pump.id]);
      expect((await searchProducts(handle.db, { q: 'gear' })).results).toEqual([]);
      expect((await searchProducts(handle.db, { q: 'vane' })).results[0]?.name).toBe('Vane pump');
    });

    it('reindexes the products of a category after it is renamed or moved', async () => {
      const { categories } = await catalog();
      await updateCategory(handle.db, categories.power_transmission.id, { name: 'Drives' });
      expect((await searchProducts(handle.db, { q: 'drives' })).results).toEqual([]);
      await indexProductsInCategory(handle.db, categories.power_transmission.id);
      const drives = await searchProducts(handle.db, { q: 'drives' });
      expect(drives.results.map((r) => r.sku)).toEqual([
        'BRG-6205',
        'BRG-6205-2RS',
        'BRG-6206-ZZ',
        'BRG-OLD-1',
        'SLV-H305',
      ]);

      await setCategoryParent(handle.db, categories.metals.id, categories.power_transmission.id);
      await indexProductsInCategory(handle.db, categories.metals.id);
      const rods = await searchProducts(handle.db, { q: 'drives rod' });
      expect(rods.results.map((r) => r.sku)).toEqual(['AL-ROD-10']);
    });

    it('records the last full build', async () => {
      expect(await getBuildState(handle.db)).toEqual({ waitingProducts: 0, lastBuild: null });
      await catalog();
      const state = await getBuildState(handle.db);
      expect(state.waitingProducts).toBe(0);
      expect(state.lastBuild).toMatchObject({ productCount: CATALOG.length, builtBy: null });
    });

    it('ignores unknown ids', async () => {
      await catalog();
      await indexProducts(handle.db, ['00000000-0000-4000-8000-000000000000']);
      expect((await getBuildState(handle.db)).lastBuild?.productCount).toBe(CATALOG.length);
    });
  });

  describe('speed', () => {
    it(`searches 10,000 products within ${SEARCH_BUDGET_MS} ms`, async () => {
      const w = await world();
      // Bulk-load 10,000 enabled products in one statement each; createProduct one at a time
      // would make the test about inserts, not search.
      await handle.db.execute(sql`
        insert into catalog_product (sku, name, status, category_id, attributes)
        select 'GEN-' || lpad(n::text, 5, '0'),
          (array['Ball bearing', 'Hex bolt', 'Nitrile glove', 'Spanner', 'Aluminium sheet',
            'Roller chain', 'V-belt', 'Pipe clamp'])[1 + n % 8] || ' ' || (6000 + n % 400)
            || ' ' || (array['open', 'sealed', 'zinc', 'black', 'large', 'small'])[1 + n % 6],
          'enabled',
          (array[${w.categories.bearings.id}::uuid, ${w.categories.tools.id}::uuid,
            ${w.categories.gloves.id}::uuid, ${w.categories.metals.id}::uuid])[1 + n % 4],
          jsonb_build_object('grade', 'G' || (n % 50))
        from generate_series(1, 10000) n`);
      await handle.db.execute(sql`
        insert into catalog_product_sold_in (product_id, unit_code, is_primary)
        select id, 'each', true from catalog_product where sku like 'GEN-%'`);
      await rebuildSearchIndex(handle.db);
      await rebuildVisibility(handle.db);
      await handle.db.execute(sql`analyze search_product`);

      const asDistributor = { buyerUserId: w.distributorBuyer, websiteId: w.website.id };
      const queries = ['bearng 6205', 'GEN-0', 'sealed spanner', 'aluminum sheet 6100'];
      for (const q of queries) await searchProductsForBuyer(handle.db, asDistributor, { q }); // warm up
      for (const q of queries) {
        const started = performance.now();
        const page = await searchProductsForBuyer(handle.db, asDistributor, { q, limit: 50 });
        const ms = performance.now() - started;
        expect(page.results.length).toBeGreaterThan(0);
        expect(ms).toBeLessThan(SEARCH_BUDGET_MS);
      }
    });
  });
});
