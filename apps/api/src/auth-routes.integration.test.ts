import { Writable } from 'node:stream';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createCustomer, createInvitation } from '@muziris/customers';
import { createUser, SESSION_POLICIES } from '@muziris/identity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
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
      sql`truncate customer_invitation, customer_buyer_user, customer_customer, identity_session,
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

  const adminSignIn = (password = PASSWORD, email = 'asha@acme.example') =>
    post('/admin/v1/auth/sign-in', { email, password });

  it('signs an admin in with a hardened cookie', async () => {
    const res = await adminSignIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { email: 'asha@acme.example', realm: 'admin' },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
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
    const cookie = sessionCookie(await adminSignIn());
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
    const cookie = sessionCookie(await adminSignIn());
    const value = cookie.split('=')[1] ?? '';
    const res = await app().request('/admin/v1/auth/me', {
      headers: { Cookie: `muziris_admin_session=${value}` },
    });
    expect(res.status).toBe(401);
  });

  it('signs out, clearing the cookie and ending the session server-side', async () => {
    const cookie = sessionCookie(await adminSignIn());
    const out = await post('/admin/v1/auth/sign-out', {}, { Cookie: cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-muziris_admin_session=;.*Max-Age=0/);
    // Replaying the old cookie no longer works.
    const me = await app().request('/admin/v1/auth/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });

  it('replaces any existing session on a new sign-in', async () => {
    const first = sessionCookie(await adminSignIn());
    const second = sessionCookie(await adminSignIn(PASSWORD, 'asha@acme.example'));
    const res = await post(
      '/admin/v1/auth/sign-in',
      { email: 'asha@acme.example', password: PASSWORD },
      { Cookie: first },
    );
    expect(res.status).toBe(200);
    expect((await app().request('/admin/v1/auth/me', { headers: { Cookie: first } })).status).toBe(
      401,
    );
    expect((await app().request('/admin/v1/auth/me', { headers: { Cookie: second } })).status).toBe(
      200,
    );
  });

  it('times out an idle admin session', async () => {
    const cookie = sessionCookie(await adminSignIn());
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
      const cookie = sessionCookie(await adminSignIn());
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
    async function invited() {
      const acme = await createCustomer(handle.db, { name: 'Acme Engineering' });
      const { token } = await createInvitation(handle.db, {
        customerId: acme.id,
        email: 'meera@acme.example',
        displayName: 'Meera',
        invitedByUserId: '7c1e0a11-0000-4000-8000-000000000001',
        now: clock,
      });
      return token;
    }

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
});
