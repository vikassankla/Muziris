import { sql } from 'drizzle-orm';
import {
  bigint,
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

/**
 * A full session may use the API. A two-factor session (ADR 0026) proves the password only: it
 * lasts minutes and allows nothing but the code step and enrolment.
 */
export const sessionStage = pgEnum('identity_session_stage', ['full', 'two_factor']);

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
    stage: sessionStage('stage').notNull().default('full'),
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

/**
 * A user's authenticator-app factor (ADR 0026). The secret is encrypted with ADMIN_TOTP_KEY and
 * the user id; it is confirmed once the user has entered one code from it.
 */
export const twoFactors = pgTable(
  'identity_two_factor',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    secretEnc: text('secret_enc').notNull(),
    /** When the first code was entered; null while enrolment is unfinished. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** The last time step a code was accepted for: that step and earlier ones are refused. */
    lastStep: bigint('last_step', { mode: 'number' }),
    /** A new phone's secret while the user moves to it, until its first code is entered. */
    replacementSecretEnc: text('replacement_secret_enc'),
    /** The salt the current recovery codes are hashed with, in base64; null before there are any. */
    recoveryCodeSalt: text('recovery_code_salt'),
    ...timestamps,
  },
  (t) => [
    check('identity_two_factor_secret_shape', sql`${t.secretEnc} like 'v1:%'`),
    check(
      'identity_two_factor_replacement_shape',
      sql`${t.replacementSecretEnc} is null or ${t.replacementSecretEnc} like 'v1:%'`,
    ),
  ],
);

/** One-time recovery codes, as Argon2id hashes. A new set replaces the old one. */
export const recoveryCodes = pgTable(
  'identity_recovery_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('identity_recovery_code_user_hash_uq').on(t.userId, t.codeHash),
    check('identity_recovery_code_hash_shape', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
