# 0015: The storefront is a React app that runs only persisted GraphQL operations

- Status: proposed
- Date: 2026-10-30

## Context

Week 3 item 5 is storefront browsing, and it carries the week's gate check: a buyer sees only
their own catalog and prices. The storefront GraphQL API (ADR 0014) exists for signed-in buyers,
with the website named by a `Muziris-Website` header. In production it runs persisted queries
only, from a registry the storefront's build must produce, and clients generate types from the
committed `apps/api/src/storefront/schema.graphql` (FR-SF-7).

The admin app (`apps/admin`) is React 19, Vite, TanStack Router, Tailwind 4 and shadcn/ui, with
its tokens in `apps/admin/src/index.css`. The storefront boards (`docs/design/storefront`) use
the same tokens and components. CLAUDE.md asks for few dependencies, each with a reason, and
apps do not import each other.

## Decision

### The app

A new app, `apps/storefront`, on the admin app's stack: React 19, Vite, TanStack Router,
Tailwind 4 and the shadcn/ui components the boards use. The same stack means no new framework
dependencies, and the same people can work on both apps.

- **Routes** (from the boards): `/sign-in`, `/` (all products), `/c/$categoryId`, `/p/$sku` and
  `/search?q=`. Every route except `/sign-in` needs a buyer session. A 401 from the API sends the
  buyer to `/sign-in?next=…`, with a "session ended" notice when they had been signed in.
- **Tokens.** The token block of `apps/admin/src/index.css` moves to a new CSS-only package,
  `packages/ui-tokens`, which both apps import. Neither app copies the other's tokens.
- **One website per deployment.** The build reads `VITE_STOREFRONT_WEBSITE` (a website code) and
  sends it in the `Muziris-Website` header on every request. Choosing a website by host name
  waits for a second website.
- **One origin with the API.** In development the Vite server proxies `/storefront/v1` to the
  API, as the admin app does with `/admin/v1`. In production the storefront's host serves the
  built app and proxies `/storefront/v1` to the API, so the buyer's `__Host-` cookie stays
  first-party and every request passes the API's origin check.
- **Money and quantities** are formatted with `@muziris/money` for the website's locale and
  currency (en-IN: ₹1,12,500.00). A quantity is checked against the unit's `precision` before
  the price is asked for.

### Operations, types and the registry

- Every query the storefront runs is a named operation in `apps/storefront/src/operations/*.graphql`.
  There is no query text anywhere else in the app.
- A script, `pnpm --filter @muziris/storefront operations`, written with `graphql` (graphql-js,
  already used by the API), does three things:
  - validates every operation against the committed `schema.graphql`;
  - writes `src/operations/generated.ts`, holding each operation's result and variables types and
    its SHA-256 hash;
  - writes `persisted-queries.json`, hash to document, the registry the API loads through
    `STOREFRONT_PERSISTED_QUERIES`.
- No GraphQL code generator, client library or DataLoader is added. The generator is a small
  script over graphql-js's `TypeInfo`, for the few operations the storefront has. GraphQL Code
  Generator and Apollo Client would bring large dependency trees for what is a fetch with a hash.
- `generated.ts` and the registry are committed. A test fails when either is stale, as the API's
  schema test does for `schema.graphql`.
- **The app sends only hashes, in every environment.** It never sends query text, so development
  behaves like production. In development the API's `STOREFRONT_PERSISTED_QUERIES` points at the
  storefront's registry. Ad hoc queries stay a tool for exploring the API.
- **Reads** use GET with the hash and variables in the query string (ADR 0014 allows this for
  persisted queries). Responses carry `Cache-Control: no-store`, since every answer is for one
  buyer. Route loaders fetch before a page renders, and a small cache per session avoids
  refetching the category list.

### Errors

A GraphQL `BAD_USER_INPUT` is shown next to its field. A null product is "We can't find that
product", the same for a hidden one. A null price is "Price on request". Any other error, or a
5xx, shows the States board's error with the API's request id as the reference, never the error
message.

## Consequences

- Buyers get the five screens of the boards, and the gate check can be shown end to end.
- One new package, `packages/ui-tokens` (CSS only). The admin app changes only where it imports
  its tokens.
- No new runtime dependencies beyond the admin app's set. `graphql` becomes a dev dependency of
  the storefront, for the operations script.
- A change to the schema or an operation needs `operations` run again, and CI catches it when
  forgotten.
- Quantity breaks (the next-break line on ProductDetail) need an additive `priceBreaks` field
  first; the app leaves that line out until then.
- Guests, shopping lists, quick order and checkout are not part of this decision. Week 4 adds
  mutations as POST operations, persisted the same way.
- A browser end-to-end run of the gate check (two buyers, two catalogs) is in week 5's journey
  tests. Item 5 tests the app against recorded API answers and relies on the API's own gate
  check tests (ADR 0014).
