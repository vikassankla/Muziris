import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import { listProductUnits } from '@muziris/catalog';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { runSetup, SetupError } from './setup.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');

const INDIA = {
  code: 'acme-in',
  name: 'Acme India',
  countryCode: 'IN',
  defaultCurrency: 'INR',
  defaultLocale: 'en-IN',
  timeZone: 'Asia/Kolkata',
};

describe.skipIf(!url)('setup and website routes against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_websites');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate catalog_product_unit, platform_config_value, platform_website,
        platform_organization, access_admin_user_role, access_admin_role_permission,
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

  async function signedInAdmin(email: string, permissions: AdminPermission[]): Promise<string> {
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
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    app().request(`/admin/v1/websites${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('sets up an empty install once, and changes nothing the second time', async () => {
    await expect(runSetup(handle.db, {})).rejects.toBeInstanceOf(SetupError);
    const first = await runSetup(handle.db, { organizationName: 'Acme Industrial Supply' });
    expect(first).toMatchObject({
      organizationCreated: true,
      unitsAdded: ['each', 'pack', 'kg', 'm', 'l'],
    });
    const second = await runSetup(handle.db, { organizationName: 'Another business' });
    expect(second).toMatchObject({ organizationCreated: false, unitsAdded: [] });
    expect(second.organization).toMatchObject({
      id: first.organization.id,
      name: 'Acme Industrial Supply',
    });
    expect(await listProductUnits(handle.db)).toContainEqual({
      code: 'kg',
      name: 'Kilogram',
      precision: 3,
    });
  });

  it('creates, lists and changes websites, with code, country and currency fixed', async () => {
    const ops = await signedInAdmin('ops@muziris.example', ['website.view', 'website.manage']);
    expect(await (await call('POST', '', ops, INDIA)).json()).toMatchObject({
      code: 'organization_missing',
    });
    await runSetup(handle.db, { organizationName: 'Acme Industrial Supply' });

    const created = await call('POST', '', ops, INDIA);
    expect(created.status).toBe(201);
    const { website } = (await created.json()) as { website: { id: string } };
    expect((await call('POST', '', ops, INDIA)).status).toBe(409);
    expect(
      (await call('POST', '', ops, { ...INDIA, code: 'acme-de', countryCode: 'DE' })).status,
    ).toBe(400);

    const list = (await (await call('GET', '', ops)).json()) as { websites: { code: string }[] };
    expect(list.websites.map((w) => w.code)).toEqual(['acme-in']);

    const changed = await call('PATCH', `/${website.id}`, ops, {
      name: 'Acme India B2B',
      isActive: false,
    });
    expect(await changed.json()).toMatchObject({
      website: { name: 'Acme India B2B', isActive: false, defaultCurrency: 'INR' },
    });
    for (const fixed of [{ code: 'acme' }, { countryCode: 'US' }, { defaultCurrency: 'USD' }]) {
      expect((await call('PATCH', `/${website.id}`, ops, fixed)).status).toBe(400);
    }
    expect((await call('GET', '/00000000-0000-4000-8000-000000000000', ops)).status).toBe(404);
  });

  it('needs website.view to read and website.manage to change', async () => {
    await runSetup(handle.db, { organizationName: 'Acme Industrial Supply' });
    const viewer = await signedInAdmin('viewer@muziris.example', ['website.view']);
    const nobody = await signedInAdmin('nobody@muziris.example', ['order.view']);
    expect((await call('GET', '', nobody)).status).toBe(403);
    expect((await call('GET', '', viewer)).status).toBe(200);
    expect((await call('POST', '', viewer, INDIA)).status).toBe(403);
  });
});
