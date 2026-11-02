import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  createBuyerRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import { createCustomer, createCustomerGroup } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { createWebsite } from '@muziris/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { runSetup } from './setup.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');

interface SettingJson {
  key: string;
  value: unknown;
  source: string;
}

describe.skipIf(!url)('setting routes against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_settings');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate catalog_product_unit, platform_config_value, platform_website,
        platform_organization, customer_customer, customer_group, access_buyer_role_permission,
        access_buyer_role, access_admin_user_role, access_admin_role_permission,
        access_admin_role, identity_session, identity_user, identity_rate_limit cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
    return createApp({
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
      maxBodyBytes: 64 * 1024,
      now: () => NOW,
      clientIp: () => '203.0.113.7',
    });
  }

  async function signedInAdmin(email: string, permissions: AdminPermission[]) {
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email,
      password: PASSWORD,
    });
    const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
      code: `role_${email.split('@')[0] ?? 'x'}`,
      name: email,
      permissions,
    });
    await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    const res = await app().request('/admin/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    return { userId: user.id, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  }

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    app().request(`/admin/v1/settings${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function seed() {
    const { organization } = await runSetup(handle.db, { organizationName: 'Acme' });
    const website = await createWebsite(handle.db, {
      organizationId: organization.id,
      code: 'acme-in',
      name: 'Acme India',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      defaultLocale: 'en-IN',
      timeZone: 'Asia/Kolkata',
    });
    const group = await createCustomerGroup(handle.db, {
      code: 'key_accounts',
      name: 'Key accounts',
    });
    const customer = await createCustomer(handle.db, {
      name: 'Acme Engineering',
      groupId: group.id,
    });
    return { website, group, customer };
  }

  const termDays = async (cookie: string, query: string) => {
    const { settings } = (await (await call('GET', query, cookie)).json()) as {
      settings: SettingJson[];
    };
    return settings.find((s) => s.key === 'payment.term_days');
  };

  it('shows effective values with their source, and overrides and clears them', async () => {
    const { website, customer } = await seed();
    const ops = await signedInAdmin('ops@muziris.example', ['setting.view', 'setting.manage']);
    expect(await termDays(ops.cookie, `?customerId=${customer.id}`)).toMatchObject({
      value: 30,
      source: 'default',
    });

    const set = (key: string, scope: unknown, value: unknown) =>
      call('PUT', `/${key}`, ops.cookie, { scope, value });
    expect((await set('payment.term_days', { type: 'website', id: website.id }, 45)).status).toBe(
      200,
    );
    expect((await set('payment.term_days', { type: 'customer', id: customer.id }, 60)).status).toBe(
      200,
    );
    expect(
      await termDays(ops.cookie, `?websiteId=${website.id}&customerId=${customer.id}`),
    ).toMatchObject({ value: 60, source: 'customer' });
    expect(await termDays(ops.cookie, `?websiteId=${website.id}`)).toMatchObject({
      value: 45,
      source: 'website',
    });

    const [row] = await handle.db.execute<{ updated_by_user_id: string }>(
      sql`select updated_by_user_id from platform_config_value where scope_type = 'website'`,
    );
    expect(row?.updated_by_user_id).toBe(ops.userId);

    const cleared = await call(
      'DELETE',
      `/payment.term_days?scope=customer&scopeId=${customer.id}`,
      ops.cookie,
    );
    expect(cleared.status).toBe(204);
    expect(
      await termDays(ops.cookie, `?websiteId=${website.id}&customerId=${customer.id}`),
    ).toMatchObject({ value: 45, source: 'website' });
  });

  it('refuses unknown settings, bad values, scopes a setting does not allow, and missing roles', async () => {
    const { website, customer } = await seed();
    const ops = await signedInAdmin('ops@muziris.example', ['setting.view', 'setting.manage']);
    const put = (key: string, body: unknown) => call('PUT', `/${key}`, ops.cookie, body);
    const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

    expect(await codeOf(await put('no.such', { scope: { type: 'global' }, value: 1 }))).toBe(
      'setting_not_found',
    );
    expect(
      await codeOf(
        await put('payment.term_days', { scope: { type: 'website', id: website.id }, value: 400 }),
      ),
    ).toBe('setting_invalid_value');
    expect(
      await codeOf(
        await put('shipping.flat_rate', {
          scope: { type: 'customer', id: customer.id },
          value: { amount: '10' },
        }),
      ),
    ).toBe('setting_scope_not_allowed');
    expect(
      await codeOf(
        await put('customers.default_buyer_role', {
          scope: { type: 'organization' },
          value: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('buyer_role_not_found');
    const role = await createBuyerRole(handle.db, { code: 'orderer', name: 'Orderer', grants: [] });
    expect(
      (
        await put('customers.default_buyer_role', {
          scope: { type: 'organization' },
          value: role.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('GET', '?websiteId=00000000-0000-4000-8000-000000000000', ops.cookie)).status,
    ).toBe(404);
  });

  it('needs setting.view to read and setting.manage to change', async () => {
    const { website } = await seed();
    const viewer = await signedInAdmin('viewer@muziris.example', ['setting.view']);
    const nobody = await signedInAdmin('nobody@muziris.example', ['order.view']);
    expect((await call('GET', '', nobody.cookie)).status).toBe(403);
    expect((await call('GET', '', viewer.cookie)).status).toBe(200);
    expect(
      (
        await call('PUT', '/payment.term_days', viewer.cookie, {
          scope: { type: 'website', id: website.id },
          value: 10,
        })
      ).status,
    ).toBe(403);
  });
});
