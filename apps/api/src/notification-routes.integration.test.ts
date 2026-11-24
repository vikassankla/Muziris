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
import { addSuppression, MAX_ATTEMPTS, queueEmail, sendDueEmails } from '@muziris/notifications';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { signInAdmin, TEST_TWO_FACTOR_KEY } from './test-admin-sign-in.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const NOW = new Date('2026-11-20T06:00:00.000Z');

describe.skipIf(!url)('notification routes against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_notifications');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate notification_outbox, notification_suppression, access_admin_user_role, access_admin_role_permission,
        access_admin_role, identity_session, identity_user, identity_rate_limit cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
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
    const cookie = await signInAdmin(app(), {
      email,
      password: PASSWORD,
      origin: ORIGIN,
      now: NOW,
    });
    return cookie;
  }

  const call = (method: string, path: string, cookie: string) =>
    app().request(`/admin/v1/notifications${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN },
    });

  const send = (method: string, path: string, cookie: string, body: unknown) =>
    app().request(`/admin/v1/notifications${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Two emails that gave up: an order email, and an invitation whose body was emptied. */
  async function failedEmails() {
    for (const [kind, sensitive] of [
      ['order_placed', false],
      ['buyer_invitation', true],
    ] as const) {
      await queueEmail(handle.db, {
        kind,
        key: `${kind}:1`,
        to: 'asha@example.in',
        locale: 'en-IN',
        message: { subject: kind, text: 'secret link', html: '<p>secret link</p>' },
        sensitive,
        now: NOW,
      });
    }
    const down = { send: () => Promise.reject(new Error('down')) };
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await sendDueEmails(handle.db, down, new Date(NOW.getTime() + i * 86_400_000));
    }
  }

  it('lists failed emails without bodies, and sends one again', async () => {
    await failedEmails();
    const ops = await signedInAdmin('ops@muziris.example', [
      'notification.view',
      'notification.manage',
    ]);
    const list = await call('GET', '?status=failed', ops);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain('secret link');
    const { emails } = JSON.parse(text) as { emails: { id: string; kind: string }[] };
    expect(emails.map((e) => e.kind).sort()).toEqual(['buyer_invitation', 'order_placed']);
    const order = emails.find((e) => e.kind === 'order_placed')?.id ?? '';
    const invite = emails.find((e) => e.kind === 'buyer_invitation')?.id ?? '';

    const retried = await call('POST', `/${order}/retry`, ops);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ email: { status: 'queued', attempts: 0 } });
    expect(await (await call('POST', `/${order}/retry`, ops)).json()).toMatchObject({
      code: 'notification_not_failed',
    });
    expect(await (await call('POST', `/${invite}/retry`, ops)).json()).toMatchObject({
      code: 'notification_body_discarded',
    });
    expect((await call('POST', '/not-an-id/retry', ops)).status).toBe(404);
  });

  it('needs notification.view to list and notification.manage to send again', async () => {
    await failedEmails();
    const viewer = await signedInAdmin('viewer@muziris.example', ['notification.view']);
    const nobody = await signedInAdmin('nobody@muziris.example', ['order.view']);
    expect((await call('GET', '', nobody)).status).toBe(403);
    const { emails } = (await (await call('GET', '', viewer)).json()) as {
      emails: { id: string }[];
    };
    expect((await call('POST', `/${emails[0]?.id ?? ''}/retry`, viewer)).status).toBe(403);
  });

  it('lists emails that were not sent to a suppressed address (ADR 0032)', async () => {
    await addSuppression(handle.db, { email: 'asha@example.in', reason: 'manual', now: NOW });
    await queueEmail(handle.db, {
      kind: 'order_placed',
      key: 'order_placed:9',
      to: 'asha@example.in',
      locale: 'en-IN',
      message: { subject: 's', text: 't', html: '<p>t</p>' },
      now: NOW,
    });
    await sendDueEmails(handle.db, { send: () => Promise.resolve() }, NOW);
    const viewer = await signedInAdmin('viewer@muziris.example', ['notification.view']);
    const { emails } = (await (await call('GET', '?status=suppressed', viewer)).json()) as {
      emails: { status: string; bounceType: string | null }[];
    };
    expect(emails).toEqual([expect.objectContaining({ status: 'suppressed', bounceType: null })]);
  });

  it('lists, adds and removes suppressed addresses (ADR 0032)', async () => {
    const ops = await signedInAdmin('ops@muziris.example', [
      'notification.view',
      'notification.manage',
    ]);
    const added = await send('POST', '/suppressions', ops, { email: ' Ravi@Example.in ' });
    expect(added.status).toBe(201);
    const { suppression } = (await added.json()) as {
      suppression: { id: string; email: string; reason: string; source: string };
    };
    expect(suppression).toMatchObject({
      email: 'ravi@example.in',
      reason: 'manual',
      source: 'admin',
    });
    expect((await send('POST', '/suppressions', ops, { email: 'not an address' })).status).toBe(
      400,
    );

    const list = await call('GET', '/suppressions?search=ravi', ops);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      suppressions: [{ email: 'ravi@example.in' }],
      nextAfter: null,
    });

    const removed = await call('DELETE', `/suppressions/${suppression.id}`, ops);
    expect(removed.status).toBe(200);
    expect((await call('DELETE', `/suppressions/${suppression.id}`, ops)).status).toBe(404);
    expect(await (await call('GET', '/suppressions', ops)).json()).toMatchObject({
      suppressions: [],
    });
  });

  it('needs notification.view to see suppressed addresses and notification.manage to change them', async () => {
    const added = await addSuppression(handle.db, {
      email: 'asha@example.in',
      reason: 'manual',
      now: NOW,
    });
    const viewer = await signedInAdmin('viewer@muziris.example', ['notification.view']);
    const nobody = await signedInAdmin('nobody@muziris.example', ['order.view']);
    expect((await call('GET', '/suppressions', nobody)).status).toBe(403);
    expect((await call('GET', '/suppressions', viewer)).status).toBe(200);
    expect((await send('POST', '/suppressions', viewer, { email: 'x@example.in' })).status).toBe(
      403,
    );
    expect((await call('DELETE', `/suppressions/${added.id}`, viewer)).status).toBe(403);
  });
});
