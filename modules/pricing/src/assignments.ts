import { findCustomer, findCustomerGroup } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findWebsite } from '@muziris/platform';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from './changes.js';
import { assignments } from './db/schema.js';
import { PricingError, isUniqueViolation, violatedConstraint } from './errors.js';
import { pageQuerySchema, toPage } from './page.js';
import { findPriceList } from './price-lists.js';

/** Who a price list is assigned to on a website, most specific first. */
export const ASSIGNMENT_TARGETS = ['customer', 'customer_group', 'website'] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

export const MAX_PRIORITY = 1000;

export interface Assignment {
  id: string;
  priceListId: string;
  websiteId: string;
  target: AssignmentTarget;
  /** The customer, customer group or website id; for a website target, the website id. */
  targetId: string;
  /** Position among the target's price lists on the website; lowest first. */
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentPage {
  assignments: Assignment[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

const idSchema = z.uuid();
const prioritySchema = z.int().min(1).max(MAX_PRIORITY);

export const newAssignmentSchema = z
  .object({
    priceListId: z.uuid(),
    websiteId: z.uuid(),
    target: z.enum(ASSIGNMENT_TARGETS),
    /** Leave out for a website target; it is the website id. */
    targetId: z.uuid().optional(),
    /** Leave out to put the price list after the target's others. */
    priority: prioritySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.target === 'website') {
      if (value.targetId !== undefined && value.targetId !== value.websiteId) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetId'],
          message: 'A website assignment targets its own website',
        });
      }
    } else if (value.targetId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Name the customer or group' });
    }
  })
  .transform((value) => ({ ...value, targetId: value.targetId ?? value.websiteId }));

export type NewAssignment = z.input<typeof newAssignmentSchema>;

export const assignmentChangesSchema = z.object({ priority: prioritySchema }).strict();

export type AssignmentChanges = z.input<typeof assignmentChangesSchema>;

export const listAssignmentsQuerySchema = pageQuerySchema.extend({
  priceListId: z.uuid().optional(),
  websiteId: z.uuid().optional(),
  target: z.enum(ASSIGNMENT_TARGETS).optional(),
  targetId: z.uuid().optional(),
});

export type ListAssignmentsQuery = z.input<typeof listAssignmentsQuerySchema>;

/** Customer first, then customer group, then website: the order of the fallback chain. */
export function targetRank(target: SQL | typeof assignments.target): SQL {
  return sql`case ${target} when 'customer' then 1 when 'customer_group' then 2 else 3 end`;
}

function isAssignmentTarget(value: string): value is AssignmentTarget {
  return (ASSIGNMENT_TARGETS as readonly string[]).includes(value);
}

function toAssignment(row: typeof assignments.$inferSelect): Assignment {
  if (!isAssignmentTarget(row.target)) {
    throw new Error(`Assignment ${row.id} has an unknown target`);
  }
  return {
    id: row.id,
    priceListId: row.priceListId,
    websiteId: row.websiteId,
    target: row.target,
    targetId: row.targetId,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function refusedWrite(error: unknown): PricingError | undefined {
  if (!isUniqueViolation(error)) return undefined;
  return violatedConstraint(error) === 'pricing_assignment_priority_uq'
    ? new PricingError(
        'assignment_priority_taken',
        'Another price list has this priority for this target on this website',
      )
    : new PricingError(
        'assignment_taken',
        'The price list is already assigned to this target on this website',
      );
}

/**
 * Assigns a price list on a website to a customer, a customer group or the website. The
 * website, the target and the price list must exist, and the price list's currency must be the
 * website's currency, or the price list could never price anything there.
 */
export async function createAssignment(db: Database, input: NewAssignment): Promise<Assignment> {
  const values = newAssignmentSchema.parse(input);
  const [website, list] = await Promise.all([
    findWebsite(db, values.websiteId),
    findPriceList(db, values.priceListId),
  ]);
  if (!website) throw new PricingError('website_not_found', 'No such website');
  if (!list) throw new PricingError('price_list_not_found', 'No such price list');
  if (list.currency !== website.defaultCurrency) {
    throw new PricingError(
      'currency_mismatch',
      `The price list is in ${list.currency} and the website prices in ${website.defaultCurrency}`,
    );
  }
  if (values.target === 'customer' && !(await findCustomer(db, values.targetId))) {
    throw new PricingError('customer_not_found', 'No such customer');
  }
  if (values.target === 'customer_group' && !(await findCustomerGroup(db, values.targetId))) {
    throw new PricingError('customer_group_not_found', 'No such customer group');
  }
  const sameTarget = and(
    eq(assignments.websiteId, values.websiteId),
    eq(assignments.target, values.target),
    eq(assignments.targetId, values.targetId),
  );
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(assignments)
        .values({
          priceListId: values.priceListId,
          websiteId: values.websiteId,
          target: values.target,
          targetId: values.targetId,
          priority:
            values.priority ??
            sql`(select coalesce(max(${assignments.priority}), 0) + 1 from ${assignments} where ${sameTarget})`,
        })
        .returning();
      if (!row) throw new Error('Assignment insert returned no row');
      await recordChange(tx);
      return toAssignment(row);
    });
  } catch (error) {
    throw refusedWrite(error) ?? error;
  }
}

/** Moves a price list to another place among its target's price lists. */
export async function updateAssignment(
  db: Database,
  assignmentId: string,
  changes: AssignmentChanges,
): Promise<Assignment> {
  const id = idSchema.parse(assignmentId);
  const values = assignmentChangesSchema.parse(changes);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(assignments)
        .set({ priority: values.priority, updatedAt: sql`now()` })
        .where(eq(assignments.id, id))
        .returning();
      if (!row) throw new PricingError('assignment_not_found', 'No such assignment');
      await recordChange(tx);
      return toAssignment(row);
    });
  } catch (error) {
    throw refusedWrite(error) ?? error;
  }
}

export async function deleteAssignment(db: Database, assignmentId: string): Promise<void> {
  const id = idSchema.parse(assignmentId);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(assignments)
      .where(eq(assignments.id, id))
      .returning({ id: assignments.id });
    if (deleted.length === 0) throw new PricingError('assignment_not_found', 'No such assignment');
    await recordChange(tx);
  });
}

/**
 * Assignments a page at a time, in fallback chain order: by website, then customer, customer
 * group and website targets, then target, then priority.
 */
export async function listAssignments(
  db: Database,
  query: ListAssignmentsQuery = {},
): Promise<AssignmentPage> {
  const q = listAssignmentsQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.priceListId !== undefined) conditions.push(eq(assignments.priceListId, q.priceListId));
  if (q.websiteId !== undefined) conditions.push(eq(assignments.websiteId, q.websiteId));
  if (q.target !== undefined) conditions.push(eq(assignments.target, q.target));
  if (q.targetId !== undefined) conditions.push(eq(assignments.targetId, q.targetId));
  const key = sql`(${assignments.websiteId}, ${targetRank(assignments.target)}, ${assignments.targetId}, ${assignments.priority}, ${assignments.id})`;
  if (q.after !== undefined) {
    conditions.push(
      sql`${key} > (select website_id, ${targetRank(sql`target`)}, target_id, priority, id
        from ${assignments} where id = ${q.after})`,
    );
  }
  const rows = await db
    .select()
    .from(assignments)
    .where(and(...conditions))
    .orderBy(
      assignments.websiteId,
      targetRank(assignments.target),
      assignments.targetId,
      assignments.priority,
      assignments.id,
    )
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.id);
  return { assignments: items.map(toAssignment), nextAfter };
}
