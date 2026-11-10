import type { PaymentMethod } from '@muziris/orders';
import { describe, expect, it } from 'vitest';
import { paymentMethodWarnings } from './payment-method-warnings.js';

const INDIA = { name: 'Acme India', defaultCurrency: 'INR' };
const US = { name: 'Acme US', defaultCurrency: 'USD' };
const NONE = new Set<PaymentMethod>();
const STRIPE = new Set<PaymentMethod>(['stripe_card', 'stripe_ach']);
const BOTH = new Set<PaymentMethod>(['stripe_card', 'stripe_ach', 'razorpay']);

describe('paymentMethodWarnings', () => {
  it.each<[string, PaymentMethod[], ReadonlySet<PaymentMethod>, string[]]>([
    ['terms always works', ['terms'], NONE, []],
    ['configured methods in the right currency', ['razorpay'], BOTH, []],
    ['an empty list', [], BOTH, ['No payment method is chosen, so checkout refuses every order.']],
    [
      'a gateway without keys, with nothing else',
      ['razorpay'],
      NONE,
      [
        'Checkout refuses every order on Acme India: none of these methods can be used there.',
        'Razorpay is not offered: its keys are not set on the server.',
      ],
    ],
    [
      'a gateway without keys, beside terms',
      ['terms', 'razorpay'],
      STRIPE,
      ['Razorpay is not offered: its keys are not set on the server.'],
    ],
    [
      'a gateway in the wrong currency',
      ['terms', 'stripe_card'],
      STRIPE,
      ['Card (Stripe) is not offered on Acme India: it takes USD only.'],
    ],
  ])('India website: %s', (_name, listed, configured, expected) => {
    expect(paymentMethodWarnings(listed, configured, [INDIA])).toEqual(expected);
  });

  it('checks each website a value reaches, and names a missing key once', () => {
    expect(paymentMethodWarnings(['stripe_card', 'razorpay'], STRIPE, [INDIA, US])).toEqual([
      'Checkout refuses every order on Acme India: none of these methods can be used there.',
      'Razorpay is not offered: its keys are not set on the server.',
      'Card (Stripe) is not offered on Acme India: it takes USD only.',
    ]);
  });

  it('has nothing to say without a website', () => {
    expect(paymentMethodWarnings(['razorpay'], NONE, [])).toEqual([
      'Razorpay is not offered: its keys are not set on the server.',
    ]);
  });
});
