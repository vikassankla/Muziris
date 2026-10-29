import { customerGroupMembership } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  assignments,
  buildState,
  combinedPriceListTargets,
  combinedPriceLists,
  combinedPrices,
  priceLists,
  prices,
} from './db/schema.js';
import { targetRank } from './assignments.js';

// The combined price build of ADR 0011. Every statement here is set-based: one `insert ...
// select` per table, whatever the number of customers, price lists or prices. Nothing loops
// over rows in JavaScript.

/** How long the build's statements may run, for its transaction only. */
const BUILD_STATEMENT_TIMEOUT = '600s';

export interface BuildResult {
  builtAt: Date;
  combinedPriceListCount: number;
  combinedPriceCount: number;
  /** Wall-clock time the build took, for the admin and the logs. */
  buildMs: number;
}

export interface BuildState {
  /** Changes to price lists, prices or assignments that no build has seen yet. */
  pendingChanges: number;
  lastBuild: (BuildResult & { builtBy: string | null }) | null;
}

/**
 * Every chain to build: one per website (its own price lists), one per customer group with
 * assignments on a website (the group's, then the website's), and one per customer with
 * assignments on a website (the customer's, then its group's, then the website's). A customer's
 * group comes from customers' public SQL, never from its tables.
 */
function chainContexts() {
  const ranked = sql`select price_list_id, website_id, target, target_id, priority,
      ${targetRank(sql`target`)} as rank
    from ${assignments}`;
  return sql`
    with a as (${ranked}),
    membership as (${customerGroupMembership()}),
    groups as (select distinct website_id, target_id from a where target = 'customer_group'),
    customers as (
      select distinct a.website_id, a.target_id, m.group_id
      from a left join membership m on m.customer_id = a.target_id
      where a.target = 'customer'
    )
    select website_id, 'website' as target, website_id as target_id,
      null::uuid as customer_group_id,
      array_agg(price_list_id order by priority) as chain
    from a where target = 'website'
    group by website_id
    union all
    select g.website_id, 'customer_group', g.target_id, null::uuid,
      array_agg(x.price_list_id order by x.rank, x.priority)
    from groups g
    join a x on x.website_id = g.website_id
      and ((x.target = 'customer_group' and x.target_id = g.target_id) or x.target = 'website')
    group by g.website_id, g.target_id
    union all
    select c.website_id, 'customer', c.target_id, c.group_id,
      array_agg(x.price_list_id order by x.rank, x.priority)
    from customers c
    join a x on x.website_id = c.website_id
      and ((x.target = 'customer' and x.target_id = c.target_id)
        or (x.target = 'customer_group' and x.target_id = c.group_id)
        or x.target = 'website')
    group by c.website_id, c.target_id, c.group_id`;
}

/**
 * Works out every combined price list's prices. Time is split at every active date of the
 * chain's price lists; within each interval the set of active price lists is fixed. Every tier
 * of an active price list is a breakpoint, and at each breakpoint the first price list in the
 * chain with a tier at or below it wins, with its largest such tier.
 */
const insertCombinedPrices = sql`
  with members as (
    select c.id as cpl_id, m.position, m.price_list_id, l.currency, l.active_from, l.active_until
    from ${combinedPriceLists} c
    cross join lateral unnest(c.price_list_ids) with ordinality as m(price_list_id, position)
    join ${priceLists} l on l.id = m.price_list_id
  ),
  bounds as (
    select cpl_id, '-infinity'::timestamptz as starts from members
    union select cpl_id, active_from from members where active_from is not null
    union select cpl_id, active_until from members where active_until is not null
  ),
  intervals as (
    select cpl_id, starts, lead(starts) over (partition by cpl_id order by starts) as ends
    from bounds
  ),
  tiers as (
    select i.cpl_id, i.starts, i.ends, m.position, m.price_list_id, m.currency,
      p.product_id, p.unit_code, p.min_quantity, p.amount_minor
    from intervals i
    join members m on m.cpl_id = i.cpl_id
      and coalesce(m.active_from, '-infinity'::timestamptz) <= i.starts
      and (m.active_until is null or m.active_until > i.starts)
    join ${prices} p on p.price_list_id = m.price_list_id
  ),
  breakpoints as (
    select distinct cpl_id, starts, ends, currency, product_id, unit_code, min_quantity from tiers
  )
  insert into ${combinedPrices} (combined_price_list_id, product_id, unit_code, currency,
    min_quantity, tier_min_quantity, valid_from, valid_until, amount_minor, price_list_id)
  select distinct on (b.cpl_id, b.starts, b.currency, b.product_id, b.unit_code, b.min_quantity)
    b.cpl_id, b.product_id, b.unit_code, b.currency, b.min_quantity, t.min_quantity,
    nullif(b.starts, '-infinity'::timestamptz), b.ends, t.amount_minor, t.price_list_id
  from breakpoints b
  join tiers t on t.cpl_id = b.cpl_id and t.starts = b.starts and t.currency = b.currency
    and t.product_id = b.product_id and t.unit_code = b.unit_code
    and t.min_quantity <= b.min_quantity
  order by b.cpl_id, b.starts, b.currency, b.product_id, b.unit_code, b.min_quantity,
    t.position, t.min_quantity desc`;

const countRow = z.object({ count: z.coerce.number().int() });

/**
 * Rebuilds every combined price list from the price lists and assignments, in one transaction.
 * Builds run one at a time; price list writes wait while one runs. Lookups read the previous
 * build until this one commits.
 */
export async function rebuildCombinedPrices(
  db: Database,
  options: { builtBy?: string | null } = {},
): Promise<BuildResult> {
  const builtBy = options.builtBy === undefined ? null : z.uuid().nullable().parse(options.builtBy);
  const started = performance.now();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing_combined_price_build'))`);
    await tx.execute(sql.raw(`set local statement_timeout = '${BUILD_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql`insert into ${buildState} (id) values (1) on conflict (id) do nothing`);
    // Holding the state row makes writers that have not yet counted their change wait, so
    // every change is either in this build or counted after it.
    const [state] = await tx.execute<{ change_count: string }>(
      sql`select change_count::text from ${buildState} where id = 1 for update`,
    );
    if (!state) throw new Error('Pricing build state row is missing');

    await tx.execute(sql`delete from ${combinedPriceLists}`);
    const contexts = chainContexts();
    await tx.execute(
      sql`insert into ${combinedPriceLists} (price_list_ids)
          select distinct chain from (${contexts}) ctx`,
    );
    await tx.execute(
      sql`insert into ${combinedPriceListTargets}
            (website_id, target, target_id, customer_group_id, combined_price_list_id)
          select ctx.website_id, ctx.target, ctx.target_id, ctx.customer_group_id, c.id
          from (${contexts}) ctx
          join ${combinedPriceLists} c on c.price_list_ids = ctx.chain`,
    );
    await tx.execute(insertCombinedPrices);

    const [lists] = await tx.execute(sql`select count(*) from ${combinedPriceLists}`);
    const [rows] = await tx.execute(sql`select count(*) from ${combinedPrices}`);
    const combinedPriceListCount = countRow.parse(lists).count;
    const combinedPriceCount = countRow.parse(rows).count;
    const buildMs = Math.round(performance.now() - started);
    const [done] = await tx.execute<{ built_at: Date }>(
      sql`update ${buildState} set built_change_count = ${state.change_count}::bigint,
            built_at = now(), built_by = ${builtBy},
            combined_price_list_count = ${combinedPriceListCount},
            combined_price_count = ${combinedPriceCount}, build_ms = ${buildMs}
          where id = 1
          returning built_at`,
    );
    if (!done) throw new Error('Pricing build state row is missing');
    return {
      builtAt: new Date(done.built_at),
      combinedPriceListCount,
      combinedPriceCount,
      buildMs,
    };
  });
}

/** Whether changes are waiting for a build, and what the last build did. */
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
      combinedPriceListCount: row.combinedPriceListCount ?? 0,
      combinedPriceCount: row.combinedPriceCount ?? 0,
      buildMs: row.buildMs ?? 0,
    },
  };
}
