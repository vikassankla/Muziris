import type { Database } from '@muziris/db';
import { createUser, findUserByEmail, type AuthenticatedUser } from '@muziris/identity';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buyerUsers, customers } from './db/schema.js';
import { CustomerError, isForeignKeyViolation, isUniqueViolation } from './errors.js';
import { pageQuerySchema, toPage, type PageQuery } from './page.js';

/** A buyer user: an identity user in the buyer realm, working for one customer. */
export interface BuyerUser {
  /** The identity user's id. */
  userId: string;
  customerId: string;
  createdAt: Date;
}

const idSchema = z.uuid();

function toBuyerUser(row: typeof buyerUsers.$inferSelect): BuyerUser {
  return { userId: row.userId, customerId: row.customerId, createdAt: row.createdAt };
}

export async function assertCustomerExists(db: Database, customerId: string): Promise<void> {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, idSchema.parse(customerId)))
    .limit(1);
  if (!row) throw new CustomerError('customer_not_found', 'No such customer');
}

/** Links an identity user to a customer. The caller has already checked the user is a buyer. */
export async function insertBuyerUser(
  db: Pick<Database, 'insert'>,
  user: AuthenticatedUser,
  customerId: string,
): Promise<BuyerUser> {
  if (user.realm !== 'buyer') {
    throw new CustomerError('not_a_buyer', 'Only buyer accounts can be buyer users');
  }
  try {
    const [row] = await db
      .insert(buyerUsers)
      .values({ userId: user.id, customerId: idSchema.parse(customerId) })
      .returning();
    if (!row) throw new Error('Buyer user insert returned no row');
    return toBuyerUser(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CustomerError('buyer_user_exists', 'That account is already a buyer user');
    }
    if (isForeignKeyViolation(error)) {
      throw new CustomerError('customer_not_found', 'No such customer');
    }
    throw error;
  }
}

/**
 * Makes an existing buyer account a buyer user of a customer. The account is found through
 * identity's public interface; an admin account, or an email with no buyer account, is refused.
 */
export async function linkBuyerUser(
  db: Database,
  customerId: string,
  email: string,
): Promise<BuyerUser> {
  const user = await findUserByEmail(db, 'buyer', z.email().max(254).parse(email));
  if (!user) throw new CustomerError('not_a_buyer', 'No buyer account with that email');
  return insertBuyerUser(db, user, customerId);
}

export interface NewBuyerUser {
  customerId: string;
  email: string;
  displayName: string;
  /** Omit to create an account that sets its password later. */
  password?: string;
}

/**
 * Creates a buyer account in identity and links it to a customer. Identity's errors (email
 * taken, password policy) pass through unchanged.
 */
export async function createBuyerUser(db: Database, input: NewBuyerUser): Promise<BuyerUser> {
  const customerId = idSchema.parse(input.customerId);
  // Check first, so a missing customer does not leave an unlinked account behind.
  await assertCustomerExists(db, customerId);
  const user = await createUser(db, {
    realm: 'buyer',
    email: input.email,
    displayName: input.displayName,
    ...(input.password === undefined ? {} : { password: input.password }),
  });
  return insertBuyerUser(db, user, customerId);
}

/**
 * The buyer user for a signed-in identity user, or undefined if they are not one. Use it to
 * build the scope context for a storefront request.
 */
export async function findBuyerUser(db: Database, userId: string): Promise<BuyerUser | undefined> {
  const [row] = await db
    .select()
    .from(buyerUsers)
    .where(eq(buyerUsers.userId, idSchema.parse(userId)))
    .limit(1);
  return row ? toBuyerUser(row) : undefined;
}

export interface BuyerUserPage {
  buyerUsers: BuyerUser[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/**
 * Buyer users of one customer, oldest first, a page at a time, for the admin. `after` is a
 * buyer user id. Storefront reads go through buyer-scope.ts.
 */
export async function listBuyerUsers(
  db: Database,
  customerId: string,
  query: PageQuery = {},
): Promise<BuyerUserPage> {
  const q = pageQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(buyerUsers)
    .where(
      and(
        eq(buyerUsers.customerId, idSchema.parse(customerId)),
        q.after === undefined
          ? undefined
          : sql`(${buyerUsers.createdAt}, ${buyerUsers.userId}) > (select created_at, user_id from ${buyerUsers} where user_id = ${q.after})`,
      ),
    )
    .orderBy(asc(buyerUsers.createdAt), asc(buyerUsers.userId))
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.userId);
  return { buyerUsers: items.map(toBuyerUser), nextAfter };
}
