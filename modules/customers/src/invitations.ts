import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@muziris/db';
import { createUser, disableUser, isWellFormedToken, newUserSchema } from '@muziris/identity';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { insertBuyerUser, assertCustomerExists, type BuyerUser } from './buyer-users.js';
import { invitations } from './db/schema.js';
import { CustomerError } from './errors.js';

const HOUR_MS = 60 * 60 * 1000;

/** How long an invitation stays open unless the sender chooses otherwise. */
export const INVITATION_DEFAULT_TTL_MS = 7 * 24 * HOUR_MS;
export const INVITATION_MIN_TTL_MS = HOUR_MS;
export const INVITATION_MAX_TTL_MS = 30 * 24 * HOUR_MS;

/** An invitation as other code sees it. The token hash never leaves the module. */
export interface Invitation {
  id: string;
  customerId: string;
  email: string;
  displayName: string;
  invitedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/**
 * Where an invitation stands at `now`. It can be accepted strictly before `expiresAt`; at that
 * instant and after, it has expired. Accepted and revoked are final and win over expiry.
 */
export function invitationStatus(
  invitation: Pick<Invitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date,
): InvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  return now.getTime() < invitation.expiresAt.getTime() ? 'pending' : 'expired';
}

/** 32 random bytes (256 bits) from the OS CSPRNG, base64url-encoded: 43 characters. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of the token: SHA-256, hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toInvitation(row: typeof invitations.$inferSelect): Invitation {
  return {
    id: row.id,
    customerId: row.customerId,
    email: row.email,
    displayName: row.displayName,
    invitedByUserId: row.invitedByUserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedUserId: row.acceptedUserId,
    revokedAt: row.revokedAt,
  };
}

/** Is open: neither accepted nor revoked. Expiry is checked against `now` separately. */
const isOpen = and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));

export const newInvitationSchema = z.object({
  customerId: z.uuid(),
  // Identity's own email rule, so an invitation can always become an account.
  email: newUserSchema.shape.email,
  displayName: z.string().trim().min(1).max(200),
  invitedByUserId: z.uuid(),
  now: z.date(),
  ttlMs: z
    .number()
    .int()
    .min(INVITATION_MIN_TTL_MS)
    .max(INVITATION_MAX_TTL_MS)
    .default(INVITATION_DEFAULT_TTL_MS),
});

export type NewInvitation = z.input<typeof newInvitationSchema>;

export interface CreatedInvitation {
  invitation: Invitation;
  /** Put this in the emailed link; it is never stored and cannot be shown again. */
  token: string;
}

/**
 * Invites a person to become a buyer user of a customer. Any open invitation for the same
 * customer and email is revoked, so only the newest link works.
 */
export async function createInvitation(
  db: Database,
  input: NewInvitation,
): Promise<CreatedInvitation> {
  const values = newInvitationSchema.parse(input);
  await assertCustomerExists(db, values.customerId);
  const token = generateToken();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(invitations)
      .set({ revokedAt: values.now })
      .where(
        and(
          eq(invitations.customerId, values.customerId),
          eq(invitations.email, values.email),
          isOpen,
        ),
      );
    const [inserted] = await tx
      .insert(invitations)
      .values({
        customerId: values.customerId,
        email: values.email,
        displayName: values.displayName,
        tokenHash: hashToken(token),
        invitedByUserId: values.invitedByUserId,
        createdAt: values.now,
        expiresAt: new Date(values.now.getTime() + values.ttlMs),
      })
      .returning();
    if (!inserted) throw new Error('Invitation insert returned no row');
    return inserted;
  });
  return { invitation: toInvitation(row), token };
}

/** Revokes an open invitation. Accepted or already revoked invitations are refused. */
export async function revokeInvitation(
  db: Database,
  invitationId: string,
  now: Date,
): Promise<Invitation> {
  const id = z.uuid().parse(invitationId);
  const [row] = await db
    .update(invitations)
    .set({ revokedAt: now })
    .where(and(eq(invitations.id, id), isOpen))
    .returning();
  if (row) return toInvitation(row);
  const [existing] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(eq(invitations.id, id));
  throw existing
    ? new CustomerError('invitation_closed', 'The invitation was already accepted or revoked')
    : new CustomerError('invitation_not_found', 'No such invitation');
}

/** Invitations of one customer that can still be accepted at `now`, oldest first. */
export async function listPendingInvitations(
  db: Database,
  customerId: string,
  now: Date,
): Promise<Invitation[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.customerId, z.uuid().parse(customerId)),
        isOpen,
        gt(invitations.expiresAt, now),
      ),
    )
    .orderBy(asc(invitations.createdAt), asc(invitations.id));
  return rows.map(toInvitation);
}

async function loadByToken(db: Database, token: string) {
  if (!isWellFormedToken(token)) return undefined;
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(token)))
    .limit(1);
  return row;
}

/** Throws unless the invitation can be accepted at `now`. */
function assertPending(row: typeof invitations.$inferSelect | undefined, now: Date) {
  if (!row) throw new CustomerError('invitation_not_found', 'No such invitation');
  switch (invitationStatus(row, now)) {
    case 'pending':
      return row;
    case 'expired':
      throw new CustomerError('invitation_expired', 'The invitation has expired');
    case 'accepted':
    case 'revoked':
      throw new CustomerError(
        'invitation_closed',
        'The invitation was already accepted or revoked',
      );
  }
}

/**
 * The invitation a token belongs to, if it can still be accepted at `now`, for showing the
 * accept page. Throws CustomerError otherwise.
 */
export async function findPendingInvitation(
  db: Database,
  token: string,
  now: Date,
): Promise<Invitation> {
  return toInvitation(assertPending(await loadByToken(db, token), now));
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  /** Defaults to the name the sender entered. */
  displayName?: string;
  now: Date;
}

/**
 * Accepts an invitation: creates the buyer account in identity with the invitation's email and
 * links it to the customer. Identity's errors (email taken, password policy) pass through.
 *
 * The invitation is claimed with a conditional update, so it is used at most once even when
 * two requests race; a second request for the same email already fails in identity on the
 * unique email. If the claim or link fails after the account was created, the account is
 * disabled, so no unlinked account can sign in.
 */
export async function acceptInvitation(
  db: Database,
  input: AcceptInvitationInput,
): Promise<BuyerUser> {
  const pending = assertPending(await loadByToken(db, input.token), input.now);
  const user = await createUser(db, {
    realm: 'buyer',
    email: pending.email,
    displayName: input.displayName ?? pending.displayName,
    password: input.password,
  });
  try {
    return await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(invitations)
        .set({ acceptedAt: input.now, acceptedUserId: user.id })
        .where(and(eq(invitations.id, pending.id), isOpen, gt(invitations.expiresAt, input.now)))
        .returning({ id: invitations.id });
      if (!claimed) {
        throw new CustomerError(
          'invitation_closed',
          'The invitation was already accepted or revoked',
        );
      }
      return insertBuyerUser(tx, user, pending.customerId);
    });
  } catch (error) {
    await disableUser(db, user.id);
    throw error;
  }
}
