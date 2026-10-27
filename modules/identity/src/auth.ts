import type { Database } from '@muziris/db';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { sessions, users } from './db/schema.js';
import { burnVerifyTime, hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  LAST_SEEN_REFRESH_MS,
  LOCKOUT_POLICY,
  lockDurationMs,
  SESSION_POLICIES,
} from './policy.js';
import { generateToken, hashToken, isWellFormedToken, normalizeEmail } from './tokens.js';
import type { AuthenticatedUser, Realm } from './types.js';

export interface SignInInput {
  realm: Realm;
  email: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  now: Date;
}

/** Why a sign-in failed. For logs and tests only: callers must show one generic message. */
export type SignInFailure =
  'unknown_email' | 'no_password' | 'disabled' | 'locked' | 'wrong_password';

export type SignInResult =
  | {
      ok: true;
      user: AuthenticatedUser;
      /** Give this to the browser; it is never stored. */
      token: string;
      expiresAt: Date;
    }
  | { ok: false; reason: SignInFailure; userId?: string };

const MAX_INPUT_LENGTH = 1024;

/**
 * Verifies an email and password and opens a session. Every failure path costs about the same
 * time and returns no detail the caller may show, so responses do not reveal which emails
 * have accounts.
 */
export async function signIn(db: Database, input: SignInInput): Promise<SignInResult> {
  const email = normalizeEmail(input.email.slice(0, MAX_INPUT_LENGTH));
  const password = input.password.slice(0, MAX_INPUT_LENGTH);

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.realm, input.realm), eq(users.email, email)))
    .limit(1);

  if (!user) {
    await burnVerifyTime(password);
    return { ok: false, reason: 'unknown_email' };
  }
  if (user.status !== 'active') {
    await burnVerifyTime(password);
    return { ok: false, reason: 'disabled', userId: user.id };
  }
  if (user.lockedUntil && user.lockedUntil > input.now) {
    await burnVerifyTime(password);
    return { ok: false, reason: 'locked', userId: user.id };
  }
  if (!user.passwordHash) {
    await burnVerifyTime(password);
    return { ok: false, reason: 'no_password', userId: user.id };
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    await recordFailure(db, user.id, input.now);
    return { ok: false, reason: 'wrong_password', userId: user.id };
  }

  const upgradedHash = needsRehash(user.passwordHash) ? await hashPassword(password) : undefined;
  const token = generateToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_POLICIES[input.realm].absoluteTimeoutMs);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: input.now,
        ...(upgradedHash ? { passwordHash: upgradedHash } : {}),
        updatedAt: input.now,
      })
      .where(eq(users.id, user.id));
    await tx.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: user.id,
      realm: input.realm,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipAddress: input.ipAddress?.slice(0, 64) ?? null,
    });
  });

  return {
    ok: true,
    user: { id: user.id, realm: user.realm, email: user.email, displayName: user.displayName },
    token,
    expiresAt,
  };
}

/** Counts a failed attempt atomically and locks the account once the limit is reached. */
async function recordFailure(db: Database, userId: string, now: Date): Promise<void> {
  const [row] = await db
    .update(users)
    .set({ failedLoginCount: sql`${users.failedLoginCount} + 1`, updatedAt: now })
    .where(eq(users.id, userId))
    .returning({ failedLoginCount: users.failedLoginCount });
  const lockMs = lockDurationMs(row?.failedLoginCount ?? 0, LOCKOUT_POLICY);
  if (lockMs > 0) {
    await db
      .update(users)
      .set({ lockedUntil: new Date(now.getTime() + lockMs) })
      .where(eq(users.id, userId));
  }
}

export interface ValidSession {
  sessionId: string;
  user: AuthenticatedUser;
  expiresAt: Date;
}

/**
 * Returns the session for a token if it is live: right realm, not revoked, within both the
 * absolute and idle timeouts, and its user still active. Otherwise undefined.
 */
export async function validateSession(
  db: Database,
  token: string,
  realm: Realm,
  now: Date,
): Promise<ValidSession | undefined> {
  if (!isWellFormedToken(token)) return undefined;
  const idleCutoff = new Date(now.getTime() - SESSION_POLICIES[realm].idleTimeoutMs);

  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      realm: users.realm,
      email: users.email,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        eq(sessions.realm, realm),
        eq(users.realm, realm),
        eq(users.status, 'active'),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.lastSeenAt, idleCutoff),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_REFRESH_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    user: { id: row.userId, realm: row.realm, email: row.email, displayName: row.displayName },
  };
}

/** Ends one session. Unknown or malformed tokens are ignored, so sign-out never fails. */
export async function revokeSession(db: Database, token: string, now: Date): Promise<void> {
  if (!isWellFormedToken(token)) return;
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

/** Removes sessions that can no longer be used. Meant for a periodic background job. */
export async function deleteDeadSessions(db: Database, now: Date): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.revokedAt, now)))
    .returning({ id: sessions.id });
  return deleted.length;
}
