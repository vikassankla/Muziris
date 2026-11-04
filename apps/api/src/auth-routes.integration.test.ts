import { Writable } from 'node:stream';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createBuyerRole, deleteBuyerRole, getBuyerAccess } from '@muziris/access';
import { createCustomer, createInvitation } from '@muziris/customers';
import { base32Decode, createUser, SESSION_POLICIES, totpCode } from '@muziris/identity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { signInAdmin, TEST_TWO_FACTOR_KEY } from './test-admin-sign-in.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://shop.example.com';

describe.skipIf(!url)('auth routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let clock: Date;
  let ip: string;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_auth');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate customer_invitation, customer_buyer_user, customer_customer,
        access_buyer_user_role, access_buyer_role_permission, access_buyer_role, identity_session,
        identity_user, identity_rate_limit cascade`,
    );
    clock = new Date('2026-11-02T09:00:00.000Z');
    ip = '203.0.113.7';
    logs = [];
    await createUser(handle.db, {
      realm: 'admin',
      email: 'asha@acme.example',
      displayName: 'Asha',
      password: PASSWORD,
    });
    await createUser(handle.db, {
      realm: 'buyer',
      email: 'ravi@buyer.example',
      displayName: 'Ravi',
      password: PASSWORD,
    });
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
      clientIp: () => ip,
    });
  }

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app().request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    });
  }

  function sessionCookie(res: Response): string {
    const header = res.headers.get('set-cookie') ?? '';
    const pair = header.split(';')[0] ?? '';
    return pair;
  }

  /** The password step only (ADR 0026). */
  const adminSignIn = (password = PASSWORD, email = 'asha@acme.example') =>
    post('/admin/v1/auth/sign-in', { email, password });

  /** The password and the second factor: a full admin session's cookie. */
  const fullSignIn = (cookie?: string) =>
    signInAdmin(app(), {
      email: 'asha@acme.example',
      password: PASSWORD,
      origin: ORIGIN,
      now: clock,
      ...(cookie ? { cookie } : {}),
    });

  it('answers a right admin password with the two-factor step, on a cookie of its own', async () => {
    const res = await adminSignIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: 'enrol', expiresAt: '2026-11-02T09:05:00.000Z' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-muziris_admin_two_factor=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=300');
    // The step's cookie is not a session: /me refuses it under either name.
    const value = sessionCookie(res).split('=')[1] ?? '';
    for (const name of ['muziris_admin_two_factor', 'muziris_admin_session']) {
      const me = await app().request('/admin/v1/auth/me', {
        headers: { Cookie: `__Host-${name}=${value}` },
      });
      expect(me.status).toBe(401);
    }
  });

  it('signs an admin in with a hardened cookie once the second factor is right', async () => {
    const step = sessionCookie(await adminSignIn());
    const enrolment = await post('/admin/v1/auth/two-factor/enrolment', {}, { Cookie: step });
    const { secret, uri } = (await enrolment.json()) as { secret: string; uri: string };
    expect(uri).toMatch(/^otpauth:\/\/totp\/Muziris:asha%40acme\.example\?secret=/);
    const res = await post(
      '/admin/v1/auth/two-factor/enrolment/confirm',
      { code: totpCode(base32Decode(secret), clock) },
      { Cookie: step },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown; recoveryCodes: string[] };
    expect(body.user).toMatchObject({ email: 'asha@acme.example', realm: 'admin' });
    expect(body.recoveryCodes).toHaveLength(10);
    for (const code of body.recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const cookies = res.headers.getSetCookie();
    // The step's cookie is cleared as the session's is set.
    expect(cookies.find((c) => c.startsWith('__Host-muziris_admin_two_factor='))).toMatch(
      /Max-Age=0/,
    );
    const cookie = cookies.find((c) => c.startsWith('__Host-muziris_admin_session=')) ?? '';
    expect(cookie).toMatch(/^__Host-muziris_admin_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toContain(`Max-Age=${SESSION_POLICIES.admin.absoluteTimeoutMs / 1000}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('uses a Lax cookie for buyers', async () => {
    const res = await post('/storefront/v1/auth/sign-in', {
      email: 'ravi@buyer.example',
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-muziris_buyer_session=.*SameSite=Lax/);
  });

  it('answers every failure with the same generic 401 and logs the real reason', async () => {
    const wrong = await adminSignIn('wrong password here');
    const unknown = await adminSignIn(PASSWORD, 'nobody@acme.example');
    const buyerAsAdmin = await adminSignIn(PASSWORD, 'ravi@buyer.example');
    const bodies = await Promise.all(
      [wrong, unknown, buyerAsAdmin].map((r) => r.json() as Promise<{ detail?: string }>),
    );
    for (const [i, res] of [wrong, unknown, buyerAsAdmin].entries()) {
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(bodies[i]).toMatchObject({ code: 'invalid_credentials' });
    }
    expect(bodies[0]?.detail).toBe(bodies[1]?.detail);
    const reasons = logs
      .filter((l) => l.includes('auth.sign_in_failed'))
      .map((l) => (JSON.parse(l) as { reason?: string }).reason);
    expect(reasons).toEqual(['wrong_password', 'unknown_email', 'unknown_email']);
    // Emails and passwords never reach the logs.
    expect(logs.join('')).not.toMatch(/asha@acme|nobody@acme|wrong password|horse battery/);
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await post('/admin/v1/auth/sign-in', { email: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('serves /me for the signed-in realm only', async () => {
    const cookie = await fullSignIn();
    const me = await app().request('/admin/v1/auth/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: 'asha@acme.example' } });

    // The admin cookie name is not read by the storefront, and swapping the value in does not work.
    const value = cookie.split('=')[1] ?? '';
    const crossed = await app().request('/storefront/v1/auth/me', {
      headers: { Cookie: `__Host-muziris_buyer_session=${value}` },
    });
    expect(crossed.status).toBe(401);
  });

  it('requires a session for /me', async () => {
    const res = await app().request('/admin/v1/auth/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  it('ignores cookies without the __Host- prefix', async () => {
    const cookie = await fullSignIn();
    const value = cookie.split('=')[1] ?? '';
    const res = await app().request('/admin/v1/auth/me', {
      headers: { Cookie: `muziris_admin_session=${value}` },
    });
    expect(res.status).toBe(401);
  });

  it('signs out, clearing the cookie and ending the session server-side', async () => {
    const cookie = await fullSignIn();
    const out = await post('/admin/v1/auth/sign-out', {}, { Cookie: cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-muziris_admin_session=;.*Max-Age=0/);
    // Replaying the old cookie no longer works.
    const me = await app().request('/admin/v1/auth/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });

  it('replaces any existing session on a new sign-in', async () => {
    const first = await fullSignIn();
    const second = await fullSignIn();
    // Signing in again from the browser that holds the first session ends it.
    await fullSignIn(first);
    expect((await app().request('/admin/v1/auth/me', { headers: { Cookie: first } })).status).toBe(
      401,
    );
    expect((await app().request('/admin/v1/auth/me', { headers: { Cookie: second } })).status).toBe(
      200,
    );
  });

  it('times out an idle admin session', async () => {
    const cookie = await fullSignIn();
    clock = new Date(clock.getTime() + SESSION_POLICIES.admin.idleTimeoutMs + 1000);
    const res = await app().request('/admin/v1/auth/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });

  describe('cross-site request forgery', () => {
    it('refuses sign-in from an untrusted origin', async () => {
      const res = await post(
        '/admin/v1/auth/sign-in',
        { email: 'asha@acme.example', password: PASSWORD },
        { Origin: 'https://evil.example.net' },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'untrusted_origin' });
    });

    it('refuses a state change with no Origin unless the browser says same-origin', async () => {
      const cookie = await fullSignIn();
      const noOrigin = await app().request('/admin/v1/auth/sign-out', {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(noOrigin.status).toBe(403);
      const sameOrigin = await app().request('/admin/v1/auth/sign-out', {
        method: 'POST',
        headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
      });
      expect(sameOrigin.status).toBe(204);
    });
  });

  describe('rate limiting', () => {
    it('limits attempts per IP and says when to retry', async () => {
      for (let i = 0; i < 20; i += 1) {
        const res = await adminSignIn('wrong password here', `user${i}@acme.example`);
        expect(res.status).toBe(401);
      }
      const blocked = await adminSignIn();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('600');
      expect(await blocked.json()).toMatchObject({ code: 'too_many_attempts' });

      // Another IP is unaffected.
      ip = '198.51.100.9';
      expect((await adminSignIn()).status).toBe(200);
    });

    it('limits attempts per email across many IPs', async () => {
      for (let i = 0; i < 10; i += 1) {
        ip = `198.51.100.${i + 1}`;
        await adminSignIn('wrong password here');
      }
      ip = '198.51.100.200';
      expect((await adminSignIn()).status).toBe(429);
    });

    it('stores no raw email in the rate-limit table', async () => {
      await adminSignIn('wrong password here');
      const rows = await handle.db.execute(sql`select key from identity_rate_limit`);
      expect(rows.map((r) => String(r['key'])).join(' ')).not.toContain('asha');
    });
  });

  describe('accepting an invitation (ADR 0020)', () => {
    async function invited(buyerRoleId: string | null = null) {
      const acme = await createCustomer(handle.db, { name: 'Acme Engineering' });
      const { token } = await createInvitation(handle.db, {
        customerId: acme.id,
        email: 'meera@acme.example',
        displayName: 'Meera',
        invitedByUserId: '7c1e0a11-0000-4000-8000-000000000001',
        buyerRoleId,
        now: clock,
      });
      return token;
    }

    it("gives the buyer the invitation's buyer role, and accepts even if the role is gone", async () => {
      const role = await createBuyerRole(handle.db, {
        code: 'orderer',
        name: 'Orderer',
        grants: [{ permission: 'order.place', accessLevel: 'my_customer' }],
      });
      const accepted = await post('/storefront/v1/auth/accept-invitation', {
        token: await invited(role.id),
        password: PASSWORD,
      });
      const { user } = (await accepted.json()) as { user: { id: string } };
      expect((await getBuyerAccess(handle.db, user.id)).get('order.place')).toBe('my_customer');

      await handle.db.execute(
        sql`truncate customer_invitation, customer_buyer_user, customer_customer, identity_user cascade`,
      );
      const gone = await createBuyerRole(handle.db, { code: 'gone', name: 'Gone', grants: [] });
      const token = await invited(gone.id);
      await deleteBuyerRole(handle.db, gone.id);
      const second = await post('/storefront/v1/auth/accept-invitation', {
        token,
        password: PASSWORD,
      });
      expect(second.status).toBe(201);
      expect(logs.join('')).toContain('auth.invitation_role_missing');
    });

    it('shows who it is for, then creates the account and signs the buyer in', async () => {
      const token = await invited();
      const look = await post('/storefront/v1/auth/invitation', { token });
      expect(look.status).toBe(200);
      expect(await look.json()).toEqual({
        invitation: {
          email: 'meera@acme.example',
          displayName: 'Meera',
          customerName: 'Acme Engineering',
          expiresAt: '2026-11-09T09:00:00.000Z',
        },
      });

      const accepted = await post('/storefront/v1/auth/accept-invitation', {
        token,
        password: PASSWORD,
      });
      expect(accepted.status).toBe(201);
      expect(await accepted.json()).toMatchObject({
        user: { email: 'meera@acme.example', displayName: 'Meera', realm: 'buyer' },
      });
      const cookie = sessionCookie(accepted);
      expect(cookie).toMatch(/^__Host-muziris_buyer_session=/);
      const me = await app().request('/storefront/v1/auth/me', { headers: { Cookie: cookie } });
      expect(await me.json()).toMatchObject({ user: { email: 'meera@acme.example' } });

      const again = await post('/storefront/v1/auth/accept-invitation', {
        token,
        password: PASSWORD,
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: 'invitation_closed' });
      expect(logs.join('')).not.toContain(token);
    });

    it('refuses an unknown token, a weak password and an expired invitation', async () => {
      const token = await invited();
      const unknown = await post('/storefront/v1/auth/invitation', { token: 'A'.repeat(43) });
      expect(unknown.status).toBe(404);
      const weak = await post('/storefront/v1/auth/accept-invitation', {
        token,
        password: 'short',
      });
      expect(weak.status).toBe(400);
      expect(await weak.json()).toMatchObject({ code: 'password_policy' });
      // The weak attempt made no account, so the invitation still works.
      expect((await post('/storefront/v1/auth/invitation', { token })).status).toBe(200);
      clock = new Date(clock.getTime() + 8 * 24 * 3_600_000);
      const expired = await post('/storefront/v1/auth/invitation', { token });
      expect(expired.status).toBe(410);
      expect(await expired.json()).toMatchObject({ code: 'invitation_expired' });
    });

    it('limits attempts per token', async () => {
      const token = await invited();
      for (let i = 0; i < 10; i += 1) {
        expect((await post('/storefront/v1/auth/invitation', { token })).status).toBe(200);
      }
      const limited = await post('/storefront/v1/auth/invitation', { token });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).not.toBeNull();
    });

    it('is not offered on the admin side', async () => {
      const token = await invited();
      expect((await post('/admin/v1/auth/invitation', { token })).status).toBe(404);
    });
  });

  describe('two-factor sign-in (ADR 0026)', () => {
    /** Enrols the admin and returns the secret and the full session's cookie. */
    async function enrolled() {
      const step = sessionCookie(await adminSignIn());
      const enrolment = await post('/admin/v1/auth/two-factor/enrolment', {}, { Cookie: step });
      const { secret } = (await enrolment.json()) as { secret: string };
      const done = await post(
        '/admin/v1/auth/two-factor/enrolment/confirm',
        { code: totpCode(base32Decode(secret), clock) },
        { Cookie: step },
      );
      const { recoveryCodes } = (await done.json()) as { recoveryCodes: string[] };
      const cookie =
        done.headers
          .getSetCookie()
          .find((c) => c.startsWith('__Host-muziris_admin_session='))
          ?.split(';')[0] ?? '';
      return { secret: base32Decode(secret), cookie, recoveryCodes };
    }

    const later = (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    };

    it('asks an enrolled admin for a code, and refuses a wrong one like a wrong password', async () => {
      const { secret } = await enrolled();
      later(30);
      const res = await adminSignIn();
      expect(await res.json()).toMatchObject({ next: 'code' });
      const step = sessionCookie(res);
      const wrong = await post(
        '/admin/v1/auth/two-factor/verify',
        { code: '000000' },
        { Cookie: step },
      );
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ code: 'invalid_code' });
      const right = await post(
        '/admin/v1/auth/two-factor/verify',
        { code: totpCode(secret, clock) },
        { Cookie: step },
      );
      expect(right.status).toBe(200);
      // Codes and secrets never reach the logs; the reason does.
      expect(logs.join('')).not.toContain(totpCode(secret, clock));
      expect(
        logs.some((l) => l.includes('auth.two_factor_failed') && l.includes('wrong_code')),
      ).toBe(true);
    });

    it('locks the account after five wrong codes', async () => {
      const { secret } = await enrolled();
      later(30);
      const step = sessionCookie(await adminSignIn());
      for (let i = 0; i < 5; i++) {
        await post('/admin/v1/auth/two-factor/verify', { code: '000000' }, { Cookie: step });
      }
      const locked = await post(
        '/admin/v1/auth/two-factor/verify',
        { code: totpCode(secret, clock) },
        { Cookie: step },
      );
      expect(locked.status).toBe(401);
      expect(await locked.json()).toMatchObject({ code: 'invalid_code' });
    });

    it('takes a recovery code once', async () => {
      const { recoveryCodes } = await enrolled();
      const code = recoveryCodes[0];
      const first = sessionCookie(await adminSignIn());
      expect(
        (await post('/admin/v1/auth/two-factor/verify', { recoveryCode: code }, { Cookie: first }))
          .status,
      ).toBe(200);
      const again = sessionCookie(await adminSignIn());
      expect(
        (await post('/admin/v1/auth/two-factor/verify', { recoveryCode: code }, { Cookie: again }))
          .status,
      ).toBe(401);
      expect(logs.some((l) => l.includes('auth.recovery_code_used'))).toBe(true);
    });

    it('sends a browser back to sign-in once the step has expired or without its cookie', async () => {
      const step = sessionCookie(await adminSignIn());
      const none = await post('/admin/v1/auth/two-factor/enrolment', {});
      expect(none.status).toBe(401);
      expect(await none.json()).toMatchObject({ code: 'two_factor_expired' });
      later(5 * 60);
      const expired = await post('/admin/v1/auth/two-factor/enrolment', {}, { Cookie: step });
      expect(await expired.json()).toMatchObject({ code: 'two_factor_expired' });
    });

    it('limits codes per admin and says when to retry', async () => {
      await enrolled();
      later(30);
      const step = sessionCookie(await adminSignIn());
      // Ten tries are counted, whether or not the account lock has already refused them, and
      // enrolment's two steps were two of them.
      for (let i = 0; i < 8; i++) {
        ip = `198.51.100.${i + 1}`;
        const res = await post(
          '/admin/v1/auth/two-factor/verify',
          { code: '000000' },
          {
            Cookie: step,
          },
        );
        expect(res.status).toBe(401);
      }
      const limited = await post(
        '/admin/v1/auth/two-factor/verify',
        { code: '000000' },
        {
          Cookie: step,
        },
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).not.toBeNull();
    });

    it('answers 503 when the server has no ADMIN_TOTP_KEY', async () => {
      const res = await createApp({
        logger: createLogger('silent'),
        db: handle.db,
        pingDatabase: () => Promise.resolve(),
        corsOrigins: [ORIGIN],
        maxBodyBytes: 64 * 1024,
        now: () => clock,
        clientIp: () => ip,
      }).request('/admin/v1/auth/sign-in', {
        method: 'POST',
        body: JSON.stringify({ email: 'asha@acme.example', password: PASSWORD }),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'two_factor_not_configured' });
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('gives new recovery codes for the password and a code, ending other sessions', async () => {
      const { secret, cookie, recoveryCodes } = await enrolled();
      const other = sessionCookie(await adminSignIn());
      const otherDone = await post(
        '/admin/v1/auth/two-factor/verify',
        { recoveryCode: recoveryCodes[0] },
        { Cookie: other },
      );
      const otherCookie =
        otherDone.headers
          .getSetCookie()
          .find((c) => c.startsWith('__Host-muziris_admin_session='))
          ?.split(';')[0] ?? '';
      later(30);
      const status = await app().request('/admin/v1/auth/two-factor', {
        headers: { Cookie: cookie },
      });
      expect(await status.json()).toMatchObject({
        twoFactor: { enrolled: true, recoveryCodesLeft: 9 },
      });

      const wrong = await post(
        '/admin/v1/auth/two-factor/recovery-codes',
        { password: 'not my password', code: totpCode(secret, clock) },
        { Cookie: cookie },
      );
      expect(wrong.status).toBe(401);
      const res = await post(
        '/admin/v1/auth/two-factor/recovery-codes',
        { password: PASSWORD, code: totpCode(secret, clock) },
        { Cookie: cookie },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
      const me = (c: string) => app().request('/admin/v1/auth/me', { headers: { Cookie: c } });
      expect((await me(cookie)).status).toBe(200);
      expect((await me(otherCookie)).status).toBe(401);
    });

    it('moves to a new phone in two steps', async () => {
      const { secret, cookie } = await enrolled();
      later(30);
      const started = await post(
        '/admin/v1/auth/two-factor/replacement',
        { password: PASSWORD, code: totpCode(secret, clock) },
        { Cookie: cookie },
      );
      expect(started.status).toBe(200);
      const { secret: newText } = (await started.json()) as { secret: string };
      later(30);
      const confirmed = await post(
        '/admin/v1/auth/two-factor/replacement/confirm',
        { code: totpCode(base32Decode(newText), clock) },
        { Cookie: cookie },
      );
      expect(confirmed.status).toBe(200);
      expect(logs.some((l) => l.includes('auth.two_factor_replaced'))).toBe(true);
      expect(logs.join('')).not.toContain(newText);
    });
  });
});
