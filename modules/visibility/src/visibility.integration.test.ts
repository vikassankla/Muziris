import {
  createCategory,
  createProduct,
  createProductUnit,
  updateProduct,
  type Category,
} from '@muziris/catalog';
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
import { createOrganization, createWebsite } from '@muziris/platform';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRule,
  deleteRule,
  getBuildState,
  listRules,
  listVisibleProducts,
  previewVisibility,
  rebuildVisibility,
  updateRule,
  visibleCategoryIdsForBuyer,
  visibleProductIdsForBuyer,
  VisibilityError,
  type VisibilityErrorCode,
  type VisibilityPreview,
} from './index.js';
import {
  CATEGORY_CASES,
  CATEGORY_CODES,
  CATEGORY_PARENTS,
  FALLBACK_CASES,
  INHERITANCE_CASES,
  type CaseTarget,
  type CategoryCode,
  type DecidedBy,
  type RuleSpec,
} from './test/known-answers.js';

const url = process.env['TEST_DATABASE_URL'];

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const PASSWORD = 'correct horse battery staple';

async function expectRefused(promise: Promise<unknown>, code: VisibilityErrorCode) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(VisibilityError);
  expect((error as VisibilityError).code).toBe(code);
}

describe.skipIf(!url)('visibility against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'visibility');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate visibility_visible_product, visibility_visible_category, visibility_context,
        visibility_rule, visibility_build_state, catalog_product_sold_in, catalog_product,
        catalog_category, catalog_product_unit, customer_buyer_user, customer_customer,
        customer_group, identity_session, identity_user, platform_website, platform_organization
        cascade`,
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

  /**
   * Two websites, the category tree of the known-answer tables, one product, and two customers
   * in two customer groups, each with a buyer user. `inGroup: false` leaves the case's customer
   * out of its group.
   */
  async function world(
    options: { category?: CategoryCode | null; enabled?: boolean; inGroup?: boolean } = {},
  ) {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    const site = (code: string) =>
      createWebsite(handle.db, {
        organizationId: org.id,
        code,
        name: code,
        countryCode: 'IN',
        defaultCurrency: 'INR',
        defaultLocale: 'en-IN',
        timeZone: 'Asia/Kolkata',
      });
    const website = await site('muziris-in');
    const otherWebsite = await site('muziris-in-b');
    await createProductUnit(handle.db, { code: 'each', name: 'Each', precision: 0 });
    const categories = {} as Record<CategoryCode, Category>;
    for (const code of CATEGORY_CODES) {
      const parent = CATEGORY_PARENTS[code];
      categories[code] = await createCategory(handle.db, {
        code,
        name: code,
        parentId: parent === null ? null : categories[parent].id,
      });
    }
    const category = options.category === undefined ? 'ball' : options.category;
    const product = await createProduct(handle.db, {
      sku: 'BRG-6205-2RS',
      name: 'Ball bearing 6205-2RS',
      status: options.enabled === false ? 'disabled' : 'enabled',
      categoryId: category === null ? null : categories[category].id,
      primaryUnitCode: 'each',
    });
    const group = await createCustomerGroup(handle.db, { code: 'distributors', name: 'Dist' });
    const otherGroup = await createCustomerGroup(handle.db, { code: 'retail', name: 'Retail' });
    const customer = await createCustomer(handle.db, {
      name: 'Pune Bearing House',
      groupId: options.inGroup === false ? null : group.id,
    });
    const otherCustomer = await createCustomer(handle.db, {
      name: 'Rival Traders',
      groupId: otherGroup.id,
    });
    const buyerId = await buyer(customer.id, 'asha@pune.example');
    const otherBuyerId = await buyer(otherCustomer.id, 'ravi@rival.example');
    return {
      website,
      otherWebsite,
      categories,
      product,
      group,
      otherGroup,
      customer,
      otherCustomer,
      buyerId,
      otherBuyerId,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** Writes a known-answer rule through the module, for the right ids in the world. */
  async function addRule(w: World, spec: RuleSpec) {
    const targets: Record<CaseTarget, [string, 'customer' | 'customer_group' | 'website', string]> =
      {
        customer: [w.website.id, 'customer', w.customer.id],
        customer_group: [w.website.id, 'customer_group', w.group.id],
        website: [w.website.id, 'website', w.website.id],
        other_customer: [w.website.id, 'customer', w.otherCustomer.id],
        other_group: [w.website.id, 'customer_group', w.otherGroup.id],
        other_website: [w.otherWebsite.id, 'website', w.otherWebsite.id],
      };
    const [websiteId, target, targetId] = targets[spec.target];
    return createRule(handle.db, {
      websiteId,
      target,
      targetId,
      subject: spec.subject === 'product' ? 'product' : 'category',
      subjectId: spec.subject === 'product' ? w.product.id : w.categories[spec.subject].id,
      visibility: spec.visibility,
    });
  }

  async function selects(ids: SQL, column: 'product_id' | 'category_id', id: string) {
    const [row] = await handle.db.execute<{ found: boolean }>(
      sql`select exists (select 1 from (${ids}) v where v.${sql.raw(column)} = ${id}) as found`,
    );
    return row?.found ?? false;
  }

  async function ids(select: SQL): Promise<string[]> {
    const rows = await handle.db.execute<{ id: string }>(
      sql`select v.id::text as id from (${select}) v(id) order by 1`,
    );
    return rows.map((r) => r.id);
  }

  function decidedBy(w: World, preview: VisibilityPreview): DecidedBy {
    if (preview.rule === null) return preview.reason === 'disabled' ? 'disabled' : 'default';
    const code =
      preview.rule.subject === 'product'
        ? 'product'
        : CATEGORY_CODES.find((c) => w.categories[c].id === preview.rule?.subjectId);
    return `${preview.rule.target}:${code ?? '?'}` as DecidedBy;
  }

  describe('known answers through the build and the buyer-scoped selects', () => {
    it.each([...FALLBACK_CASES, ...INHERITANCE_CASES].map((c) => [c.title, c] as const))(
      'product: %s',
      async (_, c) => {
        const w = await world({ category: c.category, enabled: c.enabled, inGroup: c.inGroup });
        for (const spec of c.rules) await addRule(w, spec);
        await rebuildVisibility(handle.db);

        const forBuyer = visibleProductIdsForBuyer({
          buyerUserId: w.buyerId,
          websiteId: w.website.id,
        });
        expect(await selects(forBuyer, 'product_id', w.product.id)).toBe(c.expected.visible);

        const preview = await previewVisibility(handle.db, {
          websiteId: w.website.id,
          customerId: w.customer.id,
          productId: w.product.id,
        });
        expect({ visible: preview.visible, decidedBy: decidedBy(w, preview) }).toEqual(c.expected);
        expect(preview.built).toMatchObject({ visible: c.expected.visible, needsRebuild: false });
      },
    );

    it.each(CATEGORY_CASES.map((c) => [`${c.category}: ${c.title}`, c] as const))(
      'category %s',
      async (_, c) => {
        const w = await world();
        for (const spec of c.rules) await addRule(w, spec);
        await rebuildVisibility(handle.db);

        const forBuyer = visibleCategoryIdsForBuyer({
          buyerUserId: w.buyerId,
          websiteId: w.website.id,
        });
        const id = w.categories[c.category].id;
        expect(await selects(forBuyer, 'category_id', id)).toBe(c.expected.visible);

        const preview = await previewVisibility(handle.db, {
          websiteId: w.website.id,
          customerId: w.customer.id,
          categoryId: id,
        });
        expect({ visible: preview.visible, decidedBy: decidedBy(w, preview) }).toEqual(c.expected);
        expect(preview.built.visible).toBe(c.expected.visible);
      },
    );
  });

  it('shows each buyer only their own catalog', async () => {
    const w = await world();
    const hose = await createProduct(handle.db, {
      sku: 'HOSE-25',
      name: 'Hydraulic hose 25 mm',
      status: 'enabled',
      categoryId: w.categories.safety.id,
      primaryUnitCode: 'each',
    });
    // Bearings are for distributors only; one retail customer gets the hose hidden.
    await addRule(w, { target: 'website', subject: 'bearings', visibility: 'hidden' });
    await addRule(w, { target: 'customer_group', subject: 'bearings', visibility: 'visible' });
    await createRule(handle.db, {
      websiteId: w.website.id,
      subject: 'product',
      subjectId: hose.id,
      target: 'customer',
      targetId: w.otherCustomer.id,
      visibility: 'hidden',
    });
    await rebuildVisibility(handle.db);

    const seen = (buyerUserId: string) =>
      ids(visibleProductIdsForBuyer({ buyerUserId, websiteId: w.website.id }));
    expect(await seen(w.buyerId)).toEqual([w.product.id, hose.id].sort());
    expect(await seen(w.otherBuyerId)).toEqual([]);

    // The same select is a filter inside another query, as search will use it.
    const [row] = await handle.db.execute<{ n: string }>(
      sql`select count(*)::text as n from (values (${w.product.id}::uuid), (${hose.id}::uuid)) p(id)
        where p.id in (${visibleProductIdsForBuyer({ buyerUserId: w.otherBuyerId, websiteId: w.website.id })})`,
    );
    expect(row?.n).toBe('0');
  });

  it('shows nothing to an unknown user, an admin user, or before the first build', async () => {
    const w = await world();
    const forBuyer = (buyerUserId: string) =>
      ids(visibleProductIdsForBuyer({ buyerUserId, websiteId: w.website.id }));
    expect(await forBuyer(w.buyerId)).toEqual([]);

    await rebuildVisibility(handle.db);
    expect(await forBuyer(w.buyerId)).toEqual([w.product.id]);
    const admin = await createUser(handle.db, {
      realm: 'admin',
      email: 'meera@muziris.example',
      displayName: 'Meera',
      password: PASSWORD,
    });
    expect(await forBuyer(admin.id)).toEqual([]);
    expect(await forBuyer(MISSING_ID)).toEqual([]);
  });

  it('hides a product disabled after the build at once, and shows new products after a build', async () => {
    const w = await world();
    await rebuildVisibility(handle.db);
    const seen = () =>
      ids(visibleProductIdsForBuyer({ buyerUserId: w.buyerId, websiteId: w.website.id }));
    expect(await seen()).toEqual([w.product.id]);

    await updateProduct(handle.db, w.product.id, { status: 'disabled' });
    expect(await seen()).toEqual([]);

    await updateProduct(handle.db, w.product.id, { status: 'enabled' });
    const added = await createProduct(handle.db, {
      sku: 'BRG-6206',
      name: 'Ball bearing 6206',
      status: 'enabled',
      primaryUnitCode: 'each',
    });
    expect(await seen()).toEqual([w.product.id]);
    await rebuildVisibility(handle.db);
    expect(await seen()).toEqual([w.product.id, added.id].sort());
  });

  it('shows nothing to a customer with its own rules that changed group, until a build', async () => {
    const w = await world();
    await addRule(w, { target: 'customer', subject: 'safety', visibility: 'hidden' });
    await addRule(w, { target: 'customer_group', subject: 'product', visibility: 'hidden' });
    await rebuildVisibility(handle.db);
    const seen = (buyerUserId: string) =>
      ids(visibleProductIdsForBuyer({ buyerUserId, websiteId: w.website.id }));
    expect(await seen(w.buyerId)).toEqual([]);
    expect(await seen(w.otherBuyerId)).toEqual([w.product.id]);

    // Moved to the retail group: the customer's own context was built with distributors.
    await setCustomerGroup(handle.db, w.customer.id, w.otherGroup.id);
    expect(await seen(w.buyerId)).toEqual([]);
    const preview = await previewVisibility(handle.db, {
      websiteId: w.website.id,
      customerId: w.customer.id,
      productId: w.product.id,
    });
    expect(preview).toMatchObject({
      visible: true,
      reason: 'default',
      built: { visible: false, context: null, needsRebuild: true },
    });
    await rebuildVisibility(handle.db);
    expect(await seen(w.buyerId)).toEqual([w.product.id]);

    // A customer without its own rules follows a group change at once.
    await setCustomerGroup(handle.db, w.otherCustomer.id, w.group.id);
    expect(await seen(w.otherBuyerId)).toEqual([]);
  });

  it('counts rule changes until a build, and records what the build did', async () => {
    const w = await world();
    expect(await getBuildState(handle.db)).toEqual({ pendingChanges: 0, lastBuild: null });

    const rule = await addRule(w, { target: 'website', subject: 'power', visibility: 'hidden' });
    await updateRule(handle.db, rule.id, { visibility: 'visible' });
    expect((await getBuildState(handle.db)).pendingChanges).toBe(2);

    const admin = await createUser(handle.db, {
      realm: 'admin',
      email: 'meera@muziris.example',
      displayName: 'Meera',
      password: PASSWORD,
    });
    const result = await rebuildVisibility(handle.db, { builtBy: admin.id });
    // Default and the website's context; four categories and one product in each.
    expect(result).toMatchObject({
      contextCount: 2,
      visibleCategoryCount: 8,
      visibleProductCount: 2,
    });
    const state = await getBuildState(handle.db);
    expect(state.pendingChanges).toBe(0);
    expect(state.lastBuild).toMatchObject({ builtBy: admin.id, contextCount: 2 });

    await deleteRule(handle.db, rule.id);
    expect((await getBuildState(handle.db)).pendingChanges).toBe(1);
  });

  it('refuses rules for missing records and a second rule for the same subject and target', async () => {
    const w = await world();
    const base = {
      websiteId: w.website.id,
      subject: 'product' as const,
      subjectId: w.product.id,
      target: 'website' as const,
      visibility: 'hidden' as const,
    };
    await createRule(handle.db, base);
    await expectRefused(createRule(handle.db, { ...base, visibility: 'visible' }), 'rule_taken');
    await expectRefused(
      createRule(handle.db, { ...base, websiteId: MISSING_ID, targetId: MISSING_ID }),
      'website_not_found',
    );
    await expectRefused(
      createRule(handle.db, { ...base, subjectId: MISSING_ID }),
      'product_not_found',
    );
    await expectRefused(
      createRule(handle.db, { ...base, subject: 'category', subjectId: MISSING_ID }),
      'category_not_found',
    );
    await expectRefused(
      createRule(handle.db, { ...base, target: 'customer', targetId: MISSING_ID }),
      'customer_not_found',
    );
    await expectRefused(
      createRule(handle.db, { ...base, target: 'customer_group', targetId: MISSING_ID }),
      'customer_group_not_found',
    );
    await expectRefused(
      updateRule(handle.db, MISSING_ID, { visibility: 'visible' }),
      'rule_not_found',
    );
    await expectRefused(deleteRule(handle.db, MISSING_ID), 'rule_not_found');
    await expect(createRule(handle.db, { ...base, targetId: w.otherWebsite.id })).rejects.toThrow(
      /targets its own website/,
    );
    // The database refuses what the code would: a website rule for another website's id.
    await expect(
      handle.db.execute(
        sql`insert into visibility_rule (website_id, subject, subject_id, target, target_id, visibility)
          values (${w.website.id}, 'product', ${w.product.id}, 'website', ${w.otherWebsite.id}, 'hidden')`,
      ),
    ).rejects.toThrow();
    expect((await getBuildState(handle.db)).pendingChanges).toBe(1);
  });

  it('lists rules a page at a time in fallback order, with filters', async () => {
    const w = await world();
    const website = await addRule(w, { target: 'website', subject: 'power', visibility: 'hidden' });
    const group = await addRule(w, {
      target: 'customer_group',
      subject: 'bearings',
      visibility: 'visible',
    });
    const customer = await addRule(w, {
      target: 'customer',
      subject: 'product',
      visibility: 'hidden',
    });
    const first = await listRules(handle.db, { websiteId: w.website.id, limit: 2 });
    expect(first.rules.map((r) => r.id)).toEqual([customer.id, group.id]);
    expect(first.nextAfter).toBe(group.id);
    const second = await listRules(handle.db, {
      websiteId: w.website.id,
      limit: 2,
      after: first.nextAfter ?? undefined,
    });
    expect(second).toEqual({ rules: [website], nextAfter: null });
    expect(
      (await listRules(handle.db, { subject: 'category', target: 'customer_group' })).rules,
    ).toEqual([group]);
    expect((await listRules(handle.db, { websiteId: w.otherWebsite.id })).rules).toEqual([]);
  });

  it('lists the products a customer sees a page at a time', async () => {
    const w = await world();
    const more = [];
    for (const sku of ['A-1', 'A-2', 'A-3']) {
      more.push(
        await createProduct(handle.db, {
          sku,
          name: sku,
          status: 'enabled',
          primaryUnitCode: 'each',
        }),
      );
    }
    await rebuildVisibility(handle.db);
    const all = [w.product.id, ...more.map((p) => p.id)].sort();
    const query = { websiteId: w.website.id, customerId: w.customer.id, limit: 3 };
    const first = await listVisibleProducts(handle.db, query);
    expect(first).toEqual({ productIds: all.slice(0, 3), nextAfter: all[2] });
    const second = await listVisibleProducts(handle.db, {
      ...query,
      after: first.nextAfter ?? undefined,
    });
    expect(second).toEqual({ productIds: all.slice(3), nextAfter: null });
    await expectRefused(
      listVisibleProducts(handle.db, { ...query, customerId: MISSING_ID }),
      'customer_not_found',
    );
    await expectRefused(
      listVisibleProducts(handle.db, { ...query, websiteId: MISSING_ID }),
      'website_not_found',
    );
  });

  it('serves a website without rules from the default context', async () => {
    const w = await world();
    await addRule(w, { target: 'other_website', subject: 'product', visibility: 'hidden' });
    await rebuildVisibility(handle.db);
    const preview = await previewVisibility(handle.db, {
      websiteId: w.website.id,
      customerId: w.customer.id,
      productId: w.product.id,
    });
    expect(preview.built).toEqual({ visible: true, context: 'default', needsRebuild: false });
    const other = await previewVisibility(handle.db, {
      websiteId: w.otherWebsite.id,
      customerId: w.customer.id,
      productId: w.product.id,
    });
    expect(other).toMatchObject({
      visible: false,
      built: { visible: false, context: 'website' },
    });
  });
});
