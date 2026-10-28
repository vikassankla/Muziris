import type { Database } from '@muziris/db';
import { and, asc, eq, sql, type Column, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { addressOrder, type Address } from './addresses.js';
import type { BuyerUser } from './buyer-users.js';
import type { Customer } from './customers.js';
import { addresses, buyerUsers, customers } from './db/schema.js';
import { reachableCustomerIds, type CustomerReach } from './hierarchy.js';

// Storefront reads. Each one is scoped in the query itself: the customers a buyer user may see
// are derived from their own buyer user row inside the same statement, never filtered
// afterwards. The caller supplies the signed-in identity user's id and the reach that the
// buyer's access level allows (from @muziris/access).

const idSchema = z.uuid();

/** A buyer user and the reach of the request they are making. */
export interface BuyerViewer {
  buyerUserId: string;
  reach: CustomerReach;
}

function within(column: Column, viewer: BuyerViewer): SQL {
  return sql`${column} in (${reachableCustomerIds(viewer.buyerUserId, viewer.reach)})`;
}

/** The customers the viewer may see: their own, and with subsidiaries every one below it. */
export async function listCustomersForBuyer(
  db: Database,
  viewer: BuyerViewer,
): Promise<Customer[]> {
  return db
    .select()
    .from(customers)
    .where(within(customers.id, viewer))
    .orderBy(asc(customers.name), asc(customers.id));
}

/** One customer, if the viewer may see it. */
export async function findCustomerForBuyer(
  db: Database,
  viewer: BuyerViewer,
  customerId: string,
): Promise<Customer | undefined> {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, idSchema.parse(customerId)), within(customers.id, viewer)))
    .limit(1);
  return row;
}

/**
 * Addresses the viewer may see, optionally of one customer. A customer outside the viewer's
 * reach gives an empty list, the same as a customer with no addresses.
 */
export async function listAddressesForBuyer(
  db: Database,
  viewer: BuyerViewer,
  customerId?: string,
): Promise<Address[]> {
  const conditions = [within(addresses.customerId, viewer)];
  if (customerId !== undefined)
    conditions.push(eq(addresses.customerId, idSchema.parse(customerId)));
  return db
    .select()
    .from(addresses)
    .where(and(...conditions))
    .orderBy(...addressOrder);
}

/** Buyer users the viewer may see (colleagues, and with subsidiaries theirs too). */
export async function listBuyerUsersForBuyer(
  db: Database,
  viewer: BuyerViewer,
): Promise<BuyerUser[]> {
  const rows = await db
    .select()
    .from(buyerUsers)
    .where(within(buyerUsers.customerId, viewer))
    .orderBy(asc(buyerUsers.customerId), asc(buyerUsers.createdAt), asc(buyerUsers.userId));
  return rows.map((row) => ({
    userId: row.userId,
    customerId: row.customerId,
    createdAt: row.createdAt,
  }));
}
