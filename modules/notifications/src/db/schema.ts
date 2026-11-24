import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Transactional emails waiting to go, and those that went (ADR 0020). A module queues an email
// in the same transaction as the change it reports, so a change that rolls back sends nothing.

/** The pilot's catalogue (docs/notifications.md). */
export const NOTIFICATION_KINDS = [
  'buyer_invitation',
  'admin_invitation',
  'order_placed',
  'order_received',
  'order_confirmed',
  'order_declined',
  'order_completed',
  'payment_received',
  'payment_failed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** bounced: sent, then reported back by the provider; suppressed: not sent, to a suppressed address (ADR 0032). */
export const OUTBOX_STATUSES = ['queued', 'sent', 'failed', 'bounced', 'suppressed'] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const outbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Such as order_placed:<order id>; the same email is never queued twice. */
    idempotencyKey: text('idempotency_key').notNull(),
    recipient: text('recipient').notNull(),
    locale: text('locale').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body').notNull(),
    htmlBody: text('html_body').notNull(),
    /** The body carries a secret (an invitation token): it is emptied once it is sent or given up. */
    sensitive: boolean('sensitive').notNull().default(false),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    /** A short code such as ECONNECTION or smtp_550; never the server's message. */
    lastError: text('last_error'),
    /** Postmark's bounce type, such as HardBounce or SpamComplaint, once it bounced (ADR 0032). */
    bounceType: text('bounce_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('notification_outbox_key_uq').on(t.idempotencyKey),
    index('notification_outbox_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    index('notification_outbox_status_idx').on(t.status, t.createdAt),
    check(
      'notification_outbox_kind',
      sql`${t.kind} in ('buyer_invitation', 'admin_invitation', 'order_placed', 'order_received', 'order_confirmed', 'order_declined', 'order_completed', 'payment_received', 'payment_failed')`,
    ),
    check(
      'notification_outbox_status',
      sql`${t.status} in ('queued', 'sent', 'failed', 'bounced', 'suppressed')`,
    ),
    check('notification_outbox_attempts', sql`${t.attempts} >= 0`),
    check(
      'notification_outbox_recipient_shape',
      sql`${t.recipient} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
    check(
      'notification_outbox_sent_at',
      sql`(${t.status} in ('sent', 'bounced')) = (${t.sentAt} is not null)`,
    ),
    check(
      'notification_outbox_bounce_type',
      sql`(${t.status} = 'bounced') = (${t.bounceType} is not null)`,
    ),
  ],
);

// Addresses Muziris does not send to (ADR 0032): they bounced permanently, their owner marked an
// email as spam, the relay refused them, or an admin added them. Postmark's free-text
// description is never kept: it can quote addresses and server replies.

export const SUPPRESSION_REASONS = [
  'hard_bounce',
  'spam_complaint',
  'smtp_rejected',
  'manual',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SOURCES = ['postmark', 'smtp', 'admin'] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

export const suppression = pgTable(
  'notification_suppression',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercased by the code (not by a check: JavaScript and PostgreSQL lowercase some letters differently). */
    email: text('email').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    bounceType: text('bounce_type'),
    bounceTypeCode: integer('bounce_type_code'),
    /** The email that caused it, if any; not a foreign key, so the outbox can be cleared. */
    outboxId: uuid('outbox_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('notification_suppression_email_uq').on(t.email),
    index('notification_suppression_recent_idx').on(t.firstSeenAt, t.id),
    check(
      'notification_suppression_reason',
      sql`${t.reason} in ('hard_bounce', 'spam_complaint', 'smtp_rejected', 'manual')`,
    ),
    check('notification_suppression_source', sql`${t.source} in ('postmark', 'smtp', 'admin')`),
    check(
      'notification_suppression_email_shape',
      sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
    check('notification_suppression_seen', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  ],
);

/** Each Postmark bounce or spam complaint, once, by Postmark's ID. Rows are never changed. */
export const bounceEvent = pgTable(
  'notification_bounce_event',
  {
    postmarkId: bigint('postmark_id', { mode: 'number' }).primaryKey(),
    recordType: text('record_type').notNull(),
    bounceType: text('bounce_type').notNull(),
    bounceTypeCode: integer('bounce_type_code').notNull(),
    outboxId: uuid('outbox_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'notification_bounce_event_record_type',
      sql`${t.recordType} in ('Bounce', 'SpamComplaint')`,
    ),
  ],
);
