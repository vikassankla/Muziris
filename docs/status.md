# Build status

Where the build stands and what comes next. Update this file at the end of every working
session, so the next session (human or AI) starts from here.

Last updated: 2026-10-29

## Goal

Pilot launch on **1 December 2026**, running locally or on a single VM. Cloud MVP on AWS by end
of February 2027. The full requirements, stack decisions and roadmap are in the requirements
spec: https://claude.ai/artifact/JeDtT4LfexVuHnyac3XGgV

## Done

| Area       | What exists                                                                                                             | Where                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Foundation | Monorepo, strict TypeScript, module boundary lint, CI (tests on PostgreSQL 18, audit, gitleaks, CodeQL), Docker Compose | repo root, `.github/` |
| Money      | Exact minor-unit maths, rounding, allocation, lakh/crore formatting                                                     | `packages/money`      |
| Database   | Connection, ordered migrations, per-test-file databases                                                                 | `packages/db`         |
| Platform   | Organization, websites, settings and feature toggles resolved customer to global                                        | `modules/platform`    |
| Identity   | Admin and buyer accounts, Argon2id, sessions, lockout, rate limiting                                                    | `modules/identity`    |
| Workflow   | Workflows in code (steps, transitions, guards, actions), PostgreSQL state and transition log                            | `modules/workflow`    |
| API        | Health checks, RFC 9457 errors, security headers, CORS, sign-in/out and `/me` for both realms, `admin:create`           | `apps/api`            |
| Customers  | Hierarchy, customer groups, buyer users, invitations, India and US addresses; admin routes under `/admin/v1/customers`  | `modules/customers`   |
| Access     | Admin roles and permissions with `requirePermission`; buyer roles with access levels, `buyerScope`, and admin routes    | `modules/access`      |
| Catalog    | Simple products, product units with precision, category tree, JSONB attributes, admin routes under `/admin/v1/catalog`  | `modules/catalog`     |
| Admin app  | Design-system frame, sign-in, permission-aware navigation, customer, catalog and role screens with their forms          | `apps/admin`          |

Decisions are recorded in `docs/adr/0001` to `0012`. ADRs 0006 (access control), 0007
(workflow engine), 0008 (customers) and 0009 (catalog) are merged with status proposed. ADR 0010
(admin routes for customers and buyer roles, paged admin lists) is merged with status proposed.
ADR 0011 (pricing) and ADR 0012 (visibility) are in review with status proposed. Every admin list endpoint is paged with
`limit` (at most 200) and `after`.

## Next, in order (pilot plan)

**Week 2 (4 to 10 Nov)**

Access control (ADR 0006), the workflow engine (ADR 0007), customers (ADR 0008), the catalog
(ADR 0009), the admin routes for customers and buyer roles (ADR 0010) and the admin app shell
(PR 12, merged 2026-10-29 as 6c2bbf8, with no second review recorded) are merged; see Done.
Customers has no storefront routes yet (accepting an invitation needs one), and invitation
emails wait for the email work in week 4.

**Week 3 (11 to 17 Nov):** Gate check: a buyer sees only their own catalog and prices.

1. Price lists with customer and group fallback and the combined price build (ADR 0011).
   **In review** (`feature/price-lists`); pricing needs a second human reviewer (CLAUDE.md
   rule 4). Module `modules/pricing`, admin routes under `/admin/v1/pricing`, the
   `pricing:build` command, and `findPriceForBuyer` for the storefront API to call. The admin
   screens (PriceLists, PriceListDetail) are designed but not built.
2. Visibility (ADR 0012). **In review** (`feature/visibility`, cut from `feature/price-lists`
   because PR 13 was not merged yet); visibility is access scoping and needs a second human
   reviewer (CLAUDE.md rule 4). Module `modules/visibility`, admin routes under
   `/admin/v1/visibility`, the `visibility:build` command, new admin permissions
   `visibility.view` and `visibility.manage`, and `visibleProductIdsForBuyer` and
   `visibleCategoryIdsForBuyer` for search and the storefront to put in their queries. No
   admin screens yet.
3. PostgreSQL search.
4. GraphQL storefront API.
5. Storefront browsing.

**Week 4 (18 to 24 Nov):** shopping lists, quick order, checkout (payment on terms; Stripe and
Razorpay in test mode), flat-rate shipping, GST and US tax tables, orders with the order
workflow, emails.

**Week 5 (25 Nov to 1 Dec):** known-answer tests for pricing and tax, end-to-end buyer
journeys, MRO demo catalog, install guide, security pass, pilot launch.

If a week slips, cut in this order: emails, then quick order CSV upload, then US tax tables.

## Open items

- Admin two-factor sign-in before the first production install (ADR 0005).
- A job runner (pg-boss) to schedule `deleteDeadSessions` and `pruneRateLimits`, and to run
  the combined price build after price list edits (ADR 0011) and the visibility build after
  rule and catalog edits (ADR 0012). Until then an admin runs it
  with `POST /admin/v1/pricing/build` or `pnpm --filter @muziris/api pricing:build`.
- Pricing (ADR 0011): the build is a full rebuild and makes price list writes wait while it
  runs; build only changed chains once catalogs grow. Changing the customer group of a
  customer with its own price lists stops its prices (`needs_rebuild`) until the next build.
  Not built: subsidiaries inheriting a parent's price lists, price formulas, CSV import and
  export, price activity history.
- Visibility (ADR 0012): the build is a full rebuild. Catalog changes are not counted as
  waiting changes: a new or newly enabled product, or a moved category, stays invisible until
  the next build (a disabled product disappears at once). Run `POST /admin/v1/visibility/build`
  or `pnpm --filter @muziris/api visibility:build` after catalog work until the job runner
  enqueues builds. Customers with their own rules each hold a full copy of their visible
  products; store differences from the website's result before the cloud MVP. The visible
  products list returns ids only. Not built: subsidiaries inheriting a parent's rules,
  scheduled rules, hiding products without a price.
- `CODE_OF_CONDUCT.md` has no contact email yet.
- Time-based workflow transitions (quote expiry) need the job runner to call
  `performTransition` with the system actor.
- Customers: a status for disabled customers, contacts (CRM), and a buyer user who works for
  several customers are not built (ADR 0008).
- Decide the default buyer role for invited buyer users (ADR 0006, ADR 0008). The admin
  routes (ADR 0010) assign none; an admin assigns buyer roles by hand for now.
- The admin API returns an invitation's token when it is created, because invitation emails
  are not built. Move the token into the email in week 4 (ADR 0010).
- The admin buyer users list returns identity user ids only; names and emails need a batch
  lookup in identity's public interface.
- Catalog: unit conversion (box of 10 = 10 each), localized names, attribute definitions,
  product images, and configurable and kit products are not built (ADR 0009). No product units
  are seeded; an admin creates `each` and the others before the first product.
- Admin app: designed in `docs/design/admin` but waiting on APIs: Orders, OrderDetail, RFQs,
  QuoteEditor, Websites, Settings, the Home dashboard widgets,
  Admin users, and the customer detail tabs for orders, quotes, price lists, settings
  overrides and payment term. Their sidebar items stay hidden until the APIs exist. The
  PriceLists and PriceListDetail APIs are in review (`/admin/v1/pricing`); their screens are
  not built. They need customer and website names beside the ids the API returns, and SKU
  search, CSV import and the "vs. list price" column are not in the API.
- Admin app: API gaps the boards assume. No search, totals or counts on admin lists (so no
  "1 to 25 of 1,284" and no per-row subsidiary or buyer user counts); no customer rename or
  delete; buyer users carry user ids only (no names, emails, roles or last sign-in); no list of
  a buyer user's buyer roles; no single buyer role read (the screen loads every role); no
  activity history; no product counts per category or unit.
- Admin app: the website switcher is a placeholder (India or United States) that only sets
  how money, quantities and dates show, until the websites API exists.
- Admin app: browser storage holds only UI preferences, the theme and whether the sidebar is
  collapsed (`apps/admin/src/lib/prefs.ts`). Nothing about the session, the admin user or the
  business goes there; tests check that no other key appears. Decided 2026-10-29.
- Admin app in production: serve `apps/admin/dist` from the API's origin behind one reverse
  proxy; there is no deployment recipe yet.

## Running the tests locally

```sh
docker compose up -d
docker compose exec postgres createdb -U muziris muziris_test   # once
TEST_DATABASE_URL=postgres://muziris:<your POSTGRES_PASSWORD>@127.0.0.1:5432/muziris_test pnpm check
```

Each integration test file creates its own database next to `muziris_test`.

## Working agreement

- Every commit is signed off (`git commit -s`) by Vikas before it is pushed.
- Follow `CLAUDE.md`. Run `pnpm check` with `TEST_DATABASE_URL` set before calling work done.
- Ask before starting anything not on the list above, and before any change to a decision
  recorded in an ADR.
