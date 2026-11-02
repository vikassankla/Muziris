import { sql } from 'drizzle-orm';
import {
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
  'order_placed',
  'order_received',
  'order_confirmed',
  'order_declined',
  'order_completed',
  'payment_received',
  'payment_failed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const OUTBOX_STATUSES = ['queued', 'sent', 'failed'] as const;

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
      sql`${t.kind} in ('buyer_invitation', 'order_placed', 'order_received', 'order_confirmed', 'order_declined', 'order_completed', 'payment_received', 'payment_failed')`,
    ),
    check('notification_outbox_status', sql`${t.status} in ('queued', 'sent', 'failed')`),
    check('notification_outbox_attempts', sql`${t.attempts} >= 0`),
    check(
      'notification_outbox_recipient_shape',
      sql`${t.recipient} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
    check('notification_outbox_sent_at', sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`),
  ],
);
