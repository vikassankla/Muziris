import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the visibility module. Other modules must not query these directly; they use
// the functions exported from @muziris/visibility.
//
// Products, categories, customers, customer groups and websites belong to other modules, so they
// are referred to by id without a foreign key. The module checks them through those modules'
// public interfaces before writing (ADR 0012).

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * On a website, a product or category is visible or hidden for a customer, a customer group or
 * the website itself. For a website rule the target id is the website id.
 */
export const rules = pgTable(
  'visibility_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    websiteId: uuid('website_id').notNull(),
    subject: text('subject').notNull(),
    subjectId: uuid('subject_id').notNull(),
    target: text('target').notNull(),
    targetId: uuid('target_id').notNull(),
    visibility: text('visibility').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('visibility_rule_uq').on(t.websiteId, t.subject, t.subjectId, t.target, t.targetId),
    index('visibility_rule_target_idx').on(t.websiteId, t.target, t.targetId),
    index('visibility_rule_subject_idx').on(t.subject, t.subjectId),
    check('visibility_rule_subject', sql`${t.subject} in ('product', 'category')`),
    check('visibility_rule_target', sql`${t.target} in ('customer', 'customer_group', 'website')`),
    check(
      'visibility_rule_website_target',
      sql`${t.target} <> 'website' or ${t.targetId} = ${t.websiteId}`,
    ),
    check('visibility_rule_visibility', sql`${t.visibility} in ('visible', 'hidden')`),
  ],
);

/**
 * One set of rules that can apply to a buyer: the default (no rules), a website's, a customer
 * group's on a website, or a customer's on a website. A customer row records the customer group
 * it was built with; a read refuses it once the customer is in another group. Written only by
 * the build.
 */
export const contexts = pgTable(
  'visibility_context',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    websiteId: uuid('website_id'),
    target: text('target').notNull(),
    targetId: uuid('target_id'),
    customerGroupId: uuid('customer_group_id'),
  },
  (t) => [
    unique('visibility_context_uq').on(t.websiteId, t.target, t.targetId).nullsNotDistinct(),
    check(
      'visibility_context_target',
      sql`${t.target} in ('default', 'website', 'customer_group', 'customer')`,
    ),
    check(
      'visibility_context_shape',
      sql`case ${t.target}
        when 'default' then ${t.websiteId} is null and ${t.targetId} is null
        when 'website' then ${t.websiteId} is not null and ${t.targetId} = ${t.websiteId}
        else ${t.websiteId} is not null and ${t.targetId} is not null end`,
    ),
  ],
);

/** The enabled products a context may see. Written only by the build. */
export const visibleProducts = pgTable(
  'visibility_visible_product',
  {
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contextId, t.productId] })],
);

/** The categories a context may see. Written only by the build. */
export const visibleCategories = pgTable(
  'visibility_visible_category',
  {
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contextId, t.categoryId] })],
);

/**
 * One row (id 1) counting changes to rules, and the count the last build saw. Changes are
 * waiting for a build while `change_count > built_change_count`.
 */
export const buildState = pgTable(
  'visibility_build_state',
  {
    id: smallint('id').primaryKey().default(1),
    changeCount: bigint('change_count', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    builtChangeCount: bigint('built_change_count', { mode: 'bigint' }),
    builtAt: timestamp('built_at', { withTimezone: true }),
    builtBy: uuid('built_by'),
    contextCount: integer('context_count'),
    visibleProductCount: integer('visible_product_count'),
    visibleCategoryCount: integer('visible_category_count'),
    buildMs: integer('build_ms'),
  },
  (t) => [check('visibility_build_state_one_row', sql`${t.id} = 1`)],
);
