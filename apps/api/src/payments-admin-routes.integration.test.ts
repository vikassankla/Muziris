import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { mailConfigFromEnv } from '@muziris/notifications';
import { PAYMENT_METHODS_SETTING } from '@muziris/orders';
import { applyGatewayEvent, createGatewayClients, type PaymentGateways } from '@muziris/payments';
import { createOrganization, createWebsite, setSetting } from '@muziris/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { signInAdmin, TEST_TWO_FACTOR_KEY } from './test-admin-sign-in.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const SECRETS = {
  stripeSecret: 'sk_test_never_shown_51abc',
  stripeWebhook: 'whsec_never_shown_51abc',
  razorpaySecret: 'razorpay-key-secret-never-shown',
  razorpayWebhook: 'razorpay-webhook-secret-never-shown',
};

const BOTH: PaymentGateways = {
  stripe: {
    secretKey: SECRETS.stripeSecret,
    publishableKey: 'pk_test_shown_51abc',
    webhookSecret: SECRETS.stripeWebhook,
  },
  razorpay: {
    keyId: 'rzp_test_shown',
    keySecret: SECRETS.razorpaySecret,
    webhookSecret: SECRETS.razorpayWebhook,
  },
};

describe.skipIf(!url)('the payments screen API against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_payments_admin');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate payment_transaction, payment, platform_config_value,
        access_admin_user_role, access_admin_role_permission, access_admin_role,
        platform_website, platform_organization, identity_session, identity_user,
        identity_rate_limit cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  function app(gateways: PaymentGateways | null) {
    return createApp({
      twoFactorKey: TEST_TWO_FACTOR_KEY,
      logger: createLogger(
        'silent',
        new Writable({
          write: (_c, _e, done) => {
            done();
          },
        }),
      ),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 256 * 1024,
      now: () => NOW,
      clientIp: () => '203.0.113.7',
      mail: mailConfigFromEnv(
        {
          STOREFRONT_PUBLIC_URL: 'https://shop.example.com',
          ADMIN_PUBLIC_URL: ORIGIN,
        },
        { production: false },
      ),
      ...(gateways ? { payments: { gateways, clients: createGatewayClients(gateways, {}) } } : {}),
    });
  }

  async function signedInAdmin(permissions: AdminPermission[]): Promise<string> {
    const email = `admin-${String(permissions.length)}@example.com`;
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email,
      password: PASSWORD,
    });
    const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
      code: `role_${String(permissions.length)}`,
      name: email,
      permissions,
    });
    await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    return signInAdmin(app(null), { email, password: PASSWORD, origin: ORIGIN, now: NOW });
  }

  /** An Indian website and a US one; India lists Razorpay and terms, the US lists every method. */
  async function websites() {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    const site = (code: string, name: string, currency: string, country: string) =>
      createWebsite(handle.db, {
        organizationId: org.id,
        code,
        name,
        countryCode: country,
        defaultCurrency: currency,
        defaultLocale: 'en-IN',
        timeZone: 'Asia/Kolkata',
      });
    const india = await site('muziris-in', 'Muziris India', 'INR', 'IN');
    const us = await site('muziris-us', 'Muziris US', 'USD', 'US');
    await setSetting(handle.db, PAYMENT_METHODS_SETTING, { type: 'organization', id: org.id }, [
      'terms',
      'stripe_card',
      'stripe_ach',
      'razorpay',
    ]);
    await setSetting(handle.db, PAYMENT_METHODS_SETTING, { type: 'website', id: india.id }, [
      'razorpay',
      'terms',
    ]);
    return { india, us };
  }

  const get = (gateways: PaymentGateways | null, cookie: string) =>
    app(gateways).request('/admin/v1/payments/gateways', { headers: { Cookie: cookie } });

  it('shows each gateway, its webhook address and events, and what each website offers', async () => {
    await websites();
    const event = (eventId: string, ref: string) => ({
      eventId,
      eventType: 'payment.captured',
      ref,
      amountMinor: 100n,
      currency: 'INR',
      effect: { kind: 'status', status: 'paid' } as const,
    });
    await applyGatewayEvent(
      handle.db,
      'razorpay',
      event('e1', 'order_x'),
      new Date(NOW.getTime() - 2 * DAY),
    );
    await applyGatewayEvent(
      handle.db,
      'razorpay',
      event('e2', 'order_y'),
      new Date(NOW.getTime() - DAY),
    );
    const cookie = await signedInAdmin(['payment.view']);

    const res = await get(BOTH, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);

    expect(JSON.parse(body)).toEqual({
      gateways: [
        {
          gateway: 'stripe',
          name: 'Stripe',
          configured: true,
          mode: 'test',
          publicKey: 'pk_test_shown_51abc',
          variables: [
            { name: 'STRIPE_SECRET_KEY', set: true },
            { name: 'STRIPE_PUBLISHABLE_KEY', set: true },
            { name: 'STRIPE_WEBHOOK_SECRET', set: true },
          ],
          currencies: ['USD'],
          methods: ['stripe_card', 'stripe_ach'],
          webhookUrl: 'https://shop.example.com/webhooks/stripe',
          lastEvent: null,
          refusedEvents7Days: 0,
        },
        {
          gateway: 'razorpay',
          name: 'Razorpay',
          configured: true,
          mode: 'test',
          publicKey: 'rzp_test_shown',
          variables: [
            { name: 'RAZORPAY_KEY_ID', set: true },
            { name: 'RAZORPAY_KEY_SECRET', set: true },
            { name: 'RAZORPAY_WEBHOOK_SECRET', set: true },
          ],
          currencies: ['INR'],
          methods: ['razorpay'],
          webhookUrl: 'https://shop.example.com/webhooks/razorpay',
          lastEvent: {
            receivedAt: new Date(NOW.getTime() - DAY).toISOString(),
            type: 'payment.captured',
            outcome: 'unknown_payment',
          },
          refusedEvents7Days: 2,
        },
      ],
      websites: [
        {
          id: expect.any(String) as string,
          name: 'Muziris India',
          currency: 'INR',
          listed: ['razorpay', 'terms'],
          offered: ['razorpay', 'terms'],
          warnings: [],
        },
        {
          id: expect.any(String) as string,
          name: 'Muziris US',
          currency: 'USD',
          listed: ['terms', 'stripe_card', 'stripe_ach', 'razorpay'],
          offered: ['terms', 'stripe_card', 'stripe_ach'],
          warnings: ['Razorpay is not offered on Muziris US: it takes INR only.'],
        },
      ],
    });
  });

  it('says a gateway is not configured when its keys are not set', async () => {
    await websites();
    const cookie = await signedInAdmin(['payment.view']);
    const res = await get(null, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateways: Record<string, unknown>[];
      websites: { name: string; offered: string[]; warnings: string[] }[];
    };
    expect(body.gateways[0]).toMatchObject({
      gateway: 'stripe',
      configured: false,
      mode: null,
      publicKey: null,
      variables: [
        { name: 'STRIPE_SECRET_KEY', set: false },
        { name: 'STRIPE_PUBLISHABLE_KEY', set: false },
        { name: 'STRIPE_WEBHOOK_SECRET', set: false },
      ],
    });
    expect(body.gateways[1]).toMatchObject({ gateway: 'razorpay', configured: false });
    expect(body.websites[0]).toMatchObject({
      name: 'Muziris India',
      offered: ['terms'],
      warnings: ['Razorpay is not offered: its keys are not set on the server.'],
    });
  });

  it('shows live mode from live keys', async () => {
    const cookie = await signedInAdmin(['payment.view']);
    const live: PaymentGateways = {
      razorpay: {
        keyId: 'rzp_live_shown',
        keySecret: 'x'.repeat(20),
        webhookSecret: 'y'.repeat(20),
      },
    };
    const body = (await (await get(live, cookie)).json()) as {
      gateways: { gateway: string; mode: string | null }[];
    };
    expect(body.gateways.map((g) => [g.gateway, g.mode])).toEqual([
      ['stripe', null],
      ['razorpay', 'live'],
    ]);
  });

  it('refuses an admin without payment.view', async () => {
    const cookie = await signedInAdmin(['setting.view']);
    expect((await get(BOTH, cookie)).status).toBe(403);
  });
});
