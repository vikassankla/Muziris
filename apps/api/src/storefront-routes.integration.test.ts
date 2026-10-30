import { Writable } from 'node:stream';
import { createCategory, createProduct, createProductUnit } from '@muziris/catalog';
import { createCustomer, createCustomerGroup, linkBuyerUser } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type Database,
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
import { rebuildSearchIndex } from '@muziris/search';
import { createRule, rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { MAX_COST, MAX_DEPTH } from './storefront/limits.js';
import { queryHash } from './storefront/persisted.js';
import type { StorefrontOptions } from './storefront/routes.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://shop.example.com';
const NOW = new Date('2026-11-14T09:00:00.000Z');

interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[]; extensions: { code: string } }[];
}

describe.skipIf(!url)('storefront GraphQL API against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let counted: DatabaseHandle;
  let queries: number;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_storefront');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
    counted = createDatabase({
      url: testUrl,
      applicationName: 'muziris-test-counted',
      onQuery: () => {
        queries += 1;
      },
    });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate search_product, search_build_state, pricing_combined_price,
        pricing_combined_price_list_target, pricing_combined_price_list, pricing_build_state,
        pricing_assignment, pricing_price, pricing_price_list, visibility_visible_product,
        visibility_visible_category, visibility_context, visibility_rule,
        visibility_build_state, catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit, customer_buyer_user, customer_customer, customer_group,
        platform_website, platform_organization, identity_session, identity_user,
        identity_rate_limit cascade`,
    );
    logs = [];
    queries = 0;
  });

  afterAll(async () => {
    await handle.close();
    await counted.close();
  });

  function app(
    storefront: StorefrontOptions = { persistedQueries: new Map(), allowAdhocQueries: true },
    db: Database = handle.db,
  ) {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    return createApp({
      logger: createLogger('info', stream),
      db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => NOW,
      clientIp: () => '203.0.113.7',
      storefront,
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

  async function buyer(customerId: string, email: string): Promise<string> {
    await createUser(handle.db, { realm: 'buyer', email, displayName: email, password: PASSWORD });
    await linkBuyerUser(handle.db, customerId, email);
    return signIn('buyer', email);
  }

  interface Call {
    cookie: string;
    website?: string | null;
    variables?: Record<string, unknown>;
    storefront?: StorefrontOptions;
    db?: Database;
  }

  async function post(body: unknown, call: Call) {
    const res = await app(call.storefront, call.db).request('/storefront/v1/graphql', {
      method: 'POST',
      headers: {
        Cookie: call.cookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        ...(call.website === null ? {} : { 'Muziris-Website': call.website ?? 'muziris-in' }),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as GraphqlResponse, res };
  }

  const gql = (query: string, call: Call) =>
    post({ query, ...(call.variables ? { variables: call.variables } : {}) }, call);

  /**
   * An Indian website. Bearings (under Power transmission) are hidden on the website and shown
   * to distributors; Safety is open. A list price for everyone and a contract price for the
   * distributor. A distributor buyer and a retail buyer, signed in.
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
    const power = await createCategory(handle.db, {
      code: 'power_transmission',
      name: 'Power transmission',
    });
    const bearings = await createCategory(handle.db, {
      code: 'bearings',
      name: 'Bearings',
      parentId: power.id,
    });
    const safety = await createCategory(handle.db, { code: 'safety', name: 'Safety' });
    const bearing = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      status: 'enabled',
      categoryId: bearings.id,
      attributes: { bore: '25 mm', sealed: true },
      primaryUnitCode: 'each',
    });
    const glove = await createProduct(handle.db, {
      sku: 'GLV-NITRILE-L',
      name: 'Nitrile gloves, large',
      status: 'enabled',
      categoryId: safety.id,
      attributes: { colours: ['blue', 'black'] },
      primaryUnitCode: 'each',
      additionalUnitCodes: ['kg'],
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
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: bearings.id,
      target: 'website',
      visibility: 'hidden',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: power.id,
      target: 'website',
      visibility: 'hidden',
    });
    await createRule(handle.db, {
      websiteId: website.id,
      subject: 'category',
      subjectId: power.id,
      target: 'customer_group',
      targetId: distributors.id,
      visibility: 'visible',
    });
    const list = await createPriceList(handle.db, { name: 'List price', currency: 'INR' });
    for (const [productId, amount] of [
      [bearing.id, '480.00'],
      [glove.id, '95.50'],
    ] as const) {
      await addPrice(handle.db, list.id, { productId, unitCode: 'each', amount });
    }
    await addPrice(handle.db, list.id, {
      productId: glove.id,
      unitCode: 'each',
      minQuantity: '100',
      amount: '89.00',
    });
    await createAssignment(handle.db, {
      priceListId: list.id,
      websiteId: website.id,
      target: 'website',
    });
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
    await Promise.all([
      rebuildVisibility(handle.db),
      rebuildCombinedPrices(handle.db),
      rebuildSearchIndex(handle.db),
    ]);
    return {
      website,
      power,
      bearings,
      safety,
      bearing,
      glove,
      distributor,
      retailer,
      ravi: await buyer(distributor.id, 'ravi@punebearing.in'),
      lena: await buyer(retailer.id, 'lena@kochihardware.in'),
    };
  }

  const PRODUCT_FIELDS = `id sku name category { id name }
    attributes { key values } primaryUnit { code precision } units { code }
    price { unitPrice { amount minorUnits currency } unitCode quantity minQuantity }`;

  describe('who may ask', () => {
    it('needs a buyer session', async () => {
      const res = await app().request('/storefront/v1/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ query: '{ website { code } }' }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
    });

    it('does not take an admin session', async () => {
      await world();
      await createUser(handle.db, {
        realm: 'admin',
        email: 'asha@muziris.in',
        displayName: 'Asha',
        password: PASSWORD,
      });
      const admin = await signIn('admin', 'asha@muziris.in');
      const { status } = await gql('{ website { code } }', { cookie: admin });
      expect(status).toBe(401);
    });

    it('refuses a POST from an untrusted site', async () => {
      const w = await world();
      const res = await app().request('/storefront/v1/graphql', {
        method: 'POST',
        headers: {
          Cookie: w.lena,
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
          'Muziris-Website': 'muziris-in',
        },
        body: JSON.stringify({ query: '{ website { code } }' }),
      });
      expect(res.status).toBe(403);
    });

    it.each<[string | null, string]>([
      [null, 'no header'],
      ['muziris-us', 'an unknown website'],
    ])('refuses %j (%s) before running anything', async (website) => {
      const w = await world();
      const { status, body } = await gql('{ viewer { email } }', { cookie: w.lena, website });
      expect(status).toBe(400);
      expect(body.errors?.[0]?.extensions.code).toBe('WEBSITE_NOT_FOUND');
      expect(body.data).toBeUndefined();
    });

    it('answers no-store, since every answer is for one buyer', async () => {
      const w = await world();
      const { res } = await gql('{ website { code } }', { cookie: w.lena });
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('gate check: a buyer sees only their own catalog and prices', () => {
    it('shows the viewer, their customer and the website', async () => {
      const w = await world();
      const { status, body } = await gql(
        '{ viewer { email customer { id name } } website { code currency locale timeZone } }',
        { cookie: w.ravi },
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        data: {
          viewer: {
            email: 'ravi@punebearing.in',
            customer: { id: w.distributor.id, name: 'Pune Bearing House' },
          },
          website: {
            code: 'muziris-in',
            currency: 'INR',
            locale: 'en-IN',
            timeZone: 'Asia/Kolkata',
          },
        },
      });
    });

    it('lists each buyer their own products with their own prices', async () => {
      const w = await world();
      const query = `{ products { nextAfter nodes { ${PRODUCT_FIELDS} } } }`;
      const asRavi = await gql(query, { cookie: w.ravi });
      expect(asRavi.body.errors).toBeUndefined();
      expect(asRavi.body.data).toEqual({
        products: {
          nextAfter: null,
          nodes: [
            {
              id: w.bearing.id,
              sku: 'BRG-6205-2RS',
              name: 'Ball bearing 6205-2RS',
              category: { id: w.bearings.id, name: 'Bearings' },
              attributes: [
                { key: 'bore', values: ['25 mm'] },
                { key: 'sealed', values: ['true'] },
              ],
              primaryUnit: { code: 'each', precision: 0 },
              units: [{ code: 'each' }],
              price: {
                unitPrice: { amount: '410.00', minorUnits: '41000', currency: 'INR' },
                unitCode: 'each',
                quantity: '1',
                minQuantity: '1',
              },
            },
            {
              id: w.glove.id,
              sku: 'GLV-NITRILE-L',
              name: 'Nitrile gloves, large',
              category: { id: w.safety.id, name: 'Safety' },
              attributes: [{ key: 'colours', values: ['blue', 'black'] }],
              primaryUnit: { code: 'each', precision: 0 },
              units: [{ code: 'each' }, { code: 'kg' }],
              price: {
                unitPrice: { amount: '95.50', minorUnits: '9550', currency: 'INR' },
                unitCode: 'each',
                quantity: '1',
                minQuantity: '1',
              },
            },
          ],
        },
      });
      const asLena = await gql(query, { cookie: w.lena });
      expect(asLena.body.errors).toBeUndefined();
      expect(
        (asLena.body.data?.['products'] as { nodes: { sku: string }[] }).nodes.map((p) => p.sku),
      ).toEqual(['GLV-NITRILE-L']);
    });

    it('prices a quantity tier, and gives null where there is no price', async () => {
      const w = await world();
      const { body } = await gql(
        `query ($id: ID!) { product(id: $id) {
          bulk: price(quantity: "150") { unitPrice { amount } minQuantity }
          inKg: price(unitCode: "kg", quantity: "2.5") { unitPrice { amount } }
        } }`,
        { cookie: w.lena, variables: { id: w.glove.id } },
      );
      expect(body).toEqual({
        data: {
          product: { bulk: { unitPrice: { amount: '89.00' }, minQuantity: '100' }, inKg: null },
        },
      });
    });

    it('lists only the categories the buyer may see', async () => {
      const w = await world();
      const names = async (cookie: string) => {
        const { body } = await gql('{ categories { name parentId } }', { cookie });
        return (body.data?.['categories'] as { name: string; parentId: string | null }[]).sort(
          (a, b) => (a.name < b.name ? -1 : 1),
        );
      };
      expect(await names(w.ravi)).toEqual([
        { name: 'Bearings', parentId: w.power.id },
        { name: 'Power transmission', parentId: null },
        { name: 'Safety', parentId: null },
      ]);
      expect(await names(w.lena)).toEqual([{ name: 'Safety', parentId: null }]);
    });

    it('searches within the buyer’s catalog', async () => {
      const w = await world();
      const query =
        '{ search(query: "BRG-6205-2RS") { nodes { match product { sku price { unitPrice { amount } } } } } }';
      const asRavi = await gql(query, { cookie: w.ravi });
      expect(asRavi.body.data).toEqual({
        search: {
          nodes: [
            {
              match: 'SKU_EXACT',
              product: { sku: 'BRG-6205-2RS', price: { unitPrice: { amount: '410.00' } } },
            },
          ],
        },
      });
      const asLena = await gql(query, { cookie: w.lena });
      expect(asLena.body.data).toEqual({ search: { nodes: [] } });
    });
  });

  describe('leakage', () => {
    it.each([
      ['product by id', 'query ($id: ID) { product(id: $id) { sku } }', 'id'],
      ['product by SKU', 'query ($sku: String) { product(sku: $sku) { sku } }', 'sku'],
      [
        'product by SKU in lower case',
        'query ($lower: String) { product(sku: $lower) { sku } }',
        'lower',
      ],
    ])('a retail buyer gets null for a hidden %s', async (_title, query) => {
      const w = await world();
      const { status, body } = await gql(query, {
        cookie: w.lena,
        variables: { id: w.bearing.id, sku: 'BRG-6205-2RS', lower: 'brg-6205-2rs' },
      });
      expect(status).toBe(200);
      expect(body).toEqual({ data: { product: null } });
    });

    it.each([
      ['the hidden category', (w: Awaited<ReturnType<typeof world>>) => w.bearings.id],
      [
        'the hidden parent, with subcategories',
        (w: Awaited<ReturnType<typeof world>>) => w.power.id,
      ],
    ])('lists nothing in %s', async (_title, idOf) => {
      const w = await world();
      const { body } = await gql(
        `query ($id: ID!) { products(categoryId: $id, includeSubcategories: true) { nodes { sku } }
           category(id: $id) { name } }`,
        { cookie: w.lena, variables: { id: idOf(w) } },
      );
      expect(body).toEqual({ data: { products: { nodes: [] }, category: null } });
    });

    it.each(['bearing', 'BRG', '6205', 'power transmission', 'bearings', 'bearng'])(
      'search %j finds no hidden product',
      async (q) => {
        const w = await world();
        const { body } = await gql(
          'query ($q: String!) { search(query: $q, first: 50) { nodes { product { id } } } }',
          { cookie: w.lena, variables: { q } },
        );
        const ids = (body.data?.['search'] as { nodes: { product: { id: string } }[] }).nodes.map(
          (n) => n.product.id,
        );
        expect(ids).not.toContain(w.bearing.id);
      },
    );

    it('cannot price a product the buyer may not see', async () => {
      const w = await world();
      // There is no field that takes a product id for a price: price hangs off a product the
      // buyer could read. The only way in is product(id), which is null for a hidden product.
      const { body } = await gql(
        'query ($id: ID) { product(id: $id) { price { unitPrice { amount } } } }',
        { cookie: w.lena, variables: { id: w.bearing.id } },
      );
      expect(body).toEqual({ data: { product: null } });
    });
  });

  describe('input', () => {
    it.each([
      ['{ product(id: "x", sku: "y") { sku } }', 'both id and sku'],
      ['{ product { sku } }', 'neither id nor sku'],
      ['{ products(first: 51) { nodes { sku } } }', 'a page that is too large'],
      ['{ products(first: 0) { nodes { sku } } }', 'an empty page'],
      ['{ products(after: "not a sku!") { nodes { sku } } }', 'an after that is not a SKU'],
      ['{ search(query: "") { nodes { match } } }', 'an empty search'],
    ])('refuses %s (%s) with BAD_USER_INPUT', async (query) => {
      const w = await world();
      const { status, body } = await gql(query, { cookie: w.lena });
      expect(status).toBe(200);
      expect(body.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    });

    it.each([
      ['0', 'zero'],
      ['1.5', 'too many decimals for each'],
      ['-1', 'a negative quantity'],
      ['lots', 'not a number'],
    ])('refuses a quantity of %j (%s), and keeps the rest of the answer', async (quantity) => {
      const w = await world();
      const { body } = await gql(
        `query ($id: ID, $q: String) { product(id: $id) { sku price(quantity: $q) { unitPrice { amount } } } }`,
        { cookie: w.lena, variables: { id: w.glove.id, q: quantity } },
      );
      expect(body.data).toEqual({ product: { sku: 'GLV-NITRILE-L', price: null } });
      expect(body.errors?.map((e) => [e.path, e.extensions.code])).toEqual([
        [['product', 'price'], 'BAD_USER_INPUT'],
      ]);
    });

    it('refuses a unit the product is not sold in', async () => {
      const w = await world();
      const { body } = await gql(
        `query ($id: ID) { product(id: $id) { price(unitCode: "box_10") { unitPrice { amount } } } }`,
        { cookie: w.lena, variables: { id: w.glove.id } },
      );
      expect(body.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    });

    it.each([
      ['{ website { code ', 'GRAPHQL_PARSE_FAILED'],
      ['{ website { nope } }', 'GRAPHQL_VALIDATION_FAILED'],
      ['{ __schema { types { name } } }', null],
    ])('checks %j before running it', async (query, code) => {
      const w = await world();
      const { status, body } = await gql(query, { cookie: w.lena });
      if (code === null) {
        // Introspection runs only when ad hoc queries do (development).
        expect(status).toBe(200);
        return;
      }
      expect(status).toBe(400);
      expect(body.errors?.[0]?.extensions.code).toBe(code);
    });

    it('answers 400 for variables of the wrong type', async () => {
      const w = await world();
      const { status, body } = await gql(
        'query ($n: Int) { products(first: $n) { nodes { sku } } }',
        {
          cookie: w.lena,
          variables: { n: 'ten' },
        },
      );
      expect(status).toBe(400);
      expect(body.data).toBeUndefined();
    });
  });

  describe('limits', () => {
    it(`runs the deepest queries the schema allows, within ${MAX_DEPTH} levels`, async () => {
      // No type in the first schema refers back to an outer one, so no valid query is deeper
      // than 6 levels today. The limit is for later types; limits.test.ts measures depth itself.
      const w = await world();
      const deepest = `{ search(query: "x") { nodes { product { ...A } } } }
        fragment A on Product { price { unitPrice { ...B } } category { name } }
        fragment B on Money { amount }`;
      const { status, body } = await gql(deepest, { cookie: w.lena });
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
    });

    it(`refuses a query costing more than ${MAX_COST}`, async () => {
      const w = await world();
      const page = 'products(first: 50) { nodes { sku name price { unitPrice { amount } } } }';
      const aliases = Array.from({ length: 12 }, (_, i) => `p${i}: ${page}`).join(' ');
      const { status, body } = await gql(`{ ${aliases} }`, { cookie: w.lena });
      expect(status).toBe(400);
      expect(body.errors?.[0]).toMatchObject({
        extensions: { code: 'QUERY_TOO_COSTLY', limit: MAX_COST },
      });
      expect(logs.join('\n')).not.toContain('storefront.graphql');
    });

    it('refuses a document over the size limit', async () => {
      const w = await world();
      const { status } = await gql(`{ website { code } } ${'#'.repeat(20_001)}`, {
        cookie: w.lena,
      });
      expect(status).toBe(400);
    });
  });

  describe('persisted queries', () => {
    const text = 'query Shelf($first: Int) { products(first: $first) { nodes { sku } } }';
    const hash = queryHash(text);
    const production: StorefrontOptions = {
      persistedQueries: new Map([[hash, text]]),
      allowAdhocQueries: false,
    };

    it('runs a registered query by its hash, over POST and GET', async () => {
      const w = await world();
      const viaPost = await post(
        {
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
          variables: { first: 1 },
        },
        { cookie: w.ravi, storefront: production },
      );
      expect(viaPost.body).toEqual({ data: { products: { nodes: [{ sku: 'BRG-6205-2RS' }] } } });

      const params = new URLSearchParams({
        extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
        variables: JSON.stringify({ first: 1 }),
      });
      const viaGet = await app(production).request(`/storefront/v1/graphql?${params.toString()}`, {
        headers: { Cookie: w.ravi, 'Muziris-Website': 'muziris-in' },
      });
      expect(viaGet.status).toBe(200);
      expect(await viaGet.json()).toEqual({
        data: { products: { nodes: [{ sku: 'BRG-6205-2RS' }] } },
      });
    });

    it.each([
      [{ query: '{ website { code } }' }, 'PERSISTED_QUERY_REQUIRED'],
      [
        { extensions: { persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) } } },
        'PERSISTED_QUERY_NOT_FOUND',
      ],
      [
        { query: text, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
        'BAD_REQUEST',
      ],
      [{ extensions: { persistedQuery: { version: 2, sha256Hash: hash } } }, 'BAD_REQUEST'],
      [{}, 'BAD_REQUEST'],
    ])('in production refuses %j with %s', async (body, code) => {
      const w = await world();
      const res = await post(body, { cookie: w.lena, storefront: production });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.extensions.code).toBe(code);
    });

    it('refuses introspection in production, even when registered', async () => {
      const w = await world();
      const introspection = '{ __schema { queryType { name } } }';
      const res = await post(
        { extensions: { persistedQuery: { version: 1, sha256Hash: queryHash(introspection) } } },
        {
          cookie: w.lena,
          storefront: {
            persistedQueries: new Map([[queryHash(introspection), introspection]]),
            allowAdhocQueries: false,
          },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('runs only persisted queries over GET, even in development', async () => {
      const w = await world();
      const params = new URLSearchParams({ query: '{ website { code } }' });
      const res = await app().request(`/storefront/v1/graphql?${params.toString()}`, {
        headers: { Cookie: w.lena, 'Muziris-Website': 'muziris-in' },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as GraphqlResponse).errors?.[0]?.extensions.code).toBe(
        'PERSISTED_QUERY_REQUIRED',
      );
    });

    it('refuses a body that is not JSON', async () => {
      const w = await world();
      const res = await app().request('/storefront/v1/graphql', {
        method: 'POST',
        headers: {
          Cookie: w.lena,
          Origin: ORIGIN,
          'Content-Type': 'text/plain',
          'Muziris-Website': 'muziris-in',
        },
        body: '{ website { code } }',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('batching', () => {
    it('reads 50 products with categories and prices in a fixed number of queries', async () => {
      const w = await world();
      await handle.db.execute(sql`
        insert into catalog_product (sku, name, status, category_id)
        select 'GEN-' || lpad(n::text, 3, '0'), 'Generic part ' || n, 'enabled', ${w.safety.id}::uuid
        from generate_series(1, 120) n`);
      await handle.db.execute(sql`
        insert into catalog_product_sold_in (product_id, unit_code, is_primary)
        select id, 'each', true from catalog_product where sku like 'GEN-%'`);
      await Promise.all([rebuildVisibility(handle.db), rebuildSearchIndex(handle.db)]);

      const count = async (query: string) => {
        queries = 0;
        const { body } = await gql(query, { cookie: w.lena, db: counted.db });
        expect(body.errors).toBeUndefined();
        return queries;
      };
      const card = 'sku name category { name } units { code } price { unitPrice { amount } }';
      const ten = await count(`{ products(first: 10) { nodes { ${card} } } }`);
      const fifty = await count(`{ products(first: 50) { nodes { ${card} } } }`);
      // Session, website, products, their units, categories, prices: the same for 10 or 50.
      expect(fifty).toBe(ten);
      expect(fifty).toBeLessThanOrEqual(10);

      const searchTen = await count(
        `{ search(query: "generic", first: 10) { nodes { product { ${card} } } } }`,
      );
      const searchFifty = await count(
        `{ search(query: "generic", first: 50) { nodes { product { ${card} } } } }`,
      );
      expect(searchFifty).toBe(searchTen);
    });
  });

  describe('errors and logs', () => {
    it('hides internal errors and keeps their details in the logs', async () => {
      const w = await world();
      // A database that fails on price lookups, as if a table were missing.
      const failing = new Proxy(handle.db, {
        get(target, key, receiver) {
          if (key === 'execute') {
            return (query: unknown) => {
              if (new Error().stack?.includes('findPricesForBuyer')) {
                return Promise.reject(new Error('relation "secret_internal_table" does not exist'));
              }
              return target.execute(query as Parameters<Database['execute']>[0]);
            };
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const { status, body } = await gql(
        '{ products { nodes { sku price { unitPrice { amount } } } } }',
        { cookie: w.lena, db: failing },
      );
      expect(status).toBe(200);
      expect(JSON.stringify(body)).not.toContain('secret_internal_table');
      expect(body.errors?.[0]).toMatchObject({
        message: 'Something went wrong on our side',
        extensions: { code: 'INTERNAL_ERROR' },
      });
      expect(logs.join('\n')).toContain('secret_internal_table');
    });

    it('never logs query text or variables', async () => {
      const w = await world();
      await gql('query ($q: String!) { search(query: $q) { nodes { match } } }', {
        cookie: w.lena,
        variables: { q: 'confidential-term-1234' },
      });
      const all = logs.join('\n');
      expect(all).toContain('storefront.graphql');
      expect(all).not.toContain('confidential-term-1234');
      expect(all).not.toContain('search(query');
    });
  });
});
