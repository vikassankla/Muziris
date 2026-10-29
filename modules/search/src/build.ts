import { categoryNames, categorySubtreeIds, productSearchSource } from '@muziris/catalog';
import type { Database } from '@muziris/db';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { buildState, products } from './db/schema.js';

// Building the search index of ADR 0013. Every statement is set-based: one `insert ... select`
// whatever the number of products. Nothing loops over rows in JavaScript. The full build and the
// partial ones share the statement and the lock, so they run one at a time.

/** How long the build's statements may run, for its transaction only. */
const BUILD_STATEMENT_TIMEOUT = '600s';

/** Takes the lock every write to the index holds until its transaction ends. */
const LOCK = sql`select pg_advisory_xact_lock(hashtext('search_build'))`;

/**
 * Letters and digits only, in lower case, with everything else a space. The default parser
 * reads "6205-2RS" as the number 6205 and "-2" and "rs"; splitting first gives "6205" and
 * "2rs", the words the query side makes too.
 */
function words(text: SQL): SQL {
  return sql`lower(regexp_replace(${text}, '[^[:alnum:]]+', ' ', 'g'))`;
}

/**
 * Indexes the products the source selects, replacing their rows. A product's document has its
 * SKU (A), name (B), the names of its category and every category above it (C) and its text
 * attribute values (D). Names go through `english` and `simple`, SKUs and attributes through
 * `simple` only. The walk up the tree stops at a cycle, which catalog refuses anyway.
 */
function upsertFrom(source: SQL): SQL {
  return sql`
    with recursive cats as (${categoryNames()}),
    up (category_id, ancestor_id, depth) as (
      select category_id, category_id, 0 from cats
      union all
      select up.category_id, c.parent_id, up.depth + 1
      from up join cats c on c.category_id = up.ancestor_id
      where c.parent_id is not null
    ) cycle ancestor_id set is_cycle using path,
    path_names as (
      select up.category_id, string_agg(c.name, ' ' order by up.depth) as names
      from up join cats c on c.category_id = up.ancestor_id
      where not up.is_cycle
      group by up.category_id
    ),
    source as (${source})
    insert into ${products}
      (product_id, sku, name, category_id, document, source_updated_at, indexed_at)
    select s.product_id, s.sku, s.name, s.category_id,
      setweight(to_tsvector('simple', ${words(sql`s.sku`)}), 'A')
        || setweight(to_tsvector('english', ${words(sql`s.name`)}), 'B')
        || setweight(to_tsvector('simple', ${words(sql`s.name`)}), 'B')
        || setweight(to_tsvector('english', ${words(sql`coalesce(n.names, '')`)}), 'C')
        || setweight(to_tsvector('simple', ${words(sql`coalesce(n.names, '')`)}), 'C')
        || setweight(to_tsvector('simple', ${words(sql`coalesce(a.text, '')`)}), 'D'),
      s.updated_at, now()
    from source s
    left join path_names n on n.category_id = s.category_id
    left join lateral (
      select string_agg(v.value, ' ') as text
      from jsonb_each(s.attributes) e
      cross join lateral (
        select e.value #>> '{}' as value where jsonb_typeof(e.value) = 'string'
        union all
        select t from jsonb_array_elements_text(
          case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) t
      ) v
    ) a on true
    on conflict (product_id) do update set
      sku = excluded.sku, name = excluded.name, category_id = excluded.category_id,
      document = excluded.document, source_updated_at = excluded.source_updated_at,
      indexed_at = excluded.indexed_at`;
}

const everyProduct = sql`select * from (${productSearchSource()}) p`;

export interface BuildResult {
  builtAt: Date;
  productCount: number;
  /** Wall-clock time the build took, for the admin and the logs. */
  buildMs: number;
}

export interface BuildState {
  /**
   * Products that are not indexed, or changed in catalog after they were indexed. Category
   * renames and moves are not counted (ADR 0013).
   */
  waitingProducts: number;
  lastBuild: (BuildResult & { builtBy: string | null }) | null;
}

const countRow = z.object({ count: z.coerce.number().int() });

/**
 * Rebuilds the whole index from the catalog, in one transaction. Searches keep reading the
 * previous index until it commits.
 */
export async function rebuildSearchIndex(
  db: Database,
  options: { builtBy?: string | null } = {},
): Promise<BuildResult> {
  const builtBy = options.builtBy === undefined ? null : z.uuid().nullable().parse(options.builtBy);
  const started = performance.now();
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    await tx.execute(sql.raw(`set local statement_timeout = '${BUILD_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql`delete from ${products}`);
    await tx.execute(upsertFrom(everyProduct));
    const [counted] = await tx.execute(sql`select count(*) from ${products}`);
    const productCount = countRow.parse(counted).count;
    const buildMs = Math.round(performance.now() - started);
    const [done] = await tx.execute<{ built_at: Date }>(
      sql`insert into ${buildState} (id, built_at, built_by, product_count, build_ms)
          values (1, now(), ${builtBy}, ${productCount}, ${buildMs})
          on conflict (id) do update set built_at = excluded.built_at,
            built_by = excluded.built_by, product_count = excluded.product_count,
            build_ms = excluded.build_ms
          returning built_at`,
    );
    if (!done) throw new Error('Search build state row is missing');
    return { builtAt: new Date(done.built_at), productCount, buildMs };
  });
}

/**
 * Reindexes some products after they changed in catalog: their rows are rewritten, and rows of
 * ids catalog no longer has are removed. Unknown ids are ignored.
 */
export async function indexProducts(db: Database, productIds: readonly string[]): Promise<void> {
  const ids = z.array(z.uuid()).max(1000).parse(productIds);
  if (ids.length === 0) return;
  const list = sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  await db.transaction(async (tx) => {
    await tx.execute(LOCK);
    await tx.execute(
      sql`delete from ${products} where product_id in ${list}
          and product_id not in (select product_id from (${productSearchSource()}) p)`,
    );
    await tx.execute(upsertFrom(sql`${everyProduct} where p.product_id in ${list}`));
  });
}

/**
 * Reindexes every product in a category and the categories below it, after the category was
 * renamed or moved, since the names of a product's categories are in its document.
 */
export async function indexProductsInCategory(db: Database, categoryId: string): Promise<void> {
  const subtree = categorySubtreeIds(z.uuid().parse(categoryId));
  await db.transaction(async (tx) => {
    await tx.execute(LOCK);
    await tx.execute(upsertFrom(sql`${everyProduct} where p.category_id in (${subtree})`));
  });
}

/** How many products are waiting for the index, and what the last full build did. */
export async function getBuildState(db: Database): Promise<BuildState> {
  const [waiting] = await db.execute(
    sql`select count(*) from (${productSearchSource()}) p
        left join ${products} s on s.product_id = p.product_id
        where s.product_id is null or s.source_updated_at < p.updated_at`,
  );
  const waitingProducts = countRow.parse(waiting).count;
  const [row] = await db.select().from(buildState).limit(1);
  if (!row?.builtAt) return { waitingProducts, lastBuild: null };
  return {
    waitingProducts,
    lastBuild: {
      builtAt: row.builtAt,
      builtBy: row.builtBy,
      productCount: row.productCount ?? 0,
      buildMs: row.buildMs ?? 0,
    },
  };
}
