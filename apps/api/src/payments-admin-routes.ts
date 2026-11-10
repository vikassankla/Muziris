import type { Database } from '@muziris/db';
import {
  availableMethods,
  METHOD_CURRENCIES,
  PAYMENT_METHODS_SETTING,
  type PaymentMethod,
} from '@muziris/orders';
import {
  configuredMethods,
  webhookActivity,
  type Gateway,
  type PaymentGateways,
} from '@muziris/payments';
import {
  findOrganization,
  listWebsites,
  loadStoredValues,
  resolveSetting,
} from '@muziris/platform';
import { Hono } from 'hono';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { paymentMethodWarnings } from './payment-method-warnings.js';

// The payments screen under /admin/v1/payments (ADR 0030), read only. Gateway keys stay in the
// environment (ADR 0019): this answer says which variables are set and shows the one key that is
// public by design, and never reads a secret into the response.

export interface PaymentsAdminRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
  gateways: PaymentGateways;
  /** The storefront's public address, where gateways send webhooks. */
  storefrontUrl: string;
}

interface PaymentsEnv {
  Variables: AdminAccessVariables;
}

const REFUSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface GatewayFacts {
  name: string;
  variables: readonly string[];
  methods: readonly Exclude<PaymentMethod, 'terms'>[];
  /** The key the browser already receives, or undefined when the gateway is not configured. */
  publicKey: (gateways: PaymentGateways) => string | undefined;
  livePrefix: string;
}

const GATEWAY_FACTS: Record<Gateway, GatewayFacts> = {
  stripe: {
    name: 'Stripe',
    variables: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
    methods: ['stripe_card', 'stripe_ach'],
    publicKey: (g) => g.stripe?.publishableKey,
    livePrefix: 'pk_live_',
  },
  razorpay: {
    name: 'Razorpay',
    variables: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
    methods: ['razorpay'],
    publicKey: (g) => g.razorpay?.keyId,
    livePrefix: 'rzp_live_',
  },
};

/** The payments screen's API under /admin/v1/payments. */
export function paymentsAdminRoutes(deps: PaymentsAdminRouteDependencies): Hono<PaymentsEnv> {
  const app = new Hono<PaymentsEnv>();
  const configured = configuredMethods(deps.gateways);
  const base = deps.storefrontUrl.replace(/\/+$/, '');

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/gateways', requirePermission('payment.view', deps), async (c) => {
    const activity = await webhookActivity(
      deps.db,
      new Date(deps.now().getTime() - REFUSED_WINDOW_MS),
    );
    const gateways = (Object.keys(GATEWAY_FACTS) as Gateway[]).map((gateway) => {
      const facts = GATEWAY_FACTS[gateway];
      // A gateway is all its variables or none: a partial set stops the API at startup.
      const publicKey = facts.publicKey(deps.gateways) ?? null;
      const isConfigured = publicKey !== null;
      const { lastEvent, refusedSince } = activity[gateway];
      return {
        gateway,
        name: facts.name,
        configured: isConfigured,
        mode: isConfigured ? (publicKey.startsWith(facts.livePrefix) ? 'live' : 'test') : null,
        publicKey,
        variables: facts.variables.map((name) => ({ name, set: isConfigured })),
        currencies: [...new Set(facts.methods.map((m) => METHOD_CURRENCIES[m]))],
        methods: facts.methods,
        webhookUrl: `${base}/webhooks/${gateway}`,
        lastEvent: lastEvent && {
          receivedAt: lastEvent.receivedAt.toISOString(),
          type: lastEvent.type,
          outcome: lastEvent.outcome,
        },
        refusedEvents7Days: refusedSince,
      };
    });

    const organization = await findOrganization(deps.db);
    const sites = organization ? await listWebsites(deps.db, organization.id) : [];
    const websites = await Promise.all(
      sites.map(async (website) => {
        const context = { organizationId: website.organizationId, websiteId: website.id };
        const stored = await loadStoredValues(deps.db, [PAYMENT_METHODS_SETTING.key], context);
        const listed = resolveSetting(PAYMENT_METHODS_SETTING, stored, context).value;
        return {
          id: website.id,
          name: website.name,
          currency: website.defaultCurrency,
          listed,
          offered: availableMethods(listed, configured, website.defaultCurrency),
          warnings: paymentMethodWarnings(listed, configured, [website]),
        };
      }),
    );

    return c.json({ gateways, websites });
  });

  return app;
}
