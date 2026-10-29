import { PRODUCT_STATUSES, productCategoryAndStatus, type ProductStatus } from '@muziris/catalog';
import type { Database } from '@muziris/db';
import {
  visibleCategoryIdsForBuyer,
  visibleProductIdsForBuyer,
  type BuyerOnWebsite,
} from '@muziris/visibility';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { products } from './db/schema.js';
import {
  adminSearchQuerySchema,
  escapeLike,
  parseQuery,
  searchQuerySchema,
  type AdminSearchQuery,
  type ParsedQuery,
  type SearchQuery,
} from './query.js';

// The search statement of ADR 0013. Buyer and admin searches share one statement builder, which
// is not exported: a buyer search always has the visibility select in its `where` clause, and
// the only way to search without it is the admin function.

/** How a product matched, best first. Results are ordered by this, then by score. */
export const MATCHES = ['sku_exact', 'sku_prefix', 'text', 'close'] as const;
export type Match = (typeof MATCHES)[number];

/** The lowest trigram word similarity that counts as a close match. */
export const CLOSE_MATCH_THRESHOLD = 0.5;

/** ts_rank weights for D, C, B and A: attribute, category, name, SKU. */
const RANK_WEIGHTS = '{0.1, 0.3, 0.6, 1.0}';

export interface SearchHit {
  productId: string;
  sku: string;
  name: string;
  /** For a buyer, null unless the buyer may see the category. */
  categoryId: string | null;
  match: Match;
}

export interface AdminSearchHit extends SearchHit {
  /** The product's status in catalog now. */
  status: ProductStatus;
}

export interface SearchPage<T> {
  results: T[];
  /** Pass as `offset` to fetch the next page; null on the last page reachable. */
  nextOffset: number | null;
}

/**
 * The tsquery for the words: every word must match, each spelled either way and read through
 * `simple` or `english`; the last word also as a prefix, for typing. Words hold letters and
 * digits only (query.ts), so `to_tsquery` sees no operators from them.
 */
function wordsQuery(words: readonly string[][]): SQL {
  const last = words.length - 1;
  return sql.join(
    words.map((spellings, index) => {
      const each = spellings.map((word) =>
        index === last
          ? sql`to_tsquery('simple', ${word} || ':*') || plainto_tsquery('english', ${word})`
          : sql`plainto_tsquery('simple', ${word}) || plainto_tsquery('english', ${word})`,
      );
      return sql`(${sql.join(each, sql` || `)})`;
    }),
    sql` && `,
  );
}

interface Scope {
  /** Restricts the products searched, inside the statement. */
  where: SQL;
  /** Joins the caller's scope needs. */
  join: SQL;
  /** The category id returned, from `s.category_id`. */
  category: SQL;
  /** The status returned, or null. */
  status: SQL;
}

/**
 * One statement: match in any tier, place each product in its best tier, score it there, and
 * read one page. `scope` is part of the `where` clause, so products outside it are never
 * matched, ranked or returned.
 */
function searchStatement(
  parsed: ParsedQuery,
  page: { limit: number; offset: number },
  scope: Scope,
) {
  const text = parsed.text;
  const sku = sql`lower(s.sku)`;
  const name = sql`lower(s.name)`;
  const hasWords = parsed.words.length > 0;
  const wordText = parsed.words.map((spellings) => spellings[0] ?? '').join(' ');

  const exact = sql`${sku} = ${text}`;
  const prefix =
    text.length >= 2 ? sql`${sku} like ${`${escapeLike(text)}%`} escape '\\'` : sql`false`;
  const textMatch = hasWords ? sql`s.document @@ q.tsq` : sql`false`;
  const contains =
    text.length >= 3 ? sql`${sku} like ${`%${escapeLike(text)}%`} escape '\\'` : sql`false`;
  const skuCloseness = sql`word_similarity(${text}, ${sku})`;
  const nameCloseness = hasWords ? sql`word_similarity(${wordText}, ${name})` : sql`0::real`;
  const close = sql`(${contains} or ${skuCloseness} >= ${CLOSE_MATCH_THRESHOLD}::real
    or ${nameCloseness} >= ${CLOSE_MATCH_THRESHOLD}::real)`;

  return sql`
    with q as (select ${hasWords ? wordsQuery(parsed.words) : sql`null::tsquery`} as tsq),
    matched as (
      select s.product_id, s.sku, s.name, ${scope.category} as category_id,
        ${scope.status} as status,
        case when ${exact} then 1 when ${prefix} then 2 when ${textMatch} then 3 else 4 end
          as tier,
        case
          when ${exact} or ${prefix} or ${contains} then 1.0
          when ${textMatch} then ts_rank(${RANK_WEIGHTS}::float4[], s.document, q.tsq)
          else greatest(${skuCloseness}, ${nameCloseness})
        end as score
      from ${products} s
      cross join q
      ${scope.join}
      where (${exact} or ${prefix} or ${textMatch} or ${close})
        and ${scope.where}
    )
    select product_id, sku, name, category_id, tier, status
    from matched
    order by tier, score desc, lower(sku), product_id
    limit ${page.limit + 1} offset ${page.offset}`;
}

const rowSchema = z.object({
  product_id: z.string(),
  sku: z.string(),
  name: z.string(),
  category_id: z.string().nullable(),
  tier: z.coerce.number().int().min(1).max(MATCHES.length),
  status: z.enum(PRODUCT_STATUSES).nullable(),
});

type Row = z.output<typeof rowSchema>;

function hit(row: Row): SearchHit {
  const match = MATCHES[row.tier - 1];
  if (match === undefined) throw new Error(`Search returned tier ${row.tier}`);
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    categoryId: row.category_id,
    match,
  };
}

async function run(
  db: Database,
  statement: SQL,
  page: { limit: number; offset: number },
): Promise<{ rows: Row[]; nextOffset: number | null }> {
  const raw = await db.execute(statement);
  const rows = raw.map((r) => rowSchema.parse(r));
  const more = rows.length > page.limit;
  return {
    rows: rows.slice(0, page.limit),
    nextOffset: more ? page.offset + page.limit : null,
  };
}

/**
 * Searches the products a signed-in buyer may see on a website. The visibility select is in the
 * statement's `where` clause, so a product hidden from the buyer is never selected, whatever the
 * query; before visibility's first build, or for a user who is not a buyer user, nothing is.
 * A category id is returned only if the buyer may see that category.
 */
export async function searchProductsForBuyer(
  db: Database,
  buyer: BuyerOnWebsite,
  query: SearchQuery,
): Promise<SearchPage<SearchHit>> {
  const q = searchQuerySchema.parse(query);
  const page = { limit: q.limit, offset: q.offset };
  const scope: Scope = {
    where: sql`s.product_id in (${visibleProductIdsForBuyer(buyer)})`,
    join: sql``,
    category: sql`case when s.category_id in (${visibleCategoryIdsForBuyer(buyer)})
      then s.category_id end`,
    status: sql`null::text`,
  };
  const { rows, nextOffset } = await run(db, searchStatement(parseQuery(q.q), page, scope), page);
  return { results: rows.map(hit), nextOffset };
}

/**
 * Searches every product, for the admin. Not scoped to a buyer: the caller has checked the
 * admin holds `product.view`. The status is read from catalog now, and can be filtered on.
 */
export async function searchProducts(
  db: Database,
  query: AdminSearchQuery,
): Promise<SearchPage<AdminSearchHit>> {
  const q = adminSearchQuerySchema.parse(query);
  const page = { limit: q.limit, offset: q.offset };
  const scope: Scope = {
    where: q.status === undefined ? sql`true` : sql`c.status = ${q.status}`,
    join: sql`join (${productCategoryAndStatus()}) c on c.product_id = s.product_id`,
    category: sql`s.category_id`,
    status: sql`c.status`,
  };
  const { rows, nextOffset } = await run(db, searchStatement(parseQuery(q.q), page, scope), page);
  return {
    results: rows.map((row) => {
      if (row.status === null) throw new Error(`Product ${row.product_id} has no status`);
      return { ...hit(row), status: row.status };
    }),
    nextOffset,
  };
}
