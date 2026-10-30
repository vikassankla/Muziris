import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  changePassword,
  consumeRateLimit,
  createUser,
  deleteDeadSessions,
  disableUser,
  EmailTakenError,
  PasswordPolicyError,
  revokeSession,
  SESSION_POLICIES,
  signIn,
  validateSession,
} from './index.js';
import { ARGON2_PARAMS } from './password.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const MINUTE = 60_000;

describe.skipIf(!url)('identity module against PostgreSQL', () => {
  let handle: DatabaseHandle;
  const t0 = new Date('2026-11-02T09:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'identity');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate identity_session, identity_user, identity_rate_limit cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  const adminSignIn = (password: string, now: Date, email = 'asha@acme.example') =>
    signIn(handle.db, { realm: 'admin', email, password, now, ipAddress: '203.0.113.7' });

  async function seedAdmin() {
    return createUser(handle.db, {
      realm: 'admin',
      email: 'Asha@Acme.example',
      displayName: 'Asha Rao',
      password: PASSWORD,
    });
  }

  describe('users', () => {
    it('stores the email normalised and never returns the hash', async () => {
      const user = await seedAdmin();
      expect(user).toEqual({
        id: expect.any(String) as unknown,
        realm: 'admin',
        email: 'asha@acme.example',
        displayName: 'Asha Rao',
      });
      const rows = await handle.db.execute(sql`select password_hash from identity_user`);
      expect(String(rows[0]?.['password_hash'])).toMatch(/^\$argon2id\$/);
    });

    it('rejects a duplicate email in the same realm, case-insensitively', async () => {
      await seedAdmin();
      await expect(
        createUser(handle.db, {
          realm: 'admin',
          email: 'ASHA@acme.example',
          displayName: 'x',
          password: PASSWORD,
        }),
      ).rejects.toBeInstanceOf(EmailTakenError);
    });

    it('allows the same email as an admin and as a buyer', async () => {
      await seedAdmin();
      await expect(
        createUser(handle.db, {
          realm: 'buyer',
          email: 'asha@acme.example',
          displayName: 'Asha',
          password: PASSWORD,
        }),
      ).resolves.toMatchObject({ realm: 'buyer' });
    });

    it('enforces the password policy on creation', async () => {
      await expect(
        createUser(handle.db, {
          realm: 'admin',
          email: 'x@acme.example',
          displayName: 'X',
          password: 'short',
        }),
      ).rejects.toBeInstanceOf(PasswordPolicyError);
    });

    it('refuses plaintext in the hash column at the database level', async () => {
      await expect(
        handle.db.execute(
          sql`insert into identity_user (realm, email, display_name, password_hash) values ('admin', 'p@acme.example', 'P', 'plaintext')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('sign-in', () => {
    it('opens a session that validates for its own realm only', async () => {
      const user = await seedAdmin();
      const result = await adminSignIn(PASSWORD, t0, ' ASHA@acme.example ');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expiresAt).toEqual(at(SESSION_POLICIES.admin.absoluteTimeoutMs));

      const session = await validateSession(handle.db, result.token, 'admin', at(MINUTE));
      expect(session?.user).toEqual(user);
      expect(await validateSession(handle.db, result.token, 'buyer', at(MINUTE))).toBeUndefined();
    });

    it('stores only a hash of the session token', async () => {
      await seedAdmin();
      const result = await adminSignIn(PASSWORD, t0);
      if (!result.ok) throw new Error('sign-in failed');
      const rows = await handle.db.execute(sql`select token_hash from identity_session`);
      expect(rows[0]?.['token_hash']).not.toBe(result.token);
      expect(String(rows[0]?.['token_hash'])).toMatch(/^[0-9a-f]{64}$/);
    });

    it('fails without detail for unknown emails and wrong passwords', async () => {
      await seedAdmin();
      expect(await adminSignIn(PASSWORD, t0, 'nobody@acme.example')).toEqual({
        ok: false,
        reason: 'unknown_email',
      });
      expect(await adminSignIn('wrong password here', t0)).toMatchObject({
        ok: false,
        reason: 'wrong_password',
      });
    });

    it('takes similar time for unknown and known emails', async () => {
      await seedAdmin();
      await adminSignIn('warm up the dummy hash', t0, 'nobody@acme.example');
      const time = async (email: string) => {
        const started = performance.now();
        await adminSignIn('wrong password here', t0, email);
        return performance.now() - started;
      };
      // One timing each is at the mercy of a busy CI runner, so alternate the two paths and
      // compare medians. Three failures for the known email stay under the lockout of five,
      // which would skip the hash.
      const unknowns: number[] = [];
      const knowns: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        unknowns.push(await time('nobody@acme.example'));
        knowns.push(await time('asha@acme.example'));
      }
      const median = (values: number[]) => values.sort((a, b) => a - b)[1] ?? 0;
      const unknown = median(unknowns);
      const known = median(knowns);
      // Both paths run one Argon2id verification; neither may be several times faster.
      expect(unknown / known).toBeGreaterThan(0.33);
      expect(unknown / known).toBeLessThan(3);
    });

    it('locks after five failures, rejects the right password while locked, then recovers', async () => {
      await seedAdmin();
      for (let i = 0; i < 5; i += 1) {
        expect((await adminSignIn('wrong password here', at(i * 1000))).ok).toBe(false);
      }
      expect(await adminSignIn(PASSWORD, at(10_000))).toMatchObject({
        ok: false,
        reason: 'locked',
      });
      // Locked for one minute after the fifth failure (at 4 s), so free again at 64 s.
      const after = await adminSignIn(PASSWORD, at(65_000));
      expect(after.ok).toBe(true);

      // A success resets the counter: four more failures do not lock.
      for (let i = 0; i < 4; i += 1) await adminSignIn('wrong password here', at(70_000 + i));
      expect((await adminSignIn(PASSWORD, at(80_000))).ok).toBe(true);
    });

    it('does not sign in disabled or password-less users', async () => {
      const user = await seedAdmin();
      await createUser(handle.db, {
        realm: 'admin',
        email: 'invited@acme.example',
        displayName: 'Invited',
      });
      expect(await adminSignIn(PASSWORD, t0, 'invited@acme.example')).toMatchObject({
        reason: 'no_password',
      });
      await disableUser(handle.db, user.id);
      expect(await adminSignIn(PASSWORD, t0)).toMatchObject({ reason: 'disabled' });
    });

    it('upgrades a weaker stored hash on successful sign-in', async () => {
      await seedAdmin();
      const { hash } = await import('@node-rs/argon2');
      const weakParams = { ...ARGON2_PARAMS, memoryCost: 4096, timeCost: 1 };
      const weak = await hash(PASSWORD, weakParams);
      await handle.db.execute(sql`update identity_user set password_hash = ${weak}`);
      expect((await adminSignIn(PASSWORD, t0)).ok).toBe(true);
      const rows = await handle.db.execute(sql`select password_hash from identity_user`);
      expect(String(rows[0]?.['password_hash'])).toMatch(/m=19456,t=2,p=1/);
    });
  });

  describe('sessions', () => {
    async function openSession() {
      await seedAdmin();
      const result = await adminSignIn(PASSWORD, t0);
      if (!result.ok) throw new Error('sign-in failed');
      return result.token;
    }

    it('expires after the idle timeout without activity', async () => {
      const token = await openSession();
      const idle = SESSION_POLICIES.admin.idleTimeoutMs;
      expect(await validateSession(handle.db, token, 'admin', at(idle - 1000))).toBeDefined();
      // That request refreshed last_seen_at, so the idle clock restarted.
      expect(await validateSession(handle.db, token, 'admin', at(2 * idle - 2000))).toBeDefined();
      expect(await validateSession(handle.db, token, 'admin', at(3 * idle))).toBeUndefined();
    });

    it('expires at the absolute timeout even when active', async () => {
      const token = await openSession();
      const { idleTimeoutMs, absoluteTimeoutMs } = SESSION_POLICIES.admin;
      for (let t = idleTimeoutMs / 2; t < absoluteTimeoutMs; t += idleTimeoutMs / 2) {
        expect(await validateSession(handle.db, token, 'admin', at(t))).toBeDefined();
      }
      expect(
        await validateSession(handle.db, token, 'admin', at(absoluteTimeoutMs + 1)),
      ).toBeUndefined();
    });

    it('ends on sign-out, password change and disable', async () => {
      const token = await openSession();
      await revokeSession(handle.db, token, at(1000));
      expect(await validateSession(handle.db, token, 'admin', at(2000))).toBeUndefined();

      const second = await adminSignIn(PASSWORD, at(3000));
      if (!second.ok) throw new Error('sign-in failed');
      await changePassword(handle.db, second.user.id, 'a brand new passphrase');
      expect(await validateSession(handle.db, second.token, 'admin', at(4000))).toBeUndefined();

      const third = await adminSignIn('a brand new passphrase', at(5000));
      if (!third.ok) throw new Error('sign-in failed');
      await disableUser(handle.db, third.user.id);
      expect(await validateSession(handle.db, third.token, 'admin', at(6000))).toBeUndefined();
    });

    it('ignores malformed and unknown tokens', async () => {
      await openSession();
      expect(await validateSession(handle.db, "' or '1'='1", 'admin', t0)).toBeUndefined();
      expect(await validateSession(handle.db, 'A'.repeat(43), 'admin', t0)).toBeUndefined();
      await expect(revokeSession(handle.db, 'garbage', t0)).resolves.toBeUndefined();
    });

    it('cleans up dead sessions', async () => {
      const token = await openSession();
      await revokeSession(handle.db, token, at(1000));
      expect(await deleteDeadSessions(handle.db, at(2000))).toBe(1);
    });
  });

  describe('rate limiting', () => {
    it('allows up to the limit per window, then reports when to retry', async () => {
      const key = 'signin:ip:203.0.113.7';
      for (let i = 1; i <= 3; i += 1) {
        expect(await consumeRateLimit(handle.db, key, 3, MINUTE, at(i * 1000))).toMatchObject({
          allowed: true,
          hits: i,
        });
      }
      expect(await consumeRateLimit(handle.db, key, 3, MINUTE, at(4000))).toEqual({
        allowed: false,
        hits: 4,
        retryAfterSeconds: 57,
      });
      // A new window starts once the old one has passed.
      expect(await consumeRateLimit(handle.db, key, 3, MINUTE, at(62_000))).toMatchObject({
        allowed: true,
        hits: 1,
      });
    });

    it('counts concurrent hits exactly', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          consumeRateLimit(handle.db, 'signin:ip:198.51.100.1', 10, MINUTE, t0),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
      expect(Math.max(...results.map((r) => r.hits))).toBe(20);
    });
  });
});
