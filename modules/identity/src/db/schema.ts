import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the identity module. Other modules must not query these directly.
//
// Identity knows who a person is and whether they are signed in. It does not know which
// customer a buyer works for or what they may do; the customer and access-control modules
// link to identity users by id.

/** Admin users work in the admin; buyer users sign in to the storefront. They never mix. */
export const realm = pgEnum('identity_realm', ['admin', 'buyer']);

export const userStatus = pgEnum('identity_user_status', ['active', 'disabled']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'identity_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    realm: realm('realm').notNull(),
    /** Stored lower-cased and trimmed, so lookups are exact and indexed. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** Argon2id PHC string; null for a user who has not set a password yet (invited). */
    passwordHash: text('password_hash'),
    status: userStatus('status').notNull().default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // The same email may exist once as an admin and once as a buyer.
    unique('identity_user_realm_email_uq').on(t.realm, t.email),
    check('identity_user_email_lowercase', sql`${t.email} = lower(btrim(${t.email}))`),
    check('identity_user_email_shape', sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    check('identity_user_failed_login_count_nonneg', sql`${t.failedLoginCount} >= 0`),
    check(
      'identity_user_password_hash_argon2id',
      sql`${t.passwordHash} is null or ${t.passwordHash} like '$argon2id$%'`,
    ),
  ],
);

/**
 * A signed-in session. The browser holds a random token; only its SHA-256 hash is stored,
 * so a database leak does not hand out working sessions.
 */
export const sessions = pgTable(
  'identity_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    realm: realm('realm').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute expiry; the idle timeout is checked against last_seen_at. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => [
    index('identity_session_user_idx').on(t.userId),
    index('identity_session_expires_idx').on(t.expiresAt),
    check('identity_session_token_hash_shape', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('identity_session_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Fixed-window counters for rate limiting (for example sign-in attempts per IP address).
 * Kept in PostgreSQL so limits hold across several API processes without Redis.
 */
export const rateLimits = pgTable(
  'identity_rate_limit',
  {
    key: text('key').primaryKey(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull(),
  },
  (t) => [
    index('identity_rate_limit_window_idx').on(t.windowStartedAt),
    check('identity_rate_limit_hits_positive', sql`${t.hits} > 0`),
  ],
);
