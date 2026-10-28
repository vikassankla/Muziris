import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Tables owned by the catalog module. Other modules must not query these directly; they use the
// functions exported from @muziris/catalog.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A unit products are sold in (each, box of 10, kg) with its decimal precision: the number of
 * digits a quantity in this unit may have after the decimal point. Precision cannot be changed
 * once set, because quantities already recorded in the unit would no longer fit it.
 */
export const productUnits = pgTable(
  'catalog_product_unit',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    precision: smallint('precision').notNull(),
    ...timestamps,
  },
  (t) => [
    check('catalog_product_unit_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('catalog_product_unit_name_present', sql`length(btrim(${t.name})) > 0`),
    check('catalog_product_unit_precision_range', sql`${t.precision} between 0 and 6`),
  ],
);

/** A tree of categories. The module refuses moves that would create a cycle. */
export const categories = pgTable(
  'catalog_category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'restrict',
    }),
    /** Order among siblings, lowest first; ties are broken by name. */
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('catalog_category_parent_idx').on(t.parentId),
    check('catalog_category_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,62}$'`),
    check('catalog_category_name_present', sql`length(btrim(${t.name})) > 0`),
    check('catalog_category_not_own_parent', sql`${t.parentId} <> ${t.id}`),
  ],
);

/**
 * Something sold. Only simple products are built; the type column leaves room for configurable
 * and kit products, which widen the check when they arrive.
 */
export const products = pgTable(
  'catalog_product',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().default('simple'),
    status: text('status').notNull().default('disabled'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    /** Free-form attributes, validated in code (attributes.ts). Always a JSON object. */
    attributes: jsonb('attributes').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    // SKUs are unique regardless of case, so "AB-1" and "ab-1" cannot both exist.
    uniqueIndex('catalog_product_sku_uq').on(sql`lower(${t.sku})`),
    index('catalog_product_category_idx').on(t.categoryId),
    check('catalog_product_sku_format', sql`${t.sku} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'`),
    check('catalog_product_name_present', sql`length(btrim(${t.name})) > 0`),
    check('catalog_product_type', sql`${t.type} in ('simple')`),
    check('catalog_product_status', sql`${t.status} in ('enabled', 'disabled')`),
    check('catalog_product_attributes_object', sql`jsonb_typeof(${t.attributes}) = 'object'`),
  ],
);

/** The product units a product is sold in. Exactly one is primary; the module keeps it so. */
export const productSoldIn = pgTable(
  'catalog_product_sold_in',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    unitCode: text('unit_code')
      .notNull()
      .references(() => productUnits.code, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.unitCode] }),
    index('catalog_product_sold_in_unit_idx').on(t.unitCode),
    uniqueIndex('catalog_product_sold_in_primary_uq')
      .on(t.productId)
      .where(sql`${t.isPrimary}`),
  ],
);
