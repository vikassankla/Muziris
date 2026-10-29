import { categoryParents, productCategoryAndStatus } from '@muziris/catalog';
import { customerGroupMembership } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildState, contexts, rules, visibleCategories, visibleProducts } from './db/schema.js';
import { targetRank } from './rules.js';

// The visibility build of ADR 0012. Every statement here is set-based: one `insert ... select`
// per table, whatever the number of customers, rules, categories or products. Nothing loops over
// rows in JavaScript.

/** How long the build's statements may run, for its transaction only. */
const BUILD_STATEMENT_TIMEOUT = '600s';

export interface BuildResult {
  builtAt: Date;
  contextCount: number;
  visibleProductCount: number;
  visibleCategoryCount: number;
  /** Wall-clock time the build took, for the admin and the logs. */
  buildMs: number;
}

export interface BuildState {
  /** Changes to rules that no build has seen yet. */
  pendingChanges: number;
  lastBuild: (BuildResult & { builtBy: string | null }) | null;
}

/**
 * Every set of rules that can apply to a buyer: the default (none), one per website with
 * website rules, one per customer group with rules on a website, and one per customer with
 * rules on a website, with the group it is in now. A customer's group comes from customers'
 * public SQL, never from its tables.
 */
const insertContexts = sql`
  with r as (select website_id, target, target_id from ${rules}),
  membership as (${customerGroupMembership()})
  insert into ${contexts} (website_id, target, target_id, customer_group_id)
  select null::uuid, 'default', null::uuid, null::uuid
  union all
  select distinct website_id, 'website', website_id, null::uuid from r where target = 'website'
  union all
  select distinct website_id, 'customer_group', target_id, target_id
  from r where target = 'customer_group'
  union all
  select distinct r.website_id, 'customer', r.target_id, m.group_id
  from r left join membership m on m.customer_id = r.target_id
  where r.target = 'customer'`;

/**
 * Shared CTEs: `parents` (catalog's category tree), `up` (every category with itself and each
 * category above it, at its distance), and `applicable` (each context's rules with their level:
 * 1 customer, 2 customer group, 3 website). The CYCLE clause stops the walk if a cycle ever got
 * into the tree; catalog refuses moves that would create one.
 */
const sharedCtes = sql`
  parents as (${categoryParents()}),
  up (category_id, ancestor_id, depth) as (
    select category_id, category_id, 0 from parents
    union all
    select up.category_id, p.parent_id, up.depth + 1
    from up join parents p on p.category_id = up.ancestor_id
    where p.parent_id is not null
  ) cycle ancestor_id set is_cycle using path,
  applicable as (
    select x.id as context_id, r.subject, r.subject_id, r.visibility,
      ${targetRank(sql`r.target`)} as level
    from ${contexts} x
    join ${rules} r on r.website_id = x.website_id
      and ((r.target = 'customer' and x.target = 'customer' and r.target_id = x.target_id)
        or (r.target = 'customer_group' and r.target_id = x.customer_group_id)
        or r.target = 'website')
  )`;

/**
 * A category's decision in a context: the first level with a rule on it or a category above it,
 * and within that level the nearest such category. Categories without one are visible.
 */
const insertVisibleCategories = sql`
  with recursive ${sharedCtes},
  decided as (
    select distinct on (a.context_id, up.category_id) a.context_id, up.category_id, a.visibility
    from applicable a
    join up on up.ancestor_id = a.subject_id and not up.is_cycle
    where a.subject = 'category'
    order by a.context_id, up.category_id, a.level, up.depth
  )
  insert into ${visibleCategories} (context_id, category_id)
  select x.id, p.category_id
  from ${contexts} x
  cross join parents p
  left join decided d on d.context_id = x.id and d.category_id = p.category_id
  where coalesce(d.visibility, 'visible') = 'visible'`;

/**
 * An enabled product's decision in a context: the first level with a rule on the product, its
 * category or a category above it; within the level the product's own rule first (distance 0),
 * then the nearest category (1 for its own). Products without one are visible. Disabled
 * products are never stored.
 */
const insertVisibleProducts = sql`
  with recursive ${sharedCtes},
  products as (
    select product_id, category_id from (${productCategoryAndStatus()}) p
    where status = 'enabled'
  ),
  candidates as (
    select a.context_id, p.product_id, a.visibility, a.level, 0 as distance
    from applicable a
    join products p on p.product_id = a.subject_id
    where a.subject = 'product'
    union all
    select a.context_id, p.product_id, a.visibility, a.level, 1 + up.depth
    from applicable a
    join up on up.ancestor_id = a.subject_id and not up.is_cycle
    join products p on p.category_id = up.category_id
    where a.subject = 'category'
  ),
  decided as (
    select distinct on (context_id, product_id) context_id, product_id, visibility
    from candidates
    order by context_id, product_id, level, distance
  )
  insert into ${visibleProducts} (context_id, product_id)
  select x.id, p.product_id
  from ${contexts} x
  cross join products p
  left join decided d on d.context_id = x.id and d.product_id = p.product_id
  where coalesce(d.visibility, 'visible') = 'visible'`;

const countRow = z.object({ count: z.coerce.number().int() });

/**
 * Rebuilds every context's visible products and categories from the rules and the catalog, in
 * one transaction. Builds run one at a time; rule writes wait while one runs. Readers see the
 * previous result until this one commits.
 */
export async function rebuildVisibility(
  db: Database,
  options: { builtBy?: string | null } = {},
): Promise<BuildResult> {
  const builtBy = options.builtBy === undefined ? null : z.uuid().nullable().parse(options.builtBy);
  const started = performance.now();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('visibility_build'))`);
    await tx.execute(sql.raw(`set local statement_timeout = '${BUILD_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql`insert into ${buildState} (id) values (1) on conflict (id) do nothing`);
    // Holding the state row makes writers that have not yet counted their change wait, so
    // every change is either in this build or counted after it.
    const [state] = await tx.execute<{ change_count: string }>(
      sql`select change_count::text from ${buildState} where id = 1 for update`,
    );
    if (!state) throw new Error('Visibility build state row is missing');

    await tx.execute(sql`delete from ${contexts}`);
    await tx.execute(insertContexts);
    await tx.execute(insertVisibleCategories);
    await tx.execute(insertVisibleProducts);

    const count = async (
      table: typeof contexts | typeof visibleProducts | typeof visibleCategories,
    ) => {
      const [row] = await tx.execute(sql`select count(*) from ${table}`);
      return countRow.parse(row).count;
    };
    const contextCount = await count(contexts);
    const visibleProductCount = await count(visibleProducts);
    const visibleCategoryCount = await count(visibleCategories);
    const buildMs = Math.round(performance.now() - started);
    const [done] = await tx.execute<{ built_at: Date }>(
      sql`update ${buildState} set built_change_count = ${state.change_count}::bigint,
            built_at = now(), built_by = ${builtBy}, context_count = ${contextCount},
            visible_product_count = ${visibleProductCount},
            visible_category_count = ${visibleCategoryCount}, build_ms = ${buildMs}
          where id = 1
          returning built_at`,
    );
    if (!done) throw new Error('Visibility build state row is missing');
    return {
      builtAt: new Date(done.built_at),
      contextCount,
      visibleProductCount,
      visibleCategoryCount,
      buildMs,
    };
  });
}

/** Whether rule changes are waiting for a build, and what the last build did. */
export async function getBuildState(db: Database): Promise<BuildState> {
  const [row] = await db.select().from(buildState).limit(1);
  if (!row) return { pendingChanges: 0, lastBuild: null };
  const pendingChanges = Number(row.changeCount - (row.builtChangeCount ?? 0n));
  if (row.builtAt === null) return { pendingChanges, lastBuild: null };
  return {
    pendingChanges,
    lastBuild: {
      builtAt: row.builtAt,
      builtBy: row.builtBy,
      contextCount: row.contextCount ?? 0,
      visibleProductCount: row.visibleProductCount ?? 0,
      visibleCategoryCount: row.visibleCategoryCount ?? 0,
      buildMs: row.buildMs ?? 0,
    },
  };
}
