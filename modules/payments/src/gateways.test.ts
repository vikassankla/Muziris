import { describe, expect, it } from 'vitest';
import { createGatewayClients, GatewayError, razorpayStatus, stripeStatus } from './gateways.js';

const STRIPE = {
  secretKey: 'sk_test_hidden',
  publishableKey: 'pk_test_x',
  webhookSecret: 'whsec_x',
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetcher };
}

describe('the Stripe client', () => {
  it('makes a PaymentIntent with the order total, one per payment by idempotency key', async () => {
    const { calls, fetcher } = fakeFetch(200, {
      id: 'pi_1',
      status: 'requires_payment_method',
      amount: 1250,
      currency: 'usd',
      client_secret: 'pi_1_secret_x',
    });
    const { stripe } = createGatewayClients(
      { stripe: STRIPE },
      { fetch: fetcher, stripeApi: 'https://stripe.test' },
    );
    const intent = await stripe?.createIntent({
      amountMinor: 1250n,
      currency: 'USD',
      method: 'stripe_ach',
      orderNumber: 'MZ-000001',
      paymentId: 'p1',
    });
    expect(intent).toEqual({
      ref: 'pi_1',
      status: 'pending',
      amountMinor: 1250n,
      currency: 'USD',
      clientSecret: 'pi_1_secret_x',
    });
    const [call] = calls;
    expect(call?.url).toBe('https://stripe.test/v1/payment_intents');
    expect(new URLSearchParams(call?.init.body as string).get('payment_method_types[]')).toBe(
      'us_bank_account',
    );
    expect(new Headers(call?.init.headers).get('idempotency-key')).toBe('payment-p1');
  });

  it('fails with the status only, never what the gateway said', async () => {
    const { fetcher } = fakeFetch(402, { error: { message: 'Your card sk_test_hidden' } });
    const { stripe } = createGatewayClients({ stripe: STRIPE }, { fetch: fetcher });
    const error = await stripe?.retrieveIntent('pi_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(String(error)).toBe('GatewayError: stripe answered HTTP 402');
  });
});

describe('statuses', () => {
  it('maps the gateways’ states to ours', () => {
    expect(stripeStatus('succeeded')).toBe('paid');
    expect(stripeStatus('processing')).toBe('pending');
    expect(stripeStatus('canceled')).toBe('cancelled');
    expect(razorpayStatus(['failed', 'captured'])).toBe('paid');
    expect(razorpayStatus(['failed', 'failed'])).toBe('failed');
    expect(razorpayStatus([])).toBe('pending');
  });
});
