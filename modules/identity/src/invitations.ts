import type { Database, Transaction } from '@muziris/db';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { invitations, twoFactors, users } from './db/schema.js';
import { checkPasswordPolicy, hashPassword } from './password.js';
import { generateToken, hashToken, isWellFormedToken } from './tokens.js';
import type { AuthenticatedUser, Realm } from './types.js';
import {
  EmailTakenError,
  isUniqueViolation,
  newUserSchema,
  PasswordPolicyError,
  type UserBasics,
} from './users.js';

// Admin invitations and the admin users list (ADR 0028). An invited admin has an account with
// no password, so it cannot sign in; the emailed link sets one. Accepting does not sign them in:
// they sign in with the password and enrol a second factor, as every admin does (ADR 0026).

/** As long as a buyer invitation lasts by default would be too long for an admin account. */
export const ADMIN_INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export type IdentityErrorCode = 'invitation_invalid' | 'user_not_found' | 'not_invited';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export interface UserInvitation {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreatedUserInvitation {
  user: AuthenticatedUser;
  invitation: UserInvitation;
  /** Put this in the emailed link; it is never stored and cannot be shown again. */
  token: string;
}

export interface UserInvitationHooks {
  /**
   * Runs in the invitation's transaction, for the invitation email (ADR 0020): the email is
   * queued only if the invitation commits. Throwing rolls the invitation back.
   */
  inTransaction?: (tx: Transaction, created: CreatedUserInvitation) => Promise<void>;
}

const isOpen = and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));

async function insertInvitation(
  tx: Transaction,
  user: AuthenticatedUser,
  invitedByUserId: string,
  now: Date,
  hooks: UserInvitationHooks,
): Promise<CreatedUserInvitation> {
  await tx
    .update(invitations)
    .set({ revokedAt: now })
    .where(and(eq(invitations.userId, user.id), isOpen));
  const token = generateToken();
  const [row] = await tx
    .insert(invitations)
    .values({
      userId: user.id,
      tokenHash: hashToken(token),
      invitedByUserId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_INVITATION_TTL_MS),
    })
    .returning();
  if (!row) throw new Error('Invitation insert returned no row');
  const created = {
    user,
    invitation: {
      id: row.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
    token,
  };
  if (hooks.inTransaction) await hooks.inTransaction(tx, created);
  return created;
}

const inviteSchema = newUserSchema.pick({ email: true, displayName: true }).extend({
  invitedByUserId: z.uuid(),
  now: z.date(),
});

/**
 * Makes an admin account with no password and invites its owner to set one, in one
 * transaction with the hook's email. An email already in use is refused with EmailTakenError.
 */
export async function inviteAdminUser(
  db: Database,
  input: z.input<typeof inviteSchema>,
  hooks: UserInvitationHooks = {},
): Promise<CreatedUserInvitation> {
  const values = inviteSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ realm: 'admin', email: values.email, displayName: values.displayName })
        .returning();
      if (!row) throw new Error('User insert returned no row');
      const user = { id: row.id, realm: row.realm, email: row.email, displayName: row.displayName };
      return insertInvitation(tx, user, values.invitedByUserId, values.now, hooks);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailTakenError();
    throw error;
  }
}

/**
 * Sends an admin's invitation again with a new token, which revokes the old link. Refused once
 * the admin has set a password.
 */
export async function resendAdminInvitation(
  db: Database,
  input: { userId: string; invitedByUserId: string; now: Date },
  hooks: UserInvitationHooks = {},
): Promise<CreatedUserInvitation> {
  const id = z.uuid().safeParse(input.userId);
  if (!id.success) throw new IdentityError('user_not_found', 'No such admin user');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, id.data), eq(users.realm, 'admin')))
      .for('update');
    if (!row) throw new IdentityError('user_not_found', 'No such admin user');
    if (row.passwordHash !== null) {
      throw new IdentityError('not_invited', 'This admin user has already set a password');
    }
    const user = { id: row.id, realm: row.realm, email: row.email, displayName: row.displayName };
    return insertInvitation(tx, user, input.invitedByUserId, input.now, hooks);
  });
}

/** The open, unexpired invitation a token belongs to, with its active, password-less user. */
async function pendingByToken(db: Database | Transaction, token: string, now: Date) {
  if (!isWellFormedToken(token)) return undefined;
  const [row] = await db
    .select({ invitation: invitations, user: users })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isOpen,
        gt(invitations.expiresAt, now),
        eq(users.status, 'active'),
        isNull(users.passwordHash),
      ),
    )
    .limit(1);
  return row;
}

const INVALID = 'This invitation link is not valid';

/** Who an invitation is for, to show on the accept page. Every refusal is the same. */
export async function findPendingUserInvitation(
  db: Database,
  token: string,
  now: Date,
): Promise<UserInvitation> {
  const row = await pendingByToken(db, token, now);
  if (!row) throw new IdentityError('invitation_invalid', INVALID);
  return {
    id: row.invitation.id,
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    createdAt: row.invitation.createdAt,
    expiresAt: row.invitation.expiresAt,
  };
}

/**
 * Sets the invited user's password and uses the invitation up, once: the invitation row is locked,
 * so two requests with the same token cannot both succeed. A wrong, used or expired token, or a
 * disabled account, gets the same refusal; a weak password gets PasswordPolicyError.
 */
export async function acceptUserInvitation(
  db: Database,
  input: { token: string; password: string; now: Date },
): Promise<AuthenticatedUser> {
  const found = await pendingByToken(db, input.token, input.now);
  if (!found) throw new IdentityError('invitation_invalid', INVALID);
  const problems = checkPasswordPolicy(input.password, found.user.email);
  if (problems.length > 0) throw new PasswordPolicyError(problems);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: input.now })
      .where(
        and(eq(invitations.id, found.invitation.id), isOpen, gt(invitations.expiresAt, input.now)),
      )
      .returning({ id: invitations.id });
    if (!claimed) throw new IdentityError('invitation_invalid', INVALID);
    const [user] = await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: input.now, updatedAt: input.now })
      .where(
        and(eq(users.id, found.user.id), eq(users.status, 'active'), isNull(users.passwordHash)),
      )
      .returning();
    if (!user) throw new IdentityError('invitation_invalid', INVALID);
    return { id: user.id, realm: user.realm, email: user.email, displayName: user.displayName };
  });
}

/** Lets a disabled account sign in again. Its sessions stay ended. */
export async function enableUser(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ status: 'active', updatedAt: sql`now()` })
    .where(eq(users.id, z.uuid().parse(userId)));
}

export interface UserSummary extends UserBasics {
  /** No password yet: invited and not accepted. */
  invited: boolean;
  /** An authenticator app is set up and confirmed. */
  twoFactor: boolean;
}

const summaryColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  status: users.status,
  invited: sql<boolean>`${users.passwordHash} is null`,
  twoFactor: sql<boolean>`coalesce(${twoFactors.confirmedAt} is not null, false)`,
  lastLoginAt: users.lastLoginAt,
};

export const listUsersQuerySchema = z.object({
  after: z.uuid().optional(),
  limit: z.int().min(1).max(200).default(25),
});

export interface UserPage {
  users: UserSummary[];
  nextAfter: string | null;
}

/** The accounts of a realm by name, then id, a page at a time. */
export async function listUsers(
  db: Database,
  realm: Realm,
  query: z.input<typeof listUsersQuerySchema> = {},
): Promise<UserPage> {
  const q = listUsersQuerySchema.parse(query);
  const rows = await db
    .select(summaryColumns)
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id))
    .where(
      and(
        eq(users.realm, realm),
        q.after === undefined
          ? undefined
          : sql`(lower(${users.displayName}), ${users.id}) > (select lower(display_name), id from ${users} where id = ${q.after})`,
      ),
    )
    .orderBy(sql`lower(${users.displayName})`, asc(users.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    users: page,
    nextAfter: more ? (page.at(-1)?.id ?? null) : null,
  };
}

/** One account's summary in a realm, or undefined. */
export async function findUserSummary(
  db: Database,
  realm: Realm,
  userId: string,
): Promise<UserSummary | undefined> {
  const id = z.uuid().safeParse(userId);
  if (!id.success) return undefined;
  const [row] = await db
    .select(summaryColumns)
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id))
    .where(and(eq(users.id, id.data), eq(users.realm, realm)));
  return row;
}
