import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

// Tables owned by the payments module (ADR 0019). Other modules must not query these directly;
// they use the functions exported from @muziris/payments.
//
// Orders belong to the orders module, so a payment refers to its order by id without a foreign
// key. No card or bank detail is ever stored: those go straight from the buyer to the gateway.

export const PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const GATEWAYS = ['stripe', 'razorpay'] as const;

export type Gateway = (typeof GATEWAYS)[number];

/** One payment per order paid online, made when the buyer starts paying. */
export const payments = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull(),
    websiteId: uuid('website_id').notNull(),
    /** The order's payment method, such as stripe_card. */
    method: text('method').notNull(),
    gateway: text('gateway').notNull(),
    /** The Stripe PaymentIntent id or the Razorpay order id, once made. */
    gatewayRef: text('gateway_ref'),
    /** The order's grand total in minor units, which every gateway amount must equal. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('pending'),
    /** Minor units refunded so far. */
    refundedMinor: bigint('refunded_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_order_uq').on(t.orderId),
    unique('payment_gateway_ref_uq').on(t.gateway, t.gatewayRef),
    check('payment_gateway', sql`${t.gateway} in ('stripe', 'razorpay')`),
    check(
      'payment_status',
      sql`${t.status} in ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')`,
    ),
    check('payment_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'payment_amounts',
      sql`${t.amountMinor} > 0 and ${t.refundedMinor} between 0 and ${t.amountMinor}`,
    ),
  ],
);

/**
 * The transaction log: one row per gateway event, unique on the gateway's event id, so a webhook
 * delivered twice is recorded and applied once. Rows are never changed.
 */
export const paymentTransactions = pgTable(
  'payment_transaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The order events were recorded in, which a timestamp alone cannot settle. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    /** Null when the event names no payment we know. */
    paymentId: uuid('payment_id').references(() => payments.id),
    gateway: text('gateway').notNull(),
    eventId: text('event_id').notNull(),
    /** The gateway's event type, such as payment_intent.succeeded. */
    eventType: text('event_type').notNull(),
    gatewayRef: text('gateway_ref'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    /**
     * What the event did: applied, ignored (no change it could make), amount_mismatch or
     * unknown_payment.
     */
    outcome: text('outcome').notNull(),
    /** The payment's status after the event. */
    statusAfter: text('status_after'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('payment_transaction_event_uq').on(t.gateway, t.eventId),
    index('payment_transaction_payment_idx').on(t.paymentId, t.seq),
    check(
      'payment_transaction_outcome',
      sql`${t.outcome} in ('applied', 'ignored', 'amount_mismatch', 'unknown_payment')`,
    ),
  ],
);
