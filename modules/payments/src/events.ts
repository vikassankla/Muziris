import { z } from 'zod';

// Webhook bodies (ADR 0019), read only after their signature checked out. Each becomes one
// GatewayEvent: what happened, to which gateway object, for how much. Event types we do not use
// become an event with no effect, which is logged in the transaction log and changes nothing.

export type EventEffect =
  | { kind: 'status'; status: 'paid' | 'failed' | 'cancelled' }
  /** The total refunded so far, in minor units. */
  | { kind: 'refund'; refundedMinor: bigint }
  | { kind: 'none' };

export interface GatewayEvent {
  eventId: string;
  eventType: string;
  /** The PaymentIntent id or Razorpay order id; null when the event names none. */
  ref: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  effect: EventEffect;
}

export class EventError extends Error {
  constructor() {
    super('The webhook body is not an event we can read');
    this.name = 'EventError';
  }
}

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const short = z.string().min(1).max(255);

const stripeEvent = z.object({
  id: short,
  type: short,
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const stripeIntent = z.object({
  id: short,
  amount,
  amount_received: amount.optional(),
  currency: z.string().length(3),
});

const stripeCharge = z.object({
  payment_intent: short,
  amount_refunded: amount,
  currency: z.string().length(3),
});

const STRIPE_STATUS: Readonly<Record<string, 'paid' | 'failed' | 'cancelled'>> = {
  'payment_intent.succeeded': 'paid',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'cancelled',
};

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new EventError();
  return result.data;
}

function json(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new EventError();
  }
}

export function readStripeEvent(rawBody: string): GatewayEvent {
  const event = parse(stripeEvent, json(rawBody));
  const base = { eventId: event.id, eventType: event.type };
  const status = STRIPE_STATUS[event.type];
  if (status) {
    const intent = parse(stripeIntent, event.data.object);
    return {
      ...base,
      ref: intent.id,
      amountMinor: BigInt(
        status === 'paid' ? (intent.amount_received ?? intent.amount) : intent.amount,
      ),
      currency: intent.currency.toUpperCase(),
      effect: { kind: 'status', status },
    };
  }
  if (event.type === 'charge.refunded') {
    const charge = parse(stripeCharge, event.data.object);
    return {
      ...base,
      ref: charge.payment_intent,
      amountMinor: BigInt(charge.amount_refunded),
      currency: charge.currency.toUpperCase(),
      effect: { kind: 'refund', refundedMinor: BigInt(charge.amount_refunded) },
    };
  }
  return { ...base, ref: null, amountMinor: null, currency: null, effect: { kind: 'none' } };
}

const razorpayEvent = z.object({
  event: short,
  payload: z.record(z.string(), z.unknown()),
});

const entity = <T extends z.ZodType>(schema: T) => z.object({ entity: schema });

const razorpayPayment = entity(
  z.object({
    order_id: short,
    amount,
    amount_refunded: amount.optional(),
    currency: z.string().length(3),
  }),
);

const razorpayOrder = entity(
  z.object({ id: short, amount_paid: amount, currency: z.string().length(3) }),
);

/** Razorpay names each delivery in the X-Razorpay-Event-Id header, not in the body. */
export function readRazorpayEvent(rawBody: string, eventId: string | undefined): GatewayEvent {
  const id = parse(short, eventId);
  const event = parse(razorpayEvent, json(rawBody));
  const base = { eventId: id, eventType: event.event };
  if (event.event === 'order.paid') {
    const order = parse(razorpayOrder, event.payload['order']).entity;
    return {
      ...base,
      ref: order.id,
      amountMinor: BigInt(order.amount_paid),
      currency: order.currency,
      effect: { kind: 'status', status: 'paid' },
    };
  }
  if (
    event.event === 'payment.captured' ||
    event.event === 'payment.failed' ||
    event.event === 'refund.processed'
  ) {
    const payment = parse(razorpayPayment, event.payload['payment']).entity;
    const effect: EventEffect =
      event.event === 'refund.processed'
        ? { kind: 'refund', refundedMinor: BigInt(payment.amount_refunded ?? 0) }
        : { kind: 'status', status: event.event === 'payment.captured' ? 'paid' : 'failed' };
    return {
      ...base,
      ref: payment.order_id,
      amountMinor: BigInt(effect.kind === 'refund' ? effect.refundedMinor : payment.amount),
      currency: payment.currency,
      effect,
    };
  }
  return { ...base, ref: null, amountMinor: null, currency: null, effect: { kind: 'none' } };
}
