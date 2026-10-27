import type { Database } from '@muziris/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sessions, users } from './db/schema.js';
import { checkPasswordPolicy, hashPassword, type PasswordProblem } from './password.js';
import { normalizeEmail } from './tokens.js';
import type { AuthenticatedUser, Realm } from './types.js';

export class PasswordPolicyError extends Error {
  readonly problems: PasswordProblem[];

  constructor(problems: PasswordProblem[]) {
    super(`Password does not meet the policy: ${problems.join(', ')}`);
    this.name = 'PasswordPolicyError';
    this.problems = problems;
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'EmailTakenError';
  }
}

const emailSchema = z.email().max(254).transform(normalizeEmail);

export const newUserSchema = z.object({
  realm: z.enum(['admin', 'buyer']),
  email: emailSchema,
  displayName: z.string().trim().min(1).max(200),
  /** Omit to create an invited user who sets a password later. */
  password: z.string().optional(),
});

export type NewUser = z.input<typeof newUserSchema>;

function toAuthenticatedUser(row: typeof users.$inferSelect): AuthenticatedUser {
  return { id: row.id, realm: row.realm, email: row.email, displayName: row.displayName };
}

function isUniqueViolation(error: unknown): boolean {
  // postgres.js puts the SQLSTATE on `code`; drizzle may wrap it in `cause`.
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (e) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505',
  );
}

export async function createUser(db: Database, input: NewUser): Promise<AuthenticatedUser> {
  const values = newUserSchema.parse(input);
  let passwordHash: string | null = null;
  if (values.password !== undefined) {
    const problems = checkPasswordPolicy(values.password, values.email);
    if (problems.length > 0) throw new PasswordPolicyError(problems);
    passwordHash = await hashPassword(values.password);
  }
  try {
    const [row] = await db
      .insert(users)
      .values({
        realm: values.realm,
        email: values.email,
        displayName: values.displayName,
        passwordHash,
        passwordChangedAt: passwordHash ? sql`now()` : null,
      })
      .returning();
    if (!row) throw new Error('User insert returned no row');
    return toAuthenticatedUser(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailTakenError();
    throw error;
  }
}

export async function findUserByEmail(
  db: Database,
  realm: Realm,
  email: string,
): Promise<AuthenticatedUser | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.realm, realm), eq(users.email, normalizeEmail(email))))
    .limit(1);
  return row ? toAuthenticatedUser(row) : undefined;
}

export async function findUserById(
  db: Database,
  userId: string,
): Promise<AuthenticatedUser | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ? toAuthenticatedUser(row) : undefined;
}

/**
 * Sets a new password and signs the user out everywhere, so a stolen session cannot outlive a
 * password change. Also clears any lockout.
 */
export async function changePassword(
  db: Database,
  userId: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) throw new Error('User not found');
  const problems = checkPasswordPolicy(newPassword, user.email);
  if (problems.length > 0) throw new PasswordPolicyError(problems);
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash,
        passwordChangedAt: sql`now()`,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`));
  });
}

/** Disables an account and ends all its sessions. */
export async function disableUser(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ status: 'disabled', updatedAt: sql`now()` })
      .where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`));
  });
}
