import type { Database } from '@muziris/db';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { customerGroups, customers } from './db/schema.js';
import {
  CustomerError,
  isForeignKeyViolation,
  isUniqueViolation,
  violatedConstraint,
} from './errors.js';
import { descendantCustomerIds } from './hierarchy.js';

// Admin-side functions. They are not scoped to a buyer: the admin API checks the admin's
// permission before calling them. Storefront reads go through buyer-scope.ts.

export type Customer = typeof customers.$inferSelect;
export type CustomerGroup = typeof customerGroups.$inferSelect;

const idSchema = z.uuid();

export const newCustomerGroupSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'Use 2 to 63 lowercase letters, digits or _'),
  name: z.string().trim().min(1).max(200),
});

export type NewCustomerGroup = z.input<typeof newCustomerGroupSchema>;

export const newCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().default(null),
  groupId: z.uuid().nullable().default(null),
});

export type NewCustomer = z.input<typeof newCustomerSchema>;

export async function createCustomerGroup(
  db: Database,
  input: NewCustomerGroup,
): Promise<CustomerGroup> {
  const values = newCustomerGroupSchema.parse(input);
  try {
    const [row] = await db.insert(customerGroups).values(values).returning();
    if (!row) throw new Error('Customer group insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CustomerError('customer_group_code_taken', 'That customer group code is taken');
    }
    throw error;
  }
}

export async function listCustomerGroups(db: Database): Promise<CustomerGroup[]> {
  return db.select().from(customerGroups).orderBy(asc(customerGroups.code));
}

/** A missing parent or group surfaces as a foreign key violation; name it for the caller. */
function refusedReference(error: unknown): CustomerError | undefined {
  if (!isForeignKeyViolation(error)) return undefined;
  return violatedConstraint(error)?.includes('_group_id_')
    ? new CustomerError('customer_group_not_found', 'No such customer group')
    : new CustomerError('customer_not_found', 'No such parent customer');
}

/** Creates a customer. A new customer has no subsidiaries, so any existing parent is safe. */
export async function createCustomer(db: Database, input: NewCustomer): Promise<Customer> {
  const values = newCustomerSchema.parse(input);
  try {
    const [row] = await db.insert(customers).values(values).returning();
    if (!row) throw new Error('Customer insert returned no row');
    return row;
  } catch (error) {
    throw refusedReference(error) ?? error;
  }
}

export async function findCustomer(
  db: Database,
  customerId: string,
): Promise<Customer | undefined> {
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, idSchema.parse(customerId)))
    .limit(1);
  return row;
}

/** Direct subsidiaries of a customer, by name. */
export async function listSubsidiaries(db: Database, customerId: string): Promise<Customer[]> {
  return db
    .select()
    .from(customers)
    .where(eq(customers.parentId, idSchema.parse(customerId)))
    .orderBy(asc(customers.name), asc(customers.id));
}

/**
 * Moves a customer under a new parent, or to the top of the hierarchy with null. Refuses a
 * parent that is the customer itself or any of its subsidiaries, which would form a cycle.
 *
 * Hierarchy changes take one transaction-scoped advisory lock, so two concurrent moves (A under
 * B, and B under A) cannot each pass the check against the other's old state.
 */
export async function setCustomerParent(
  db: Database,
  customerId: string,
  parentId: string | null,
): Promise<Customer> {
  const id = idSchema.parse(customerId);
  const parent = parentId === null ? null : idSchema.parse(parentId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('customer_customer.parent_id'))`);
    if (parent !== null) {
      if (parent === id) {
        throw new CustomerError('hierarchy_cycle', 'A customer cannot be its own parent');
      }
      const below = await tx.execute(
        sql`select 1 from (${descendantCustomerIds(id)}) below where below.id = ${parent} limit 1`,
      );
      if (below.length > 0) {
        throw new CustomerError(
          'hierarchy_cycle',
          'A customer cannot be moved under one of its own subsidiaries',
        );
      }
    }
    try {
      const [row] = await tx
        .update(customers)
        .set({ parentId: parent, updatedAt: sql`now()` })
        .where(eq(customers.id, id))
        .returning();
      if (!row) throw new CustomerError('customer_not_found', 'No such customer');
      return row;
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new CustomerError('customer_not_found', 'No such parent customer');
      }
      throw error;
    }
  });
}

/** Puts a customer in a customer group, or takes it out with null. */
export async function setCustomerGroup(
  db: Database,
  customerId: string,
  groupId: string | null,
): Promise<Customer> {
  const id = idSchema.parse(customerId);
  const group = groupId === null ? null : idSchema.parse(groupId);
  try {
    const [row] = await db
      .update(customers)
      .set({ groupId: group, updatedAt: sql`now()` })
      .where(eq(customers.id, id))
      .returning();
    if (!row) throw new CustomerError('customer_not_found', 'No such customer');
    return row;
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new CustomerError('customer_group_not_found', 'No such customer group');
    }
    throw error;
  }
}
