import { categoryParents, findCategory, findProduct } from '@muziris/catalog';
import { findCustomer } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findWebsite } from '@muziris/platform';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getBuildState } from './build.js';
import { contexts, rules } from './db/schema.js';
import { VisibilityError } from './errors.js';
import {
  servingContextTarget,
  visibleCategoryIds,
  visibleProductIds,
  type CustomerOnWebsite,
} from './read.js';
import {
  resolveCategoryVisibility,
  resolveProductVisibility,
  type RuleSubject,
  type VisibilityDecision,
  type VisibilityReason,
} from './resolve.js';
import { toRule, type Rule } from './rules.js';

// The admin preview: why a customer can or cannot see one product or category on a website.
// The decision is worked out from the rules as they are now, with the same fallback rule the
// build uses (resolve.ts), next to the answer the last build gives buyers.

export const visibilityPreviewQuerySchema = z
  .object({
    websiteId: z.uuid(),
    customerId: z.uuid(),
    productId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
  })
  .refine((q) => (q.productId === undefined) !== (q.categoryId === undefined), {
    message: 'Name either a product or a category',
    path: ['productId'],
  });

export type VisibilityPreviewQuery = z.input<typeof visibilityPreviewQuerySchema>;

/** Which kind of context the last build serves the customer from. */
export type ServingContext = 'customer' | 'customer_group' | 'website' | 'default';

export interface VisibilityPreview {
  subject: RuleSubject;
  subjectId: string;
  /** The subject's category and every category above it, nearest first. */
  categoryPath: string[];
  /** The decision from the rules as they are now. */
  visible: boolean;
  reason: VisibilityReason;
  /** The rule that decided, when `reason` is `rule`. */
  rule: Rule | null;
  /** For a category rule, how far above the subject's own category it sits (0 = own). */
  categoryDistance: number | null;
  /** What buyers of the customer get now, from the last build. */
  built: {
    visible: boolean;
    /** Null when nothing serves the customer: no build yet, or `needsRebuild`. */
    context: ServingContext | null;
    /** The customer has its own rules but changed customer group since the last build. */
    needsRebuild: boolean;
  };
  pendingChanges: number;
}

/** The category and every category above it, nearest first, in one recursive query. */
async function categoryPath(db: Database, categoryId: string | null): Promise<string[]> {
  if (categoryId === null) return [];
  const rows = await db.execute<{ category_id: string }>(
    sql`with recursive parents as (${categoryParents()}),
      up (category_id, depth) as (
        select category_id, 0 from parents where category_id = ${categoryId}
        union all
        select p.parent_id, up.depth + 1
        from up join parents p on p.category_id = up.category_id
        where p.parent_id is not null
      ) cycle category_id set is_cycle using path
      select category_id from up where not is_cycle order by depth`,
  );
  return rows.map((r) => r.category_id);
}

/** The rules on the website for the customer, its group and the website, about these subjects. */
async function applicableRules(
  db: Database,
  who: { websiteId: string; customerId: string; groupId: string | null },
  subjects: { productId: string | null; categoryIds: string[] },
): Promise<Rule[]> {
  const levels: SQL[] = [
    and(eq(rules.target, 'customer'), eq(rules.targetId, who.customerId)) ?? sql`false`,
    eq(rules.target, 'website'),
  ];
  if (who.groupId !== null) {
    levels.push(
      and(eq(rules.target, 'customer_group'), eq(rules.targetId, who.groupId)) ?? sql`false`,
    );
  }
  const about: SQL[] = [];
  if (subjects.productId !== null) {
    about.push(
      and(eq(rules.subject, 'product'), eq(rules.subjectId, subjects.productId)) ?? sql`false`,
    );
  }
  if (subjects.categoryIds.length > 0) {
    about.push(
      and(eq(rules.subject, 'category'), inArray(rules.subjectId, subjects.categoryIds)) ??
        sql`false`,
    );
  }
  if (about.length === 0) return [];
  const rows = await db
    .select()
    .from(rules)
    .where(and(eq(rules.websiteId, who.websiteId), or(...levels), or(...about)));
  return rows.map(toRule);
}

const builtRow = z.object({
  context: z.enum(['customer', 'customer_group', 'website', 'default']).nullable(),
  needs_rebuild: z.boolean(),
  visible: z.boolean(),
});

/** Explains whether a customer can see a product or a category on a website. */
export async function previewVisibility(
  db: Database,
  query: VisibilityPreviewQuery,
): Promise<VisibilityPreview> {
  const q = visibilityPreviewQuerySchema.parse(query);
  const [website, customer] = await Promise.all([
    findWebsite(db, q.websiteId),
    findCustomer(db, q.customerId),
  ]);
  if (!website) throw new VisibilityError('website_not_found', 'No such website');
  if (!customer) throw new VisibilityError('customer_not_found', 'No such customer');
  const who = { websiteId: q.websiteId, customerId: q.customerId, groupId: customer.groupId };
  const scope: CustomerOnWebsite = { websiteId: q.websiteId, customerId: q.customerId };

  let subject: RuleSubject;
  let subjectId: string;
  let path: string[];
  let decision: VisibilityDecision<Rule>;
  let builtIds: SQL;
  if (q.productId !== undefined) {
    const product = await findProduct(db, q.productId);
    if (!product) throw new VisibilityError('product_not_found', 'No such product');
    subject = 'product';
    subjectId = product.id;
    path = await categoryPath(db, product.categoryId);
    const found = await applicableRules(db, who, { productId: product.id, categoryIds: path });
    decision = resolveProductVisibility({
      productId: product.id,
      enabled: product.status === 'enabled',
      categoryPath: path,
      rules: found,
    });
    builtIds = sql`select 1 from (${visibleProductIds(scope)}) v where v.product_id = ${product.id}`;
  } else {
    const category = await findCategory(db, q.categoryId ?? '');
    if (!category) throw new VisibilityError('category_not_found', 'No such category');
    subject = 'category';
    subjectId = category.id;
    path = await categoryPath(db, category.id);
    const found = await applicableRules(db, who, { productId: null, categoryIds: path });
    decision = resolveCategoryVisibility({ categoryPath: path, rules: found });
    builtIds = sql`select 1 from (${visibleCategoryIds(scope)}) v where v.category_id = ${category.id}`;
  }

  const [raw] = await db.execute(sql`select
      (${servingContextTarget(scope)}) as context,
      exists (select 1 from ${contexts}
        where website_id = ${q.websiteId} and target = 'customer' and target_id = ${q.customerId}
          and customer_group_id is distinct from ${customer.groupId}::uuid) as needs_rebuild,
      exists (${builtIds}) as visible`);
  const built = builtRow.parse(raw);
  const { pendingChanges } = await getBuildState(db);
  return {
    subject,
    subjectId,
    categoryPath: path,
    visible: decision.visible,
    reason: decision.reason,
    rule: decision.rule,
    categoryDistance: decision.categoryDistance,
    built: {
      visible: built.visible,
      context: built.context,
      needsRebuild: built.needs_rebuild,
    },
    pendingChanges,
  };
}
