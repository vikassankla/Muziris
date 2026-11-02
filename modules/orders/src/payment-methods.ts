// How an order is paid (ADR 0019). Terms is an invoice the customer pays later; the others are
// paid online through a gateway, which the API enables only when its keys are configured.

export const PAYMENT_METHODS = ['terms', 'stripe_card', 'stripe_ach', 'razorpay'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The currency each gateway method takes: Stripe in the US, Razorpay in India. */
export const METHOD_CURRENCIES: Readonly<Record<Exclude<PaymentMethod, 'terms'>, string>> = {
  stripe_card: 'USD',
  stripe_ach: 'USD',
  razorpay: 'INR',
};

/**
 * The methods a checkout may offer: those the setting lists, that are configured (terms always
 * is), and that take the order's currency. In the setting's order.
 */
export function availableMethods(
  listed: readonly PaymentMethod[],
  configured: ReadonlySet<PaymentMethod>,
  currency: string,
): PaymentMethod[] {
  return listed.filter(
    (m, i) =>
      listed.indexOf(m) === i &&
      (m === 'terms' || (configured.has(m) && METHOD_CURRENCIES[m] === currency)),
  );
}
