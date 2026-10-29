import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the pricing module. Other modules must not query these directly; they use the
// functions exported from @muziris/pricing.
//
// Products, product units, customers, customer groups and websites belong to other modules, so
// they are referred to by id or code without a foreign key. The module checks them through
// those modules' public interfaces before writing (ADR 0011).

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A set of prices in one currency, active from `active_from` (inclusive) until `active_until`
 * (exclusive). A missing date is open. The currency never changes once the list exists.
 */
export const priceLists = pgTable(
  'pricing_price_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }),
    activeUntil: timestamp('active_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('pricing_price_list_name_idx').on(t.name, t.id),
    check('pricing_price_list_name_present', sql`length(btrim(${t.name})) > 0`),
    check('pricing_price_list_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_price_list_dates_ordered',
      sql`${t.activeFrom} is null or ${t.activeUntil} is null or ${t.activeUntil} > ${t.activeFrom}`,
    ),
  ],
);

/**
 * One price tier: the amount, in minor units of the list's currency, for buying at least
 * `min_quantity` of a product in a product unit.
 */
export const prices = pgTable(
  'pricing_price',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    unitCode: text('unit_code').notNull(),
    minQuantity: numeric('min_quantity', { precision: 18, scale: 6 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('pricing_price_tier_uq').on(t.priceListId, t.productId, t.unitCode, t.minQuantity),
    index('pricing_price_product_idx').on(t.productId),
    check('pricing_price_min_quantity_positive', sql`${t.minQuantity} > 0`),
    check('pricing_price_amount_not_negative', sql`${t.amountMinor} >= 0`),
  ],
);

/**
 * Puts a price list on a website for a customer, a customer group or the website itself. For a
 * website assignment the target id is the website id. Lower priorities come first in the chain.
 */
export const assignments = pgTable(
  'pricing_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    websiteId: uuid('website_id').notNull(),
    target: text('target').notNull(),
    targetId: uuid('target_id').notNull(),
    priority: integer('priority').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('pricing_assignment_list_uq').on(t.websiteId, t.target, t.targetId, t.priceListId),
    unique('pricing_assignment_priority_uq').on(t.websiteId, t.target, t.targetId, t.priority),
    index('pricing_assignment_price_list_idx').on(t.priceListId),
    check(
      'pricing_assignment_target',
      sql`${t.target} in ('customer', 'customer_group', 'website')`,
    ),
    check(
      'pricing_assignment_website_target',
      sql`${t.target} <> 'website' or ${t.targetId} = ${t.websiteId}`,
    ),
    check('pricing_assignment_priority_range', sql`${t.priority} between 1 and 1000`),
  ],
);

/** The precomputed result of one chain of price lists. Written only by the build. */
export const combinedPriceLists = pgTable(
  'pricing_combined_price_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The chain, in order: customer, then customer group, then website price lists. */
    priceListIds: uuid('price_list_ids').array().notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('pricing_combined_price_list_chain_uq').on(t.priceListIds)],
);

/**
 * Which combined price list serves a customer, a customer group or a website on a website.
 * A customer row records the customer group its chain was built with; a lookup refuses it once
 * the customer is in another group. Written only by the build.
 */
export const combinedPriceListTargets = pgTable(
  'pricing_combined_price_list_target',
  {
    websiteId: uuid('website_id').notNull(),
    target: text('target').notNull(),
    targetId: uuid('target_id').notNull(),
    customerGroupId: uuid('customer_group_id'),
    combinedPriceListId: uuid('combined_price_list_id')
      .notNull()
      .references(() => combinedPriceLists.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.websiteId, t.target, t.targetId] }),
    index('pricing_combined_price_list_target_list_idx').on(t.combinedPriceListId),
    check(
      'pricing_combined_price_list_target_target',
      sql`${t.target} in ('customer', 'customer_group', 'website')`,
    ),
  ],
);

/**
 * The winning price for a quantity of at least `min_quantity` (a breakpoint: every tier of every
 * price list in the chain is one), from the winner's tier `tier_min_quantity`, valid from `valid_from`
 * (inclusive, null for always) until `valid_until` (exclusive, null for ever). Written only by
 * the build; read by every price lookup.
 */
export const combinedPrices = pgTable(
  'pricing_combined_price',
  {
    combinedPriceListId: uuid('combined_price_list_id')
      .notNull()
      .references(() => combinedPriceLists.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    unitCode: text('unit_code').notNull(),
    currency: text('currency').notNull(),
    minQuantity: numeric('min_quantity', { precision: 18, scale: 6 }).notNull(),
    tierMinQuantity: numeric('tier_min_quantity', { precision: 18, scale: 6 }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    /** The price list the amount came from. */
    priceListId: uuid('price_list_id').notNull(),
  },
  (t) => [
    unique('pricing_combined_price_uq')
      .on(t.combinedPriceListId, t.productId, t.unitCode, t.currency, t.minQuantity, t.validFrom)
      .nullsNotDistinct(),
  ],
);

/**
 * One row (id 1) counting changes to price lists, prices and assignments, and the count the
 * last build saw. Changes are waiting for a build while `change_count > built_change_count`.
 */
export const buildState = pgTable(
  'pricing_build_state',
  {
    id: smallint('id').primaryKey().default(1),
    changeCount: bigint('change_count', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    builtChangeCount: bigint('built_change_count', { mode: 'bigint' }),
    builtAt: timestamp('built_at', { withTimezone: true }),
    builtBy: uuid('built_by'),
    combinedPriceListCount: integer('combined_price_list_count'),
    combinedPriceCount: integer('combined_price_count'),
    buildMs: integer('build_ms'),
  },
  (t) => [check('pricing_build_state_one_row', sql`${t.id} = 1`)],
);
