import type { Database } from '@muziris/db';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { customerGroups, customers } from './db/schema.js';
import {
  CustomerError,
  isForeignKeyViolation,
  isUniqueViolation,
  violatedConstraint,
} from './errors.js';
import { descendantCustomerIds } from './hierarchy.js';
import { pageQuerySchema, toPage, type PageQuery } from './page.js';

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

export interface CustomerGroupPage {
  customerGroups: CustomerGroup[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/** Customer groups by code, a page at a time. */
export async function listCustomerGroups(
  db: Database,
  query: PageQuery = {},
): Promise<CustomerGroupPage> {
  const q = pageQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(customerGroups)
    .where(
      q.after === undefined
        ? undefined
        : sql`${customerGroups.code} > (select code from ${customerGroups} where id = ${q.after})`,
    )
    .orderBy(asc(customerGroups.code))
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (g) => g.id);
  return { customerGroups: items, nextAfter };
}

export async function findCustomerGroup(
  db: Database,
  groupId: string,
): Promise<CustomerGroup | undefined> {
  const [row] = await db
    .select()
    .from(customerGroups)
    .where(eq(customerGroups.id, idSchema.parse(groupId)))
    .limit(1);
  return row;
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

export const listCustomersQuerySchema = pageQuerySchema
  .extend({
    /** Only the direct subsidiaries of this customer. */
    parentId: z.uuid().optional(),
    /** Only customers with no parent. */
    topLevel: z.boolean().default(false),
    /** Only customers in this customer group. */
    groupId: z.uuid().optional(),
  })
  .refine((q) => !(q.topLevel && q.parentId !== undefined), {
    message: 'Ask for top-level customers or for the subsidiaries of one customer, not both',
    path: ['topLevel'],
  });

export type ListCustomersQuery = z.input<typeof listCustomersQuerySchema>;

export interface CustomerPage {
  customers: Customer[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/** Customers by name, a page at a time, for the admin. Storefront reads use buyer-scope.ts. */
export async function listCustomers(
  db: Database,
  query: ListCustomersQuery = {},
): Promise<CustomerPage> {
  const q = listCustomersQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.parentId !== undefined) conditions.push(eq(customers.parentId, q.parentId));
  if (q.topLevel) conditions.push(isNull(customers.parentId));
  if (q.groupId !== undefined) conditions.push(eq(customers.groupId, q.groupId));
  if (q.after !== undefined) {
    conditions.push(
      sql`(${customers.name}, ${customers.id}) > (select name, id from ${customers} where id = ${q.after})`,
    );
  }
  const rows = await db
    .select()
    .from(customers)
    .where(and(...conditions))
    .orderBy(asc(customers.name), asc(customers.id))
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (c) => c.id);
  return { customers: items, nextAfter };
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
