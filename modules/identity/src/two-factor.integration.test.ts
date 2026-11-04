import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  base32Decode,
  confirmEnrolment,
  confirmReplacement,
  createUser,
  hasTwoFactor,
  parseTotpKey,
  replaceRecoveryCodes,
  resetTwoFactor,
  rotateTwoFactorKey,
  signIn,
  startEnrolment,
  startReplacement,
  totpCode,
  TWO_FACTOR_STEP_MS,
  twoFactorStatus,
  validateSession,
  validateTwoFactorSession,
  verifySecondFactor,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const KEY = parseTotpKey(Buffer.alloc(32, 5).toString('base64'));
const STEP = 30_000;

describe.skipIf(!url)('admin two-factor sign-in against PostgreSQL', () => {
  let handle: DatabaseHandle;
  // At the start of a 30-second step, so a few seconds later is still the same step.
  const t0 = new Date('2026-11-03T09:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  let userId: string;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'two_factor');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate identity_session, identity_user, identity_rate_limit cascade`,
    );
    userId = (
      await createUser(handle.db, {
        realm: 'admin',
        email: 'asha@acme.example',
        displayName: 'Asha Rao',
        password: PASSWORD,
      })
    ).id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function password(now: Date) {
    const result = await signIn(handle.db, {
      realm: 'admin',
      email: 'asha@acme.example',
      password: PASSWORD,
      now,
    });
    if (!result.ok) throw new Error(`password step failed: ${result.reason}`);
    return { realm: 'admin' as const, token: result.token, now, result };
  }

  /** Enrols at t0 and returns the secret and recovery codes. */
  async function enrol(now = t0) {
    const pending = await password(now);
    const factor = await startEnrolment(handle.db, KEY, { ...pending, issuer: 'Muziris' });
    if (!factor.ok) throw new Error(factor.reason);
    const secret = base32Decode(factor.secret);
    const done = await confirmEnrolment(handle.db, KEY, {
      ...pending,
      code: totpCode(secret, now),
    });
    if (!done.ok) throw new Error(done.reason);
    return { secret, recoveryCodes: done.recoveryCodes, session: done };
  }

  describe('the password step', () => {
    it('opens a two-factor session that grants nothing and lasts five minutes', async () => {
      const pending = await password(t0);
      expect(pending.result).toMatchObject({ stage: 'two_factor', enrolled: false });
      expect(pending.result.expiresAt).toEqual(at(TWO_FACTOR_STEP_MS));
      expect(await validateSession(handle.db, pending.token, 'admin', at(1000))).toBeUndefined();
      expect(
        await validateTwoFactorSession(handle.db, pending.token, 'admin', at(1000)),
      ).toMatchObject({ enrolled: false, user: { id: userId } });
      expect(
        await validateTwoFactorSession(handle.db, pending.token, 'admin', at(TWO_FACTOR_STEP_MS)),
      ).toBeUndefined();
    });

    it('leaves buyers with a full session at once', async () => {
      await createUser(handle.db, {
        realm: 'buyer',
        email: 'buyer@acme.example',
        displayName: 'Buyer',
        password: PASSWORD,
      });
      const result = await signIn(handle.db, {
        realm: 'buyer',
        email: 'buyer@acme.example',
        password: PASSWORD,
        now: t0,
      });
      expect(result).toMatchObject({ ok: true, stage: 'full' });
    });
  });

  describe('enrolment', () => {
    it('confirms with the first code, opens a full session and gives ten recovery codes', async () => {
      const pending = await password(t0);
      const factor = await startEnrolment(handle.db, KEY, { ...pending, issuer: 'Muziris' });
      if (!factor.ok) throw new Error(factor.reason);
      expect(factor.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(factor.uri).toContain(`secret=${factor.secret}`);

      // The stored secret is encrypted, never the text the app shows.
      const rows = await handle.db.execute(sql`select secret_enc from identity_two_factor`);
      expect(String(rows[0]?.['secret_enc'])).toMatch(/^v1:/);
      expect(String(rows[0]?.['secret_enc'])).not.toContain(factor.secret);

      const done = await confirmEnrolment(handle.db, KEY, {
        ...pending,
        code: totpCode(base32Decode(factor.secret), t0),
      });
      if (!done.ok) throw new Error(done.reason);
      expect(done.recoveryCodes).toHaveLength(10);
      expect(new Set(done.recoveryCodes).size).toBe(10);
      expect(await validateSession(handle.db, done.token, 'admin', at(1000))).toBeDefined();
      // The two-factor token is spent; the full session has a token of its own.
      expect(done.token).not.toBe(pending.token);
      expect(
        await validateTwoFactorSession(handle.db, pending.token, 'admin', at(1000)),
      ).toBeUndefined();
      expect(await twoFactorStatus(handle.db, userId)).toMatchObject({
        enrolled: true,
        recoveryCodesLeft: 10,
      });
    });

    it('refuses a wrong first code and counts it toward the lock', async () => {
      const pending = await password(t0);
      await startEnrolment(handle.db, KEY, { ...pending, issuer: 'Muziris' });
      expect(await confirmEnrolment(handle.db, KEY, { ...pending, code: '000000' })).toMatchObject({
        ok: false,
        reason: 'wrong_code',
      });
      const rows = await handle.db.execute(sql`select failed_login_count from identity_user`);
      expect(rows[0]?.['failed_login_count']).toBe(1);
      expect(await hasTwoFactor(handle.db, userId)).toBe(false);
    });

    it('starts over with a new secret, and cannot replace a confirmed one', async () => {
      const pending = await password(t0);
      const first = await startEnrolment(handle.db, KEY, { ...pending, issuer: 'Muziris' });
      const second = await startEnrolment(handle.db, KEY, { ...pending, issuer: 'Muziris' });
      if (!first.ok || !second.ok) throw new Error('enrolment failed');
      expect(second.secret).not.toBe(first.secret);

      await enrol(at(STEP));
      const later = await password(at(2 * STEP));
      expect(later.result.enrolled).toBe(true);
      expect(await startEnrolment(handle.db, KEY, { ...later, issuer: 'Muziris' })).toMatchObject({
        ok: false,
        reason: 'already_enrolled',
      });
    });
  });

  describe('the code step', () => {
    it('accepts a code once, so it cannot be replayed', async () => {
      const { secret } = await enrol();
      const now = at(STEP);
      const code = totpCode(secret, now);
      const first = await password(now);
      expect(await verifySecondFactor(handle.db, KEY, { ...first, code })).toMatchObject({
        ok: true,
      });
      const again = await password(at(STEP + 5000));
      expect(await verifySecondFactor(handle.db, KEY, { ...again, code })).toMatchObject({
        ok: false,
        reason: 'wrong_code',
      });
    });

    it('refuses the enrolment code at sign-in in the same step', async () => {
      const { secret } = await enrol();
      const pending = await password(at(5000));
      expect(
        await verifySecondFactor(handle.db, KEY, { ...pending, code: totpCode(secret, t0) }),
      ).toMatchObject({ ok: false, reason: 'wrong_code' });
    });

    it('takes each recovery code once', async () => {
      const { recoveryCodes } = await enrol();
      const code = recoveryCodes[0] ?? '';
      const first = await password(at(1000));
      expect(
        await verifySecondFactor(handle.db, KEY, { ...first, recoveryCode: code.toLowerCase() }),
      ).toMatchObject({ ok: true, usedRecoveryCode: true });
      const again = await password(at(2000));
      expect(
        await verifySecondFactor(handle.db, KEY, { ...again, recoveryCode: code }),
      ).toMatchObject({
        ok: false,
        reason: 'wrong_code',
      });
      expect((await twoFactorStatus(handle.db, userId)).recoveryCodesLeft).toBe(9);
    });

    it('locks after five wrong codes and refuses a right one while locked', async () => {
      const { secret } = await enrol();
      const pending = await password(at(1000));
      for (let i = 0; i < 5; i++) {
        await verifySecondFactor(handle.db, KEY, { ...pending, code: '000000' });
      }
      const now = at(STEP);
      expect(
        await verifySecondFactor(handle.db, KEY, { ...pending, now, code: totpCode(secret, now) }),
      ).toMatchObject({ ok: false, reason: 'locked' });
      // The password step is locked too.
      expect(
        await signIn(handle.db, {
          realm: 'admin',
          email: 'asha@acme.example',
          password: PASSWORD,
          now,
        }),
      ).toMatchObject({ ok: false, reason: 'locked' });
    });

    it('clears the failure count only once the code is right', async () => {
      const { secret } = await enrol();
      const pending = await password(at(STEP));
      await verifySecondFactor(handle.db, KEY, { ...pending, code: '000000' });
      // A right password alone leaves the count alone.
      const again = await password(at(STEP + 1000));
      let rows = await handle.db.execute(sql`select failed_login_count from identity_user`);
      expect(rows[0]?.['failed_login_count']).toBe(1);
      const now = at(STEP + 2000);
      await verifySecondFactor(handle.db, KEY, { ...again, now, code: totpCode(secret, now) });
      rows = await handle.db.execute(sql`select failed_login_count from identity_user`);
      expect(rows[0]?.['failed_login_count']).toBe(0);
    });
  });

  describe('changes while signed in', () => {
    it('gives new recovery codes for the password and a code, and ends other sessions', async () => {
      const { secret, session, recoveryCodes } = await enrol();
      const other = await password(at(1000));
      const otherFull = await verifySecondFactor(handle.db, KEY, {
        ...other,
        recoveryCode: recoveryCodes[0],
      });
      if (!otherFull.ok) throw new Error('second sign-in failed');
      const current = await validateSession(handle.db, session.token, 'admin', at(2000));
      if (!current) throw new Error('no session');

      const change = { userId, sessionId: current.sessionId, now: at(STEP) };
      expect(
        await replaceRecoveryCodes(handle.db, KEY, {
          ...change,
          password: 'not the password',
          code: totpCode(secret, change.now),
        }),
      ).toMatchObject({ ok: false, reason: 'wrong_password' });
      expect(
        await replaceRecoveryCodes(handle.db, KEY, {
          ...change,
          password: PASSWORD,
          code: '000000',
        }),
      ).toMatchObject({ ok: false, reason: 'wrong_code' });
      const renewed = await replaceRecoveryCodes(handle.db, KEY, {
        ...change,
        password: PASSWORD,
        code: totpCode(secret, change.now),
      });
      if (!renewed.ok) throw new Error(renewed.reason);
      expect(renewed.recoveryCodes).toHaveLength(10);
      expect(renewed.recoveryCodes).not.toContain(recoveryCodes[1]);
      expect(
        await validateSession(handle.db, session.token, 'admin', at(STEP + 1000)),
      ).toBeDefined();
      expect(
        await validateSession(handle.db, otherFull.token, 'admin', at(STEP + 1000)),
      ).toBeUndefined();
    });

    it('moves to a new phone: the old secret works until the new one is confirmed', async () => {
      const { secret: oldSecret, session } = await enrol();
      const current = await validateSession(handle.db, session.token, 'admin', at(1000));
      if (!current) throw new Error('no session');
      const now = at(STEP);
      const started = await startReplacement(handle.db, KEY, {
        userId,
        sessionId: current.sessionId,
        password: PASSWORD,
        code: totpCode(oldSecret, now),
        now,
        issuer: 'Muziris',
        email: 'asha@acme.example',
      });
      if (!started.ok) throw new Error(started.reason);
      expect((await twoFactorStatus(handle.db, userId)).replacing).toBe(true);
      const newSecret = base32Decode(started.secret);

      const later = at(2 * STEP);
      expect(
        await confirmReplacement(handle.db, KEY, {
          userId,
          sessionId: current.sessionId,
          now: later,
          code: totpCode(oldSecret, later),
        }),
      ).toMatchObject({ ok: false, reason: 'wrong_code' });
      const confirmed = await confirmReplacement(handle.db, KEY, {
        userId,
        sessionId: current.sessionId,
        now: later,
        code: totpCode(newSecret, later),
      });
      expect(confirmed).toMatchObject({ ok: true });

      const next = at(3 * STEP);
      const pending = await password(next);
      expect(
        await verifySecondFactor(handle.db, KEY, { ...pending, code: totpCode(oldSecret, next) }),
      ).toMatchObject({ ok: false });
      const pending2 = await password(at(4 * STEP));
      expect(
        await verifySecondFactor(handle.db, KEY, {
          ...pending2,
          code: totpCode(newSecret, at(4 * STEP)),
        }),
      ).toMatchObject({ ok: true });
    });
  });

  describe('resets and key rotation', () => {
    it('a reset ends every session and sends the admin to enrolment', async () => {
      const { session } = await enrol();
      expect(await resetTwoFactor(handle.db, userId, at(1000))).toBe(true);
      expect(await validateSession(handle.db, session.token, 'admin', at(2000))).toBeUndefined();
      expect((await password(at(3000))).result.enrolled).toBe(false);
      expect((await twoFactorStatus(handle.db, userId)).recoveryCodesLeft).toBe(0);
      expect(await resetTwoFactor(handle.db, userId, at(4000))).toBe(false);
    });

    it('re-encrypts every secret under a new key', async () => {
      const { secret } = await enrol();
      const newKey = parseTotpKey(Buffer.alloc(32, 9).toString('base64'));
      expect(await rotateTwoFactorKey(handle.db, KEY, newKey)).toBe(1);
      const now = at(STEP);
      const pending = await password(now);
      await expect(
        verifySecondFactor(handle.db, KEY, { ...pending, code: totpCode(secret, now) }),
      ).rejects.toThrow();
      expect(
        await verifySecondFactor(handle.db, newKey, { ...pending, code: totpCode(secret, now) }),
      ).toMatchObject({ ok: true });
    });
  });
});
