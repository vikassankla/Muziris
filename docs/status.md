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
| Customers  | Hierarchy, customer groups, buyer users, invitations, India and US addresses                                            | `modules/customers`   |

Decisions are recorded in `docs/adr/0001` to `0005`, `0007` and `0008`.

## Next, in order (pilot plan)

**Week 2 (4 to 10 Nov)**

1. Access control: admin roles and permissions; buyer roles with access levels (own records,
   my customer, my customer and subsidiaries), enforced in queries, not after them.
2. Workflow engine: built in `modules/workflow` (ADR 0007). The order workflow (week 4), RFQs
   and quotes declare their workflows with `defineWorkflow`.
3. Customers: built in `modules/customers` (ADR 0008). Admin and storefront routes for
   customers, buyer users, invitations and addresses are not built yet, and invitation emails
   wait for the email work in week 4.
4. Catalog: simple products, product units with precision, categories, attributes (JSONB).
5. Admin app shell: React, Vite, TanStack Router, shadcn/ui, sign-in screen.

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
