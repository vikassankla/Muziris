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
