import type { Database } from '@muziris/db';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  productAttributesSchema,
  readStoredAttributes,
  type ProductAttributes,
} from './attributes.js';
import { categorySubtreeIds } from './categories.js';
import { products, productSoldIn, productUnits } from './db/schema.js';
import {
  CatalogError,
  isForeignKeyViolation,
  isUniqueViolation,
  violatedConstraint,
} from './errors.js';
import { productUnitCodeSchema, type ProductUnit } from './product-units.js';

// Admin-side functions. The catalog is the organization's own data, so these are not scoped to a
// buyer; what a buyer may see is decided by visibility (week 3). The admin API checks the
// admin's permission before calling them.

/**
 * Product types from the glossary. Only simple products are built; configurable (has variants)
 * and kit (bundle of selectable items) will join this list, and the database check, later.
 */
export const PRODUCT_TYPES = ['simple'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_STATUSES = ['enabled', 'disabled'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface Product {
  id: string;
  sku: string;
  name: string;
  type: ProductType;
  status: ProductStatus;
  categoryId: string | null;
  attributes: ProductAttributes;
  /** The product unit quantities and prices default to. */
  primaryUnitCode: string;
  /** Every product unit the product is sold in, the primary one first, then by code. */
  units: ProductUnit[];
  createdAt: Date;
  updatedAt: Date;
}

const idSchema = z.uuid();

export const skuSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/,
    'Use 1 to 64 letters, digits, ".", "_", "/" or "-", starting with a letter or digit',
  );

export const MAX_PRODUCT_UNITS = 20;

export const productUnitsSchema = z
  .object({
    primaryUnitCode: productUnitCodeSchema,
    additionalUnitCodes: z
      .array(productUnitCodeSchema)
      .max(MAX_PRODUCT_UNITS - 1)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set([value.primaryUnitCode]);
    value.additionalUnitCodes.forEach((code, index) => {
      if (seen.has(code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['additionalUnitCodes', index],
          message: 'Each product unit can be listed only once',
        });
      }
      seen.add(code);
    });
  });

export type ProductUnitsInput = z.input<typeof productUnitsSchema>;

const productFields = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1).max(200),
  status: z.enum(PRODUCT_STATUSES),
  categoryId: z.uuid().nullable(),
  attributes: productAttributesSchema,
});

export const newProductSchema = z
  .object({
    sku: productFields.shape.sku,
    name: productFields.shape.name,
    type: z.enum(PRODUCT_TYPES).default('simple'),
    status: productFields.shape.status.default('disabled'),
    categoryId: productFields.shape.categoryId.default(null),
    attributes: productFields.shape.attributes.default({}),
  })
  .and(productUnitsSchema);

export type NewProduct = z.input<typeof newProductSchema>;

/** Fields an admin may change after creation. The type and units have their own paths. */
export const productChangesSchema = productFields.partial().strict();

export type ProductChanges = z.input<typeof productChangesSchema>;

export const listProductsQuerySchema = z.object({
  /** Only products in this category, or in it and its subcategories with includeSubcategories. */
  categoryId: z.uuid().optional(),
  includeSubcategories: z.boolean().default(false),
  status: z.enum(PRODUCT_STATUSES).optional(),
  /** Continue after this SKU, from the previous page's nextAfter. */
  after: skuSchema.optional(),
  limit: z.int().min(1).max(200).default(50),
});

export type ListProductsQuery = z.input<typeof listProductsQuerySchema>;

export interface ProductPage {
  products: Product[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

type ProductRow = typeof products.$inferSelect;

type Reader = Pick<Database, 'select'>;

/** Turns a refused insert or update into a named error, or returns undefined. */
function refusedWrite(error: unknown): CatalogError | undefined {
  if (isUniqueViolation(error) && violatedConstraint(error) === 'catalog_product_sku_uq') {
    return new CatalogError('sku_taken', 'Another product already uses that SKU');
  }
  if (isForeignKeyViolation(error)) {
    return violatedConstraint(error)?.includes('_category_id_')
      ? new CatalogError('category_not_found', 'No such category')
      : new CatalogError('product_unit_not_found', 'No such product unit');
  }
  return undefined;
}

function isProductType(value: string): value is ProductType {
  return (PRODUCT_TYPES as readonly string[]).includes(value);
}

function isProductStatus(value: string): value is ProductStatus {
  return (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/** Loads the product units of each product, and assembles the products in the rows' order. */
async function withUnits(db: Reader, rows: readonly ProductRow[]): Promise<Product[]> {
  if (rows.length === 0) return [];
  const units = await db
    .select({
      productId: productSoldIn.productId,
      isPrimary: productSoldIn.isPrimary,
      code: productUnits.code,
      name: productUnits.name,
      precision: productUnits.precision,
    })
    .from(productSoldIn)
    .innerJoin(productUnits, eq(productUnits.code, productSoldIn.unitCode))
    .where(
      inArray(
        productSoldIn.productId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(
      asc(productSoldIn.productId),
      sql`${productSoldIn.isPrimary} desc`,
      asc(productUnits.code),
    );

  const byProduct = new Map<string, { primary: string | undefined; units: ProductUnit[] }>();
  for (const u of units) {
    const entry = byProduct.get(u.productId) ?? { primary: undefined, units: [] };
    if (u.isPrimary) entry.primary = u.code;
    entry.units.push({ code: u.code, name: u.name, precision: u.precision });
    byProduct.set(u.productId, entry);
  }

  return rows.map((row) => {
    const entry = byProduct.get(row.id);
    if (!entry?.primary) throw new Error(`Product ${row.id} has no primary product unit`);
    if (!isProductType(row.type) || !isProductStatus(row.status)) {
      throw new Error(`Product ${row.id} has an unknown type or status`);
    }
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      type: row.type,
      status: row.status,
      categoryId: row.categoryId,
      attributes: readStoredAttributes(row.attributes),
      primaryUnitCode: entry.primary,
      units: entry.units,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

function soldInRows(productId: string, units: z.output<typeof productUnitsSchema>) {
  return [
    { productId, unitCode: units.primaryUnitCode, isPrimary: true },
    ...units.additionalUnitCodes.map((unitCode) => ({ productId, unitCode, isPrimary: false })),
  ];
}

/** Creates a simple product with the product units it is sold in, in one transaction. */
export async function createProduct(db: Database, input: NewProduct): Promise<Product> {
  const values = newProductSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({
          sku: values.sku,
          name: values.name,
          type: values.type,
          status: values.status,
          categoryId: values.categoryId,
          attributes: values.attributes,
        })
        .returning();
      if (!row) throw new Error('Product insert returned no row');
      await tx.insert(productSoldIn).values(soldInRows(row.id, values));
      const [product] = await withUnits(tx, [row]);
      if (!product) throw new Error('Product read returned nothing');
      return product;
    });
  } catch (error) {
    throw refusedWrite(error) ?? error;
  }
}

export async function findProduct(db: Database, productId: string): Promise<Product | undefined> {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.id, idSchema.parse(productId)))
    .limit(1);
  if (!row) return undefined;
  const [product] = await withUnits(db, [row]);
  return product;
}

/**
 * An SQL select of every product's id, category id (null for none) and status, as the columns
 * `product_id`, `category_id` and `status`, without surrounding parentheses. Visibility builds
 * and filters on it without reading catalog tables.
 */
export function productCategoryAndStatus(): SQL {
  return sql`select id as product_id, category_id, status from ${products}`;
}

/**
 * An SQL select of every product's id, SKU, name, category id (null for none), attributes and
 * last change, as the columns `product_id`, `sku`, `name`, `category_id`, `attributes` and
 * `updated_at`, without surrounding parentheses. Search builds its index from it without reading
 * catalog tables.
 */
export function productSearchSource(): SQL {
  return sql`select id as product_id, sku, name, category_id, attributes, updated_at
    from ${products}`;
}

/** Finds a product by SKU in any letter case. */
export async function findProductBySku(db: Database, sku: string): Promise<Product | undefined> {
  const parsed = skuSchema.safeParse(sku);
  if (!parsed.success) return undefined;
  const [row] = await db
    .select()
    .from(products)
    .where(sql`lower(${products.sku}) = lower(${parsed.data})`)
    .limit(1);
  if (!row) return undefined;
  const [product] = await withUnits(db, [row]);
  return product;
}

/** A page of products ordered by SKU, ignoring letter case. */
export async function listProducts(
  db: Database,
  query: ListProductsQuery = {},
): Promise<ProductPage> {
  const q = listProductsQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.categoryId !== undefined) {
    conditions.push(
      q.includeSubcategories
        ? sql`${products.categoryId} in (${categorySubtreeIds(q.categoryId)})`
        : eq(products.categoryId, q.categoryId),
    );
  }
  if (q.status !== undefined) conditions.push(eq(products.status, q.status));
  if (q.after !== undefined) conditions.push(sql`lower(${products.sku}) > lower(${q.after})`);

  const rows = await db
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(sql`lower(${products.sku})`)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    products: await withUnits(db, page),
    nextAfter: rows.length > q.limit && last ? last.sku : null,
  };
}

/** Changes a product's SKU, name, status, category or attributes. Attributes are replaced. */
export async function updateProduct(
  db: Database,
  productId: string,
  changes: ProductChanges,
): Promise<Product> {
  const id = idSchema.parse(productId);
  const values = productChangesSchema.parse(changes);
  try {
    const [row] = await db
      .update(products)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(products.id, id))
      .returning();
    if (!row) throw new CatalogError('product_not_found', 'No such product');
    const [product] = await withUnits(db, [row]);
    if (!product) throw new Error('Product read returned nothing');
    return product;
  } catch (error) {
    throw refusedWrite(error) ?? error;
  }
}

/**
 * Replaces the product units a product is sold in. The product row is locked, so two admins
 * setting units at once cannot leave a product with two primary units or none.
 */
export async function setProductUnits(
  db: Database,
  productId: string,
  input: ProductUnitsInput,
): Promise<Product> {
  const id = idSchema.parse(productId);
  const units = productUnitsSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, id))
        .for('update');
      if (!locked) throw new CatalogError('product_not_found', 'No such product');
      await tx.delete(productSoldIn).where(eq(productSoldIn.productId, id));
      await tx.insert(productSoldIn).values(soldInRows(id, units));
      const [row] = await tx
        .update(products)
        .set({ updatedAt: sql`now()` })
        .where(eq(products.id, id))
        .returning();
      if (!row) throw new CatalogError('product_not_found', 'No such product');
      const [product] = await withUnits(tx, [row]);
      if (!product) throw new Error('Product read returned nothing');
      return product;
    });
  } catch (error) {
    throw refusedWrite(error) ?? error;
  }
}
