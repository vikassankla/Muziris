import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the shopping lists module (ADR 0018). Other modules must not query these
// directly; they use the functions exported from @muziris/shopping-lists.
//
// Websites, customers, buyer users and products belong to other modules, so they are referred to
// by id without a foreign key. A list stores no prices: the buyer's price is looked up when the
// list is shown, and checked again at checkout.

/** Most lists one buyer user may own. */
export const MAX_LISTS_PER_OWNER = 100;
/** Most lines one list may hold. */
export const MAX_LINES_PER_LIST = 500;

/** A buyer's named list of products, on one website, for one customer. */
export const shoppingLists = pgTable(
  'shopping_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    websiteId: uuid('website_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The buyer user (identity user id) who owns it. */
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Milliseconds only, so the page cursor (a JavaScript Date) compares exactly. */
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('shopping_list_customer_idx').on(t.customerId, t.websiteId),
    index('shopping_list_owner_idx').on(t.ownerId),
    check('shopping_list_name_length', sql`char_length(${t.name}) between 1 and 100`),
  ],
);

/** One product in one unit on a list. Adding the same product and unit again adds quantity. */
export const shoppingListLines = pgTable(
  'shopping_list_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => shoppingLists.id, { onDelete: 'cascade' }),
    /** The order the buyer sees, 1 upward; a new line goes last. */
    position: integer('position').notNull(),
    productId: uuid('product_id').notNull(),
    unitCode: text('unit_code').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 6 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('shopping_list_line_product_unit').on(t.listId, t.productId, t.unitCode),
    index('shopping_list_line_list_idx').on(t.listId, t.position),
    check('shopping_list_line_quantity_positive', sql`${t.quantity} > 0`),
    check('shopping_list_line_note_length', sql`char_length(${t.note}) <= 500`),
  ],
);
