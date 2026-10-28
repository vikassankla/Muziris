# Build status

Where the build stands and what comes next. Update this file at the end of every working
session, so the next session (human or AI) starts from here.

Last updated: 2026-10-28

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

Decisions are recorded in `docs/adr/0001` to `0010`. ADRs 0006 (access control), 0007
(workflow engine), 0008 (customers) and 0009 (catalog) are merged with status proposed. ADR 0010
(admin routes for customers and buyer roles, paged admin lists) is proposed in its pull request.
Every admin list endpoint is paged with `limit` (at most 200) and `after`.

## Next, in order (pilot plan)

**Week 2 (4 to 10 Nov)**

Access control (ADR 0006), the workflow engine (ADR 0007), customers (ADR 0008) and the
catalog (ADR 0009) are merged; see Done. Admin routes for customers and buyer roles (ADR 0010)
are in review. Customers has no storefront routes yet (accepting an invitation needs one), and
invitation emails wait for the email work in week 4.

1. Admin app shell: React, Vite, TanStack Router, shadcn/ui, sign-in screen. Use
   `GET /admin/v1/access/me` to hide what the admin may not do.

**Week 3 (11 to 17 Nov):** price lists with customer and group fallback and the combined
price build; visibility; PostgreSQL search; GraphQL storefront API; storefront browsing.
Gate check: a buyer sees only their own catalog and prices.

**Week 4 (18 to 24 Nov):** shopping lists, quick order, checkout (payment on terms; Stripe and
Razorpay in test mode), flat-rate shipping, GST and US tax tables, orders with the order
workflow, emails.

**Week 5 (25 Nov to 1 Dec):** known-answer tests for pricing and tax, end-to-end buyer
journeys, MRO demo catalog, install guide, security pass, pilot launch.

If a week slips, cut in this order: emails, then quick order CSV upload, then US tax tables.

## Open items

- Admin two-factor sign-in before the first production install (ADR 0005).
- A job runner (pg-boss) to schedule `deleteDeadSessions` and `pruneRateLimits`.
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
