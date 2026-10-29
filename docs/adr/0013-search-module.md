# 0013: Product search lives in a search module, on PostgreSQL

- Status: proposed
- Date: 2026-10-29

## Context

Week 3 of the pilot plan needs product search; the GraphQL storefront API and storefront
browsing come next in the same week and will call it. ADR 0002 puts the default search index in
PostgreSQL (full-text, trigram and vector search), with OpenSearch as the planned adapter for
catalogs beyond about 250,000 products, and asks that search quality and speed be measured.

Catalog (ADR 0009) owns products (SKU unique regardless of letter case, name, status, at most
one category, JSONB attributes whose values are text, true or false, or lists of texts) and the
category tree. Visibility (ADR 0012) decides which products each buyer may see and exports
`visibleProductIdsForBuyer` and `visibleCategoryIdsForBuyer`, `SQL` selects to put in the query
that lists products. A module never reads another module's tables (ADR 0001). CLAUDE.md requires
every query that returns buyer data to be scoped in the query itself, and heavy rebuilds
(prices, visibility, search) to be set-based SQL, never row by row in a request. There is no job
runner yet, and the catalog module has no hook or event that other modules can subscribe to.
Websites in India and the United States sell to buyers who write Indian and US English
("aluminium" and "aluminum", "spanner" and "wrench"). Admin lists are paged (ADR 0010);
`product.view` and `product.manage` exist (ADR 0006).

## Decision

Search is a new module, `modules/search` (`@muziris/search`), owning the tables prefixed
`search_`. It depends on `@muziris/db` and the public interfaces of `@muziris/catalog` and
`@muziris/visibility`. It keeps its own index of products, built from catalog's public SQL, and
answers two kinds of search: an admin search over every product, and a buyer search scoped by
visibility inside the query.

### The index

- **`search_product`** has one row per product: its id, SKU, name and category id as they were
  when indexed, a weighted `tsvector` **document**, the catalog's `updated_at` it was built from,
  and when it was indexed. There is no foreign key into catalog tables.
- The document carries, by weight:
  - **A**, the SKU, whole and split at `-`, `.`, `_` and `/` (`BRG-6205-2RS` gives `brg`,
    `6205` and `2rs` as well);
  - **B**, the product name;
  - **C**, the names of the product's category and every category above it;
  - **D**, attribute values that are text or lists of texts (true and false say nothing alone).
- Indexes: GIN on the document; GIN with `gin_trgm_ops` on `lower(sku)` and `lower(name)` for
  typo tolerance and partial SKUs; a b-tree with `text_pattern_ops` on `lower(sku)` for SKU
  prefixes.
- **Text search configuration: both `english` and `simple`.** Names and category names are put
  in the document twice, once through `english` (stemmed, so "bearings" finds "bearing" and
  "gloves" finds "glove") and once through `simple` (unchanged words, so brand names, Indian
  English words and model numbers that the English stemmer would mangle still match exactly).
  SKUs and attribute values go through `simple` only, since stemming a part number or a grade
  ("EN8", "IS 2062") is wrong. Each query word is looked up both ways and either may match.
  `english` alone breaks exact brand and model words; `simple` alone misses plurals.
- **Indian and US spellings.** The query, not the index, is widened: each word that has a known
  pair in the other spelling (aluminium/aluminum, colour/color, grey/gray, tyre/tire,
  metre/meter, litre/liter, spanner/wrench, and a few more, kept in code) also matches its pair.
  A product named either way is found by either. The list is short and grows when buyers' words
  show the need.
- `pg_trgm` is created by the migration with `create extension if not exists`, which is safe on
  a database that already has data or already has the extension. `pg_trgm` is a trusted
  extension (PostgreSQL 13 and later), so the database owner can create it without superuser.

### Building the index

- **`rebuildSearchIndex`** is set-based SQL in one transaction, as the price and visibility
  builds are: a transaction-scoped advisory lock so builds run one at a time, a raised statement
  timeout for the transaction only, a delete of every row, and one `insert ... select` from
  catalog's `productSearchSource()` (product id, SKU, name, category id, attributes, updated at)
  and `categoryNames()` (category id, parent id, name), walking the tree with a recursive CTE
  and the `CYCLE` clause. Readers keep the previous index until it commits. It records the build
  in `search_build_state`.
- **`indexProducts(ids)`** and **`indexProductsInCategory(categoryId)`** run the same
  statement for some products only: a product and its category subtree's products. Catalog has
  no hook other modules can subscribe to, so the admin API calls them after each product create,
  edit and unit change, and after a category rename or move. A failure there is logged and does
  not fail the catalog request, which has already committed; the product then waits for the
  next build.
- **Freshness.** The build state counts products **waiting** for the index: products that are
  not indexed or whose catalog `updated_at` is later than the one indexed, worked out from
  catalog's SQL at read time. Category renames and moves do not change a product's `updated_at`,
  so they are not counted; the API reindexes the category's products at once, and a build
  catches anything missed.
- **How a build is triggered:** a synchronous admin action, `POST /admin/v1/search/build`
  (`product.manage`), and a CLI command, `pnpm --filter @muziris/api search:build`. When the job
  runner lands, catalog writes enqueue the incremental job and the admin action enqueues the
  full build; the functions and tables do not change.

### Matching and ranking

A query is 1 to 100 characters. In code it is normalized (Unicode NFKC, lower case), split into
words of letters and digits (at most 8; common English stop words dropped), and each word is
passed to SQL as a parameter. No query text is ever put into SQL by concatenation; `to_tsquery`
is given only words of letters and digits with a `:*` suffix, so its syntax cannot be injected.

Each product that matches falls in one **tier**, and results are ordered by tier, then score
within the tier, then SKU and id so the order is total:

1. **Exact SKU**: the SKU equals the query, ignoring letter case.
2. **SKU prefix**: the SKU starts with the query (two characters or more).
3. **Text**: every word matches the document (the last word also as a prefix, so "bear"
   finds "bearing" while typing). Score: `ts_rank` with weights 1.0, 0.6, 0.3 and 0.1 for A to
   D, so a SKU word outranks a name word, which outranks a category or attribute.
4. **Close match**: the SKU contains the query (three characters or more), or the words are
   close to the name or the SKU by trigram `word_similarity` at or above 0.5. This catches
   typos ("bearng") and partial SKUs ("6205-2"). Score: the similarity.

A product matching several tiers is placed in the best one. Results are read a page at a time
with `limit` (1 to 50, default 20) and `offset`, and no more than the first 1,000 results can be
reached. Ranked results have no stable key to page after, so the cursor style of ADR 0010 does
not fit; the bound keeps deep offsets cheap and stops the search being used to list the whole
catalog.

### Buyer scoping in the query

- **`searchProductsForBuyer(db, { buyerUserId, websiteId }, query)`** is what the storefront
  API (week 3 item 4) calls. The search statement has
  `product_id in (visibleProductIdsForBuyer(...))` in its `where` clause, so a product the buyer
  may not see is never selected, ranked, counted or returned, whatever the query, including a
  guessed exact SKU. Visibility derives the customer from the signed-in user inside that select,
  fails closed before its first build, and checks catalog's status live, so a disabled product
  disappears at once even before the index catches up.
- A buyer result carries the product id, SKU, name, the tier and the category id **only if the
  buyer may see the category** (`visibleCategoryIdsForBuyer`, in the same statement); otherwise
  the category id is null.
- **`searchProducts(db, query)`** is the admin search over every product, with the status read
  live from catalog's SQL and an optional status filter. It is a separate function, and its
  route is behind `requirePermission('product.view')`. The two share the statement builder,
  which is not exported; a buyer scope cannot be left out by passing an option.
- Search results carry no totals or counts, so nothing about hidden products can be inferred
  from them.

### Admin API

Under `/admin/v1/search`: `GET /products?q=...&limit=...&offset=...&status=...`
(`product.view`), `GET /build` (`product.view`) and `POST /build` (`product.manage`).

## Consequences

- Search is one statement against one module's tables plus visibility's semi-join; it never
  walks rules, price lists or the category tree at query time. One search over 10,000 products
  is measured by a test with a stated budget.
- Catalog gains two small public functions (`productSearchSource`, `categoryNames`). The API's
  catalog routes call search after writes; when catalog grows an event or the job runner lands,
  that call moves there.
- A buyer can find a product they may see through the name of a category above it that is
  hidden from them; the result does not show that category. Splitting category text per
  visibility context is later work if a client needs it.
- Results reflect the index, so a renamed product shows its old name until it is reindexed;
  whether a buyer may see it is always current.
- Words in the English stop word list are dropped from queries, so a search made only of them
  finds nothing in the text tier (SKU tiers still apply).
- Offset paging is capped at 1,000 results; a buyer who needs more narrows the query.
- Vector (semantic) search, synonyms beyond the spelling pairs, facets and attribute filters,
  per-website or localized names, and an OpenSearch adapter are not in this decision. Attribute
  filters need attribute definitions (ADR 0009).
