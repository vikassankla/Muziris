import type { Database, Transaction } from '@muziris/db';
import { findOrderForBuyer, type PaymentMethod } from '@muziris/orders';
import { and, asc, eq } from 'drizzle-orm';
import { payments, paymentTransactions, type Gateway, type PaymentStatus } from './db/schema.js';
import type { EventEffect, GatewayEvent } from './events.js';
import { GatewayError, type GatewayClients } from './gateways.js';

// Payments for orders paid online (ADR 0019). The payment row is made when the buyer first
// starts paying. Only a signed webhook, or the gateway itself read server to server, changes
// its status; nothing the browser says is trusted.

export interface Payment {
  id: string;
  orderId: string;
  method: PaymentMethod;
  gateway: Gateway;
  gatewayRef: string | null;
  amountMinor: bigint;
  currency: string;
  status: PaymentStatus;
  refundedMinor: bigint;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentTransaction {
  id: string;
  eventId: string;
  eventType: string;
  amountMinor: bigint | null;
  currency: string | null;
  outcome: 'applied' | 'ignored' | 'amount_mismatch' | 'unknown_payment';
  statusAfter: PaymentStatus | null;
  receivedAt: Date;
}

/** What the browser needs to show the gateway's own payment form. */
export type PaymentStart =
  | { gateway: 'stripe'; publishableKey: string; clientSecret: string }
  | {
      gateway: 'razorpay';
      keyId: string;
      razorpayOrderId: string;
      amountMinor: bigint;
      currency: string;
    };

export type PaymentRefusalCode =
  | 'order_not_found'
  /** The order is on terms. */
  | 'not_paid_online'
  | 'already_paid'
  /** Cancelled at the gateway; the order cannot be paid any more. */
  | 'payment_closed'
  | 'gateway_not_configured'
  | 'gateway_unavailable';

export type StartPaymentResult =
  { ok: true; payment: Payment; start: PaymentStart } | { ok: false; refusal: PaymentRefusalCode };

type Row = typeof payments.$inferSelect;

function toPayment(row: Row): Payment {
  return {
    id: row.id,
    orderId: row.orderId,
    method: row.method as PaymentMethod,
    gateway: row.gateway as Gateway,
    gatewayRef: row.gatewayRef,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status as PaymentStatus,
    refundedMinor: row.refundedMinor,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const gatewayOf = (method: PaymentMethod): Gateway =>
  method === 'razorpay' ? 'razorpay' : 'stripe';

/** The payment of an order, if one was started. */
export async function findPaymentForOrder(
  db: Database,
  orderId: string,
): Promise<Payment | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  return row ? toPayment(row) : undefined;
}

/** A payment's transaction log, in the order it was recorded. */
export async function listPaymentTransactions(
  db: Database,
  paymentId: string,
): Promise<PaymentTransaction[]> {
  const rows = await db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.paymentId, paymentId))
    .orderBy(asc(paymentTransactions.seq));
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    eventType: r.eventType,
    amountMinor: r.amountMinor,
    currency: r.currency,
    outcome: r.outcome as PaymentTransaction['outcome'],
    statusAfter: r.statusAfter as PaymentStatus | null,
    receivedAt: r.receivedAt,
  }));
}

/**
 * Starts, or starts again, paying an order the buyer may see: makes the payment and the gateway
 * object on first use, and returns what the browser needs. The row lock keeps two tabs from
 * making two gateway objects.
 */
export async function startPayment(
  db: Database,
  clients: GatewayClients,
  input: { buyerUserId: string; websiteId: string; orderNumber: string; now: Date },
): Promise<StartPaymentResult> {
  const order = await findOrderForBuyer(db, input.buyerUserId, {
    websiteId: input.websiteId,
    number: input.orderNumber,
  });
  if (!order) return { ok: false, refusal: 'order_not_found' };
  if (order.paymentMethod === 'terms') return { ok: false, refusal: 'not_paid_online' };
  const method = order.paymentMethod;
  const gateway = gatewayOf(method);
  const { stripe, razorpay } = clients;
  if ((gateway === 'stripe' && !stripe) || (gateway === 'razorpay' && !razorpay)) {
    return { ok: false, refusal: 'gateway_not_configured' };
  }

  try {
    return await db.transaction(async (tx): Promise<StartPaymentResult> => {
      await tx
        .insert(payments)
        .values({
          orderId: order.id,
          websiteId: order.websiteId,
          method,
          gateway,
          amountMinor: order.grandTotal.minor,
          currency: order.currency,
        })
        .onConflictDoNothing({ target: payments.orderId });
      const [row] = await tx
        .select()
        .from(payments)
        .where(eq(payments.orderId, order.id))
        .for('update');
      if (!row) throw new Error(`Payment for order ${order.id} vanished`);
      if (
        row.status === 'paid' ||
        row.status === 'refunded' ||
        row.status === 'partially_refunded'
      ) {
        return { ok: false, refusal: 'already_paid' };
      }
      if (row.status === 'cancelled') return { ok: false, refusal: 'payment_closed' };

      const ask = {
        amountMinor: row.amountMinor,
        currency: row.currency,
        orderNumber: order.number,
        paymentId: row.id,
      };
      let start: PaymentStart;
      let ref = row.gatewayRef;
      if (stripe && method !== 'razorpay') {
        const intent =
          ref === null
            ? await stripe.createIntent({ ...ask, method })
            : await stripe.retrieveIntent(ref);
        ref = intent.ref;
        start = {
          gateway: 'stripe',
          publishableKey: stripe.publishableKey,
          clientSecret: intent.clientSecret,
        };
      } else if (razorpay) {
        ref ??= (await razorpay.createOrder(ask)).ref;
        start = {
          gateway: 'razorpay',
          keyId: razorpay.keyId,
          razorpayOrderId: ref,
          amountMinor: row.amountMinor,
          currency: row.currency,
        };
      } else {
        return { ok: false, refusal: 'gateway_not_configured' };
      }
      // A failed payment may be tried again; it is pending until the gateway says otherwise.
      const [updated] = await tx
        .update(payments)
        .set({ gatewayRef: ref, status: 'pending', updatedAt: input.now })
        .where(eq(payments.id, row.id))
        .returning();
      if (!updated) throw new Error(`Payment ${row.id} vanished`);
      return { ok: true, payment: toPayment(updated), start };
    });
  } catch (error) {
    if (error instanceof GatewayError) return { ok: false, refusal: 'gateway_unavailable' };
    throw error;
  }
}

/** Where an effect takes a payment; the same status when it changes nothing. */
export function nextStatus(
  payment: { status: PaymentStatus; amountMinor: bigint; refundedMinor: bigint },
  effect: Exclude<EventEffect, { kind: 'none' }>,
): { status: PaymentStatus; refundedMinor: bigint } {
  const { status, refundedMinor } = payment;
  const same = { status, refundedMinor };
  if (effect.kind === 'refund') {
    const refundable = status === 'paid' || status === 'partially_refunded';
    if (!refundable || effect.refundedMinor <= refundedMinor) return same;
    return {
      status: effect.refundedMinor >= payment.amountMinor ? 'refunded' : 'partially_refunded',
      refundedMinor: effect.refundedMinor,
    };
  }
  const open = status === 'pending' || status === 'failed';
  if (effect.status === 'paid')
    return open || status === 'cancelled' ? { ...same, status: 'paid' } : same;
  return open && status !== effect.status ? { ...same, status: effect.status } : same;
}

export type ApplyEventResult =
  | { outcome: 'duplicate' }
  | {
      outcome: PaymentTransaction['outcome'];
      payment: Payment | undefined;
      /** Set when the event changed the payment's status. */
      changedTo: PaymentStatus | undefined;
    };

/**
 * Applies one verified gateway event: logs it once (a repeat is a duplicate and changes
 * nothing), checks its amount and currency against the payment, and moves the payment.
 */
/**
 * Called in the transaction that changes a payment's status, so what it writes (the payment
 * emails, ADR 0020) commits or rolls back with the change.
 */
export interface PaymentHooks {
  onStatusChanged?: (
    tx: Transaction,
    change: { payment: Payment; from: PaymentStatus; to: PaymentStatus },
  ) => Promise<void>;
}

/** The payment a gateway reference belongs to, such as a webhook's PaymentIntent id. */
export async function findPaymentByGatewayRef(
  db: Database,
  gateway: Gateway,
  ref: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.gateway, gateway), eq(payments.gatewayRef, ref)))
    .limit(1);
  return row ? toPayment(row) : undefined;
}

export async function applyGatewayEvent(
  db: Database,
  gateway: Gateway,
  event: GatewayEvent,
  now: Date,
  hooks: PaymentHooks = {},
): Promise<ApplyEventResult> {
  return db.transaction(async (tx): Promise<ApplyEventResult> => {
    const [row] =
      event.ref === null
        ? []
        : await tx
            .select()
            .from(payments)
            .where(and(eq(payments.gateway, gateway), eq(payments.gatewayRef, event.ref)))
            .for('update');

    let outcome: PaymentTransaction['outcome'];
    let next: { status: PaymentStatus; refundedMinor: bigint } | undefined;
    if (event.effect.kind === 'none') outcome = 'ignored';
    else if (!row) outcome = 'unknown_payment';
    else if (
      event.currency !== row.currency ||
      event.amountMinor === null ||
      (event.effect.kind === 'status'
        ? event.amountMinor !== row.amountMinor
        : event.amountMinor > row.amountMinor)
    ) {
      outcome = 'amount_mismatch';
    } else {
      next = nextStatus(toPayment(row), event.effect);
      const changed = next.status !== row.status || next.refundedMinor !== row.refundedMinor;
      outcome = changed ? 'applied' : 'ignored';
    }

    const logged = await tx
      .insert(paymentTransactions)
      .values({
        paymentId: row?.id ?? null,
        gateway,
        eventId: event.eventId,
        eventType: event.eventType,
        gatewayRef: event.ref,
        amountMinor: event.amountMinor,
        currency: event.currency,
        outcome,
        statusAfter: next?.status ?? row?.status ?? null,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: [paymentTransactions.gateway, paymentTransactions.eventId] })
      .returning({ id: paymentTransactions.id });
    if (logged.length === 0) return { outcome: 'duplicate' };
    if (!row) return { outcome, payment: undefined, changedTo: undefined };
    if (outcome !== 'applied' || !next)
      return { outcome, payment: toPayment(row), changedTo: undefined };

    const [updated] = await tx
      .update(payments)
      .set({
        status: next.status,
        refundedMinor: next.refundedMinor,
        updatedAt: now,
        ...(next.status === 'paid' && row.paidAt === null ? { paidAt: now } : {}),
      })
      .where(eq(payments.id, row.id))
      .returning();
    if (!updated) throw new Error(`Payment ${row.id} vanished`);
    const payment = toPayment(updated);
    const changedTo = next.status === row.status ? undefined : next.status;
    if (changedTo !== undefined && hooks.onStatusChanged) {
      await hooks.onStatusChanged(tx, {
        payment,
        from: row.status as PaymentStatus,
        to: changedTo,
      });
    }
    return { outcome, payment, changedTo };
  });
}

export type CheckPaymentResult =
  | { ok: true; payment: Payment | undefined; changedTo: PaymentStatus | undefined }
  | { ok: false; refusal: 'order_not_found' | 'not_paid_online' };

/**
 * The payment of an order the buyer may see. A pending payment is read from the gateway once,
 * server to server, so a slow webhook does not leave the buyer waiting.
 */
export async function checkPayment(
  db: Database,
  clients: GatewayClients,
  input: { buyerUserId: string; websiteId: string; orderNumber: string; now: Date },
  hooks: PaymentHooks = {},
): Promise<CheckPaymentResult> {
  const order = await findOrderForBuyer(db, input.buyerUserId, {
    websiteId: input.websiteId,
    number: input.orderNumber,
  });
  if (!order) return { ok: false, refusal: 'order_not_found' };
  if (order.paymentMethod === 'terms') return { ok: false, refusal: 'not_paid_online' };
  const payment = await findPaymentForOrder(db, order.id);
  if (payment?.status !== 'pending' || payment.gatewayRef === null) {
    return { ok: true, payment, changedTo: undefined };
  }
  const ref = payment.gatewayRef;
  let state;
  try {
    state =
      payment.gateway === 'stripe'
        ? await clients.stripe?.retrieveIntent(ref)
        : await clients.razorpay?.orderState(ref);
  } catch (error) {
    // The webhook will still come; the buyer sees the payment as pending meanwhile.
    if (error instanceof GatewayError) return { ok: true, payment, changedTo: undefined };
    throw error;
  }
  if (!state || state.status === 'pending') return { ok: true, payment, changedTo: undefined };
  const applied = await applyGatewayEvent(
    db,
    payment.gateway,
    {
      // One log row per status read, however often the buyer reloads.
      eventId: `poll:${state.status}:${ref}`,
      eventType: 'poll',
      ref,
      amountMinor: state.amountMinor,
      currency: state.currency,
      effect: { kind: 'status', status: state.status },
    },
    input.now,
    hooks,
  );
  if (applied.outcome === 'duplicate') {
    return { ok: true, payment: await findPaymentForOrder(db, order.id), changedTo: undefined };
  }
  return { ok: true, payment: applied.payment, changedTo: applied.changedTo };
}
