import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  numeric,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the orders module (ADR 0016). Other modules must not query these directly;
// they use the functions exported from @muziris/orders.
//
// Websites, customers, buyer users, products and price lists belong to other modules, so they
// are referred to by id without a foreign key. An order copies everything it shows (SKU, name,
// unit, prices, tax, addresses), so a later catalog or customer change never alters it.

/** The number part of order numbers: one sequence per installation. */
export const orderNumbers = pgSequence('orders_order_number_seq', { startWith: 1 });

/**
 * A placed order. Immutable once placed except `step`, which the order workflow's action keeps
 * equal to the workflow instance's current step.
 */
export const orders = pgTable(
  'orders_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** For people: a prefix and six digits, for example MZ-000123. */
    number: text('number').notNull().unique(),
    websiteId: uuid('website_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    customerName: text('customer_name').notNull(),
    /** The buyer user (identity user id) who placed it. */
    placedBy: uuid('placed_by').notNull(),
    /** The buyer's key for this attempt: placing again with it returns this order. */
    idempotencyKey: uuid('idempotency_key').notNull(),
    /** SHA-256 of the request, so a key reused for a different order is refused. */
    requestHash: text('request_hash').notNull(),
    step: text('step').notNull().default('new'),
    currency: text('currency').notNull(),
    purchaseOrderNumber: text('purchase_order_number'),
    paymentMethod: text('payment_method').notNull().default('terms'),
    paymentTermDays: integer('payment_term_days').notNull(),
    /** The day payment is due, in the website's time zone. */
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    shippingMethod: text('shipping_method').notNull(),
    taxProvider: text('tax_provider').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull(),
    shippingMinor: bigint('shipping_minor', { mode: 'bigint' }).notNull(),
    shippingDiscountMinor: bigint('shipping_discount_minor', { mode: 'bigint' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
    grandTotalMinor: bigint('grand_total_minor', { mode: 'bigint' }).notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('orders_order_idempotency_uq').on(t.placedBy, t.idempotencyKey),
    index('orders_order_customer_idx').on(t.customerId, t.placedAt, t.id),
    index('orders_order_website_idx').on(t.websiteId, t.placedAt, t.id),
    check('orders_order_number_format', sql`${t.number} ~ '^[A-Z0-9]{1,10}-[0-9]{6,}$'`),
    check('orders_order_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'orders_order_step',
      sql`${t.step} in ('new', 'confirmed', 'processing', 'completed', 'declined')`,
    ),
    check('orders_order_payment_method', sql`${t.paymentMethod} = 'terms'`),
    check('orders_order_payment_term', sql`${t.paymentTermDays} between 0 and 365`),
    check('orders_order_request_hash', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'orders_order_amounts_not_negative',
      sql`${t.subtotalMinor} >= 0 and ${t.discountMinor} >= 0 and ${t.shippingMinor} >= 0
        and ${t.shippingDiscountMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.grandTotalMinor} >= 0`,
    ),
    check(
      'orders_order_grand_total',
      sql`${t.grandTotalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.shippingMinor}
        - ${t.shippingDiscountMinor} + ${t.taxMinor}`,
    ),
  ],
);

/** One line of an order, as it was bought. */
export const orderLines = pgTable(
  'orders_order_line',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    sku: text('sku').notNull(),
    productName: text('product_name').notNull(),
    unitCode: text('unit_code').notNull(),
    unitName: text('unit_name').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 6 }).notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull(),
    netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
    /** The tax code the tax provider used (HSN or SAC in India, a tax category in the US). */
    taxCode: text('tax_code'),
    /** The price list the unit price came from, for support and reports. */
    priceListId: uuid('price_list_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.lineNo] }),
    check('orders_order_line_no_positive', sql`${t.lineNo} > 0`),
    check('orders_order_line_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'orders_order_line_amounts',
      sql`${t.unitPriceMinor} >= 0 and ${t.subtotalMinor} >= 0 and ${t.discountMinor} >= 0
        and ${t.discountMinor} <= ${t.subtotalMinor}`,
    ),
    check('orders_order_line_net', sql`${t.netMinor} = ${t.subtotalMinor} - ${t.discountMinor}`),
  ],
);

/** One tax charged on an order: on a line, or on shipping when `line_no` is null. */
export const orderTaxLines = pgTable(
  'orders_order_tax_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    lineNo: integer('line_no'),
    /** For example CGST, SGST, IGST or a US state's sales tax. */
    name: text('name').notNull(),
    /** A decimal fraction, for example 0.09 for 9%. */
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    taxableMinor: bigint('taxable_minor', { mode: 'bigint' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    index('orders_order_tax_line_order_idx').on(t.orderId),
    check('orders_order_tax_line_name_present', sql`length(btrim(${t.name})) > 0`),
    check('orders_order_tax_line_rate', sql`${t.rate} >= 0 and ${t.rate} < 1`),
    check('orders_order_tax_line_amounts', sql`${t.taxableMinor} >= 0 and ${t.amountMinor} >= 0`),
  ],
);

/** The billing and shipping addresses as they were when the order was placed. */
export const orderAddresses = pgTable(
  'orders_order_address',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    /** The customer address it was copied from. */
    addressId: uuid('address_id').notNull(),
    label: text('label').notNull(),
    countryCode: text('country_code').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    regionCode: text('region_code').notNull(),
    postalCode: text('postal_code').notNull(),
    gstin: text('gstin'),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.role] }),
    check('orders_order_address_role', sql`${t.role} in ('billing', 'shipping')`),
    check('orders_order_address_country', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
  ],
);
