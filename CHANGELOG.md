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
