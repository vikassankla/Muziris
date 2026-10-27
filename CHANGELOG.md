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
