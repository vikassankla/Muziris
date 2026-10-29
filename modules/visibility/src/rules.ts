import { findCategory, findProduct } from '@muziris/catalog';
import { findCustomer, findCustomerGroup } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findWebsite } from '@muziris/platform';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from './changes.js';
import { rules } from './db/schema.js';
import { isUniqueViolation, VisibilityError } from './errors.js';
import { pageQuerySchema, toPage } from './page.js';
import {
  RULE_SUBJECTS,
  RULE_TARGETS,
  VISIBILITIES,
  type RuleSubject,
  type RuleTarget,
  type Visibility,
} from './resolve.js';

// Admin-side functions. Rules are the organization's own data, so these are not scoped to a
// buyer; the admin API checks the admin's permission before calling them. Buyers see the effect
// of rules only through the build's result (read.ts).

export interface Rule {
  id: string;
  websiteId: string;
  subject: RuleSubject;
  /** The product or category id. */
  subjectId: string;
  target: RuleTarget;
  /** The customer, customer group or website id; for a website target, the website id. */
  targetId: string;
  visibility: Visibility;
  createdAt: Date;
  updatedAt: Date;
}

export interface RulePage {
  rules: Rule[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

const idSchema = z.uuid();

export const newRuleSchema = z
  .object({
    websiteId: z.uuid(),
    subject: z.enum(RULE_SUBJECTS),
    subjectId: z.uuid(),
    target: z.enum(RULE_TARGETS),
    /** Leave out for a website target; it is the website id. */
    targetId: z.uuid().optional(),
    visibility: z.enum(VISIBILITIES),
  })
  .superRefine((value, ctx) => {
    if (value.target === 'website') {
      if (value.targetId !== undefined && value.targetId !== value.websiteId) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetId'],
          message: 'A website rule targets its own website',
        });
      }
    } else if (value.targetId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Name the customer or group' });
    }
  })
  .transform((value) => ({ ...value, targetId: value.targetId ?? value.websiteId }));

export type NewRule = z.input<typeof newRuleSchema>;

export const ruleChangesSchema = z.object({ visibility: z.enum(VISIBILITIES) }).strict();

export type RuleChanges = z.input<typeof ruleChangesSchema>;

export const listRulesQuerySchema = pageQuerySchema.extend({
  websiteId: z.uuid().optional(),
  subject: z.enum(RULE_SUBJECTS).optional(),
  subjectId: z.uuid().optional(),
  target: z.enum(RULE_TARGETS).optional(),
  targetId: z.uuid().optional(),
});

export type ListRulesQuery = z.input<typeof listRulesQuerySchema>;

/** Customer first, then customer group, then website: the order the levels are tried in. */
export function targetRank(target: SQL | typeof rules.target): SQL {
  return sql`case ${target} when 'customer' then 1 when 'customer_group' then 2 else 3 end`;
}

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

export function toRule(row: typeof rules.$inferSelect): Rule {
  if (
    !isOneOf(RULE_SUBJECTS, row.subject) ||
    !isOneOf(RULE_TARGETS, row.target) ||
    !isOneOf(VISIBILITIES, row.visibility)
  ) {
    throw new Error(`Visibility rule ${row.id} has an unknown subject, target or visibility`);
  }
  return {
    id: row.id,
    websiteId: row.websiteId,
    subject: row.subject,
    subjectId: row.subjectId,
    target: row.target,
    targetId: row.targetId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Makes a product or category visible or hidden on a website for a customer, a customer group or
 * the website. The website, the subject and the target must exist. A subject has one rule per
 * target and website; to change it, update or delete that rule.
 */
export async function createRule(db: Database, input: NewRule): Promise<Rule> {
  const values = newRuleSchema.parse(input);
  if (!(await findWebsite(db, values.websiteId))) {
    throw new VisibilityError('website_not_found', 'No such website');
  }
  if (values.subject === 'product' && !(await findProduct(db, values.subjectId))) {
    throw new VisibilityError('product_not_found', 'No such product');
  }
  if (values.subject === 'category' && !(await findCategory(db, values.subjectId))) {
    throw new VisibilityError('category_not_found', 'No such category');
  }
  if (values.target === 'customer' && !(await findCustomer(db, values.targetId))) {
    throw new VisibilityError('customer_not_found', 'No such customer');
  }
  if (values.target === 'customer_group' && !(await findCustomerGroup(db, values.targetId))) {
    throw new VisibilityError('customer_group_not_found', 'No such customer group');
  }
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(rules).values(values).returning();
      if (!row) throw new Error('Visibility rule insert returned no row');
      await recordChange(tx);
      return toRule(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new VisibilityError(
        'rule_taken',
        'This product or category already has a rule for this target on this website',
      );
    }
    throw error;
  }
}

export async function findRule(db: Database, ruleId: string): Promise<Rule | undefined> {
  const [row] = await db
    .select()
    .from(rules)
    .where(eq(rules.id, idSchema.parse(ruleId)))
    .limit(1);
  return row === undefined ? undefined : toRule(row);
}

/** Turns a rule from visible to hidden or back. */
export async function updateRule(
  db: Database,
  ruleId: string,
  changes: RuleChanges,
): Promise<Rule> {
  const id = idSchema.parse(ruleId);
  const values = ruleChangesSchema.parse(changes);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rules)
      .set({ visibility: values.visibility, updatedAt: sql`now()` })
      .where(eq(rules.id, id))
      .returning();
    if (!row) throw new VisibilityError('rule_not_found', 'No such rule');
    await recordChange(tx);
    return toRule(row);
  });
}

export async function deleteRule(db: Database, ruleId: string): Promise<void> {
  const id = idSchema.parse(ruleId);
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id });
    if (deleted.length === 0) throw new VisibilityError('rule_not_found', 'No such rule');
    await recordChange(tx);
  });
}

/**
 * Rules a page at a time, in fallback order: by website, then customer, customer group and
 * website targets, then target, then subject.
 */
export async function listRules(db: Database, query: ListRulesQuery = {}): Promise<RulePage> {
  const q = listRulesQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.websiteId !== undefined) conditions.push(eq(rules.websiteId, q.websiteId));
  if (q.subject !== undefined) conditions.push(eq(rules.subject, q.subject));
  if (q.subjectId !== undefined) conditions.push(eq(rules.subjectId, q.subjectId));
  if (q.target !== undefined) conditions.push(eq(rules.target, q.target));
  if (q.targetId !== undefined) conditions.push(eq(rules.targetId, q.targetId));
  const key = sql`(${rules.websiteId}, ${targetRank(rules.target)}, ${rules.targetId}, ${rules.subject}, ${rules.subjectId}, ${rules.id})`;
  if (q.after !== undefined) {
    conditions.push(
      sql`${key} > (select website_id, ${targetRank(sql`target`)}, target_id, subject, subject_id,
        id from ${rules} where id = ${q.after})`,
    );
  }
  const rows = await db
    .select()
    .from(rules)
    .where(and(...conditions))
    .orderBy(
      rules.websiteId,
      targetRank(rules.target),
      rules.targetId,
      rules.subject,
      rules.subjectId,
      rules.id,
    )
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.id);
  return { rules: items.map(toRule), nextAfter };
}
