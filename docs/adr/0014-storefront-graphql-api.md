# 0014: The storefront API is GraphQL, served by the API app with graphql-js

- Status: proposed
- Date: 2026-10-30

## Context

Week 3 of the pilot plan needs the GraphQL storefront API, and storefront browsing (item 5)
will be its first client. The requirements spec asks for one GraphQL schema for every storefront
need (FR-SF-1), persisted queries only in production with ad hoc queries in development
(FR-SF-2), cost and depth limits checked before a query runs (FR-SF-3), database reads batched
per request so a list of 50 products costs a fixed handful of queries (FR-SF-4), prices and
visibility read only from precomputed tables scoped to the signed-in buyer (FR-SF-5), additive
schema changes (FR-SF-6), and typed client code generated from the schema (FR-SF-7). The admin
API stays REST.

Buyers already sign in at `/storefront/v1/auth` with a `__Host-` session cookie (ADR 0005).
Visibility (ADR 0012), pricing (ADR 0011) and search (ADR 0013) export buyer-scoped functions
that derive the customer from the signed-in user inside their SQL. Catalog (ADR 0009) has
admin-side reads only, and pricing looks up one price per call. Apps wire modules together and
hold no business rules. CLAUDE.md asks for few dependencies, each with a reason, and for every
query that returns buyer data to be scoped in the query itself. There is no buyer permission
for browsing the catalog: what a buyer may see is decided by visibility.

## Decision

The storefront API is one GraphQL endpoint, `/storefront/v1/graphql`, in `apps/api`, built with
**`graphql`** (graphql-js, the reference implementation) and nothing else. Every field resolves
through a module's buyer-scoped public function.

### Why graphql-js alone

`graphql` has no dependencies of its own and is what every other GraphQL server builds on. The
parts a server adds are small here and are written to the spec's own rules: the HTTP handling
(Hono already does it), persisted queries from a registry, a depth and cost rule, error masking,
and per-request batching. GraphQL Yoga, Apollo Server and DataLoader would bring their own
dependency trees, plugin systems and defaults (introspection on, automatic persisted query
registration on a miss) that we would have to turn off. The schema is written in code with
graphql-js types, so resolvers are type-checked without a code generator, and the schema is
printed to a committed `schema.graphql` that clients generate from.

### Transport

- **Signed-in buyers only.** The endpoint is behind `requireSession('buyer')`; a request without
  a buyer session gets the API's 401 problem. Guest browsing needs visibility for guests and is
  later work.
- **The website** is named by the `Muziris-Website` header, holding a website code. A missing or
  unknown code is refused before anything runs. Every catalog, price and search read is for that
  website.
- **POST** takes `application/json` with `query` or a persisted query hash, `variables` and
  `operationName`, behind the API's trusted-origin guard. **GET** is for persisted queries only
  and runs queries only, never mutations. Responses are buyer-specific, so they carry
  `Cache-Control: no-store`; CDN caching is for guest pages, which do not exist yet.
- **Persisted queries.** A request names a query by `extensions.persistedQuery.sha256Hash`, and
  the server looks the hash up in a registry: a JSON file of hash to document, named by
  `STOREFRONT_PERSISTED_QUERIES` and produced by the storefront's build. Every entry is hashed
  again at startup, and a mismatch stops the API. An unknown hash is refused; it is never
  registered on a miss. **Ad hoc queries** (`query` text) are accepted only when
  `STOREFRONT_ADHOC_QUERIES` is `allow`, which is the default outside production and refused in
  production.
- **Errors.** Problems with the request itself (no website, unknown persisted query, ad hoc text
  refused, a parse or validation failure, a limit exceeded) answer 400 with
  `{ errors: [{ message, extensions: { code } }] }`, as the GraphQL over HTTP spec describes. An
  operation that ran answers 200 with `data` and any `errors`. An error the caller may see
  carries a stable `extensions.code` (`BAD_USER_INPUT`, `NOT_FOUND`); any other error becomes
  `INTERNAL_ERROR` with a fixed message, and its details stay in the logs. Query text and
  variables are never logged.

### Limits, checked before execution

- **Document size:** at most 20,000 characters.
- **Depth:** at most 8 levels of fields, counted through fragments.
- **Cost:** every field costs 1. A list field taking `first` multiplies the cost of what is
  below it by `first` (or its default), so 50 products with prices cost about 50 times one
  product. The budget is 2,500. A query over a limit is refused with the limit and the
  measured value in `extensions`.
- **Introspection** is allowed only with ad hoc queries (development); clients use the
  committed `schema.graphql`.

### Batching

Each request has its own loaders, which collect the keys asked for in one tick and read them in
one query: products by id (with their units), categories by id, and prices for many products at
once. Fifty products with their units, categories and prices cost one query each for products,
categories and prices, whatever the page size. To make that possible:

- Catalog gains reads **within** a set of product ids given as an `SQL` select:
  `listProductsWithin`, `findProductsWithin` and `findProductBySkuWithin`, plus
  `listCategoriesWithin` for a set of category ids. They take the select as a required argument;
  the API passes visibility's `visibleProductIdsForBuyer` and `visibleCategoryIdsForBuyer`, so
  the scope is part of the catalog query, never a filter on its result.
- Pricing gains **`findPricesForBuyer`**, the buyer lookup of ADR 0011 for many products, product
  units and quantities in one statement, choosing the combined price list once.

### Schema (first version)

`viewer` (the buyer user and their customer), `website`, `categories` (the visible categories,
flat, with parent ids), `category(id)`, `product(id | sku)`, `products(categoryId,
includeSubcategories, first, after)` paged by SKU as in ADR 0010, and `search(query, first,
offset)` from ADR 0013. A product has its SKU, name, category (null if the buyer may not see
it), attributes, product units, and `price(unitCode, quantity)`: the price for that quantity
from the combined price list, as minor units, a decimal amount and a currency, or null when
there is none. Quantities are decimal strings read at the unit's precision. Shopping lists,
quick order, RFQs, checkout, orders and account management join the schema with their modules.

Changes are additive (FR-SF-6). A test compares the schema with the committed `schema.graphql`,
so every change shows in review; `pnpm --filter @muziris/api storefront:schema` rewrites it.

## Consequences

- Storefront browsing (week 3 item 5) has one endpoint, and can generate typed client code from
  `schema.graphql`. Its build must also produce the persisted query registry for production.
- One new dependency, `graphql`, with no dependencies of its own.
- The batching, limits and persisted query handling are our code to maintain; they are small
  and tested, and can be swapped for a library later without changing the schema.
- Catalog and pricing gain buyer-oriented reads. Pricing is changed, so this needs the second
  human review of CLAUDE.md rule 4, and the API now returns buyer data, which needs it too.
- Guests, rate limits per API client (FR-API-5), mutations and subscriptions are not in this
  decision. When mutations arrive, they run over POST only and keep the trusted-origin guard.
