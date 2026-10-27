import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the platform module. Other modules must not query these directly;
// they use the functions exported from @muziris/platform.

export const scopeType = pgEnum('platform_scope_type', [
  'global',
  'organization',
  'website',
  'customer_group',
  'customer',
]);

export const unitSystem = pgEnum('platform_unit_system', ['metric', 'imperial']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The business that owns this install. One install holds one organization. */
export const organizations = pgTable('platform_organization', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ...timestamps,
});

/** A storefront the organization runs: its own domain, country, currency, languages and units. */
export const websites = pgTable(
  'platform_website',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    countryCode: text('country_code').notNull(),
    defaultCurrency: text('default_currency').notNull(),
    defaultLocale: text('default_locale').notNull(),
    timeZone: text('time_zone').notNull(),
    unitSystem: unitSystem('unit_system').notNull().default('metric'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('platform_website_organization_idx').on(t.organizationId),
    check('platform_website_code_format', sql`${t.code} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('platform_website_country_format', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check('platform_website_currency_format', sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * A setting value stored at one scope. Resolution walks from the most specific scope
 * (customer) to the least (global) and takes the first value found.
 */
export const configValues = pgTable(
  'platform_config_value',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeType: scopeType('scope_type').notNull(),
    // Null only for the global scope (enforced by the check below).
    scopeId: uuid('scope_id'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('platform_config_value_scope_key_uq')
      .on(t.scopeType, t.scopeId, t.key)
      .nullsNotDistinct(),
    index('platform_config_value_key_idx').on(t.key),
    check(
      'platform_config_value_scope_id_presence',
      sql`(${t.scopeType} = 'global') = (${t.scopeId} is null)`,
    ),
    check(
      'platform_config_value_key_format',
      sql`${t.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`,
    ),
  ],
);
