import type { PaymentMethod } from '@muziris/orders';
import type { PaymentGateways } from './config.js';

// The two gateways' REST APIs (ADR 0019), called with fetch: no SDKs. Each call has a timeout.
// A failure is a GatewayError that carries the HTTP status at most; request and response bodies
// and headers are never put in an error or a log, since they hold keys and client secrets.

export const STRIPE_API = 'https://api.stripe.com';
export const RAZORPAY_API = 'https://api.razorpay.com';
const TIMEOUT_MS = 10_000;

export class GatewayError extends Error {
  readonly gateway: 'stripe' | 'razorpay';
  /** The gateway's HTTP status, or 0 when it could not be reached. */
  readonly status: number;

  constructor(gateway: 'stripe' | 'razorpay', status: number) {
    super(
      status === 0
        ? `${gateway} could not be reached`
        : `${gateway} answered HTTP ${String(status)}`,
    );
    this.name = 'GatewayError';
    this.gateway = gateway;
    this.status = status;
  }
}

/** What a gateway says about a payment, in our terms. */
export interface GatewayState {
  ref: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  amountMinor: bigint;
  currency: string;
}

export interface StripeIntent extends GatewayState {
  /** Lets the browser complete this one payment; never logged or stored. */
  clientSecret: string;
}

export interface GatewayClients {
  stripe?: {
    publishableKey: string;
    createIntent(input: {
      amountMinor: bigint;
      currency: string;
      method: Extract<PaymentMethod, 'stripe_card' | 'stripe_ach'>;
      orderNumber: string;
      paymentId: string;
    }): Promise<StripeIntent>;
    retrieveIntent(ref: string): Promise<StripeIntent>;
  };
  razorpay?: {
    keyId: string;
    createOrder(input: {
      amountMinor: bigint;
      currency: string;
      orderNumber: string;
      paymentId: string;
    }): Promise<GatewayState>;
    orderState(ref: string): Promise<GatewayState>;
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function call(
  gateway: 'stripe' | 'razorpay',
  fetcher: Fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GatewayError(gateway, 0);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GatewayError(gateway, response.status);
  }
  return response.json().catch(() => {
    throw new GatewayError(gateway, response.status);
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, gateway: 'stripe' | 'razorpay'): string {
  if (typeof value !== 'string' || value === '') throw new GatewayError(gateway, 200);
  return value;
}

function minor(value: unknown, gateway: 'stripe' | 'razorpay'): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(gateway, 200);
  }
  return BigInt(value);
}

/** Stripe's PaymentIntent statuses in our terms. requires_* and processing are still pending. */
export function stripeStatus(status: string): GatewayState['status'] {
  if (status === 'succeeded') return 'paid';
  if (status === 'canceled') return 'cancelled';
  return 'pending';
}

function stripeIntent(body: unknown): StripeIntent {
  const o = record(body);
  return {
    ref: text(o['id'], 'stripe'),
    status: stripeStatus(text(o['status'], 'stripe')),
    amountMinor: minor(o['amount'], 'stripe'),
    currency: text(o['currency'], 'stripe').toUpperCase(),
    clientSecret: text(o['client_secret'], 'stripe'),
  };
}

/** A Razorpay order's state from its payments: captured is paid; only failures is failed. */
export function razorpayStatus(paymentStatuses: readonly string[]): GatewayState['status'] {
  if (paymentStatuses.includes('captured')) return 'paid';
  if (paymentStatuses.length > 0 && paymentStatuses.every((s) => s === 'failed')) return 'failed';
  return 'pending';
}

/** Builds the clients for the configured gateways. Tests pass a fake fetch and base URLs. */
export function createGatewayClients(
  gateways: PaymentGateways,
  options: { fetch?: Fetch; stripeApi?: string; razorpayApi?: string } = {},
): GatewayClients {
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const clients: GatewayClients = {};

  if (gateways.stripe) {
    const { secretKey, publishableKey } = gateways.stripe;
    const base = options.stripeApi ?? STRIPE_API;
    const headers = { authorization: `Bearer ${secretKey}` };
    clients.stripe = {
      publishableKey,
      async createIntent(input) {
        const form = new URLSearchParams({
          amount: input.amountMinor.toString(),
          currency: input.currency.toLowerCase(),
          'payment_method_types[]': input.method === 'stripe_ach' ? 'us_bank_account' : 'card',
          'metadata[order_number]': input.orderNumber,
          'metadata[payment_id]': input.paymentId,
        });
        return stripeIntent(
          await call('stripe', fetcher, `${base}/v1/payment_intents`, {
            method: 'POST',
            // The same payment always gets the same PaymentIntent, however often it is asked.
            headers: {
              ...headers,
              'content-type': 'application/x-www-form-urlencoded',
              'idempotency-key': `payment-${input.paymentId}`,
            },
            body: form.toString(),
          }),
        );
      },
      async retrieveIntent(ref) {
        return stripeIntent(
          await call('stripe', fetcher, `${base}/v1/payment_intents/${encodeURIComponent(ref)}`, {
            method: 'GET',
            headers,
          }),
        );
      },
    };
  }

  if (gateways.razorpay) {
    const { keyId, keySecret } = gateways.razorpay;
    const base = options.razorpayApi ?? RAZORPAY_API;
    const headers = {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    };
    clients.razorpay = {
      keyId,
      async createOrder(input) {
        const o = record(
          await call('razorpay', fetcher, `${base}/v1/orders`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              amount: Number(input.amountMinor),
              currency: input.currency,
              receipt: input.orderNumber,
              notes: { payment_id: input.paymentId },
            }),
          }),
        );
        return {
          ref: text(o['id'], 'razorpay'),
          status: o['status'] === 'paid' ? 'paid' : 'pending',
          amountMinor: minor(o['amount'], 'razorpay'),
          currency: text(o['currency'], 'razorpay').toUpperCase(),
        };
      },
      async orderState(ref) {
        const path = `/v1/orders/${encodeURIComponent(ref)}`;
        const [order, paid] = await Promise.all([
          call('razorpay', fetcher, `${base}${path}`, { method: 'GET', headers }),
          call('razorpay', fetcher, `${base}${path}/payments`, { method: 'GET', headers }),
        ]);
        const o = record(order);
        const items = record(paid)['items'];
        const statuses = Array.isArray(items) ? items.map((i) => String(record(i)['status'])) : [];
        return {
          ref: text(o['id'], 'razorpay'),
          status: razorpayStatus(statuses),
          amountMinor: minor(o['amount'], 'razorpay'),
          currency: text(o['currency'], 'razorpay').toUpperCase(),
        };
      },
    };
  }
  return clients;
}
