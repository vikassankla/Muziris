import type { PaymentMethod } from '@muziris/orders';

// Gateway credentials (ADR 0019) come from the environment only. They are checked once at
// startup. An error names the variables that are wrong, never their values.

export interface StripeConfig {
  secretKey: string;
  /** Published by design: the browser needs it to show Stripe's payment form. */
  publishableKey: string;
  webhookSecret: string;
}

export interface RazorpayConfig {
  /** Published by design: Razorpay Checkout in the browser needs it. */
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface PaymentGateways {
  stripe?: StripeConfig;
  razorpay?: RazorpayConfig;
}

export const PAYMENT_ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
] as const;

/** The shortest Razorpay webhook secret accepted. */
export const RAZORPAY_WEBHOOK_SECRET_MIN_LENGTH = 16;

type Source = Readonly<Record<string, string | undefined>>;

function read(source: Source, name: string): string | undefined {
  const value = source[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads both gateways. A gateway is on when all its variables are set and off when none are;
 * some but not all is an error. Live keys are refused unless PAYMENTS_LIVE is "true".
 */
export function paymentGatewaysFromEnv(source: Source): PaymentGateways {
  const live = read(source, 'PAYMENTS_LIVE') === 'true';
  const problems: string[] = [];

  function gateway<K extends string>(
    names: Record<K, string>,
    prefixes: Partial<Record<K, readonly string[]>>,
  ): Record<K, string> | undefined {
    const entries = Object.entries(names) as [K, string][];
    const values = entries.map(([key, name]) => [key, name, read(source, name)] as const);
    const missing = values.filter(([, , v]) => v === undefined).map(([, name]) => name);
    if (missing.length === values.length) return undefined;
    if (missing.length > 0) {
      problems.push(`${missing.join(', ')}: set every variable of a gateway, or none`);
      return undefined;
    }
    const result = {} as Record<K, string>;
    for (const [key, name, value] of values) {
      const allowed = prefixes[key];
      if (value === undefined) continue;
      if (allowed && !allowed.some((p) => value.startsWith(p))) {
        const hint = !live && allowed.some((p) => p.includes('_test_'));
        problems.push(
          `${name}: expected a key starting ${allowed.join(' or ')}${hint ? ' (live keys need PAYMENTS_LIVE=true)' : ''}`,
        );
      }
      result[key] = value;
    }
    return result;
  }

  const stripe = gateway(
    {
      secretKey: 'STRIPE_SECRET_KEY',
      publishableKey: 'STRIPE_PUBLISHABLE_KEY',
      webhookSecret: 'STRIPE_WEBHOOK_SECRET',
    },
    {
      secretKey: live ? ['sk_test_', 'sk_live_'] : ['sk_test_'],
      publishableKey: live ? ['pk_test_', 'pk_live_'] : ['pk_test_'],
      webhookSecret: ['whsec_'],
    },
  );
  const razorpay = gateway(
    {
      keyId: 'RAZORPAY_KEY_ID',
      keySecret: 'RAZORPAY_KEY_SECRET',
      webhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
    },
    { keyId: live ? ['rzp_test_', 'rzp_live_'] : ['rzp_test_'] },
  );
  // Razorpay takes any webhook secret the operator types, and a short one could be guessed and
  // used to sign a payment event; Stripe's are generated.
  if (razorpay && razorpay.webhookSecret.length < RAZORPAY_WEBHOOK_SECRET_MIN_LENGTH) {
    problems.push(
      `RAZORPAY_WEBHOOK_SECRET: use at least ${String(RAZORPAY_WEBHOOK_SECRET_MIN_LENGTH)} random characters`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return { ...(stripe ? { stripe } : {}), ...(razorpay ? { razorpay } : {}) };
}

/** The payment methods the configured gateways can take. */
export function configuredMethods(gateways: PaymentGateways): Set<PaymentMethod> {
  const methods = new Set<PaymentMethod>();
  if (gateways.stripe) {
    methods.add('stripe_card');
    methods.add('stripe_ach');
  }
  if (gateways.razorpay) methods.add('razorpay');
  return methods;
}
