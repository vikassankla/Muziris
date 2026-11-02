import { consumeRateLimit } from '@muziris/identity';
import { findOrderById } from '@muziris/orders';
import {
  applyGatewayEvent,
  EventError,
  findPaymentByGatewayRef,
  readRazorpayEvent,
  readStripeEvent,
  verifyRazorpaySignature,
  verifyStripeSignature,
  type Gateway,
  type GatewayEvent,
  type PaymentGateways,
} from '@muziris/payments';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthRouteDependencies, AuthVariables } from './auth-routes.js';
import type { Emails } from './emails.js';
import { HttpProblem } from './problem.js';

// Payment gateway webhooks under /webhooks (ADR 0019): the API's only unauthenticated POST
// routes. No session and no trusted origin: each request must carry the gateway's signature
// over its exact body, which is checked before the body is read as JSON. Bodies, headers and
// signatures are never logged.

/** Gateway events are small; anything larger is not one. */
export const WEBHOOK_MAX_BYTES = 64 * 1024;
/** Per gateway and client IP, per minute: well above a gateway's retry bursts. */
const RATE_LIMIT = 600;

export interface WebhookRouteDependencies extends AuthRouteDependencies {
  gateways: PaymentGateways;
  /** Queues the payment emails in the payment's transaction (ADR 0020). */
  emails: Emails;
}

interface WebhookEnv {
  Variables: AuthVariables;
}

export function webhookRoutes(deps: WebhookRouteDependencies): Hono<WebhookEnv> {
  const app = new Hono<WebhookEnv>();
  app.use(
    '*',
    bodyLimit({
      maxSize: WEBHOOK_MAX_BYTES,
      onError: () => {
        throw new HttpProblem(413, 'payload_too_large', 'The request body is too large');
      },
    }),
  );

  async function receive(
    c: Context<WebhookEnv>,
    gateway: Gateway,
    read: (rawBody: string, now: Date) => GatewayEvent | undefined,
  ) {
    const now = deps.now();
    const limited = await consumeRateLimit(
      deps.db,
      `webhook:${gateway}:${deps.clientIp(c) ?? 'unknown'}`,
      RATE_LIMIT,
      60_000,
      now,
    );
    if (!limited.allowed) {
      c.header('Retry-After', String(limited.retryAfterSeconds));
      throw new HttpProblem(429, 'rate_limited', 'Too many requests');
    }
    const rawBody = await c.req.text();
    let event: GatewayEvent | undefined;
    try {
      event = read(rawBody, now);
    } catch (error) {
      if (!(error instanceof EventError)) throw error;
    }
    if (!event) {
      deps.logger.warn({ requestId: c.get('requestId'), gateway }, 'webhook.refused');
      throw new HttpProblem(400, 'webhook_refused', 'The webhook is not signed or not readable');
    }
    // What the payment email needs is read first; the hook only queues it, in the transaction.
    const payment =
      event.ref === null ? undefined : await findPaymentByGatewayRef(deps.db, gateway, event.ref);
    const order = payment ? await findOrderById(deps.db, payment.orderId) : undefined;
    const hooks = await deps.emails.payment(order, now);
    const result = await applyGatewayEvent(deps.db, gateway, event, now, hooks);
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        gateway,
        eventType: event.eventType,
        outcome: result.outcome,
        ...(result.outcome === 'duplicate' ? {} : { paymentId: result.payment?.id }),
      },
      'webhook.received',
    );
    if (result.outcome !== 'duplicate' && result.changedTo !== undefined) {
      // The event emails and the order workflow subscribe to (FR-WF-3, ADR 0020).
      deps.logger.info(
        { paymentId: result.payment?.id, status: result.changedTo },
        'payment.status_changed',
      );
    }
    // Every readable, signed event is acknowledged, so the gateway stops sending it.
    return c.json({ received: true });
  }

  app.post('/stripe', async (c) => {
    const config = deps.gateways.stripe;
    if (!config) throw new HttpProblem(404, 'not_found', 'No such resource');
    return receive(c, 'stripe', (raw, now) =>
      verifyStripeSignature(raw, c.req.header('stripe-signature'), config.webhookSecret, now)
        ? readStripeEvent(raw)
        : undefined,
    );
  });

  app.post('/razorpay', async (c) => {
    const config = deps.gateways.razorpay;
    if (!config) throw new HttpProblem(404, 'not_found', 'No such resource');
    return receive(c, 'razorpay', (raw) =>
      verifyRazorpaySignature(raw, c.req.header('x-razorpay-signature'), config.webhookSecret)
        ? readRazorpayEvent(raw, c.req.header('x-razorpay-event-id'))
        : undefined,
    );
  });

  return app;
}
