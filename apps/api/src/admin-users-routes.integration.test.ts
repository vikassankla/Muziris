import { Writable } from 'node:stream';
import {
  ADMINISTRATOR_ROLE_CODE,
  assignAdminRole,
  createAdminRole,
  ensureBuiltInAdminRoles,
  findAdminRoleByCode,
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
import { signInAdmin, TEST_TWO_FACTOR_KEY } from './test-admin-sign-in.js';

// The admin users screen's routes and admin invitations (ADR 0028).

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'periyar river at dawn';
const ORIGIN = 'https://admin.example.com';
const START = new Date('2026-11-04T09:00:00.000Z');

interface AdminUserView {
  id: string;
  displayName: string;
  email: string;
  status: 'active' | 'invited' | 'disabled';
  twoFactor: boolean;
  lastSignInAt: string | null;
  roles: { id: string; name: string }[];
  mayManage: boolean;
}

describe.skipIf(!url)('admin users routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];
  let administratorId: string;
  let clock: Date;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_admin_users');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate access_admin_user_role, access_admin_role_permission, access_admin_role,
        identity_invitation, identity_session, identity_user, identity_rate_limit,
        notification_outbox cascade`,
    );
    logs = [];
    clock = START;
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
      twoFactorKey: TEST_TWO_FACTOR_KEY,
      logger: createLogger('info', stream),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => clock,
      clientIp: () => '203.0.113.7',
    });
  }

  async function signedInAdmin(
    email: string,
    permissions: AdminPermission[] | 'administrator',
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email.split('@')[0] ?? email,
      password: PASSWORD,
    });
    if (permissions === 'administrator') {
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, administratorId);
    } else if (permissions.length > 0) {
      const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
        code: `role_${email.split('@')[0] ?? 'x'}`,
        name: `Role of ${email}`,
        permissions,
      });
      await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    }
    const cookie = await signInAdmin(app(), {
      email,
      password: PASSWORD,
      origin: ORIGIN,
      now: clock,
    });
    return { id: user.id, cookie };
  }

  function call(method: string, path: string, cookie: string | undefined, body?: unknown) {
    return app().request(`/admin/v1${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function json<T>(res: Response | Promise<Response>): Promise<T> {
    return (await (await res).json()) as T;
  }

  /** The token in the newest admin invitation email to `to`. */
  async function emailedToken(to: string): Promise<string> {
    const rows = await handle.db.execute<{ text_body: string; kind: string }>(
      sql`select text_body, kind from notification_outbox where recipient = ${to}
        order by created_at desc, id desc limit 1`,
    );
    expect(rows[0]?.kind).toBe('admin_invitation');
    const body = rows[0]?.text_body ?? '';
    const token = /accept-invitation#token=([A-Za-z0-9_-]{43})/.exec(body)?.[1] ?? '';
    expect(body).toContain(`http://localhost:5173/accept-invitation#token=${token}`);
    return token;
  }

  it('invites an admin, who sets a password from the email and then signs in with two factors', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const roles = await json<{ roles: { id: string; code: string }[] }>(
      call('GET', '/access/roles', asha.cookie),
    );

    const invited = await call('POST', '/access/admin-users', asha.cookie, {
      displayName: 'Ravi Pillai',
      email: 'Ravi@Acme.example',
      roleIds: roles.roles.map((r) => r.id),
    });
    expect(invited.status).toBe(201);
    const body = await json<{ adminUser: AdminUserView }>(invited);
    expect(body).not.toHaveProperty('token');
    expect(body.adminUser).toMatchObject({
      displayName: 'Ravi Pillai',
      email: 'ravi@acme.example',
      status: 'invited',
      twoFactor: false,
      lastSignInAt: null,
      roles: [{ id: administratorId, name: 'Administrator' }],
    });
    const ravi = body.adminUser.id;

    // The list shows both, by name, with their roles and two-factor sign-in.
    const list = await json<{ adminUsers: AdminUserView[]; nextAfter: string | null }>(
      call('GET', '/access/admin-users', asha.cookie),
    );
    expect(list.adminUsers.map((u) => [u.displayName, u.status, u.twoFactor])).toEqual([
      ['asha', 'active', true],
      ['Ravi Pillai', 'invited', false],
    ]);
    expect(list.adminUsers[0]?.lastSignInAt).toBe(START.toISOString());

    // Sending again replaces the link.
    const first = await emailedToken('ravi@acme.example');
    clock = new Date(START.getTime() + 1000);
    expect((await call('POST', `/access/admin-users/${ravi}/invitation`, asha.cookie)).status).toBe(
      200,
    );
    const token = await emailedToken('ravi@acme.example');
    expect(token).not.toBe(first);
    const stale = await call('POST', '/auth/invitation', undefined, { token: first });
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({ code: 'invitation_invalid' });

    // Before accepting, there is no password to sign in with.
    const early = await call('POST', '/auth/sign-in', undefined, {
      email: 'ravi@acme.example',
      password: NEW_PASSWORD,
    });
    expect(early.status).toBe(401);

    expect(await json(call('POST', '/auth/invitation', undefined, { token }))).toMatchObject({
      invitation: { email: 'ravi@acme.example', displayName: 'Ravi Pillai' },
    });
    const weak = await call('POST', '/auth/accept-invitation', undefined, {
      token,
      password: 'ravi',
    });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ code: 'password_policy' });
    const accepted = await call('POST', '/auth/accept-invitation', undefined, {
      token,
      password: NEW_PASSWORD,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ email: 'ravi@acme.example' });
    // Accepting does not sign in.
    expect(accepted.headers.getSetCookie()).toEqual([]);
    const again = await call('POST', '/auth/accept-invitation', undefined, {
      token,
      password: NEW_PASSWORD,
    });
    expect(again.status).toBe(404);
    expect((await call('POST', `/access/admin-users/${ravi}/invitation`, asha.cookie)).status).toBe(
      409,
    );

    // The password and an enrolled second factor, as for every admin.
    const raviCookie = await signInAdmin(app(), {
      email: 'ravi@acme.example',
      password: NEW_PASSWORD,
      origin: ORIGIN,
      now: clock,
    });
    expect((await call('GET', '/access/me', raviCookie)).status).toBe(200);
    expect(
      (
        await json<{ adminUser: AdminUserView }>(
          call('POST', `/access/admin-users/${ravi}/enable`, asha.cookie),
        )
      ).adminUser,
    ).toMatchObject({ status: 'active', twoFactor: true });

    // Who did what, never the token or the password.
    const audit = logs.filter((l) => l.includes('admin_user_invited') || l.includes('invitation'));
    expect(audit.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(NEW_PASSWORD);
    }
  });

  it('refuses an expired link, a taken email, and roles the inviter may not give', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const meera = await signedInAdmin('meera@acme.example', ['admin_user.manage']);
    const leela = await signedInAdmin('leela@acme.example', [
      'admin_user.manage',
      'admin_role.assign',
    ]);
    const invite = (cookie: string, email: string, roleIds: string[] = []) =>
      call('POST', '/access/admin-users', cookie, { displayName: 'Someone', email, roleIds });

    expect((await invite(asha.cookie, 'meera@acme.example')).status).toBe(409);
    const taken = await invite(asha.cookie, 'MEERA@acme.example');
    expect(await taken.json()).toMatchObject({ code: 'email_taken' });
    // Roles need admin_role.assign, and every permission they grant.
    expect((await invite(meera.cookie, 'a@acme.example', [administratorId])).status).toBe(403);
    const escalation = await invite(leela.cookie, 'b@acme.example', [administratorId]);
    expect(escalation.status).toBe(403);
    expect(await escalation.json()).toMatchObject({ code: 'privilege_escalation' });
    // Nothing was made for the refused invitations.
    const list = await json<{ adminUsers: AdminUserView[] }>(
      call('GET', '/access/admin-users', asha.cookie),
    );
    expect(list.adminUsers.map((u) => u.email)).not.toContain('b@acme.example');
    // Seeing the list needs admin_user.view.
    expect((await call('GET', '/access/admin-users', meera.cookie)).status).toBe(403);

    expect((await invite(meera.cookie, 'c@acme.example')).status).toBe(201);
    const token = await emailedToken('c@acme.example');
    clock = new Date(START.getTime() + 72 * 60 * 60 * 1000 + 1);
    const expired = await call('POST', '/auth/accept-invitation', undefined, {
      token,
      password: NEW_PASSWORD,
    });
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ code: 'invitation_invalid' });
    const malformed = await call('POST', '/auth/accept-invitation', undefined, {
      token: 'not-a-token',
      password: NEW_PASSWORD,
    });
    expect(await malformed.json()).toMatchObject({ code: 'invitation_invalid' });
  });

  it('disables an admin and ends their sessions, never yourself or the last administrator', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const meera = await signedInAdmin('meera@acme.example', [
      'admin_user.manage',
      'admin_user.view',
    ]);
    const disable = (target: string, cookie: string) =>
      call('POST', `/access/admin-users/${target}/disable`, cookie);

    const own = await disable(asha.id, asha.cookie);
    expect(own.status).toBe(409);
    expect(await own.json()).toMatchObject({ code: 'own_account' });
    expect((await disable('00000000-0000-4000-8000-000000000000', asha.cookie)).status).toBe(404);

    const done = await json<{ adminUser: AdminUserView }>(disable(meera.id, asha.cookie));
    expect(done.adminUser.status).toBe('disabled');
    expect((await call('GET', '/access/me', meera.cookie)).status).toBe(401);
    const refused = await call('POST', '/auth/sign-in', undefined, {
      email: 'meera@acme.example',
      password: PASSWORD,
    });
    expect(refused.status).toBe(401);

    const enabled = await json<{ adminUser: AdminUserView }>(
      call('POST', `/access/admin-users/${meera.id}/enable`, asha.cookie),
    );
    expect(enabled.adminUser.status).toBe('active');
    clock = new Date(START.getTime() + 60_000);
    const back = await call('POST', '/auth/sign-in', undefined, {
      email: 'meera@acme.example',
      password: PASSWORD,
    });
    expect(back.status).toBe(200);
    const logged = logs.find((l) => l.includes('access.admin_user_disabled')) ?? '';
    expect(JSON.parse(logged)).toMatchObject({ userId: asha.id, targetUserId: meera.id });
  });

  it('acts on another admin only with every permission they hold (ADR 0028, amended)', async () => {
    const asha = await signedInAdmin('asha@acme.example', 'administrator');
    const meera = await signedInAdmin('meera@acme.example', [
      'admin_user.manage',
      'admin_user.view',
    ]);
    const ravi = await signedInAdmin('ravi@acme.example', ['admin_user.view']);
    const leela = await signedInAdmin('leela@acme.example', ['admin_user.view', 'tax.manage']);
    const act = (action: string, target: string) =>
      call('POST', `/access/admin-users/${target}/${action}`, meera.cookie);

    // The list says whom each may act on, so the screen offers only what will be allowed.
    const listed = async (cookie: string): Promise<Record<string, boolean>> => {
      const { adminUsers } = await json<{ adminUsers: AdminUserView[] }>(
        call('GET', '/access/admin-users', cookie),
      );
      return Object.fromEntries(
        adminUsers.map((u): [string, boolean] => [u.email.split('@')[0] ?? u.email, u.mayManage]),
      );
    };
    expect(await listed(meera.cookie)).toEqual({
      asha: false,
      leela: false,
      meera: true,
      ravi: true,
    });
    expect(Object.values(await listed(asha.cookie)).every(Boolean)).toBe(true);

    // Meera holds neither the administrator's permissions nor tax.manage.
    for (const target of [asha.id, leela.id]) {
      for (const action of ['disable', 'enable', 'two-factor/reset']) {
        const refused = await act(action, target);
        expect(refused.status, `${action} ${target}`).toBe(403);
        expect(await refused.json()).toMatchObject({ code: 'outranked' });
      }
    }
    // Nothing changed for them.
    expect((await call('GET', '/access/me', asha.cookie)).status).toBe(200);
    expect((await call('GET', '/access/me', leela.cookie)).status).toBe(200);

    // She holds everything Ravi holds.
    expect((await act('two-factor/reset', ravi.id)).status).toBe(204);
    expect((await act('disable', ravi.id)).status).toBe(200);
    expect((await act('enable', ravi.id)).status).toBe(200);
  });
});
