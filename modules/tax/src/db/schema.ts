import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the tax module (ADR 0017). Other modules must not query these directly; they
// use the functions exported from @muziris/tax.
//
// Websites, customers and admin users belong to other modules, so they are referred to by id
// without a foreign key. Rates are dated: a rate applies from `valid_from` up to, but not on,
// `valid_to` (null: no end), in the website's time zone. The module refuses overlapping periods
// for the same code, state or ZIP prefix, so at most one rate applies on any day.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Who entered or last changed a rate: an admin user id, for the record ADR 0017 asks for. */
const changedBy = {
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by').notNull(),
};

/**
 * Where a website's seller is registered to charge tax. India: one GST registration per
 * website, its state from the GSTIN. US: one sales tax permit per state the seller collects in.
 */
export const registrations = pgTable(
  'tax_registration',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    websiteId: uuid('website_id').notNull(),
    regime: text('regime').notNull(),
    /** India: the two-digit GST state code. US: the two-letter state code. */
    regionCode: text('region_code').notNull(),
    /** India: the GSTIN. US: the state's sales tax permit number. */
    number: text('number').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('tax_registration_website_region_uq').on(t.websiteId, t.regime, t.regionCode),
    check('tax_registration_regime', sql`${t.regime} in ('gst', 'us_sales_tax')`),
    check(
      'tax_registration_region',
      sql`(${t.regime} = 'gst' and ${t.regionCode} ~ '^[0-9]{2}$')
        or (${t.regime} = 'us_sales_tax' and ${t.regionCode} ~ '^[A-Z]{2}$')`,
    ),
    check(
      'tax_registration_gstin',
      sql`${t.regime} <> 'gst' or (${t.number} ~ '^[0-9]{2}[A-Z0-9]{13}$'
        and left(${t.number}, 2) = ${t.regionCode})`,
    ),
    check('tax_registration_number_present', sql`length(btrim(${t.number})) > 0`),
  ],
);

/**
 * A GST rate for every HSN or SAC code that starts with `code_prefix`. The longest prefix that
 * covers a code on the day wins, so a rate can be entered for a chapter (2 digits), a heading
 * (4), a subheading (6) or one code (8).
 */
export const gstRates = pgTable(
  'tax_gst_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codePrefix: text('code_prefix').notNull(),
    /** A fraction: 0.18 is 18%. The full rate; within a state it is split in two halves. */
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    ...changedBy,
    ...timestamps,
  },
  (t) => [
    index('tax_gst_rate_prefix_idx').on(t.codePrefix, t.validFrom),
    check('tax_gst_rate_prefix', sql`${t.codePrefix} ~ '^([0-9]{2}){1,4}$'`),
    check('tax_gst_rate_rate', sql`${t.rate} >= 0 and ${t.rate} < 1`),
    check('tax_gst_rate_period', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);

/**
 * A combined US sales tax rate (state and local) for a state, or for the ZIP codes in it that
 * start with `zip_prefix`. The longest prefix that covers the ship-to ZIP code wins, then the
 * state's row (no prefix).
 */
export const usRates = pgTable(
  'tax_us_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stateCode: text('state_code').notNull(),
    zipPrefix: text('zip_prefix'),
    /** A fraction: 0.0725 is 7.25%. */
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    /** Whether shipping charges are taxed where this rate applies. */
    shippingTaxable: boolean('shipping_taxable').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    ...changedBy,
    ...timestamps,
  },
  (t) => [
    index('tax_us_rate_state_idx').on(t.stateCode, t.validFrom),
    check('tax_us_rate_state', sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check('tax_us_rate_zip_prefix', sql`${t.zipPrefix} ~ '^[0-9]{1,5}$'`),
    check('tax_us_rate_rate', sql`${t.rate} >= 0 and ${t.rate} < 1`),
    check('tax_us_rate_period', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);

/** A customer's US sales tax exemption certificate for one state. */
export const exemptions = pgTable(
  'tax_exemption',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull(),
    stateCode: text('state_code').notNull(),
    certificateNumber: text('certificate_number').notNull(),
    /** The last day it is valid; null when it does not expire. */
    expiresOn: date('expires_on', { mode: 'string' }),
    ...changedBy,
    ...timestamps,
  },
  (t) => [
    unique('tax_exemption_customer_state_uq').on(t.customerId, t.stateCode),
    check('tax_exemption_state', sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check(
      'tax_exemption_certificate_present',
      sql`length(btrim(${t.certificateNumber})) between 1 and 64`,
    ),
  ],
);
