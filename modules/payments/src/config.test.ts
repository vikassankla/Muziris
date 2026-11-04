import { describe, expect, it } from 'vitest';
import { configuredMethods, paymentGatewaysFromEnv } from './config.js';

const STRIPE = {
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
};
const RAZORPAY = {
  RAZORPAY_KEY_ID: 'rzp_test_abc',
  RAZORPAY_KEY_SECRET: 'secret-value-1',
  RAZORPAY_WEBHOOK_SECRET: 'secret-value-2-of-length',
};

describe('paymentGatewaysFromEnv', () => {
  it('turns a gateway on only when all its variables are set', () => {
    expect(paymentGatewaysFromEnv({})).toEqual({});
    const both = paymentGatewaysFromEnv({ ...STRIPE, ...RAZORPAY });
    expect(both.stripe?.publishableKey).toBe('pk_test_abc');
    expect(both.razorpay?.keyId).toBe('rzp_test_abc');
    expect([...configuredMethods(both)]).toEqual(['stripe_card', 'stripe_ach', 'razorpay']);
    expect(configuredMethods(paymentGatewaysFromEnv(RAZORPAY))).toEqual(new Set(['razorpay']));
  });

  it('names the missing variables of a half-set gateway, without any value', () => {
    expect(() =>
      paymentGatewaysFromEnv({ STRIPE_SECRET_KEY: 'sk_test_hidden', STRIPE_WEBHOOK_SECRET: '' }),
    ).toThrow(/STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET: set every variable/);
    try {
      paymentGatewaysFromEnv({ ...STRIPE, RAZORPAY_KEY_SECRET: 'secret-value-1' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-value-1');
    }
  });

  it('refuses a Razorpay webhook secret short enough to guess, without echoing it', () => {
    let message = '';
    try {
      paymentGatewaysFromEnv({ ...RAZORPAY, RAZORPAY_WEBHOOK_SECRET: 'short-secret' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/RAZORPAY_WEBHOOK_SECRET: use at least 16 random characters/);
    expect(message).not.toContain('short-secret');
  });

  it('refuses live keys unless PAYMENTS_LIVE is true', () => {
    const liveStripe = { ...STRIPE, STRIPE_SECRET_KEY: 'sk_live_hidden' };
    expect(() => paymentGatewaysFromEnv(liveStripe)).toThrow(
      /STRIPE_SECRET_KEY: expected a key starting sk_test_ \(live keys need PAYMENTS_LIVE=true\)/,
    );
    expect(() => paymentGatewaysFromEnv({ ...RAZORPAY, RAZORPAY_KEY_ID: 'rzp_live_x' })).toThrow(
      /RAZORPAY_KEY_ID/,
    );
    expect(paymentGatewaysFromEnv({ ...liveStripe, PAYMENTS_LIVE: 'true' }).stripe?.secretKey).toBe(
      'sk_live_hidden',
    );
  });

  it('checks the webhook secret looks like Stripe’s', () => {
    expect(() =>
      paymentGatewaysFromEnv({ ...STRIPE, STRIPE_WEBHOOK_SECRET: 'not-a-secret' }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET: expected a key starting whsec_$/m);
  });
});
