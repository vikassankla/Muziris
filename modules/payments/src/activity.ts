import type { Database } from '@muziris/db';
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { paymentTransactions, type Gateway } from './db/schema.js';
import type { PaymentTransaction } from './payments.js';

// Whether webhooks arrive, for the admin's payments screen (ADR 0030). Read from the transaction
// log, which holds no secret and no card or bank detail.

/** Outcomes that mean an event was refused: it named a payment we do not know, or a wrong amount. */
const REFUSED_OUTCOMES = ['amount_mismatch', 'unknown_payment'] as const;

export interface WebhookActivity {
  lastEvent: {
    receivedAt: Date;
    type: string;
    outcome: PaymentTransaction['outcome'];
  } | null;
  /** Events refused since the time asked about. */
  refusedSince: number;
}

/** Each gateway's latest webhook event, and how many were refused since a time. */
export async function webhookActivity(
  db: Database,
  since: Date,
): Promise<Record<Gateway, WebhookActivity>> {
  const one = async (gateway: Gateway): Promise<WebhookActivity> => {
    const [[last], [refused]] = await Promise.all([
      db
        .select({
          receivedAt: paymentTransactions.receivedAt,
          type: paymentTransactions.eventType,
          outcome: paymentTransactions.outcome,
        })
        .from(paymentTransactions)
        .where(eq(paymentTransactions.gateway, gateway))
        .orderBy(desc(paymentTransactions.receivedAt), desc(paymentTransactions.seq))
        .limit(1),
      db
        .select({ n: count() })
        .from(paymentTransactions)
        .where(
          and(
            eq(paymentTransactions.gateway, gateway),
            inArray(paymentTransactions.outcome, [...REFUSED_OUTCOMES]),
            gte(paymentTransactions.receivedAt, since),
          ),
        ),
    ]);
    return {
      lastEvent: last ? { ...last, outcome: last.outcome as PaymentTransaction['outcome'] } : null,
      refusedSince: refused?.n ?? 0,
    };
  };
  const [stripe, razorpay] = await Promise.all([one('stripe'), one('razorpay')]);
  return { stripe, razorpay };
}
