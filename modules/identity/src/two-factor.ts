import type { Database } from '@muziris/db';
import { and, count, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  markSignedIn,
  openSession,
  recordFailure,
  revokeSession,
  validateSession,
} from './auth.js';
import { recoveryCodes, sessions, twoFactors, users } from './db/schema.js';
import { verifyPassword } from './password.js';
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  generateRecoverySalt,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  RECOVERY_CODE_COUNT,
  totpUri,
  type TotpKey,
} from './totp.js';
import type { AuthenticatedUser, Realm } from './types.js';

// The second factor for admins (ADR 0026): an authenticator app's codes, with one-time
// recovery codes for a lost phone. Wrong codes count toward the same account lock as wrong
// passwords. Nothing here logs or returns a secret except at the moment of enrolment.

/** Why a step failed. For logs and tests only: callers show one generic message. */
export type TwoFactorFailure =
  'no_session' | 'not_enrolled' | 'already_enrolled' | 'locked' | 'wrong_code' | 'wrong_password';

export interface TwoFactorRefusal {
  ok: false;
  reason: TwoFactorFailure;
  userId?: string;
}

/** A full session, opened once the second factor is right. */
export interface SignedIn {
  ok: true;
  user: AuthenticatedUser;
  token: string;
  expiresAt: Date;
}

/** What enrolment shows once: the secret as text and as the link a QR code carries. */
export interface NewFactor {
  ok: true;
  secret: string;
  uri: string;
}

interface SessionContext {
  realm: Realm;
  /** The two-factor session's token, from its cookie. */
  token: string;
  now: Date;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

const MAX_CODE_LENGTH = 64;

interface Factor {
  userId: string;
  secretEnc: string;
  confirmedAt: Date | null;
  lastStep: number | null;
  replacementSecretEnc: string | null;
}

async function factorFor(db: Database, userId: string, lock = false): Promise<Factor | undefined> {
  const query = db.select().from(twoFactors).where(eq(twoFactors.userId, userId)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

async function isLocked(db: Database, userId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const until = row?.lockedUntil ?? null;
  return until !== null && until > now;
}

/**
 * Accepts a code from the secret once: it must match now or a step either side, and be for a
 * later step than the last one accepted. Run inside the transaction that locked the row.
 */
async function acceptCode(
  db: Database,
  key: TotpKey,
  factor: Factor,
  secretEnc: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const secret = decryptSecret(key, factor.userId, secretEnc);
  const step = matchTotp(secret, code.slice(0, MAX_CODE_LENGTH), now);
  if (step === undefined) return false;
  if (factor.lastStep !== null && step <= factor.lastStep) return false;
  await db
    .update(twoFactors)
    .set({ lastStep: step, updatedAt: now })
    .where(eq(twoFactors.userId, factor.userId));
  return true;
}

/** Uses up one recovery code, if it is the user's and unused. */
async function useRecoveryCode(
  db: Database,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const [factor] = await db
    .select({ salt: twoFactors.recoveryCodeSalt })
    .from(twoFactors)
    .where(eq(twoFactors.userId, userId))
    .limit(1);
  const salt = factor?.salt ?? null;
  if (salt === null) return false;
  const codeHash = await hashRecoveryCode(code.slice(0, MAX_CODE_LENGTH), salt);
  const used = await db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, codeHash),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  return used.length > 0;
}

/** Replaces a user's recovery codes with a new set and returns them, to show once. */
async function newRecoveryCodes(db: Database, userId: string, now: Date): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const salt = generateRecoverySalt();
  const hashes = await Promise.all(codes.map((code) => hashRecoveryCode(code, salt)));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db
    .update(twoFactors)
    .set({ recoveryCodeSalt: salt, updatedAt: now })
    .where(eq(twoFactors.userId, userId));
  await db
    .insert(recoveryCodes)
    .values(hashes.map((codeHash) => ({ userId, codeHash, createdAt: now })));
  return codes;
}

/** Ends every session of a user except one, or all of them. */
async function revokeSessions(
  db: Database,
  userId: string,
  now: Date,
  keepSessionId?: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(keepSessionId ? [ne(sessions.id, keepSessionId)] : []),
      ),
    );
}

/** Turns a two-factor session into a full one with a new token, so the old token is spent. */
async function promote(
  db: Database,
  context: SessionContext,
  user: AuthenticatedUser,
): Promise<SignedIn> {
  await revokeSession(db, context.token, context.now);
  await markSignedIn(db, user.id, context.now);
  const opened = await openSession(db, {
    userId: user.id,
    realm: context.realm,
    stage: 'full',
    now: context.now,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
  return { ok: true, user, ...opened };
}

export interface TwoFactorSession {
  sessionId: string;
  user: AuthenticatedUser;
  expiresAt: Date;
  /** False until the user has finished enrolment. */
  enrolled: boolean;
}

/** The two-factor session for a token, if it is live. */
export async function validateTwoFactorSession(
  db: Database,
  token: string,
  realm: Realm,
  now: Date,
): Promise<TwoFactorSession | undefined> {
  const session = await validateSession(db, token, realm, now, 'two_factor');
  if (!session) return undefined;
  const factor = await factorFor(db, session.user.id);
  return { ...session, enrolled: (factor?.confirmedAt ?? null) !== null };
}

/**
 * The code step of sign-in: a code from the authenticator app, or a recovery code. A right one
 * opens a full session; a wrong one counts toward the account lock.
 */
export async function verifySecondFactor(
  db: Database,
  key: TotpKey,
  input: SessionContext & { code?: string | undefined; recoveryCode?: string | undefined },
): Promise<(SignedIn & { usedRecoveryCode: boolean }) | TwoFactorRefusal> {
  const session = await validateTwoFactorSession(db, input.token, input.realm, input.now);
  if (!session) return { ok: false, reason: 'no_session' };
  const userId = session.user.id;
  if (!session.enrolled) return { ok: false, reason: 'not_enrolled', userId };
  if (await isLocked(db, userId, input.now)) return { ok: false, reason: 'locked', userId };

  const result = await db.transaction(async (tx) => {
    const factor = await factorFor(tx, userId, true);
    if (!factor?.confirmedAt) return undefined;
    let usedRecoveryCode = false;
    let right = false;
    if (input.code !== undefined) {
      right = await acceptCode(tx, key, factor, factor.secretEnc, input.code, input.now);
    } else if (input.recoveryCode !== undefined) {
      right = await useRecoveryCode(tx, userId, input.recoveryCode, input.now);
      usedRecoveryCode = right;
    }
    if (!right) return undefined;
    return { ...(await promote(tx, input, session.user)), usedRecoveryCode };
  });
  if (result) return result;
  await recordFailure(db, userId, input.now);
  return { ok: false, reason: 'wrong_code', userId };
}

/**
 * Starts enrolment for a two-factor session whose user has no confirmed factor: a new secret,
 * replacing any unfinished one.
 */
export async function startEnrolment(
  db: Database,
  key: TotpKey,
  input: Omit<SessionContext, 'ipAddress' | 'userAgent'> & { issuer: string },
): Promise<NewFactor | TwoFactorRefusal> {
  const session = await validateTwoFactorSession(db, input.token, input.realm, input.now);
  if (!session) return { ok: false, reason: 'no_session' };
  if (session.enrolled) return { ok: false, reason: 'already_enrolled', userId: session.user.id };
  const secret = generateTotpSecret();
  const secretEnc = encryptSecret(key, session.user.id, secret);
  await db
    .insert(twoFactors)
    .values({ userId: session.user.id, secretEnc, createdAt: input.now, updatedAt: input.now })
    .onConflictDoUpdate({
      target: twoFactors.userId,
      set: { secretEnc, lastStep: null, updatedAt: input.now },
      // Never over a confirmed factor, even if one was confirmed since the check above.
      setWhere: isNull(twoFactors.confirmedAt),
    });
  return {
    ok: true,
    secret: base32Encode(secret),
    uri: totpUri(secret, input.issuer, session.user.email),
  };
}

/**
 * Finishes enrolment with the first code from the new secret: the factor is confirmed, a full
 * session opens, and the recovery codes are returned to show once.
 */
export async function confirmEnrolment(
  db: Database,
  key: TotpKey,
  input: SessionContext & { code: string },
): Promise<(SignedIn & { recoveryCodes: string[] }) | TwoFactorRefusal> {
  const session = await validateTwoFactorSession(db, input.token, input.realm, input.now);
  if (!session) return { ok: false, reason: 'no_session' };
  const userId = session.user.id;
  if (session.enrolled) return { ok: false, reason: 'already_enrolled', userId };
  if (await isLocked(db, userId, input.now)) return { ok: false, reason: 'locked', userId };

  const result = await db.transaction(async (tx) => {
    const factor = await factorFor(tx, userId, true);
    if (!factor || factor.confirmedAt) return undefined;
    if (!(await acceptCode(tx, key, factor, factor.secretEnc, input.code, input.now))) {
      return undefined;
    }
    await tx
      .update(twoFactors)
      .set({ confirmedAt: input.now, updatedAt: input.now })
      .where(eq(twoFactors.userId, userId));
    const codes = await newRecoveryCodes(tx, userId, input.now);
    return { ...(await promote(tx, input, session.user)), recoveryCodes: codes };
  });
  if (result) return result;
  await recordFailure(db, userId, input.now);
  return { ok: false, reason: 'wrong_code', userId };
}

export interface TwoFactorStatus {
  enrolled: boolean;
  confirmedAt: Date | null;
  recoveryCodesLeft: number;
  /** True while a move to a new phone has started and is not finished. */
  replacing: boolean;
}

export async function twoFactorStatus(db: Database, userId: string): Promise<TwoFactorStatus> {
  const factor = await factorFor(db, userId);
  const [left] = await db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return {
    enrolled: (factor?.confirmedAt ?? null) !== null,
    confirmedAt: factor?.confirmedAt ?? null,
    recoveryCodesLeft: left?.n ?? 0,
    replacing:
      (factor?.confirmedAt ?? null) !== null && (factor?.replacementSecretEnc ?? null) !== null,
  };
}

interface SignedInChange {
  userId: string;
  /** The session making the change: it stays signed in, every other one ends. */
  sessionId: string;
  password: string;
  code: string;
  now: Date;
}

/**
 * Checks the password and a current code for a change a signed-in user makes to their own
 * factor. Both must be right; either wrong counts toward the account lock. Runs `change` in the
 * transaction that accepted the code.
 */
async function withPasswordAndCode<T>(
  db: Database,
  key: TotpKey,
  input: SignedInChange,
  change: (tx: Database, factor: Factor) => Promise<T>,
): Promise<{ ok: true; value: T } | TwoFactorRefusal> {
  const { userId, now } = input;
  const [user] = await db
    .select({ passwordHash: users.passwordHash, lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.passwordHash) return { ok: false, reason: 'wrong_password', userId };
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: 'locked', userId };
  if (!(await verifyPassword(user.passwordHash, input.password.slice(0, 1024)))) {
    await recordFailure(db, userId, now);
    return { ok: false, reason: 'wrong_password', userId };
  }
  const outcome = await db.transaction(async (tx) => {
    const factor = await factorFor(tx, userId, true);
    if (!factor?.confirmedAt) return { refused: 'not_enrolled' as const };
    if (!(await acceptCode(tx, key, factor, factor.secretEnc, input.code, now))) {
      return { refused: 'wrong_code' as const };
    }
    return { value: await change(tx, factor) };
  });
  if ('refused' in outcome) {
    if (outcome.refused === 'wrong_code') await recordFailure(db, userId, now);
    return { ok: false, reason: outcome.refused, userId };
  }
  return { ok: true, value: outcome.value };
}

/** A new set of recovery codes in place of the old one. Every other session ends. */
export async function replaceRecoveryCodes(
  db: Database,
  key: TotpKey,
  input: SignedInChange,
): Promise<{ ok: true; recoveryCodes: string[] } | TwoFactorRefusal> {
  const result = await withPasswordAndCode(db, key, input, async (tx) => {
    const codes = await newRecoveryCodes(tx, input.userId, input.now);
    await revokeSessions(tx, input.userId, input.now, input.sessionId);
    return codes;
  });
  return result.ok ? { ok: true, recoveryCodes: result.value } : result;
}

/**
 * Starts the move to a new phone: a new secret, kept beside the current one until a code from
 * it is entered. The current one keeps working meanwhile.
 */
export async function startReplacement(
  db: Database,
  key: TotpKey,
  input: SignedInChange & { issuer: string; email: string },
): Promise<NewFactor | TwoFactorRefusal> {
  const secret = generateTotpSecret();
  const result = await withPasswordAndCode(db, key, input, async (tx) => {
    await tx
      .update(twoFactors)
      .set({
        replacementSecretEnc: encryptSecret(key, input.userId, secret),
        updatedAt: input.now,
      })
      .where(eq(twoFactors.userId, input.userId));
  });
  if (!result.ok) return result;
  return {
    ok: true,
    secret: base32Encode(secret),
    uri: totpUri(secret, input.issuer, input.email),
  };
}

/**
 * Finishes the move with the first code from the new phone: it replaces the old secret, the
 * recovery codes are renewed, and every other session ends.
 */
export async function confirmReplacement(
  db: Database,
  key: TotpKey,
  input: Omit<SignedInChange, 'password'>,
): Promise<{ ok: true; recoveryCodes: string[] } | TwoFactorRefusal> {
  const { userId, now } = input;
  if (await isLocked(db, userId, now)) return { ok: false, reason: 'locked', userId };
  const codes = await db.transaction(async (tx) => {
    const factor = await factorFor(tx, userId, true);
    if (!factor?.confirmedAt || factor.replacementSecretEnc === null) return undefined;
    // The new secret starts with no accepted step of its own.
    const fresh = { ...factor, lastStep: null };
    if (!(await acceptCode(tx, key, fresh, factor.replacementSecretEnc, input.code, now))) {
      return undefined;
    }
    await tx
      .update(twoFactors)
      .set({
        secretEnc: factor.replacementSecretEnc,
        replacementSecretEnc: null,
        updatedAt: now,
      })
      .where(eq(twoFactors.userId, userId));
    const renewed = await newRecoveryCodes(tx, userId, now);
    await revokeSessions(tx, userId, now, input.sessionId);
    return renewed;
  });
  if (codes) return { ok: true, recoveryCodes: codes };
  const status = await twoFactorStatus(db, userId);
  if (!status.replacing) return { ok: false, reason: 'not_enrolled', userId };
  await recordFailure(db, userId, now);
  return { ok: false, reason: 'wrong_code', userId };
}

/**
 * Removes a user's factor and recovery codes and ends all their sessions, so they enrol again
 * at their next sign-in. For an administrator resetting another admin, or the CLI.
 */
export async function resetTwoFactor(db: Database, userId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(twoFactors)
      .where(eq(twoFactors.userId, userId))
      .returning({ userId: twoFactors.userId });
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await revokeSessions(tx, userId, now);
    return removed.length > 0;
  });
}

/**
 * Re-encrypts every secret from the old key to the new one, in one transaction. Returns how
 * many factors it re-encrypted.
 */
export async function rotateTwoFactorKey(
  db: Database,
  oldKey: TotpKey,
  newKey: TotpKey,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(twoFactors).for('update');
    for (const row of rows) {
      const move = (stored: string) =>
        encryptSecret(newKey, row.userId, decryptSecret(oldKey, row.userId, stored));
      await tx
        .update(twoFactors)
        .set({
          secretEnc: move(row.secretEnc),
          replacementSecretEnc:
            row.replacementSecretEnc === null ? null : move(row.replacementSecretEnc),
          updatedAt: sql`now()`,
        })
        .where(eq(twoFactors.userId, row.userId));
    }
    return rows.length;
  });
}

/** Whether a user has a confirmed factor. */
export async function hasTwoFactor(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: twoFactors.userId })
    .from(twoFactors)
    .where(and(eq(twoFactors.userId, userId), isNotNull(twoFactors.confirmedAt)))
    .limit(1);
  return row !== undefined;
}
