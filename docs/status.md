# Build status

Where the build stands and what comes next. Update this file at the end of every working
session, so the next session (human or AI) starts from here.

Last updated: 2026-11-04

## Goal

Pilot launch on **1 December 2026**, running locally or on a single VM. Cloud MVP on AWS by end
of February 2027. The full requirements, stack decisions and roadmap are in the requirements
spec: https://claude.ai/artifact/JeDtT4LfexVuHnyac3XGgV

## Done

| Area       | What exists                                                                                                             | Where                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Foundation | Monorepo, strict TypeScript, module boundary lint, CI (tests on PostgreSQL 18, audit, gitleaks, CodeQL), Docker Compose | repo root, `.github/`    |
| Money      | Exact minor-unit maths, rounding, allocation, lakh/crore formatting                                                     | `packages/money`         |
| Database   | Connection, ordered migrations, per-test-file databases                                                                 | `packages/db`            |
| Platform   | Organization, websites, settings and feature toggles resolved customer to global                                        | `modules/platform`       |
| Identity   | Admin and buyer accounts, Argon2id, sessions, lockout, rate limiting                                                    | `modules/identity`       |
| Workflow   | Workflows in code (steps, transitions, guards, actions), PostgreSQL state and transition log                            | `modules/workflow`       |
| API        | Health checks, RFC 9457 errors, security headers, CORS, sign-in/out and `/me` for both realms, `admin:create`           | `apps/api`               |
| Customers  | Hierarchy, customer groups, buyer users, invitations, India and US addresses; admin routes under `/admin/v1/customers`  | `modules/customers`      |
| Access     | Admin roles and permissions with `requirePermission`; buyer roles with access levels, `buyerScope`, and admin routes    | `modules/access`         |
| Catalog    | Simple products, product units with precision, category tree, JSONB attributes, admin routes under `/admin/v1/catalog`  | `modules/catalog`        |
| Admin app  | Design-system frame, sign-in, permission-aware navigation, customer, catalog and role screens with their forms          | `apps/admin`             |
| Storefront | Signed-in buyers: sign-in, catalogue, product page with a live price box, search, lists, quick order, checkout          | `apps/storefront`        |
| Orders     | Checkout preview and place with re-checks and idempotency, totals pipeline, order copies, numbers, terms, workflow      | `modules/orders`         |
| Lists      | Shopping lists scoped by buyer access level, lines with notes, duplicate and move; admin reads under `customer.view`    | `modules/shopping-lists` |
| Payments   | Stripe and Razorpay in test mode: one payment per order, signed webhooks, gateway event log, Pay now in the storefront  | `modules/payments`       |
| Emails     | Outbox queued with each change, SMTP sender with retries, eight templates, invitations accepted from the email link     | `modules/notifications`  |

Decisions are recorded in `docs/adr/0001` to `0023`. ADRs 0006 (access control), 0007
(workflow engine), 0008 (customers) and 0009 (catalog) are merged with status proposed. ADR 0010
(admin routes for customers and buyer roles, paged admin lists) is merged with status proposed.
ADR 0011 (pricing) and ADR 0012 (visibility) are merged with status proposed. ADR 0013 (search) is merged with status proposed. ADR 0014 (storefront GraphQL API) is merged
with status proposed. ADR 0015 (storefront app) is merged with status proposed. ADR 0016 (orders and checkout) is merged with status proposed. ADR 0017 (tax engine) is merged with status proposed. ADRs 0018 (shopping lists, quick order and the checkout page), 0019 (payments) and 0020 (emails) are merged with status proposed. ADRs 0021 (websites, settings and first-run setup), 0022 (price list screens) and 0023 (tax screens) are merged with status proposed. Every admin list endpoint is paged with
`limit` (at most 200) and `after`.

ADRs 0027 (visibility rule screens) and 0028 (admin users screen and admin invitations) were
accepted by Vikas in chat on 2026-11-04 (PR 54, merged 2026-11-04 as 636a17a). 0027 is built
(item 25, PR 55, merged 2026-11-04 as 90f98c8); 0028 is built (item 26, PR 56, merged 2026-11-04
as 3a8543f). Both need a second human review under CLAUDE.md rule 4.

ADRs 0030 (a payments screen in the admin, keys kept in the environment) and 0031 (feature
toggles for quick order and shopping lists) are proposed (branch `docs/adr-payments-toggles`),
for Vikas to accept before they are built.

## Next, in order (pilot plan)

**Week 2 (4 to 10 Nov)**

Access control (ADR 0006), the workflow engine (ADR 0007), customers (ADR 0008), the catalog
(ADR 0009), the admin routes for customers and buyer roles (ADR 0010) and the admin app shell
(PR 12, merged 2026-10-29 as 6c2bbf8, with no second review recorded) are merged; see Done.
Accepting an invitation and the invitation email are built with ADR 0020 (item 12, in
review).

**Week 3 (11 to 17 Nov):** Gate check: a buyer sees only their own catalog and prices.

1. Price lists with customer and group fallback and the combined price build (ADR 0011).
   **Merged** (PR 13, 2026-10-29, as f44fc56, with no second review recorded; pricing needs
   one under CLAUDE.md rule 4). Module `modules/pricing`, admin routes under `/admin/v1/pricing`, the
   `pricing:build` command, and `findPriceForBuyer` for the storefront API to call. The admin
   screens (PriceLists, PriceListDetail) are designed but not built.
2. Visibility (ADR 0012). **Merged** (PR 14, 2026-10-29, with no second review recorded;
   visibility is access scoping and needs one under CLAUDE.md rule 4). Module `modules/visibility`, admin routes under
   `/admin/v1/visibility`, the `visibility:build` command, new admin permissions
   `visibility.view` and `visibility.manage`, and `visibleProductIdsForBuyer` and
   `visibleCategoryIdsForBuyer` for search and the storefront to put in their queries. No
   admin screens yet.
3. PostgreSQL search (ADR 0013). **Merged** (PR 15, 2026-10-29, approved by Vikas in chat,
   with no second review recorded on GitHub; it scopes buyer data, so CLAUDE.md rule 4 asks
   for one). Module `modules/search`, admin routes under `/admin/v1/search`
   (`product.view`, and `product.manage` for the build), the `search:build` command, and
   `searchProductsForBuyer` for the storefront API to call. The catalog routes reindex after
   each write. Migrations `0008` (creates `pg_trgm`) and `0009`. No admin screen yet.
4. GraphQL storefront API (ADR 0014). **Merged** (PR 16, 2026-10-30, as 69dbd70, approved by
   Vikas in chat, with no second review recorded on GitHub; it changes pricing and returns
   buyer data, so CLAUDE.md rule 4 asks for one).
   One endpoint, `/storefront/v1/graphql`, built with `graphql` (graphql-js) alone: buyer
   sessions only, the website from the `Muziris-Website` header, persisted queries from a
   registry (`STOREFRONT_PERSISTED_QUERIES`) with ad hoc queries only outside production
   (`STOREFRONT_ADHOC_QUERIES`), depth, cost and size limits before execution, error masking,
   and per-request batching. Catalog gains `findProductsWithin`, `findProductBySkuWithin`,
   `listProductsWithin` and `listCategoriesWithin`; pricing gains `findPricesForBuyer`. The
   schema is committed as `apps/api/src/storefront/schema.graphql`.
5. Storefront browsing (ADR 0015). **Merged** (PR 19, 2026-10-30, as e32f859, approved by
   Vikas in chat, who confirmed rule 4's second review does not apply). No pricing or scoping
   change in the API; the app shows what the API already scopes.
   `apps/storefront` on the admin app's stack, signed-in buyers only (guests are later work).
   Design boards in `docs/design/storefront/`. Tokens moved to `packages/ui-tokens`. The
   operations are `.graphql` files compiled into types and the persisted query registry the
   API loads; the app sends hashes only. Not built: the next quantity break on the product
   page (needs an additive `priceBreaks` field), product images, list totals.

6. Orders and checkout (ADR 0016). **Merged** (PR 22, 2026-10-30, reviewed and approved by
   Vikas in chat). It handles payment terms, pricing and tax, so CLAUDE.md rule 4 asks for a
   second human review; Vikas's review is recorded in chat, not on GitHub. Module
   `modules/orders`: `previewCheckout` and `placeOrder` with every re-check and idempotency, the
   totals pipeline with replaceable providers, order copies, order numbers, payment terms from a
   setting, the `order_processing` workflow and buyer reads scoped by `order.view`. Migration
   `0010`. Not built yet: the tax engine (ADR 0017, so the tests use a GST test provider), tax
   codes on catalog products, and the seller's GST registration.
7. Checkout and orders in the APIs (ADR 0016). **Merged** (PR 24, 2026-10-30, approved by
   Vikas in chat, with no second review recorded on GitHub). It exposes ordering and order data
   to buyers and admins, so CLAUDE.md rule 4 asks for a second human review.
   Storefront GraphQL `checkoutPreview`, `placeOrder`, `orders`, `order(number)` and the
   customer's `addresses`; admin `/admin/v1/orders` (list, view with history, transitions). Not
   built yet: the checkout and order screens in the storefront and the admin app.
8. Tax engine (ADR 0017). **Merged** (PR 25, 2026-10-30, as b786d4f, approved by Vikas in chat,
   with no second review recorded on GitHub). This is tax, so CLAUDE.md rule 4 asks for a second
   human review. Module `modules/tax`: registrations per website (GSTIN, US permits),
   dated GST rates by HSN or SAC prefix, dated US rates by state and ZIP prefix with a CSV
   import, US exemption certificates, and `tableTaxProvider`, which the server now passes to
   checkout. Products gain `hsnSacCode` and `usTaxCategory`; orders copy the seller's
   registration and any exemption certificate. Admin routes under `/admin/v1/tax` with new
   permissions `tax.view` and `tax.manage`. Migrations `0011` to `0013`. Four choices in the
   ADR are marked for a tax adviser to confirm before go-live. Not built yet: the tax admin
   screens, and the product tax code fields in the admin app.
9. Order screens. **Merged** (PR 27, 2026-11-02, through PR 28, which contained its commits;
   approved by Vikas in chat). Admin `/orders` (status filter) and
   `/orders/$orderId` (lines, taxes per rate, addresses, payment, progress, history, workflow
   moves for `order.manage`); storefront `/orders` and `/orders/$number`. The storefront
   checkout page came with item 10.
10. Shopping lists, quick order and the checkout page (ADR 0018). **Merged** (PR 28, 2026-11-02,
    as c2ccd2f, approved by Vikas in chat).
    `modules/shopping-lists` (migration `0014`), scoped by the `shopping_list.manage` access
    level; storefront GraphQL list queries and eight mutations, `productsBySkus` (100 SKUs per
    call); admin reads under `/admin/v1/shopping-lists` (`customer.view`). Storefront
    mutations run over POST as persisted operations; a test runs every registered operation
    through the depth and cost limits. Storefront `/lists`, `/lists/$listId`, `/quick-order`
    (paste or CSV read in the browser, each row checked) and `/checkout` (from a list or an
    in-memory quick order; live preview; place with an idempotency key kept across retries;
    after a list checkout, an offer to empty it). Not built: SKU typeahead in quick order,
    moving lines between lists in the storefront (the API has it), and admin list screens.
11. Payments through Stripe and Razorpay, in test mode (ADR 0019). **Merged** (PR 29, 2026-11-02,
    as a6e00a5, approved by Vikas in chat, with no second review recorded on GitHub). This is
    payments and secrets, so CLAUDE.md rule 4 asks for a second human review.
    `modules/payments` (migration `0015`): one payment per order and a log of gateway events,
    unique per event; Stripe and Razorpay over `fetch` with HMAC signature checks and no SDKs.
    Keys come only from the environment (`STRIPE_*`, `RAZORPAY_*`, `PAYMENTS_LIVE`; see
    `.env.example`) and are redacted from logs. Orders gain `payment.methods`, an online method
    with no due date, and a `payment_settled` guard on confirm. Webhooks at
    `POST /webhooks/stripe` and `/webhooks/razorpay`. Storefront: a "Pay by" choice at checkout,
    Pay now on the order page (Stripe Payment Element or Razorpay Checkout) and a content
    security policy; admin: the payment and its gateway events on the order page. Not done: the
    manual test-mode run against both gateways, the CSP as a hosting header, refunds from the
    admin.
12. Transactional emails through an outbox (ADR 0020). **Merged** (PR 30, 2026-11-02, as
    4a6afe5, approved by Vikas in chat, with no second review recorded on GitHub). This touches
    authentication, access control and secrets, so CLAUDE.md rule 4 asks for a second human
    review. `modules/notifications` (migration `0016`): an outbox queued in the transaction of
    each change, sent with `FOR UPDATE SKIP LOCKED`, retried after 1, 5, 30 and 120 minutes,
    with secret bodies emptied once sent or failed; eight templates (see
    `docs/notifications.md`); one new dependency, `nodemailer`. The sender runs in the API
    process every 10 seconds when `SMTP_URL` is set (moved into the job runner, item 22), and as
    `notifications:send`. The admin API no longer returns invitation tokens: the email carries
    the link (`/accept-invitation#token=`), with "Send again" on the customer page. Storefront
    `/accept-invitation`; admin System > Emails (`notification.view`, `notification.manage`).
    Not done: a check against Mailpit by hand, bounce handling.

13. Websites, settings and first-run setup (ADR 0021). **Merged** (PR 34, 2026-11-03, as
    5c05644, approved by Vikas in chat, with no second review recorded on GitHub). This touches access control (a buyer role granted on acceptance) and settings that
    steer payments, so CLAUDE.md rule 4 asks for a second human review. The setup CLI
    (`pnpm --filter @muziris/api run setup --organization "<name>"`) creates the organization and
    the standard product units; `/admin/v1/websites` and `/admin/v1/settings` list, create and
    change websites and override or clear settings at one scope, recording who did it
    (migration `0017`). The default buyer role is a setting, stored on the invitation (migration
    `0018`) and granted when it is accepted. Admin: a real website switcher, System > Websites
    and System > Settings, a buyer role in the invite dialog. Not done: feature toggles. Checked
    by hand on 2026-11-08 (item 32).
14. Price list screens with CSV import and export (ADR 0022). **Merged** (PR 35, 2026-11-03,
    as 7284121, approved by Vikas in chat, with no second review recorded on GitHub). This touches pricing, so CLAUDE.md rule 4 asks for a second human review. A shared
    `@muziris/csv` package (also used by the US tax rate import); batch lookups by id in catalog
    and customers, and `searchProductIds` in search. The pricing API gains SKUs and names beside
    ids, `q` search on prices, `POST .../prices/import` (text/csv, at most 2 MB and 10,000
    rows, all or nothing unless `skipInvalid=true`) and `GET .../prices.csv`. Admin: Pricing >
    Price lists and a price list's page (prices with tiers, import, export, assignments), the
    build banner and the price preview. No migrations. Not done: the "vs. list price" column,
    import history. Checked by hand on 2026-11-08 (item 32).
15. Tax screens, the readiness check and product tax codes (ADR 0023). **Merged** (PR 36,
    2026-11-03, as 091f85d, approved by Vikas in chat, with no second review recorded on GitHub). This touches tax, so CLAUDE.md rule 4 asks for a second human review; the four
    **(check)** items in ADR 0017 still need the tax adviser. Catalog gains `taxCodeUsage` and
    a `missingTaxCode` products filter; the API gains `GET /admin/v1/tax/readiness?websiteId=`.
    Admin: System > Tax for the top bar website (Readiness, Registration, Rates with the US CSV
    import, and US Exemptions), a Tax section on the product page (HSN or SAC code with the GST
    rate covering it, US tax category), a missing tax code filter on the products list, and
    exemptions on the customer page. No migrations. Not done: warnings for rates about to end.
    Checked by hand on 2026-11-08 (item 32).

16. Fixes from the hand test of items 13 to 15 on the Docker stack (2026-11-03). **Merged**
    (PR 38, 2026-11-03, as 8489a88, approved by Vikas in chat, with no second review recorded
    on GitHub; it touches access control, so CLAUDE.md rule 4 asks for one).
    - Setup adds the standard buyer roles **Buyer** and **Purchasing admin** when they are
      missing, and makes Buyer the organization's default buyer role when it created it. Before
      this, a fresh install had no buyer roles, so invited buyers could not order.
    - The visibility build state also says whether products or categories changed since the
      last build (`catalogChangedSinceBuild`), and the Products list shows "Buyers do not see
      ... yet" with **Build visibility now**. Before this, a new product stayed invisible to
      buyers with nothing in the admin app saying so.
    - Admin: dates on the Tax screen read as dates; the readiness item for a missing
      registration shows no count; the customer page's Orders tab lists its orders.
    - Storefront: addresses show the state name, the totals say "Shipping", and quick order
      says its price is for one unit and quantity breaks apply at checkout.
    - Checked and working by hand: price CSV import and export, tier prices after a build, GST
      CGST plus SGST within a state, invitation and order emails in Mailpit, accepting an
      invitation, and confirming an order.
    - Follow-ups: an order or add-to-list button on the storefront product page (item 27);
      names, not ids, in the customer's buyer users tab (item 28); admin screens for visibility
      rules (item 25).

17. Known-answer tests for a whole checkout (PR 39, merged 2026-11-03 as b0c5cb0, approved by
    Vikas in chat, with no second review recorded; pricing and tax tests, so CLAUDE.md rule 4
    asks for one): eight cases through `previewCheckout` and the stored tax tables, India
    within and across states and US ZIP, state, no-permit and exemption cases.
18. MRO demo catalog (PR 40, merged 2026-11-03 as ad25cfe): `demo:seed --website <code>` adds
    10 categories and 37 products with list prices in INR and USD, breaks at 1, 10 and 100,
    and runs the builds. No tax data.
19. Install guide, first draft (PR 41, merged 2026-11-03 as 03c8331): `docs/install.md`.
20. ADRs 0024 (end-to-end buyer journeys with Playwright), 0025 (job runner with pg-boss) and
    0026 (two-factor sign-in for admins), accepted by Vikas in chat on 2026-11-03. Built as items
    21, 22 and 24.
21. End-to-end journeys (ADR 0024; PR 43, merged 2026-11-03 as 46f9d15). Package
    `e2e/` with Playwright 1.64.1, `pnpm e2e`, and a CI job "End-to-end journeys" after the
    checks. All five first journeys pass, three times over locally: invitation to order, prices
    and tiers, shopping list reorder, catalog changes reach buyers, tax readiness. The Vite
    configs read `MUZIRIS_API_TARGET`, so the journeys' API can run on its own port.
22. Job runner (ADR 0025; PR 44, merged 2026-11-03 as 6b944b4, approved by Vikas in chat, with
    no second review recorded; it touches pricing builds, access control and session clean-up,
    so CLAUDE.md rule 4 asks for one). Package
    `packages/jobs` with pg-boss 12.38.0 (MIT) in schema `pgboss`, installed by `db:migrate`.
    Admin writes queue `pricing.build` and `visibility.build` in their own transaction, 15
    seconds ahead, one build per burst; "Build now" answers 202. `notifications.send` replaces
    the 10-second email loop; `sessions.cleanup` runs hourly. The API runs the workers unless
    `JOB_WORKERS=false`, and then `pnpm --filter @muziris/api worker` does. New permission
    `job.view` and a read-only System > Jobs screen. Journey 4 now waits for the queued build
    instead of pressing "Build now". `workflow.timers` waits for the first time-based
    transition.
23. Storefront tests get 15 seconds each (PR 45, merged 2026-11-03 as 1170236): the sign-in
    test ran past vitest's 5-second default on CI and failed main.

24. Admin two-factor sign-in (ADR 0026; PR 51, merged 2026-11-04 as 3067070, approved by Vikas
    in chat, with no second review recorded; it is authentication and handles a secret, so
    CLAUDE.md rule 4 asks for one). Authenticator-app codes (RFC 6238, `node:crypto`, the RFC
    vectors as known-answer tests) and 10 recovery codes, stored as Argon2id hashes; secrets
    encrypted with `ADMIN_TOTP_KEY` (migration `0019`). Every `.env` needs the key.
    A right password opens a 5-minute two-factor session; the code opens the full one with a
    new token. First sign-in enrols, with a QR code (`uqr`, MIT, new dependency). A Security
    page under the profile menu gives new recovery codes and moves to a new phone. Reset by an
    admin with `admin_user.manage` (API only, no screen yet) or `admin:reset-2fa`; key rotation
    with `admin:rotate-2fa-key`. The end-to-end setup enrols the administrator in the browser.
25. Visibility rule screens (ADR 0027; PR 55, merged 2026-11-04 as 90f98c8, approved by Vikas in
    chat; needs a second human review under CLAUDE.md rule 4, since visibility scopes what buyers
    may see). `/visibility` under Catalog, on the top bar's website: the build banner, rules by name
    (SKU and name, or a category's path; "Everyone on <website>", a customer group or a customer),
    filters by subject and target, and a search by SKU, product, category, customer or group name.
    New rule, a row switch between Visible and Hidden, and delete, for `visibility.manage`; a taken
    rule offers to change the one already there. "Check a buyer's view" explains one product or
    category for one customer, and says when the answer waits for a build. The product and customer
    pages gain a Visibility card linking to the screen filtered to them. The API names subjects and
    targets beside their ids and takes `q` (customers gains `customerIdsMatching` and
    `customerGroupIdsMatching`). Journey 7 hides a category from a customer group and checks two
    buyers' storefronts.
26. Admin users screen and admin invitations (ADR 0028; PR 56, merged 2026-11-04 as 3a8543f,
    approved by Vikas in chat; needs a second human review under CLAUDE.md rule 4: authentication
    and access control). `/admin-users` under System for `admin_user.view`: name, email, admin
    roles, two-factor, status (Active, Invited, Disabled) and last sign-in. Inviting makes an
    account with no password, gives the roles the inviter may give, and emails a one-time link to
    `/accept-invitation` in the admin app, good for 72 hours (`identity_invitation`, migration
    `0020`, new email kind `admin_invitation`). Accepting sets the password only; the admin then
    signs in and enrols a second factor. Row actions: change admin roles, send the invitation again,
    reset two-factor (not your own), disable (not yourself, never the last active administrator) and
    enable. New setting `ADMIN_PUBLIC_URL`, required in production. Journey 8 invites an admin,
    accepts from Mailpit, enrols, and is disabled.
27. Ordering from the storefront product page (first hand-test follow-up in item 16). PR 52,
    merged 2026-11-04 as 5bf6b90, approved by Vikas in chat. The price box gains **Order now** (the
    unit and quantity go to checkout as one line, in memory as from quick order) and **Add to
    shopping list** (pick a list or name a new one; the page links to it). Quick order and the
    product page share the list picker and `addToShoppingList`. No API change. Journey 6
    (`e2e/tests/product-page.spec.ts`) saves a product to a new list and orders it from its
    page.
28. Buyer users by name (second hand-test follow-up in item 16). PR 53, merged 2026-11-04 as
    4b4698e, approved by Vikas in chat. It reads buyer role assignments, so CLAUDE.md rule 4 asks
    for a second human review. Identity gains `findUsersByIds` and access gains
    `buyerRolesOfUsers`; `GET /admin/v1/customers/:id/buyer-users` adds each user's name,
    email, status, last sign-in and buyer roles, looked up for the page at once. The customer's
    Buyer users tab shows them as the board does (Name, Email, Buyer roles, Status, Last
    sign-in); a user with no account left shows by id. Journey 1 now checks the tab.
29. Security pass (week 5, ahead of the plan). **Merged** (PR 57, 2026-11-04, as 958263d,
    approved by Vikas in chat after a second review); it touches authentication, payments,
    secrets and access control (CLAUDE.md rule 4). Findings and what held are in `docs/security-review.md`. Fixed: database
    errors no longer put query values in the logs or pg-boss's job table (`withoutQueryValues`
    in `@muziris/db`); the admin app's build writes a content security policy and nginx forbids
    framing either app (`docker/app-headers.conf`); `safeRedirect` refuses a tab or line break
    that a browser would turn into another site; `RAZORPAY_WEBHOOK_SECRET` needs 16 or more
    characters. The end-to-end journeys fail on a content security policy violation. ADR 0028
    amended (Vikas, in chat): disabling, enabling or resetting another admin user's two-factor
    sign-in needs every permission they hold (`outranked` otherwise), and the admin users list
    offers those actions only where they are allowed (`mayManage`).

30. ADR 0029, the pilot deployment (launch prep). **Accepted** by Vikas in chat on 2026-11-04
    (PR 58).
31. The pilot deployment recipe (ADR 0029). **Merged** (PR 59, 2026-11-04, as 062ce94,
    approved by Vikas in chat after a second review, as CLAUDE.md rule 4 asks: it carries
    secrets and HTTPS).
    `deploy/compose.yml` runs PostgreSQL, `migrate`, the API, Caddy 2.11.7 (`edge`) and a daily
    `pg_dump`; only ports 80 and 443 are published. `deploy/muziris` runs Compose with the
    root-only `/etc/muziris/muziris.env`. The Dockerfile gains `api-prod` (a production-only install from
    the lockfile, `NODE_ENV=production`, still on `tsx`, now an API dependency) and `edge`.
    `deploy/check-stack.sh` checks HTTPS, the redirect, the headers against
    `docker/app-headers.conf`, which paths reach the API, the unpublished ports and a backup
    restore; CI's new "Production stack" job runs it with Caddy's own certificates. The install
    guide is rewritten around the VM install. Not done: an install on a real VM with Let's
    Encrypt, and a first release tag.
32. Hand checks of items 13 to 15 (launch prep, 2026-11-08). **Done**, in the admin app on a
    local install with no SMTP. Checked and working: website fields, locks and refusals;
    settings overrides, Clear and inheritance by scope; price lists, tiers, the build banner,
    the price preview and customer assignment; Readiness in both countries; GSTIN validation;
    GST and US rates, including refusals, overlaps, longest prefix, End and Delete; the US
    CSV import (all or nothing); permits; exemptions on the Tax screen and the customer page;
    the product Tax section and the missing tax code filter. Not repeated: accepting an
    invitation with the default buyer role, and price CSV import and export (checked by hand
    in PR 38). Nothing was fixed; the findings are under Open items.
33. Fix for hand check finding 1 (item 32). **In review** (branch `fix/setting-money-decimals`);
    it touches a setting that steers pricing, so CLAUDE.md rule 4 asks for a second human review.
    `PUT /admin/v1/settings/shipping.flat_rate` refuses an amount with more decimals than the
    currency allows, against the website's currency or, above a website, every website's. A value
    saved before this shows as stored (150.555 INR) instead of crashing the Settings page, so it
    can be changed or cleared there. No migrations.
34. Fix for hand check finding 2 (item 32). **In review** (branch `fix/payment-methods-warning`,
    stacked on item 33); it touches payment settings, so CLAUDE.md rule 4 asks for a second human
    review. Saving `payment.methods` refuses an empty list. Reading settings gives each one
    `warnings`; for payment methods they name a website where checkout would refuse every order,
    a gateway method whose keys are not set, and one that does not take a website's currency.
    The Settings page shows them under the setting. Checkout is unchanged. No migrations.

**Next (ahead of the plan):** the rest of launch prep: an install on a real VM with Let's
Encrypt, the Stripe and Razorpay test-mode run (it needs test keys in `.env`), and a decision
on the hand check findings (Open items).

**Week 4 (18 to 24 Nov):** shopping lists, quick order, checkout (payment on terms; Stripe and
Razorpay in test mode), flat-rate shipping, GST and US tax tables, orders with the order
workflow, emails.

**Week 5 (25 Nov to 1 Dec):** known-answer tests for pricing and tax, end-to-end buyer
journeys, MRO demo catalog, install guide, security pass, pilot launch.

If a week slips, cut in this order: emails, then quick order CSV upload, then US tax tables.

## Open items

- Hand check findings (item 32, 2026-11-08). Finding 1 is fixed by item 33 and finding 2 by item 34; the others are open:
  1. Bug: Settings accepts `shipping.flat_rate` with more decimals than the currency allows
     (₹150.555 saves). `formatAmount` then throws `RangeError` and the Settings page crashes on
     every load, so the value can only be cleared through the API. Checkout rounds it and does
     not crash. The fix touches a setting that steers pricing, so CLAUDE.md rule 4 applies.
  2. Payment methods can be saved empty, and checkout then refuses every order with
     `payment_method_not_available`, with no warning in the admin app. Gateway methods without
     keys, or in the wrong currency, are dropped just as silently.
  3. Ending a tax rate on a day before it starts says "Another rate applies on some of the
     same days": `modules/tax/src/rates.ts` raises `rate_overlaps` for both cases.
  4. A US rates CSV with the wrong header says the file has rows that are not valid, and
     does not mention the columns.
  5. An exemption certificate can be added with an expiry date in the past, and the list does
     not mark it expired. Checkout ignores it correctly.
  6. Display: the tab lists overflow by 1px and show a stray scrollbar on a price list's page
     and Tax; Readiness says "(1 products)"; the GSTIN hint shows "State: State SH" for partial
     input.
  7. To consider: Settings' website selector does not follow the top bar, so the two can show
     different websites; `?website=` on Tax is replaced by the top bar's website on load; the
     Prices tab badge counts loaded rows (25), not the total (111); the prices table hides its
     Price column behind a horizontal scroll at 1024 wide; the payment methods description
     shows raw codes; Clear on a setting has no confirmation.

- Selling to all countries (requested 2026-10-30) is a later phase, after the pilot. The pilot
  stays India and US. It needs general address formats and tax ids, a tax provider beyond the
  India and US tables, payment providers per region, shipping by zone, a translation layer for
  the admin app and the storefront, product names per locale, search in more languages, and
  data protection and residency decisions. The foundations (websites with country, currency,
  locale, time zone and units; exact money; price lists per currency) already work per country.

- Admin two-factor sign-in (ADR 0026): no passkeys, no remembered devices.
- Admin users (ADR 0028): no password reset ("forgot password") for admins or buyers, no
  editing an admin's name or email, no deleting admins. Two admins disabled at the same moment
  could both pass the last-administrator check; `admin:create` recovers.
- Job runner (ADR 0025): no admin action retries or removes a failed job; the Jobs screen only
  lists them. pg-boss keeps finished jobs for its default retention.
- Pricing (ADR 0011): the build is a full rebuild and makes price list writes wait while it
  runs; build only changed chains once catalogs grow. Changing the customer group of a
  customer with its own price lists stops its prices (`needs_rebuild`) until the next build.
  Not built: subsidiaries inheriting a parent's price lists, price formulas, CSV import and
  export, price activity history.
- Visibility (ADR 0012): the build is a full rebuild. Catalog changes are not counted as
  waiting changes: a new or newly enabled product, or a moved category, stays invisible until
  the next build (a disabled product disappears at once). Run `POST /admin/v1/visibility/build`
  or `pnpm --filter @muziris/api visibility:build` after catalog changes made outside the admin
  API; changes through it queue a build (ADR 0025). Customers with their own rules each hold a full copy of their visible
  products; store differences from the website's result before the cloud MVP. The visible
  products list returns ids only. Not built: subsidiaries inheriting a parent's rules,
  scheduled rules, hiding products without a price.
- Search (ADR 0013): the catalog routes reindex after writes because catalog has no hook;
  move that into an event when catalog has one (the job runner runs only the full build). Products changed outside the admin API, and
  category renames made outside it, need `POST /admin/v1/search/build` or
  `pnpm --filter @muziris/api search:build`. A buyer can find a visible product by the name of
  a category above it that is hidden from them (the result does not show that category).
  Results page by `offset` within the first 1,000. Not built: vector search, synonyms beyond
  the Indian and US spelling pairs, facets and attribute filters (they need attribute
  definitions), localized names, the admin search screen, and the OpenSearch adapter. One
  buyer search over 10,000 products is held under 250 ms by a test (about 40 ms locally).
- Storefront API (ADR 0014): signed-in buyers only; guest browsing needs visibility and prices
  for guests. Mutations run over POST as persisted operations (ADR 0018); no subscriptions.
  No rate limits per API client (FR-API-5). The storefront build must produce the
  persisted query registry before production. No valid query in the first schema is deeper
  than 6 levels, so the depth limit of 8 guards later types.
- `CODE_OF_CONDUCT.md` has no contact email yet.
- Time-based workflow transitions (quote expiry) need a `workflow.timers` job (ADR 0025) to
  call `performTransition` with the system actor.
- Customers: a status for disabled customers, contacts (CRM), and a buyer user who works for
  several customers are not built (ADR 0008).
- Catalog: unit conversion (box of 10 = 10 each), localized names, attribute definitions,
  product images, and configurable and kit products are not built (ADR 0009). No product units
  are seeded; an admin creates `each` and the others before the first product.
- Admin app: designed in `docs/design/admin` but waiting on APIs: RFQs,
  QuoteEditor, the Home dashboard widgets,
  and the customer detail tabs for orders, quotes, price lists, settings
  overrides and payment term (the Settings screen covers a customer's overrides). Their sidebar
  items stay hidden until the APIs exist. The price list screens have no "vs. list price"
  column, import history or Activity tab (ADR 0022).
- Admin app: API gaps the boards assume. No search, totals or counts on admin lists (so no
  "1 to 25 of 1,284" and no per-row subsidiary or buyer user counts); no customer rename or
  delete; no search or filters on a customer's buyer users; no single buyer role read (the screen loads every role); no
  activity history; no product counts per category or unit.
- Admin app: the website switcher lists the real websites but forgets the choice on reload
  (browser storage holds UI preferences only).
- Admin app: browser storage holds only UI preferences, the theme and whether the sidebar is
  collapsed (`apps/admin/src/lib/prefs.ts`). Nothing about the session, the admin user or the
  business goes there; tests check that no other key appears. Decided 2026-10-29.
- Deployment (ADR 0029): one VM, so one point of failure, and up to a day of data lost between
  dumps. The API still runs from TypeScript with `tsx`; images are built on the VM, with no
  registry. Both wait for the cloud MVP.

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
