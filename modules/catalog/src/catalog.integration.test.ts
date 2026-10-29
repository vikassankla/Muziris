import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogError,
  categoryNames,
  categoryParents,
  createCategory,
  createProduct,
  createProductUnit,
  deleteCategory,
  descendantCategoryIds,
  findProduct,
  findProductBySku,
  findProductUnit,
  listCategories,
  listProducts,
  listProductUnits,
  parseQuantity,
  productCategoryAndStatus,
  productSearchSource,
  quantityToString,
  setCategoryParent,
  setProductUnits,
  updateCategory,
  updateProduct,
  type CatalogErrorCode,
  type Category,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

async function expectRefused(promise: Promise<unknown>, code: CatalogErrorCode) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CatalogError);
  expect((error as CatalogError).code).toBe(code);
}

describe.skipIf(!url)('catalog module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'catalog');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate catalog_product_sold_in, catalog_product, catalog_category,
        catalog_product_unit cascade`,
    );
    const db = handle.db;
    await createProductUnit(db, { code: 'each', name: 'Each', precision: 0 });
    await createProductUnit(db, { code: 'box_10', name: 'Box of 10', precision: 0 });
    await createProductUnit(db, { code: 'kg', name: 'Kilogram', precision: 3 });
  });

  afterAll(async () => {
    await handle.close();
  });

  /**
   * Fasteners
   * ├── Bolts
   * │   └── Hex bolts
   * └── Nuts
   * Safety
   */
  async function seedTree() {
    const db = handle.db;
    const fasteners = await createCategory(db, { code: 'fasteners', name: 'Fasteners' });
    const bolts = await createCategory(db, {
      code: 'bolts',
      name: 'Bolts',
      parentId: fasteners.id,
    });
    const hex = await createCategory(db, {
      code: 'hex_bolts',
      name: 'Hex bolts',
      parentId: bolts.id,
    });
    const nuts = await createCategory(db, {
      code: 'nuts',
      name: 'Nuts',
      parentId: fasteners.id,
      position: 1,
    });
    const safety = await createCategory(db, { code: 'safety', name: 'Safety', position: 1 });
    return { fasteners, bolts, hex, nuts, safety };
  }

  async function ids(select: ReturnType<typeof descendantCategoryIds>, all: Category[]) {
    const rows = await handle.db.execute<{ id: string }>(select);
    return rows.map((r) => all.find((c) => c.id === r.id)?.code).sort();
  }

  describe('product units', () => {
    it('lists product units with their precision, by code', async () => {
      expect(await listProductUnits(handle.db)).toEqual([
        { code: 'box_10', name: 'Box of 10', precision: 0 },
        { code: 'each', name: 'Each', precision: 0 },
        { code: 'kg', name: 'Kilogram', precision: 3 },
      ]);
      expect(await findProductUnit(handle.db, 'kg')).toEqual({
        code: 'kg',
        name: 'Kilogram',
        precision: 3,
      });
      expect(await findProductUnit(handle.db, 'KG; drop')).toBeUndefined();
    });

    it('refuses a code that is taken', async () => {
      await expectRefused(
        createProductUnit(handle.db, { code: 'kg', name: 'Kilo', precision: 2 }),
        'product_unit_code_taken',
      );
    });

    it('reads a quantity at the precision stored for the unit', async () => {
      const kg = await findProductUnit(handle.db, 'kg');
      if (!kg) throw new Error('kg missing');
      expect(quantityToString(parseQuantity('2.5', kg))).toBe('2.500');
      expect(() => parseQuantity('2.5005', kg)).toThrow(RangeError);
    });

    it('enforces the precision range in the database too', async () => {
      await expect(
        handle.db.execute(
          sql`insert into catalog_product_unit (code, name, precision) values ('ml', 'ml', 7)`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('categories', () => {
    it('lists the tree and walks subcategories', async () => {
      const tree = await seedTree();
      const all = await listCategories(handle.db);
      expect(all.map((c) => c.code)).toEqual(['bolts', 'fasteners', 'hex_bolts', 'nuts', 'safety']);
      expect(await ids(descendantCategoryIds(tree.fasteners.id), all)).toEqual([
        'bolts',
        'hex_bolts',
        'nuts',
      ]);
      expect(await ids(descendantCategoryIds(tree.hex.id), all)).toEqual([]);
    });

    it('selects every category with its parent for other modules', async () => {
      const tree = await seedTree();
      const rows = await handle.db.execute<{ category_id: string; parent_id: string | null }>(
        sql`select category_id, parent_id from (${categoryParents()}) c`,
      );
      const byId = new Map(rows.map((r) => [r.category_id, r.parent_id]));
      expect(byId.size).toBe(5);
      expect(byId.get(tree.hex.id)).toBe(tree.bolts.id);
      expect(byId.get(tree.bolts.id)).toBe(tree.fasteners.id);
      expect(byId.get(tree.fasteners.id)).toBeNull();
    });

    it('selects every category with its parent and name for other modules', async () => {
      const tree = await seedTree();
      const rows = await handle.db.execute<{
        category_id: string;
        parent_id: string | null;
        name: string;
      }>(sql`select category_id, parent_id, name from (${categoryNames()}) c`);
      const byId = new Map(rows.map((r) => [r.category_id, r]));
      expect(byId.size).toBe(5);
      expect(byId.get(tree.hex.id)).toEqual({
        category_id: tree.hex.id,
        parent_id: tree.bolts.id,
        name: tree.hex.name,
      });
    });

    it('refuses a code that is taken and a missing parent', async () => {
      await seedTree();
      await expectRefused(
        createCategory(handle.db, { code: 'bolts', name: 'Bolts 2' }),
        'category_code_taken',
      );
      await expectRefused(
        createCategory(handle.db, { code: 'washers', name: 'Washers', parentId: MISSING_ID }),
        'category_not_found',
      );
    });

    it('renames and reorders a category', async () => {
      const { nuts } = await seedTree();
      const updated = await updateCategory(handle.db, nuts.id, {
        name: 'Nuts and washers',
        position: 0,
      });
      expect(updated).toMatchObject({
        name: 'Nuts and washers',
        position: 0,
        parentId: nuts.parentId,
      });
      await expectRefused(
        updateCategory(handle.db, MISSING_ID, { name: 'X' }),
        'category_not_found',
      );
    });

    it('moves a category, and refuses moves that would form a cycle', async () => {
      const t = await seedTree();
      const moved = await setCategoryParent(handle.db, t.bolts.id, t.safety.id);
      expect(moved.parentId).toBe(t.safety.id);
      await expectRefused(setCategoryParent(handle.db, t.safety.id, t.safety.id), 'category_cycle');
      await expectRefused(setCategoryParent(handle.db, t.safety.id, t.hex.id), 'category_cycle');
      await expectRefused(
        setCategoryParent(handle.db, t.bolts.id, MISSING_ID),
        'category_not_found',
      );
      await expectRefused(setCategoryParent(handle.db, MISSING_ID, null), 'category_not_found');
      expect((await setCategoryParent(handle.db, t.bolts.id, null)).parentId).toBeNull();
    });

    it('serialises crossing moves, so they cannot form a cycle together', async () => {
      const a = await createCategory(handle.db, { code: 'a_cat', name: 'A' });
      const b = await createCategory(handle.db, { code: 'b_cat', name: 'B' });
      const results = await Promise.allSettled([
        setCategoryParent(handle.db, a.id, b.id),
        setCategoryParent(handle.db, b.id, a.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected?.reason as CatalogError).code).toBe('category_cycle');
    });

    it('deletes only an empty category', async () => {
      const t = await seedTree();
      await createProduct(handle.db, {
        sku: 'NUT-M8',
        name: 'Nut M8',
        primaryUnitCode: 'each',
        categoryId: t.nuts.id,
      });
      await expectRefused(deleteCategory(handle.db, t.bolts.id), 'category_not_empty');
      await expectRefused(deleteCategory(handle.db, t.nuts.id), 'category_not_empty');
      await deleteCategory(handle.db, t.hex.id);
      await deleteCategory(handle.db, t.bolts.id);
      await expectRefused(deleteCategory(handle.db, t.bolts.id), 'category_not_found');
    });
  });

  describe('products', () => {
    it('creates a simple product with its units and attributes', async () => {
      const { hex } = await seedTree();
      const product = await createProduct(handle.db, {
        sku: 'BLT-M8-40',
        name: 'Hex bolt M8 x 40',
        status: 'enabled',
        categoryId: hex.id,
        attributes: { material: 'stainless steel', thread_pitch_mm: '1.25', rohs_compliant: true },
        primaryUnitCode: 'each',
        additionalUnitCodes: ['kg', 'box_10'],
      });
      expect(product).toMatchObject({
        sku: 'BLT-M8-40',
        type: 'simple',
        status: 'enabled',
        categoryId: hex.id,
        attributes: { material: 'stainless steel', thread_pitch_mm: '1.25', rohs_compliant: true },
        primaryUnitCode: 'each',
        units: [
          { code: 'each', name: 'Each', precision: 0 },
          { code: 'box_10', name: 'Box of 10', precision: 0 },
          { code: 'kg', name: 'Kilogram', precision: 3 },
        ],
      });
      expect(await findProduct(handle.db, product.id)).toEqual(product);
      expect(await findProductBySku(handle.db, 'blt-m8-40')).toEqual(product);
      expect(await findProduct(handle.db, MISSING_ID)).toBeUndefined();
    });

    it('refuses a SKU taken in any letter case, and writes nothing', async () => {
      await createProduct(handle.db, { sku: 'BLT-M8-40', name: 'Bolt', primaryUnitCode: 'each' });
      await expectRefused(
        createProduct(handle.db, { sku: 'blt-m8-40', name: 'Bolt', primaryUnitCode: 'each' }),
        'sku_taken',
      );
      const rows = await handle.db.execute(sql`select count(*)::int as n from catalog_product`);
      expect(rows[0]).toEqual({ n: 1 });
    });

    it('refuses a missing unit or category without leaving a product behind', async () => {
      await expectRefused(
        createProduct(handle.db, {
          sku: 'A1',
          name: 'A',
          primaryUnitCode: 'each',
          additionalUnitCodes: ['litre'],
        }),
        'product_unit_not_found',
      );
      await expectRefused(
        createProduct(handle.db, {
          sku: 'A1',
          name: 'A',
          primaryUnitCode: 'each',
          categoryId: MISSING_ID,
        }),
        'category_not_found',
      );
      expect((await listProducts(handle.db)).products).toEqual([]);
    });

    it('updates fields and replaces attributes', async () => {
      const product = await createProduct(handle.db, {
        sku: 'BLT-1',
        name: 'Bolt',
        attributes: { colour: 'zinc', grade: '8.8' },
        primaryUnitCode: 'each',
      });
      const updated = await updateProduct(handle.db, product.id, {
        sku: 'BLT-2',
        status: 'enabled',
        attributes: { grade: '10.9' },
      });
      expect(updated).toMatchObject({
        sku: 'BLT-2',
        name: 'Bolt',
        status: 'enabled',
        attributes: { grade: '10.9' },
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(product.updatedAt.getTime());

      await createProduct(handle.db, { sku: 'NUT-1', name: 'Nut', primaryUnitCode: 'each' });
      await expectRefused(updateProduct(handle.db, product.id, { sku: 'nut-1' }), 'sku_taken');
      await expectRefused(
        updateProduct(handle.db, product.id, { categoryId: MISSING_ID }),
        'category_not_found',
      );
      await expectRefused(updateProduct(handle.db, MISSING_ID, { name: 'X' }), 'product_not_found');
    });

    it('replaces the units a product is sold in', async () => {
      const product = await createProduct(handle.db, {
        sku: 'CBL-1',
        name: 'Cable',
        primaryUnitCode: 'each',
        additionalUnitCodes: ['box_10'],
      });
      const updated = await setProductUnits(handle.db, product.id, {
        primaryUnitCode: 'kg',
        additionalUnitCodes: ['each'],
      });
      expect(updated.primaryUnitCode).toBe('kg');
      expect(updated.units.map((u) => u.code)).toEqual(['kg', 'each']);

      await expectRefused(
        setProductUnits(handle.db, product.id, { primaryUnitCode: 'litre' }),
        'product_unit_not_found',
      );
      expect((await findProduct(handle.db, product.id))?.units.map((u) => u.code)).toEqual([
        'kg',
        'each',
      ]);
      await expectRefused(
        setProductUnits(handle.db, MISSING_ID, { primaryUnitCode: 'each' }),
        'product_not_found',
      );
    });

    it('keeps exactly one primary unit when units are set at the same moment', async () => {
      const product = await createProduct(handle.db, {
        sku: 'CBL-1',
        name: 'Cable',
        primaryUnitCode: 'each',
      });
      await Promise.all([
        setProductUnits(handle.db, product.id, { primaryUnitCode: 'kg' }),
        setProductUnits(handle.db, product.id, {
          primaryUnitCode: 'box_10',
          additionalUnitCodes: ['each'],
        }),
      ]);
      const rows = await handle.db.execute(
        sql`select count(*)::int as n from catalog_product_sold_in where product_id = ${product.id} and is_primary`,
      );
      expect(rows[0]).toEqual({ n: 1 });
    });

    it('refuses to delete a product unit a product is sold in', async () => {
      await createProduct(handle.db, { sku: 'A1', name: 'A', primaryUnitCode: 'kg' });
      await expect(
        handle.db.execute(sql`delete from catalog_product_unit where code = 'kg'`),
      ).rejects.toThrow();
    });

    it('refuses attributes that are not a JSON object in the database too', async () => {
      await expect(
        handle.db.execute(
          sql`insert into catalog_product (sku, name, attributes) values ('X1', 'X', '[1]'::jsonb)`,
        ),
      ).rejects.toThrow();
    });

    it('pages through products by SKU and filters by category and status', async () => {
      const t = await seedTree();
      const make = (
        sku: string,
        categoryId: string | null,
        status: 'enabled' | 'disabled' = 'enabled',
      ) =>
        createProduct(handle.db, { sku, name: sku, categoryId, status, primaryUnitCode: 'each' });
      await make('c-300', t.hex.id);
      await make('A-100', t.bolts.id);
      await make('b-200', t.nuts.id, 'disabled');
      await make('D-400', t.safety.id);
      await make('E-500', null);

      const first = await listProducts(handle.db, { limit: 2 });
      expect(first.products.map((p) => p.sku)).toEqual(['A-100', 'b-200']);
      expect(first.nextAfter).toBe('b-200');
      const second = await listProducts(handle.db, { limit: 2, after: 'B-200' });
      expect(second.products.map((p) => p.sku)).toEqual(['c-300', 'D-400']);
      const last = await listProducts(handle.db, { limit: 2, after: 'D-400' });
      expect(last).toMatchObject({ nextAfter: null });
      expect(last.products.map((p) => p.sku)).toEqual(['E-500']);

      const inBolts = await listProducts(handle.db, { categoryId: t.bolts.id });
      expect(inBolts.products.map((p) => p.sku)).toEqual(['A-100']);
      const underFasteners = await listProducts(handle.db, {
        categoryId: t.fasteners.id,
        includeSubcategories: true,
      });
      expect(underFasteners.products.map((p) => p.sku)).toEqual(['A-100', 'b-200', 'c-300']);
      const enabledUnderFasteners = await listProducts(handle.db, {
        categoryId: t.fasteners.id,
        includeSubcategories: true,
        status: 'enabled',
      });
      expect(enabledUnderFasteners.products.map((p) => p.sku)).toEqual(['A-100', 'c-300']);
    });

    it('selects every product with its category and status for other modules', async () => {
      const t = await seedTree();
      const bolt = await createProduct(handle.db, {
        sku: 'HB-M8',
        name: 'Hex bolt M8',
        status: 'enabled',
        categoryId: t.hex.id,
        primaryUnitCode: 'each',
      });
      const loose = await createProduct(handle.db, {
        sku: 'LOOSE-1',
        name: 'Loose part',
        primaryUnitCode: 'each',
      });
      const rows = await handle.db.execute<{
        product_id: string;
        category_id: string | null;
        status: string;
      }>(sql`select product_id, category_id, status from (${productCategoryAndStatus()}) p
        order by status desc`);
      expect(rows).toEqual([
        { product_id: bolt.id, category_id: t.hex.id, status: 'enabled' },
        { product_id: loose.id, category_id: null, status: 'disabled' },
      ]);
    });

    it('selects what search indexes for every product, without its tables', async () => {
      const t = await seedTree();
      const bolt = await createProduct(handle.db, {
        sku: 'HB-M8',
        name: 'Hex bolt M8',
        categoryId: t.hex.id,
        attributes: { grade: '8.8', finishes: ['zinc', 'black'] },
        primaryUnitCode: 'each',
      });
      const rows = await handle.db.execute<{
        product_id: string;
        sku: string;
        name: string;
        category_id: string | null;
        attributes: unknown;
        updated_at: string;
      }>(sql`select product_id, sku, name, category_id, attributes, updated_at
        from (${productSearchSource()}) p`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        product_id: bolt.id,
        sku: 'HB-M8',
        name: 'Hex bolt M8',
        category_id: t.hex.id,
        attributes: { grade: '8.8', finishes: ['zinc', 'black'] },
      });
      expect(new Date(rows[0]!.updated_at).getTime()).toBe(bolt.updatedAt.getTime());
    });

    it('refuses to read stored attributes that no longer match the schema', async () => {
      const product = await createProduct(handle.db, {
        sku: 'A1',
        name: 'A',
        primaryUnitCode: 'each',
      });
      await handle.db.execute(
        sql`update catalog_product set attributes = '{"weight": 2.5}'::jsonb where id = ${product.id}`,
      );
      await expect(findProduct(handle.db, product.id)).rejects.toThrow();
    });
  });
});
