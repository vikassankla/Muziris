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
