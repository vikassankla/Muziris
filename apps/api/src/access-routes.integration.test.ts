import { Writable } from 'node:stream';
import {
  ADMINISTRATOR_ROLE_CODE,
  assignAdminRole,
  createAdminRole,
  createBuyerRole,
  ensureBuiltInAdminRoles,
  findAdminRoleByCode,
  getBuyerAccess,
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
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';

describe.skipIf(!url)('access routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];
  let administratorId: string;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_access');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate access_admin_user_role, access_admin_role_permission, access_admin_role,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role,
        identity_session, identity_user, identity_rate_limit cascade`,
    );
    logs = [];
    await ensureBuiltInAdminRoles(handle.db);
    const role = await findAdminRoleByCode(handle.db, ADMINISTRATOR_ROLE_CODE);
    if (!role) throw new Error('administrator role missing');
    administratorId = role.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    return createApp({
      logger: createLogger('info', stream),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => new Date('2026-11-04T09:00:00.000Z'),
      clientIp: () => '203.0.113.7',
    });
  }

  /** Creates an admin holding exactly these permissions (or administrator) and signs them in. */
  async function signedInAdmin(
    email: string,
    permissions: AdminPermission[] | 'administrator',
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email,
      password: PASSWORD,
    });
    if (permissions === 'administrator') {
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, administratorId);
    } else if (permissions.length > 0) {
      const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: `role_${email.split('@')[0] ?? 'x'}`,
        name: email,
        permissions,
      });
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    }
    const res = await app().request('/admin/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    return { id: user.id, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  }

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return app().request(`/admin/v1/access${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('requires an admin session', async () => {
    const res = await app().request('/admin/v1/access/roles');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  it('does not accept a buyer session', async () => {
    await createUser(handle.db, {
      realm: 'buyer',
      email: 'ravi@buyer.example',
      displayName: 'Ravi',
      password: PASSWORD,
    });
    const signIn = await app().request('/storefront/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email: 'ravi@buyer.example', password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    const value = (signIn.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    const res = await call('GET', '/roles', `__Host-muziris_admin_session=${value}`);
    expect(res.status).toBe(401);
  });

  it.each([
    ['GET', '/permissions', undefined, 'admin_role.view'],
    ['GET', '/roles', undefined, 'admin_role.view'],
    ['POST', '/roles', { code: 'x_role', name: 'X', permissions: [] }, 'admin_role.manage'],
  ] as const)(
    '%s %s answers 403 problem+json without %s, and succeeds with it',
    async (method, path, body, permission) => {
      const without = await signedInAdmin('meera@acme.example', ['order.view']);
      const denied = await call(method, path, without.cookie, body);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      expect(await denied.json()).toMatchObject({
        status: 403,
        code: 'permission_denied',
        type: 'urn:muziris:problem:permission_denied',
      });
      expect(logs.some((l) => l.includes('access.permission_denied'))).toBe(true);

      const withIt = await signedInAdmin('asha@acme.example', [permission]);
      const allowed = await call(method, path, withIt.cookie, body);
      expect(allowed.status).toBeLessThan(300);
    },
  );

  it('denies an admin with no roles everything but their own permission list', async () => {
    const admin = await signedInAdmin('meera@acme.example', []);
    expect((await call('GET', '/roles', admin.cookie)).status).toBe(403);
    const me = await call('GET', '/me', admin.cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ permissions: [] });
  });

  it('lets an administrator manage roles end to end', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const meera = await signedInAdmin('meera@acme.example', []);

    const created = await call('POST', '/roles', asha.cookie, {
      code: 'sales',
      name: 'Sales',
      permissions: ['order.view', 'customer.view'],
    });
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string; permissions: string[] } };
    expect(role.permissions).toEqual(['customer.view', 'order.view']);

    expect((await call('GET', '/roles', meera.cookie)).status).toBe(403);
    expect(
      (await call('PUT', `/admin-users/${meera.id}/roles/${role.id}`, asha.cookie)).status,
    ).toBe(204);
    const meeraMe = await call('GET', '/me', meera.cookie);
    expect(await meeraMe.json()).toEqual({ permissions: ['customer.view', 'order.view'] });

    // Changes apply to Meera's existing session at once.
    expect(
      (
        await call('PUT', `/roles/${role.id}/permissions`, asha.cookie, {
          permissions: ['admin_role.view'],
        })
      ).status,
    ).toBe(204);
    expect((await call('GET', '/roles', meera.cookie)).status).toBe(200);

    expect(
      (await call('DELETE', `/admin-users/${meera.id}/roles/${role.id}`, asha.cookie)).status,
    ).toBe(204);
    expect((await call('GET', '/roles', meera.cookie)).status).toBe(403);
    expect((await call('DELETE', `/roles/${role.id}`, asha.cookie)).status).toBe(204);
  });

  it.each([
    [
      'an unknown permission',
      () => ({
        method: 'POST',
        path: '/roles',
        body: { code: 'x', name: 'X', permissions: ['nope.nope'] },
      }),
      400,
      'validation_failed',
    ],
    [
      'editing a built-in role',
      (ids: Ids) => ({
        method: 'PUT',
        path: `/roles/${ids.administrator}/permissions`,
        body: { permissions: [] },
      }),
      409,
      'built_in_role',
    ],
    [
      'deleting a built-in role',
      (ids: Ids) => ({ method: 'DELETE', path: `/roles/${ids.administrator}` }),
      409,
      'built_in_role',
    ],
    [
      'removing the last administrator',
      (ids: Ids) => ({
        method: 'DELETE',
        path: `/admin-users/${ids.self}/roles/${ids.administrator}`,
      }),
      409,
      'last_administrator',
    ],
    [
      'an unknown role',
      (ids: Ids) => ({
        method: 'PUT',
        path: `/admin-users/${ids.self}/roles/${crypto.randomUUID()}`,
      }),
      404,
      'role_not_found',
    ],
    [
      'assigning to a user who is not an admin',
      (ids: Ids) => ({
        method: 'PUT',
        path: `/admin-users/${crypto.randomUUID()}/roles/${ids.administrator}`,
      }),
      404,
      'user_not_found',
    ],
    [
      'a malformed id',
      () => ({ method: 'DELETE', path: "/roles/1' or '1'='1" }),
      400,
      'validation_failed',
    ],
  ] as const)('refuses %s', async (_label, request, status, code) => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const { method, path, body } = request({ self: asha.id, administrator: administratorId }) as {
      method: string;
      path: string;
      body?: unknown;
    };
    const res = await call(method, path, asha.cookie, body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it('stops a role manager from granting themselves more', async () => {
    const meera = await signedInAdmin('meera@acme.example', [
      'admin_role.manage',
      'admin_role.assign',
      'order.view',
    ]);
    const widen = await call('POST', '/roles', meera.cookie, {
      code: 'mine',
      name: 'Mine',
      permissions: ['order.view', 'price_list.manage'],
    });
    expect(widen.status).toBe(403);
    expect(await widen.json()).toMatchObject({ code: 'privilege_escalation' });

    const takeover = await call(
      'PUT',
      `/admin-users/${meera.id}/roles/${administratorId}`,
      meera.cookie,
    );
    expect(takeover.status).toBe(403);
    expect(await takeover.json()).toMatchObject({ code: 'privilege_escalation' });
  });

  it('refuses state changes from an untrusted origin', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const res = await app().request('/admin/v1/access/roles', {
      method: 'POST',
      headers: {
        Cookie: asha.cookie,
        Origin: 'https://evil.example.net',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: 'evil', name: 'Evil', permissions: [] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'untrusted_origin' });
  });

  describe('buyer roles', () => {
    const MISSING = '00000000-0000-4000-8000-000000000000';

    /** A buyer role and a buyer account to point routes at. */
    async function seed() {
      const priya = await createUser(handle.db, {
        realm: 'buyer',
        email: 'priya@buyer.example',
        displayName: 'Priya',
      });
      const role = await createBuyerRole(handle.db, {
        code: 'purchaser',
        name: 'Purchaser',
        grants: [{ permission: 'order.view', accessLevel: 'own_records' }],
      });
      const fill = (s: string) => s.replaceAll('{role}', role.id).replaceAll('{buyer}', priya.id);
      return { priya, role, fill };
    }

    const grants = [{ permission: 'order.place', accessLevel: 'my_customer' }];

    it.each([
      ['GET', '/buyer-permissions', undefined, 'buyer_role.view', 200],
      ['GET', '/buyer-roles', undefined, 'buyer_role.view', 200],
      ['GET', '/buyer-roles?limit=10', undefined, 'buyer_role.view', 200],
      [
        'POST',
        '/buyer-roles',
        { code: 'approver', name: 'Approver', grants },
        'buyer_role.manage',
        201,
      ],
      ['PUT', '/buyer-roles/{role}/grants', { grants }, 'buyer_role.manage', 204],
      ['DELETE', '/buyer-roles/{role}', undefined, 'buyer_role.manage', 204],
      ['PUT', '/buyer-users/{buyer}/buyer-roles/{role}', undefined, 'buyer_role.manage', 204],
      ['DELETE', '/buyer-users/{buyer}/buyer-roles/{role}', undefined, 'buyer_role.manage', 204],
    ] as const)(
      '%s %s with body %j answers 401 signed out, 403 without %s, and %i with it',
      async (method, rawPath, body, permission, status) => {
        const { fill } = await seed();
        const path = fill(rawPath);

        const signedOut = await call(method, path, '', body);
        expect(signedOut.status).toBe(401);
        expect(await signedOut.json()).toMatchObject({ code: 'not_signed_in' });

        const other: AdminPermission =
          permission === 'buyer_role.view' ? 'buyer_role.manage' : 'buyer_role.view';
        const without = await signedInAdmin('meera@acme.example', [other]);
        const denied = await call(method, path, without.cookie, body);
        expect(denied.status).toBe(403);
        expect(denied.headers.get('content-type')).toContain('application/problem+json');
        expect(await denied.json()).toMatchObject({ code: 'permission_denied' });

        const withIt = await signedInAdmin('asha@acme.example', [permission]);
        const allowed = await call(method, path, withIt.cookie, body);
        expect(allowed.status).toBe(status);
        expect(allowed.headers.get('cache-control')).toBe('no-store');
      },
    );

    it('lets a buyer role manager create, grant, assign and delete buyer roles', async () => {
      const { priya } = await seed();
      const asha = await signedInAdmin('asha@acme.example', [
        'buyer_role.view',
        'buyer_role.manage',
      ]);

      const catalogue = (await (await call('GET', '/buyer-permissions', asha.cookie)).json()) as {
        permissions: { key: string }[];
        accessLevels: string[];
      };
      expect(catalogue.permissions.map((p) => p.key)).toContain('order.place');
      expect(catalogue.accessLevels).toEqual([
        'own_records',
        'my_customer',
        'my_customer_and_subsidiaries',
      ]);

      const created = await call('POST', '/buyer-roles', asha.cookie, {
        code: 'approver',
        name: 'Approver',
        grants: [{ permission: 'quote.accept', accessLevel: 'my_customer' }],
      });
      expect(created.status).toBe(201);
      const { buyerRole } = (await created.json()) as { buyerRole: { id: string } };
      expect(logs.some((l) => l.includes('access.buyer_role_created'))).toBe(true);

      const regrant = await call('PUT', `/buyer-roles/${buyerRole.id}/grants`, asha.cookie, {
        grants: [{ permission: 'quote.accept', accessLevel: 'my_customer_and_subsidiaries' }],
      });
      expect(regrant.status).toBe(204);

      const assigned = await call(
        'PUT',
        `/buyer-users/${priya.id}/buyer-roles/${buyerRole.id}`,
        asha.cookie,
      );
      expect(assigned.status).toBe(204);
      expect(await getBuyerAccess(handle.db, priya.id)).toEqual(
        new Map([['quote.accept', 'my_customer_and_subsidiaries']]),
      );
      expect(
        logs.some(
          (l) =>
            l.includes('access.buyer_role_assigned') &&
            l.includes(priya.id) &&
            !l.includes('priya@buyer.example'),
        ),
      ).toBe(true);

      const firstPage = await call('GET', '/buyer-roles?limit=1', asha.cookie);
      expect(await firstPage.json()).toMatchObject({
        buyerRoles: [{ code: 'approver', grants: [{ permission: 'quote.accept' }] }],
        nextAfter: buyerRole.id,
      });
      const secondPage = await call(
        'GET',
        `/buyer-roles?limit=1&after=${buyerRole.id}`,
        asha.cookie,
      );
      expect(await secondPage.json()).toMatchObject({
        buyerRoles: [{ code: 'purchaser' }],
        nextAfter: null,
      });

      expect(
        (await call('DELETE', `/buyer-users/${priya.id}/buyer-roles/${buyerRole.id}`, asha.cookie))
          .status,
      ).toBe(204);
      expect(await getBuyerAccess(handle.db, priya.id)).toEqual(new Map());
      expect((await call('DELETE', `/buyer-roles/${buyerRole.id}`, asha.cookie)).status).toBe(204);
    });

    it.each([
      [
        'an unknown buyer permission',
        'POST',
        '/buyer-roles',
        {
          code: 'x_role',
          name: 'X',
          grants: [{ permission: 'order.cancel', accessLevel: 'own_records' }],
        },
        400,
        'validation_failed',
      ],
      [
        'an unknown access level',
        'PUT',
        '/buyer-roles/{role}/grants',
        { grants: [{ permission: 'order.view', accessLevel: 'everyone' }] },
        400,
        'validation_failed',
      ],
      [
        'the same permission twice',
        'PUT',
        '/buyer-roles/{role}/grants',
        { grants: [grants[0], grants[0]] },
        400,
        'validation_failed',
      ],
      [
        'a bad role code',
        'POST',
        '/buyer-roles',
        { code: 'Has Spaces', name: 'X', grants: [] },
        400,
        'validation_failed',
      ],
      [
        'a taken role code',
        'POST',
        '/buyer-roles',
        { code: 'purchaser', name: 'X', grants: [] },
        409,
        'role_code_taken',
      ],
      [
        'a page size over 200',
        'GET',
        '/buyer-roles?limit=201',
        undefined,
        400,
        'validation_failed',
      ],
      [
        'a malformed page cursor',
        'GET',
        '/buyer-roles?after=purchaser',
        undefined,
        400,
        'validation_failed',
      ],
      [
        'a malformed role id',
        'DELETE',
        "/buyer-roles/1' or '1'='1",
        undefined,
        400,
        'validation_failed',
      ],
      [
        'grants for a missing role',
        'PUT',
        `/buyer-roles/${MISSING}/grants`,
        { grants },
        404,
        'role_not_found',
      ],
      [
        'deleting a missing role',
        'DELETE',
        `/buyer-roles/${MISSING}`,
        undefined,
        404,
        'role_not_found',
      ],
      [
        'assigning a missing role',
        'PUT',
        `/buyer-users/{buyer}/buyer-roles/${MISSING}`,
        undefined,
        404,
        'role_not_found',
      ],
      [
        'assigning to a missing user',
        'PUT',
        `/buyer-users/${MISSING}/buyer-roles/{role}`,
        undefined,
        404,
        'user_not_found',
      ],
      [
        'assigning to an admin user',
        'PUT',
        '/buyer-users/{admin}/buyer-roles/{role}',
        undefined,
        404,
        'user_not_found',
      ],
    ] as const)('refuses %s', async (_label, method, rawPath, rawBody, status, code) => {
      const { fill } = await seed();
      const asha = await signedInAdmin('asha@acme.example', [
        'buyer_role.view',
        'buyer_role.manage',
      ]);
      const res = await call(
        method,
        fill(rawPath).replaceAll('{admin}', asha.id),
        asha.cookie,
        rawBody,
      );
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    });

    it('refuses buyer role changes from an untrusted origin', async () => {
      const { priya, role } = await seed();
      const asha = await signedInAdmin('asha@acme.example', ['buyer_role.manage']);
      const res = await app().request(
        `/admin/v1/access/buyer-users/${priya.id}/buyer-roles/${role.id}`,
        { method: 'PUT', headers: { Cookie: asha.cookie, Origin: 'https://evil.example.net' } },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'untrusted_origin' });
      expect(await getBuyerAccess(handle.db, priya.id)).toEqual(new Map());
    });
  });
});

interface Ids {
  self: string;
  administrator: string;
}
