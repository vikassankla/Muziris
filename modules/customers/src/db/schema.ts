import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Tables owned by the customers module. Other modules must not query these directly;
// they use the functions exported from @muziris/customers.
//
// Buyer users and invitations refer to identity users by id, without a foreign key, because a
// module never touches another module's tables. Identity is checked through its public interface.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** A set of customers that share price lists, visibility and settings, for example "Distributors". */
export const customerGroups = pgTable(
  'customer_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [check('customer_group_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,62}$'`)],
);

/**
 * A company that buys from the organization. Customers form a hierarchy through parent_id; the
 * module refuses changes that would create a cycle (see hierarchy.ts).
 */
export const customers = pgTable(
  'customer_customer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'restrict',
    }),
    groupId: uuid('group_id').references(() => customerGroups.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('customer_customer_parent_idx').on(t.parentId),
    index('customer_customer_group_idx').on(t.groupId),
    check('customer_customer_not_own_parent', sql`${t.parentId} <> ${t.id}`),
    check('customer_customer_name_present', sql`length(btrim(${t.name})) > 0`),
  ],
);

/**
 * A person who signs in to the storefront on behalf of one customer. The primary key is the
 * identity user's id, so "buyer user id" means the same thing in every module.
 */
export const buyerUsers = pgTable(
  'customer_buyer_user',
  {
    userId: uuid('user_id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [index('customer_buyer_user_customer_idx').on(t.customerId)],
);

/**
 * An invitation for a person to become a buyer user of a customer. The emailed token is never
 * stored; only its SHA-256 hash is.
 */
export const invitations = pgTable(
  'customer_invitation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Stored lower-cased and trimmed, like identity stores it. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** The identity user (admin or buyer) who sent it. */
    invitedByUserId: uuid('invited_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('customer_invitation_customer_idx').on(t.customerId),
    // At most one open invitation per customer and email; sending a new one revokes the old.
    uniqueIndex('customer_invitation_open_uq')
      .on(t.customerId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check('customer_invitation_email_lowercase', sql`${t.email} = lower(btrim(${t.email}))`),
    check('customer_invitation_email_shape', sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    check('customer_invitation_token_hash_shape', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('customer_invitation_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'customer_invitation_accepted_with_user',
      sql`(${t.acceptedAt} is null) = (${t.acceptedUserId} is null)`,
    ),
    check(
      'customer_invitation_single_outcome',
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`,
    ),
  ],
);

/**
 * A customer's postal address in India or the US. The format rules are checked in code with
 * their messages, and again here so a bad row can never be stored. The GSTIN check digit is
 * checked in code only.
 */
export const addresses = pgTable(
  'customer_address',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    countryCode: text('country_code').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    /** India: two-digit GST state code. US: two-letter USPS state code. */
    regionCode: text('region_code').notNull(),
    /** India: six-digit PIN code. US: ZIP code or ZIP+4. */
    postalCode: text('postal_code').notNull(),
    /** India only, optional. Its first two digits are the address's GST state code. */
    gstin: text('gstin'),
    isDefaultBilling: boolean('is_default_billing').notNull().default(false),
    isDefaultShipping: boolean('is_default_shipping').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('customer_address_customer_idx').on(t.customerId),
    uniqueIndex('customer_address_default_billing_uq')
      .on(t.customerId)
      .where(sql`${t.isDefaultBilling}`),
    uniqueIndex('customer_address_default_shipping_uq')
      .on(t.customerId)
      .where(sql`${t.isDefaultShipping}`),
    check('customer_address_country', sql`${t.countryCode} in ('IN', 'US')`),
    check(
      'customer_address_india_format',
      sql`${t.countryCode} <> 'IN' or (${t.postalCode} ~ '^[1-9][0-9]{5}$' and ${t.regionCode} ~ '^[0-9]{2}$')`,
    ),
    check(
      'customer_address_us_format',
      sql`${t.countryCode} <> 'US' or (${t.postalCode} ~ '^[0-9]{5}(-[0-9]{4})?$' and ${t.regionCode} ~ '^[A-Z]{2}$')`,
    ),
    check(
      'customer_address_gstin',
      sql`${t.gstin} is null or (${t.countryCode} = 'IN' and ${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' and left(${t.gstin}, 2) = ${t.regionCode})`,
    ),
  ],
);
