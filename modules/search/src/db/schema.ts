import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the search module. Other modules must not query these directly; they use the
// functions exported from @muziris/search.
//
// Products and categories belong to catalog, so they are referred to by id without a foreign
// key. The index is built from catalog's public SQL (ADR 0013).

/** A full-text search document. Written and read only through SQL, never in JavaScript. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * One product as search sees it: the SKU, name and category it had when indexed, and its
 * weighted document (A the SKU, B the name, C its category names, D attribute values). The
 * pg_trgm extension is created by the migration that creates this table.
 */
export const products = pgTable(
  'search_product',
  {
    productId: uuid('product_id').primaryKey(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    categoryId: uuid('category_id'),
    document: tsvector('document').notNull(),
    /** The catalog's `updated_at` this row was built from, to tell which products are stale. */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('search_product_document_idx').using('gin', t.document),
    index('search_product_sku_trgm_idx').using('gin', sql`lower(${t.sku}) gin_trgm_ops`),
    index('search_product_name_trgm_idx').using('gin', sql`lower(${t.name}) gin_trgm_ops`),
    index('search_product_sku_prefix_idx').using('btree', sql`lower(${t.sku}) text_pattern_ops`),
  ],
);

/** One row (id 1) recording the last full build. */
export const buildState = pgTable(
  'search_build_state',
  {
    id: smallint('id').primaryKey().default(1),
    builtAt: timestamp('built_at', { withTimezone: true }),
    builtBy: uuid('built_by'),
    productCount: integer('product_count'),
    buildMs: integer('build_ms'),
  },
  (t) => [check('search_build_state_one_row', sql`${t.id} = 1`)],
);
