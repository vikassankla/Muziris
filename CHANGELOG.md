# Changelog

All notable changes are listed here. The project follows semantic versioning from 1.0.

## Unreleased

### Added

- Monorepo with pnpm and Turborepo, strict TypeScript, lint rules that enforce module
  boundaries, and CI with tests against PostgreSQL 18, dependency audit, secret scanning and
  CodeQL.
- Local development services in Docker Compose: PostgreSQL 18, S3-compatible storage
  (SeaweedFS) and Mailpit.
- `@muziris/money`: exact money and decimal maths, rounding modes, allocation without lost
  units, and locale formatting (lakh and crore grouping for en-IN).
- `@muziris/platform`: organization and websites (country, currency, locale, time zone, unit
  system) and settings that resolve from customer to global, with feature toggles.
- API: health endpoints (`/health/live`, `/health/ready`), RFC 9457 error responses, security
  headers, CORS allowlist, request size limit, request ids, structured logs with secrets
  redacted, and graceful shutdown.
- `@muziris/identity`: admin and buyer accounts in separate realms, Argon2id password hashing
  with automatic upgrades, password policy, server-side sessions with idle and absolute
  timeouts, account lockout with backoff, and PostgreSQL-backed rate limiting.
- API: `POST /admin/v1/auth/sign-in`, `POST /admin/v1/auth/sign-out`, `GET /admin/v1/auth/me`,
  and the same under `/storefront/v1/auth` for buyers. `__Host-` session cookies, origin
  checks against cross-site request forgery, per-IP and per-email sign-in limits.
- `admin:create` command to create an admin without exposing the password.
- `TRUSTED_PROXY_HOPS` setting for the client IP behind a load balancer.
- `@muziris/workflow`: workflows declared in code with steps, transitions, pure guards and
  actions that run in the transition's transaction. State and an append-only transition log
  in PostgreSQL; each transition locks its instance, so concurrent transitions are safe.
  Refused transitions say why (unknown transition, stale version, wrong step, failed guard).
- `@muziris/customers`: customer hierarchy (parent and subsidiaries) with cycles refused,
  customer groups, buyer users linked to identity users, invitations with hashed single-use
  tokens and an expiry, and India and US addresses (PIN code, GST state code, GSTIN check
  character, ZIP and ZIP+4). Storefront reads are scoped to the buyer user's customer, or its
  subsidiaries too, in the query itself. `descendantCustomerIds` supplies the subquery that
  access control needs for "my customer and subsidiaries" (ADR 0008).
- `@muziris/access`: admin roles holding permissions from a typed catalogue, assigned to admin
  users, with a built-in `administrator` role that grants every permission. Nobody can grant or
  remove permissions they do not hold, built-in roles cannot be changed, and the last
  administrator cannot be removed. Buyer roles grant storefront permissions at an access level
  (own records, my customer, my customer and subsidiaries), and `buyerScope` turns that level
  into a SQL predicate so storefront queries are scoped in the query itself (ADR 0006).
- API: `requirePermission` middleware for admin routes, answering 403 `permission_denied`.
  `GET /admin/v1/access/me`, `GET /admin/v1/access/permissions`, `GET` and `POST
/admin/v1/access/roles`, `PUT /admin/v1/access/roles/{roleId}/permissions`, `DELETE
/admin/v1/access/roles/{roleId}`, and `PUT` and `DELETE
/admin/v1/access/admin-users/{userId}/roles/{roleId}`. Refusals use the codes
  `privilege_escalation`, `built_in_role`, `last_administrator`, `role_code_taken`,
  `role_not_found` and `user_not_found`.
- `admin:create` now gives the new admin the `administrator` role; `--existing` gives it to an
  admin created earlier.
- `@muziris/identity`: `findUserById`.
- `@muziris/catalog`: simple products (SKU unique in any letter case, name, enabled or disabled
  status, one category, attributes as a JSONB object validated with zod), product units with
  their decimal precision, the product units each product is sold in with one primary, and a
  category tree with cycles refused. `parseQuantity` and `quantitySchema` read quantities as
  exact decimals at a unit's precision, refusing extra decimals unless a rounding mode is
  given (ADR 0009).
- API: `GET` and `POST /admin/v1/catalog/product-units`; `GET` (as a tree) and `POST
/admin/v1/catalog/categories`, `PATCH` and `DELETE /admin/v1/catalog/categories/{categoryId}`,
  `PUT /admin/v1/catalog/categories/{categoryId}/parent`; `GET` (paged by SKU, filtered by
  category and status) and `POST /admin/v1/catalog/products`, `GET` and `PATCH
/admin/v1/catalog/products/{productId}`, `PUT /admin/v1/catalog/products/{productId}/units`.
  Reads need `product.view` and changes `product.manage`. Refusals use the codes `sku_taken`,
  `product_not_found`, `product_unit_not_found`, `product_unit_code_taken`,
  `category_not_found`, `category_code_taken`, `category_cycle` and `category_not_empty`.
- API: admin routes for customers (ADR 0010). `GET` (paged by name; filtered by `parentId`,
  `topLevel` or `groupId`) and `POST /admin/v1/customers`; `GET
/admin/v1/customers/{customerId}`; `GET /admin/v1/customers/{customerId}/subsidiaries`; `PUT
/admin/v1/customers/{customerId}/parent` and `PUT /admin/v1/customers/{customerId}/group`;
  `GET` and `POST /admin/v1/customers/groups`; `GET` and `POST
/admin/v1/customers/{customerId}/buyer-users` and `POST
/admin/v1/customers/{customerId}/buyer-users/link`; `GET` (pending only) and `POST
/admin/v1/customers/{customerId}/invitations` and `POST
/admin/v1/customers/invitations/{invitationId}/revoke`; `GET` and `POST
/admin/v1/customers/{customerId}/addresses`. Reads need `customer.view` and changes
  `customer.manage`. Refusals use the codes `customer_not_found`, `customer_group_not_found`,
  `customer_group_code_taken`, `hierarchy_cycle`, `not_a_buyer`, `buyer_user_exists`,
  `email_taken`, `password_policy`, `invitation_not_found`, `invitation_closed` and
  `default_address_conflict`.
- API: admin routes for buyer roles. `GET /admin/v1/access/buyer-permissions`; `GET` (paged by
  code) and `POST /admin/v1/access/buyer-roles`; `PUT
/admin/v1/access/buyer-roles/{roleId}/grants`; `DELETE /admin/v1/access/buyer-roles/{roleId}`;
  `PUT` and `DELETE /admin/v1/access/buyer-users/{userId}/buyer-roles/{roleId}`. Reads need
  `buyer_role.view` and changes `buyer_role.manage`.
- Every admin list endpoint is paged: `limit` from 1 to 200 (50 by default), and `after` set to
  the previous page's `nextAfter`.
- `@muziris/customers`: `listCustomers`, paged and filtered, and `pageQuerySchema`.
  `@muziris/access`: `listBuyerRolesQuerySchema`.
- `apps/admin` (`@muziris/admin`): the admin app shell, built with React, Vite, TanStack Router
  and shadcn/ui (Tailwind). A sign-in screen over `POST /admin/v1/auth/sign-in` that shows one
  message for `invalid_credentials` and the retry time for `too_many_attempts`; sign-out; a
  guard that asks `GET /admin/v1/auth/me` on every navigation and sends any 401 to sign-in;
  navigation that hides what `GET /admin/v1/access/me` does not allow, with a "No access" view
  for a 403 `permission_denied`; RFC 9457 errors shown by `title` and branched on `code`, with
  a fixed message for any 5xx. Read-only screens: customers (paged) with a customer's place in
  the hierarchy and its subsidiaries, buyer roles (paged) with their grants, products (paged),
  the category tree and admin roles. The session lives only in the API's `__Host-` cookie;
  browser storage holds only the theme and the sidebar's collapsed state. The Vite dev server proxies `/admin/v1` to the API.
- Admin app design pass, following the Claude Design boards kept in `docs/design/admin`: the
  boards' light and dark tokens under shadcn names, self-hosted Inter and JetBrains Mono, a
  grouped sidebar (Ctrl+B), a top bar with a placeholder website switcher, a Ctrl+K command
  palette and a user menu with the theme, breadcrumbs, and the shared loading, empty, no
  access, error, toast and confirm states. Sign-in shows failed, locked (with a countdown)
  and session-ended states. Screens with their forms: customers (create, change customer
  group and parent), customer detail (hierarchy, buyer users, invitations, India and US
  addresses with PIN, ZIP and GSTIN checks), customer groups, products and product detail
  (edit, product units, attributes, unsaved-changes guard), categories (create, rename, move,
  reorder, delete), product units, admin roles (permission matrix that locks what the admin
  does not hold) and buyer roles (access-level matrix). Money, quantities and dates follow
  the website's locale (lakh grouping for en-IN).
- `.claude/launch.json` entries for the admin dev server and the API.
- `@muziris/pricing` (ADR 0011): price lists in one currency with optional active dates, prices
  as tiers by product, product unit and minimum quantity (amounts in minor units, quantities as
  exact decimals at the unit's precision, extra decimals refused), and assignments of price
  lists to a customer, a customer group or a website, with priorities. The fallback chain is
  customer, then customer group, then website, and the first price list with a tier for the
  quantity wins. `rebuildCombinedPrices` builds every combined price list with set-based SQL in
  one transaction, split at every active date, so starts and ends need no rebuild.
  `findPrice` and the buyer-scoped `findPriceForBuyer` read only the combined price list, and
  refuse (`needs_rebuild`) a customer with its own price lists whose group changed since the
  build. `previewPrice` explains each step of the chain and rounds the line amount once, half
  up. Writes count changes, so `getBuildState` shows changes waiting for a build.
- API: admin routes under `/admin/v1/pricing`. `GET` (paged by name, with status and counts) and
  `POST /price-lists`, `GET`, `PATCH` and `DELETE /price-lists/{priceListId}`; `GET` (paged)
  and `POST /price-lists/{priceListId}/prices`, `PATCH` and `DELETE /prices/{priceId}`; `GET`
  (paged, in chain order) and `POST /assignments`, `PATCH` and `DELETE
/assignments/{assignmentId}`; `GET` and `POST /build`; `GET /preview`. Reads need
  `price_list.view` and changes and the build `price_list.manage`. Amounts are decimal strings.
  Refusals use the codes `price_list_not_found`, `active_dates_out_of_order`,
  `price_not_found`, `price_tier_taken`, `invalid_amount`, `invalid_quantity`,
  `product_not_found`, `product_unit_not_sold`, `assignment_not_found`, `assignment_taken`,
  `assignment_priority_taken`, `currency_mismatch`, `website_not_found`, `customer_not_found`
  and `customer_group_not_found`.
- `pricing:build` command to rebuild the combined price lists from a shell.
- `@muziris/customers`: `findCustomerGroup` and `customerGroupMembership` (an SQL select of
  every customer's group). `@muziris/platform`: `findWebsite`.
- `@muziris/visibility` (ADR 0012): rules that make a product or a category visible or hidden
  on a website for a customer, a customer group or the website. Levels are tried customer,
  customer group, website, as for prices; within a level the product's own rule comes first,
  then its category, then the categories above it. Without a rule an enabled product is
  visible; a disabled product never is. `rebuildVisibility` writes every context's visible
  products and categories with set-based SQL in one transaction. `visibleProductIdsForBuyer`
  and `visibleCategoryIdsForBuyer` return SQL selects scoped to the signed-in buyer's customer
  inside the query, for search and the storefront; they show nothing before the first build
  and nothing to a customer with its own rules whose group changed since the build.
  `previewVisibility` explains one product or category for a customer. Rule writes count
  changes, so `getBuildState` shows changes waiting for a build.
- API: admin routes under `/admin/v1/visibility`. `GET` (paged, with filters) and
  `POST /rules`, `GET`, `PATCH` and `DELETE /rules/{ruleId}`; `GET` and `POST /build`;
  `GET /preview`; `GET /visible-products` (paged product ids for a customer on a website).
  Reads need `visibility.view` and changes and the build `visibility.manage`. Refusals use the
  codes `rule_not_found`, `rule_taken`, `product_not_found`, `category_not_found`,
  `website_not_found`, `customer_not_found` and `customer_group_not_found`.
- `visibility:build` command to rebuild visibility from a shell.
- `@muziris/access`: admin permissions `visibility.view` and `visibility.manage`.
- `@muziris/catalog`: `productCategoryAndStatus` and `categoryParents`, SQL selects of every
  product's category and status and of the category tree.
- `@muziris/search` (ADR 0013): product search on PostgreSQL. An index (`search_product`)
  built from catalog's public SQL with a weighted document (SKU, name, category names,
  attribute values), read through both the `english` and `simple` configurations, and
  `pg_trgm` trigram indexes. Results rank exact SKU, then SKU prefix, then text matches, then
  close matches (typos and partial SKUs), and are paged with `limit` (at most 50) and `offset`
  within the first 1,000. Queries also match the other spelling of common Indian and US
  English pairs (aluminium and aluminum, spanner and wrench). `searchProductsForBuyer` puts
  visibility's `visibleProductIdsForBuyer` in the statement's `where` clause, and returns a
  category id only if the buyer may see the category. `searchProducts` is the admin search,
  with the status read live. `rebuildSearchIndex` is a set-based build; `indexProducts` and
  `indexProductsInCategory` reindex after catalog writes; `getBuildState` counts products
  waiting for the index.
- API: `GET /admin/v1/search/products?q=` (`product.view`), `GET /admin/v1/search/build`
  (`product.view`) and `POST /admin/v1/search/build` (`product.manage`). The catalog routes
  reindex a product, or a category's products, after each write.
- `search:build` command to rebuild the search index from a shell.
- `@muziris/catalog`: `productSearchSource` and `categoryNames`, SQL selects of what search
  indexes.
- Migrations create the `pg_trgm` extension, if it is not there yet, and the search tables.
- API: the storefront GraphQL endpoint, `/storefront/v1/graphql` (ADR 0014), for signed-in
  buyers. The website comes from the `Muziris-Website` header. Queries: `viewer`, `website`,
  `categories`, `category`, `product` (by id or SKU), `products` (paged by SKU) and `search`,
  with each product's price for a unit and quantity. Every read is scoped to the buyer inside
  its SQL. Persisted queries from a registry (`STOREFRONT_PERSISTED_QUERIES`); ad hoc queries
  and introspection only when `STOREFRONT_ADHOC_QUERIES=allow`, the default outside
  production and refused in production. Depth, cost and document size limits are checked
  before execution, internal errors are masked, and reads are batched per request. The
  schema is committed as `schema.graphql`; `pnpm --filter @muziris/api storefront:schema`
  rewrites it.
- `@muziris/catalog`: `findProductsWithin`, `findProductBySkuWithin`, `listProductsWithin` and
  `listCategoriesWithin`, reads within a set of ids given as an SQL select.
- `@muziris/pricing`: `findPricesForBuyer`, the buyer price lookup for many products, units and
  quantities in one statement.
- `@muziris/db`: an `onQuery` option on `createDatabase`, for tests that count queries.
- `@muziris/orders` (ADR 0016): checkout as two functions, `previewCheckout` and `placeOrder`.
  Placing re-checks the buyer's `order.place` permission, the website, the addresses, each
  line's visibility, unit, quantity and price, and refuses with `prices_changed` when the
  grand total differs from the one the buyer saw. It is idempotent per buyer and key, and a key
  reused for a different order is refused. The totals pipeline runs line discounts, order
  discounts, shipping, shipping discounts and tax as replaceable providers (the pilot has no
  discounts and flat-rate shipping; the tax engine is ADR 0017). Orders copy their lines, taxes
  and addresses, are numbered from a sequence (`MZ-000001`), carry payment terms from the
  `payment.term_days` setting, and move through the `order_processing` workflow (new,
  confirmed, processing, completed, or declined). Buyer reads are scoped by `order.view`.
  Migration `0010`.
- Storefront API: `checkoutPreview`, `orders` and `order(number)`, `addresses` on the viewer's
  customer, and the first mutation, `placeOrder`. Refusals are data with a stable code
  (`PRICES_CHANGED` carries the new totals). Without a tax calculator, checkout refuses with
  `TAX_NOT_CONFIGURED`.
- API: `GET /admin/v1/orders`, `GET /admin/v1/orders/:orderId` (with its history, version and
  open transitions) with `order.view`, and `POST /admin/v1/orders/:orderId/transitions` with
  `order.manage`, refusing a stale version with 409.
- `apps/storefront` (ADR 0015): the buyer storefront, for signed-in buyers. Sign-in with the
  session-ended message, a header with search and the category bar, all products and category
  pages with a side menu, subcategories and paging, the product page with details and a price
  box that prices any unit and quantity the buyer enters, and search with match labels and a
  close-spellings notice. Prices show in the website's locale and currency, with "Price on
  request" when there is none. Light and dark follow the system. Design boards in
  `docs/design/storefront/`.
- `pnpm --filter @muziris/storefront operations`: compiles the storefront's operations into
  TypeScript types and the persisted query registry (`persisted-queries.json`) the API loads.
- `packages/ui-tokens`: the design tokens, shared by the admin app and the storefront.

### Changed

- `@muziris/customers`: `listCustomerGroups`, `listBuyerUsers`, `listPendingInvitations` and
  `listAddresses` return a page (`{ <items>, nextAfter }`) instead of an array.
  `@muziris/access`: so does `listBuyerRoles`.
- API: the `user_not_found` problem title is now "No such user", since buyer role assignment
  uses it too.

### Fixed

- `@muziris/platform`: a string setting that looks like JSON (such as `"250.00"` or `"123"`)
  is read back as the string stored. Drizzle's jsonb column parsed the driver's already decoded
  value again, so it came back as a number and failed its schema.
- `@muziris/orders`: order line quantities read without the column's trailing zeros (`10`, not
  `10.000000`).
